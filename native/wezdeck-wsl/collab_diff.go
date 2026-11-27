package main

// `collab.diff {id, child?}` (read):
// Return bounded, secret-redacted net git diffs for a ticket's worktree(s)
// (single ticket, child ticket, or parent integration / child worktrees) so
// the web console can review all changes in a fullscreen Shiki Diff drawer.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	collabDiffTimeout       = 3 * time.Second
	collabDiffMaxFiles      = 80
	collabDiffMaxLinesFile  = 240
	collabDiffMaxTotalBytes = 512 * 1024
)

type collabDiffFile struct {
	Path      string `json:"path"`
	Status    string `json:"status"` // M | A | D | R | ?
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Binary    bool   `json:"binary,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
	Patch     string `json:"patch,omitempty"`
}

type collabDiffRepo struct {
	Repo      string           `json:"repo"`
	Branch    string           `json:"branch,omitempty"`
	Base      string           `json:"base,omitempty"`
	Worktree  string           `json:"worktree,omitempty"`
	Source    string           `json:"source"` // integration | worktree | child
	TicketID  string           `json:"ticket_id"`
	Additions int              `json:"additions"`
	Deletions int              `json:"deletions"`
	Truncated bool             `json:"truncated,omitempty"`
	Note      string           `json:"note,omitempty"`
	Files     []collabDiffFile `json:"files"`
}

type ticketMetaFile struct {
	Kind        string `json:"kind"`
	Worktree    string `json:"worktree"`
	Branch      string `json:"branch"`
	Base        string `json:"base"`
	BaseSHA     string `json:"base_sha"`
	Parent      string `json:"parent"`
	Repos       []string `json:"repos"`
	Integration map[string]struct {
		Worktree string   `json:"worktree"`
		Branch   string   `json:"branch"`
		Base     string   `json:"base"`
		Head     string   `json:"head"`
		Merged   []string `json:"merged"`
		Skipped  string   `json:"skipped"`
	} `json:"integration"`
}

func collabDiff(args json.RawMessage) (any, error) {
	started := time.Now()
	var a struct {
		ID    string `json:"id"`
		Child string `json:"child"`
	}
	if json.Unmarshal(args, &a) != nil || !collabTicketIDRe.MatchString(a.ID) {
		return nil, errors.New("invalid ticket id")
	}
	if a.Child != "" && !collabTicketIDRe.MatchString(a.Child) {
		return nil, errors.New("invalid child ticket id")
	}

	targetID := a.ID
	if a.Child != "" {
		targetID = a.Child
	}

	dataRoot := filepath.Join(ticketsRootDir(), "_data")
	ticketDir := filepath.Join(dataRoot, targetID)
	if st, err := os.Stat(ticketDir); err != nil || !st.IsDir() {
		return nil, errors.New("ticket not found")
	}

	var meta ticketMetaFile
	readJSONFile(filepath.Join(ticketDir, "meta.json"), &meta)

	var repos []collabDiffRepo
	budgetBytes := collabDiffMaxTotalBytes
	anyTruncated := false

	// 1. Parent with integration worktrees
	if a.Child == "" && len(meta.Integration) > 0 {
		names := make([]string, 0, len(meta.Integration))
		for repo := range meta.Integration {
			names = append(names, repo)
		}
		sort.Strings(names)
		for _, repo := range names {
			info := meta.Integration[repo]
			if info.Worktree == "" {
				continue
			}
			entry := collectWorktreeDiff(repo, info.Worktree, info.Branch, info.Base, "integration", targetID, &budgetBytes)
			if entry.Truncated {
				anyTruncated = true
			}
			repos = append(repos, entry)
		}
	}

	// 2. Single / child ticket with own worktree
	if len(repos) == 0 && meta.Worktree != "" {
		repoName := ticketToRepo(ticketDir, meta.Repos)
		base := firstNonEmpty(meta.Base, meta.BaseSHA, earliestRunBaseSHA(filepath.Join(ticketDir, "runs")))
		source := "worktree"
		if a.Child != "" || meta.Parent != "" {
			source = "child"
		}
		entry := collectWorktreeDiff(repoName, meta.Worktree, meta.Branch, base, source, targetID, &budgetBytes)
		if entry.Truncated {
			anyTruncated = true
		}
		repos = append(repos, entry)
	}

	// 3. Parent without integration yet: aggregate child worktrees
	if len(repos) == 0 && a.Child == "" && meta.Kind == "parent" {
		entries, _ := os.ReadDir(dataRoot)
		for _, e := range entries {
			if !e.IsDir() || !strings.HasPrefix(e.Name(), "req-") {
				continue
			}
			cDir := filepath.Join(dataRoot, e.Name())
			var cm ticketMetaFile
			if !readJSONFile(filepath.Join(cDir, "meta.json"), &cm) || cm.Parent != targetID || cm.Worktree == "" {
				continue
			}
			repoName := ticketToRepo(cDir, cm.Repos)
			base := firstNonEmpty(cm.Base, cm.BaseSHA, earliestRunBaseSHA(filepath.Join(cDir, "runs")))
			entry := collectWorktreeDiff(repoName, cm.Worktree, cm.Branch, base, "child", e.Name(), &budgetBytes)
			if entry.Truncated {
				anyTruncated = true
			}
			repos = append(repos, entry)
		}
	}

	if repos == nil {
		repos = []collabDiffRepo{}
	}
	totalFiles, totalAdd, totalDel := 0, 0, 0
	for _, r := range repos {
		totalFiles += len(r.Files)
		totalAdd += r.Additions
		totalDel += r.Deletions
	}

	relayLogf("collab_diff", "id=%s child=%s repos=%d files=%d +%d -%d truncated=%t ms=%d",
		a.ID, a.Child, len(repos), totalFiles, totalAdd, totalDel, anyTruncated, time.Since(started).Milliseconds())

	return map[string]any{
		"v":               1,
		"ok":              true,
		"id":              a.ID,
		"child":           a.Child,
		"total_files":     totalFiles,
		"total_additions": totalAdd,
		"total_deletions": totalDel,
		"truncated":       anyTruncated,
		"repos":           repos,
	}, nil
}

func ticketToRepo(ticketDir string, repos []string) string {
	if len(repos) > 0 && repos[0] != "" {
		return repos[0]
	}
	raw, err := os.ReadFile(filepath.Join(ticketDir, "ticket.md"))
	if err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.HasPrefix(line, "to:") {
				if v := strings.TrimSpace(strings.TrimPrefix(line, "to:")); v != "" {
					return v
				}
			}
			if strings.HasPrefix(line, "## ") {
				break
			}
		}
	}
	return filepath.Base(ticketDir)
}

func earliestRunBaseSHA(runsDir string) string {
	matches, err := filepath.Glob(filepath.Join(runsDir, "run-*.launch.json"))
	if err != nil || len(matches) == 0 {
		return ""
	}
	sort.Strings(matches)
	for _, p := range matches {
		var l runLaunchMeta
		if readJSONFile(p, &l) && strings.TrimSpace(l.Invocation.BaseSHA) != "" {
			return strings.TrimSpace(l.Invocation.BaseSHA)
		}
	}
	return ""
}

func gitDiffOutput(cwd string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), collabDiffTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", cwd}, args...)...)
	out, err := cmd.Output()
	return string(out), err
}

func collectWorktreeDiff(repo, worktree, branch, base, source, ticketID string, budgetBytes *int) collabDiffRepo {
	res := collabDiffRepo{
		Repo:     repo,
		Branch:   branch,
		Base:     shortSHA(base),
		Worktree: worktree,
		Source:   source,
		TicketID: ticketID,
		Files:    []collabDiffFile{},
	}
	if st, err := os.Stat(worktree); err != nil || !st.IsDir() {
		res.Note = "worktree no longer exists on disk"
		return res
	}
	if res.Branch == "" {
		if b, err := gitDiffOutput(worktree, "rev-parse", "--abbrev-ref", "HEAD"); err == nil {
			res.Branch = strings.TrimSpace(b)
		}
	}
	baseRef := resolveDiffBase(worktree, base)
	if baseRef == "" {
		res.Note = "unable to determine base commit"
		return res
	}
	res.Base = shortSHA(baseRef)

	// 1. File statuses (`M`, `A`, `D`, `R`) + numstat against baseRef (includes both commits and working tree).
	statusByPath := map[string]string{}
	if stOut, err := gitDiffOutput(worktree, "diff", "--name-status", "--no-renames", baseRef); err == nil {
		for _, line := range strings.Split(strings.TrimSpace(stOut), "\n") {
			parts := strings.SplitN(line, "\t", 2)
			if len(parts) == 2 {
				statusByPath[parts[1]] = strings.TrimSpace(parts[0])
			}
		}
	}

	numOut, err := gitDiffOutput(worktree, "diff", "--numstat", "--no-renames", baseRef)
	if err != nil {
		res.Note = "git diff failed"
		return res
	}

	type statRow struct {
		path      string
		additions int
		deletions int
		binary    bool
		status    string
	}
	var rows []statRow
	for _, line := range strings.Split(strings.TrimSpace(numOut), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) != 3 {
			continue
		}
		r := statRow{
			path:   parts[2],
			status: firstNonEmpty(statusByPath[parts[2]], "M"),
		}
		if parts[0] == "-" || parts[1] == "-" {
			r.binary = true
		} else {
			r.additions, _ = strconv.Atoi(parts[0])
			r.deletions, _ = strconv.Atoi(parts[1])
		}
		rows = append(rows, r)
	}

	// Include untracked files (excluding ignored files and `.ticket/` scratch).
	if untrackOut, uerr := gitDiffOutput(worktree, "ls-files", "--others", "--exclude-standard"); uerr == nil {
		for _, line := range strings.Split(strings.TrimSpace(untrackOut), "\n") {
			p := strings.TrimSpace(line)
			if p == "" || strings.HasPrefix(p, ".ticket/") || p == ".ticket" {
				continue
			}
			rows = append(rows, statRow{path: p, status: "?"})
		}
	}

	if len(rows) > collabDiffMaxFiles {
		rows = rows[:collabDiffMaxFiles]
		res.Truncated = true
	}

	for _, r := range rows {
		f := collabDiffFile{
			Path:      r.path,
			Status:    r.status,
			Additions: r.additions,
			Deletions: r.deletions,
			Binary:    r.binary,
		}
		if !r.binary && *budgetBytes > 0 {
			var patch string
			if r.status == "?" {
				patch, f.Additions = untrackedFilePatch(worktree, r.path)
			} else if rawPatch, perr := gitDiffOutput(worktree, "diff", "--unified=3", "--no-color", "--no-ext-diff", baseRef, "--", r.path); perr == nil {
				patch = extractUnifiedHunks(rawPatch)
			}
			if patch != "" {
				patch, _ = redactFileSecrets(patch)
				clipped, wasClipped := clipDiffPatch(patch, collabDiffMaxLinesFile, *budgetBytes)
				f.Patch = clipped
				f.Truncated = wasClipped
				if wasClipped {
					res.Truncated = true
				}
				*budgetBytes -= len(clipped)
				if *budgetBytes < 0 {
					*budgetBytes = 0
				}
			}
		}
		res.Additions += f.Additions
		res.Deletions += f.Deletions
		res.Files = append(res.Files, f)
	}
	return res
}

func resolveDiffBase(worktree, base string) string {
	candidates := []string{}
	if strings.TrimSpace(base) != "" {
		candidates = append(candidates, strings.TrimSpace(base))
	}
	for _, ref := range candidates {
		if out, err := gitDiffOutput(worktree, "rev-parse", "--verify", ref+"^{commit}"); err == nil {
			return strings.TrimSpace(out)
		}
	}
	for _, ref := range []string{"@{u}", "origin/HEAD", "origin/master", "origin/main", "master", "main"} {
		if out, err := gitDiffOutput(worktree, "merge-base", "HEAD", ref); err == nil && strings.TrimSpace(out) != "" {
			return strings.TrimSpace(out)
		}
	}
	if out, err := gitDiffOutput(worktree, "rev-parse", "--verify", "HEAD~1"); err == nil {
		return strings.TrimSpace(out)
	}
	return ""
}

func shortSHA(sha string) string {
	sha = strings.TrimSpace(sha)
	if len(sha) > 12 {
		return sha[:12]
	}
	return sha
}

// extractUnifiedHunks strips `diff --git` / `index` / `---` / `+++` headers
// so the output starts directly at `@@ -a,b +c,d @@` for `chat-diff.tsx`'s ToolBody.
func extractUnifiedHunks(raw string) string {
	lines := strings.Split(raw, "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, "@@ ") {
			return strings.TrimRight(strings.Join(lines[i:], "\n"), "\n")
		}
	}
	return ""
}

func isBinaryDiffBytes(b []byte) bool {
	limit := min(len(b), 4096)
	for i := 0; i < limit; i++ {
		if b[i] == 0 {
			return true
		}
	}
	return false
}

func untrackedFilePatch(worktree, relPath string) (string, int) {
	full := filepath.Join(worktree, relPath)
	raw, err := os.ReadFile(full)
	if err != nil || len(raw) == 0 || isBinaryDiffBytes(raw) {
		return "", 0
	}
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	var b strings.Builder
	fmt.Fprintf(&b, "@@ -0,0 +1,%d @@\n", len(lines))
	for _, line := range lines {
		b.WriteString("+" + line + "\n")
	}
	return strings.TrimRight(b.String(), "\n"), len(lines)
}

func clipDiffPatch(patch string, maxLines, maxBytes int) (string, bool) {
	lines := strings.Split(patch, "\n")
	clipped := false
	if len(lines) > maxLines {
		omitted := len(lines) - maxLines
		lines = append(lines[:maxLines], fmt.Sprintf("… (+%d lines)", omitted))
		clipped = true
	}
	out := strings.Join(lines, "\n")
	if len(out) > maxBytes && maxBytes > 64 {
		out = out[:maxBytes] + "\n… (truncated)"
		clipped = true
	}
	return out, clipped
}

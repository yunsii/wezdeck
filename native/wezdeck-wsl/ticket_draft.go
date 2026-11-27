package main

// AI-assisted quick ticket structuring (`ticket.draft`) and background
// enrichment for quick-captured tickets (`ticket.new` with mode="quick").
// Single-shot host CLI invocation routes strictly through
// scripts/runtime/ticket-draft.sh → skills/adversarial-review/lib/provider.sh.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

const ticketDraftTimeout = 45 * time.Second

type ticketDraftResult struct {
	Title       string `json:"title"`
	Summary     string `json:"summary"`
	Observed    string `json:"observed"`
	Assumed     string `json:"assumed"`
	SuggestedTo string `json:"suggested_to"`
	Provider    string `json:"provider,omitempty"`
}

// sessionCwd resolves the working directory of a tracked session.
func sessionCwd(id string) (string, error) {
	if !sessionIDPattern.MatchString(id) {
		return "", errors.New("invalid session id")
	}
	entries, err := liveSessions()
	if err != nil {
		return "", err
	}
	e, ok := entries[id]
	if !ok {
		return "", errors.New("session not found (ended or not tracked)")
	}
	_, cwd, _, _, _, _ := paneState(e)
	if cwd == "" {
		return "", errors.New("the session's directory is unknown")
	}
	return cwd, nil
}

// resolveTargetForDir maps a repo directory or linked worktree to a configured
// ticket target key, mirroring skills/agent-collab/lib/ticket_fs.py.
func resolveTargetForDir(dir string, targets []ticketTarget) string {
	dir = strings.TrimSpace(dir)
	if dir == "" || len(targets) == 0 {
		return ""
	}
	pathMap := make(map[string]string, len(targets))
	for _, t := range targets {
		if t.Path == "" {
			continue
		}
		if resolved, err := filepath.EvalSymlinks(t.Path); err == nil {
			pathMap[filepath.Clean(resolved)] = t.Key
		}
		pathMap[filepath.Clean(t.Path)] = t.Key
	}
	matchAncestors := func(start string) string {
		cur := filepath.Clean(start)
		if resolved, err := filepath.EvalSymlinks(cur); err == nil {
			cur = filepath.Clean(resolved)
		}
		for {
			if key, ok := pathMap[cur]; ok {
				return key
			}
			parent := filepath.Dir(cur)
			if parent == cur {
				return ""
			}
			cur = parent
		}
	}
	if key := matchAncestors(dir); key != "" {
		return key
	}
	// Linked worktree: follow `.git` file (`gitdir: .../.git/worktrees/<name>`).
	cur := filepath.Clean(dir)
	for {
		dotGit := filepath.Join(cur, ".git")
		info, err := os.Stat(dotGit)
		if err == nil {
			if !info.IsDir() {
				if data, rerr := os.ReadFile(dotGit); rerr == nil {
					line := strings.TrimSpace(string(data))
					if strings.HasPrefix(strings.ToLower(line), "gitdir:") {
						gd := strings.TrimSpace(line[len("gitdir:"):])
						if !filepath.IsAbs(gd) {
							gd = filepath.Join(cur, gd)
						}
						gd = filepath.Clean(gd)
						if filepath.Base(filepath.Dir(gd)) == "worktrees" &&
							filepath.Base(filepath.Dir(filepath.Dir(gd))) == ".git" {
							mainRoot := filepath.Dir(filepath.Dir(filepath.Dir(gd)))
							if key := matchAncestors(mainRoot); key != "" {
								return key
							}
						}
					}
				}
			}
			break
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	return ""
}

func resolveTargetForSession(sessionID string, targets []ticketTarget) string {
	if sessionID == "" {
		return ""
	}
	cwd, err := sessionCwd(sessionID)
	if err != nil {
		return ""
	}
	return resolveTargetForDir(cwd, targets)
}

func resolveAttachmentPaths(names []string) ([]string, error) {
	if len(names) == 0 {
		return nil, nil
	}
	if len(names) > attachmentsMax {
		return nil, fmt.Errorf("at most %d attachments", attachmentsMax)
	}
	dir := uploadDir()
	out := make([]string, 0, len(names))
	for _, n := range names {
		base := filepath.Base(n)
		if base != n || base == "." || !strings.Contains(base, "-") {
			return nil, fmt.Errorf("bad attachment %q", n)
		}
		p := filepath.Join(dir, base)
		if _, err := os.Stat(p); err != nil {
			return nil, fmt.Errorf("attachment %q is not on the host (upload it again)", n)
		}
		out = append(out, p)
	}
	return out, nil
}

func deriveQuickTitle(text string, attachmentCount int) string {
	for _, line := range strings.Split(text, "\n") {
		s := strings.TrimSpace(line)
		s = strings.TrimLeft(s, "#-*• ")
		s = strings.TrimSpace(s)
		if s != "" {
			return clip(s, 80)
		}
	}
	if attachmentCount > 0 {
		return "图片工单"
	}
	return "新工单"
}

func buildSessionContextSnippet(sessionID string) string {
	if sessionID == "" || !sessionIDPattern.MatchString(sessionID) {
		return ""
	}
	entries, err := liveSessions()
	if err != nil {
		return ""
	}
	e, ok := entries[sessionID]
	if !ok {
		return ""
	}
	path, agent := findTranscript(sessionID)
	if path == "" || agent == "" {
		return ""
	}
	t, err := loadTranscript(path, agent)
	if err != nil || t == nil || len(t.messages) == 0 {
		return ""
	}
	var users []string
	var lastAssistant string
	for _, m := range t.messages {
		switch m.Role {
		case "user":
			s := strings.TrimSpace(m.Text)
			if s != "" && !strings.HasPrefix(s, "<") {
				users = append(users, s)
			}
		case "assistant":
			if s := strings.TrimSpace(m.Text); s != "" {
				lastAssistant = s
			}
		}
	}
	if len(users) > 3 {
		users = users[len(users)-3:]
	}
	var b strings.Builder
	if title := resolveSessionTitle(sessionID, path, agent); title != "" {
		fmt.Fprintf(&b, "Session title: %s\n", clip(title, 80))
	}
	if e.GitBranch != "" {
		fmt.Fprintf(&b, "Branch: %s\n", e.GitBranch)
	}
	for i, u := range users {
		fmt.Fprintf(&b, "Recent user %d: %s\n", i+1, clip(strings.ReplaceAll(u, "\n", " "), 220))
	}
	if lastAssistant != "" {
		fmt.Fprintf(&b, "Latest assistant: %s\n", clip(strings.ReplaceAll(lastAssistant, "\n", " "), 300))
	}
	return strings.TrimSpace(b.String())
}

func buildTicketDraftPrompt(to string, targets []ticketTarget, text string, attachments []string, sessionID string, includeContext bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Target repo: %s\n", to)
	keys := make([]string, 0, len(targets))
	for _, t := range targets {
		keys = append(keys, t.Key)
	}
	fmt.Fprintf(&b, "Available repos: %s\n", strings.Join(keys, ", "))
	if includeContext && sessionID != "" {
		if ctx := buildSessionContextSnippet(sessionID); ctx != "" {
			fmt.Fprintf(&b, "\nSession context:\n%s\n", ctx)
		}
	}
	if len(attachments) > 0 {
		labels := make([]string, 0, len(attachments))
		imgIdx := 0
		for _, n := range attachments {
			if strings.HasPrefix(filepath.Base(n), "diagnostics-") {
				labels = append(labels, "客户端诊断")
			} else {
				imgIdx++
				labels = append(labels, fmt.Sprintf("[图片%d]", imgIdx))
			}
		}
		fmt.Fprintf(&b, "\nAttachments: %s (%d files attached)\n", strings.Join(labels, ", "), len(attachments))
	}
	fmt.Fprintf(&b, "\nUser request:\n%s\n", strings.TrimSpace(text))
	return b.String()
}

// runTicketDraftFunc is injectable for tests; production routes through
// scripts/runtime/ticket-draft.sh → adversarial-review/lib/provider.sh.
var runTicketDraftFunc = runTicketDraftCLI

func runTicketDraftCLI(ctx context.Context, promptInput string) (output string, provider string, err error) {
	script := filepath.Join(repoRoot(), "scripts", "runtime", "ticket-draft.sh")
	if _, statErr := os.Stat(script); statErr != nil {
		return "", "", fmt.Errorf("ticket-draft script missing: %w", statErr)
	}
	args := []string{script}
	if order := enabledAutoTitleOrder(); len(order) > 0 {
		args = append(args, "--order", strings.Join(order, ","))
	}
	cmd := exec.CommandContext(ctx, "bash", args...)
	cmd.Stdin = strings.NewReader(promptInput)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	for _, line := range strings.Split(stderr.String(), "\n") {
		if p, ok := strings.CutPrefix(strings.TrimSpace(line), "provider="); ok && p != "" {
			provider = p
		}
	}
	if err != nil {
		return "", provider, fmt.Errorf("%w: %s", err, clip(stderr.String(), 180))
	}
	return stdout.String(), provider, nil
}

func extractJSONObject(raw string) string {
	s := strings.TrimSpace(raw)
	if strings.HasPrefix(s, "```") {
		lines := strings.Split(s, "\n")
		if len(lines) >= 2 {
			lines = lines[1:]
			if len(lines) > 0 && strings.HasPrefix(strings.TrimSpace(lines[len(lines)-1]), "```") {
				lines = lines[:len(lines)-1]
			}
			s = strings.TrimSpace(strings.Join(lines, "\n"))
		}
	}
	start := strings.IndexByte(s, '{')
	end := strings.LastIndexByte(s, '}')
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return s
}

func parseTicketDraftOutput(raw string, known map[string]bool, currentTo string) (ticketDraftResult, error) {
	body := extractJSONObject(raw)
	var out ticketDraftResult
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		return ticketDraftResult{}, fmt.Errorf("AI returned invalid JSON: %w", err)
	}
	// Sanitize single-line title and bounded text fields.
	out.Title = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(out.Title, "\r", " "), "\n", " "))
	out.Title = clip(out.Title, 120)
	out.Summary = clip(strings.TrimSpace(out.Summary), 2000)
	out.Observed = clip(strings.TrimSpace(out.Observed), 8000)
	out.Assumed = clip(strings.TrimSpace(out.Assumed), 8000)
	out.SuggestedTo = strings.TrimSpace(out.SuggestedTo)
	if out.SuggestedTo == currentTo || !known[out.SuggestedTo] {
		out.SuggestedTo = ""
	}
	if out.Title == "" || out.Observed == "" || out.Assumed == "" {
		return ticketDraftResult{}, errors.New("AI draft missed required fields (title/observed/assumed)")
	}
	if out.Summary == "" {
		out.Summary = out.Title
	}
	return out, nil
}

func draftTicket(args json.RawMessage) (any, error) {
	var a struct {
		To             string   `json:"to"`
		Text           string   `json:"text"`
		Attachments    []string `json:"attachments"`
		Session        string   `json:"session"`
		IncludeContext bool     `json:"include_context"`
	}
	if json.Unmarshal(args, &a) != nil {
		return nil, errors.New("ticket.draft: bad arguments")
	}
	a.To = strings.TrimSpace(a.To)
	a.Text = strings.TrimSpace(a.Text)
	targets := ticketTargets()
	known := map[string]bool{}
	for _, t := range targets {
		known[t.Key] = true
	}
	if !known[a.To] {
		return nil, errors.New("ticket.draft: target repository is not configured")
	}
	if a.Text == "" && len(a.Attachments) == 0 {
		return nil, errors.New("ticket.draft: text or attachments required")
	}
	if utf8.RuneCountInString(a.Text) > 8000 {
		return nil, errors.New("ticket.draft: text is too long (max 8000 chars)")
	}
	if _, err := resolveAttachmentPaths(a.Attachments); err != nil {
		return nil, err
	}

	prompt := buildTicketDraftPrompt(a.To, targets, a.Text, a.Attachments, a.Session, a.IncludeContext)
	ctx, cancel := context.WithTimeout(context.Background(), ticketDraftTimeout)
	defer cancel()
	started := time.Now()
	raw, provider, err := runTicketDraftFunc(ctx, prompt)
	elapsed := time.Since(started).Milliseconds()
	if err != nil {
		relayLogf("ticket_draft", "to=%s provider=%s ok=false latency_ms=%d attachments=%d err=%q",
			a.To, provider, elapsed, len(a.Attachments), clip(err.Error(), 160))
		return nil, fmt.Errorf("ticket.draft: %w", err)
	}
	parsed, err := parseTicketDraftOutput(raw, known, a.To)
	if err != nil {
		relayLogf("ticket_draft", "to=%s provider=%s ok=false latency_ms=%d attachments=%d err=%q",
			a.To, provider, elapsed, len(a.Attachments), clip(err.Error(), 160))
		return nil, fmt.Errorf("ticket.draft: %w", err)
	}
	parsed.Provider = provider
	relayLogf("ticket_draft", "to=%s provider=%s ok=true latency_ms=%d attachments=%d suggested_to=%q",
		a.To, provider, elapsed, len(a.Attachments), parsed.SuggestedTo)
	return map[string]any{
		"v":            1,
		"ok":           true,
		"title":        parsed.Title,
		"summary":      parsed.Summary,
		"observed":     parsed.Observed,
		"assumed":      parsed.Assumed,
		"suggested_to": parsed.SuggestedTo,
		"provider":     provider,
	}, nil
}

// ticketEnrichDoneHook notifies tests when background enrichment completes.
var ticketEnrichDoneHook func(id string, ok bool)

func enrichTicketAsync(id, to, text string, attachments []string, sessionID string, includeContext bool) {
	targets := ticketTargets()
	known := map[string]bool{}
	for _, t := range targets {
		known[t.Key] = true
	}
	prompt := buildTicketDraftPrompt(to, targets, text, attachments, sessionID, includeContext)
	ctx, cancel := context.WithTimeout(context.Background(), ticketDraftTimeout)
	defer cancel()
	started := time.Now()
	raw, provider, err := runTicketDraftFunc(ctx, prompt)
	elapsed := time.Since(started).Milliseconds()
	var parsed ticketDraftResult
	if err == nil {
		parsed, err = parseTicketDraftOutput(raw, known, to)
	}
	if err != nil {
		_, _ = runTicketCLI("ticket enrich", []string{
			"enrich", "--id", id, "--status", "failed", "--provider", provider, "--error", clip(err.Error(), 240),
		})
		relayLogf("ticket_enrich", "id=%s to=%s provider=%s ok=false latency_ms=%d err=%q",
			id, to, provider, elapsed, clip(err.Error(), 160))
		if ticketEnrichDoneHook != nil {
			ticketEnrichDoneHook(id, false)
		}
		return
	}
	_, enrichErr := runTicketCLI("ticket enrich", []string{
		"enrich",
		"--id", id,
		"--title", parsed.Title,
		"--summary", parsed.Summary,
		"--observed", parsed.Observed,
		"--assumed", parsed.Assumed,
		"--status", "done",
		"--provider", provider,
	})
	relayLogf("ticket_enrich", "id=%s to=%s provider=%s ok=%t latency_ms=%d",
		id, to, provider, enrichErr == nil, elapsed)
	if ticketEnrichDoneHook != nil {
		ticketEnrichDoneHook(id, enrichErr == nil)
	}
}

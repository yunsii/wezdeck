package main

// `session.git {id}` (read): what the header's git tag stands for, opened on
// tap — the changed files by state, the commits not pushed / not pulled yet,
// and the recent commits of the pane's checkout. On demand only (the session
// poll carries just the counts, git_status.go); every git call is bounded.

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const (
	gitDetailTimeout = 1500 * time.Millisecond
	gitFilesMax      = 200
	gitCommitsMax    = 20
	gitRecentMax     = 10
)

type gitFile struct {
	Path  string `json:"path"`
	State string `json:"state"` // staged | modified | untracked | conflict
	Code  string `json:"code"`  // the porcelain letter (M A D R C U ?)
}

type gitCommit struct {
	SHA     string `json:"sha"`
	Subject string `json:"subject"`
	Body    string `json:"body,omitempty"` // the message after the subject (clipped)
	Author  string `json:"author"`
	At      int64  `json:"at"` // ms
}

const gitBodyMax = 500

type gitDetail struct {
	Status    *gitStatus  `json:"status"`
	Branch    string      `json:"branch,omitempty"`
	Upstream  string      `json:"upstream,omitempty"`
	Files     []gitFile   `json:"files"`
	Truncated bool        `json:"truncated,omitempty"`
	Ahead     []gitCommit `json:"ahead"`
	Behind    []gitCommit `json:"behind"`
	Recent    []gitCommit `json:"recent"`
}

func sessionGit(args json.RawMessage) (any, error) {
	var a struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(args, &a) != nil || !sessionIDPattern.MatchString(a.ID) {
		return nil, errors.New("invalid session id")
	}
	live, err := liveSessions()
	if err != nil {
		return nil, err
	}
	e, ok := live[a.ID]
	if !ok {
		return nil, errors.New("session not found (ended or not tracked)")
	}
	cwd, alive := paneInfo(e)
	if !alive || cwd == "" {
		return nil, errors.New("the session's tmux pane is gone")
	}
	start := time.Now()
	out, err := gitOutput(cwd, "status", "--porcelain=v2", "--branch", "--untracked-files=all")
	if err != nil {
		return nil, errors.New("not a git checkout (or git timed out)")
	}
	d := parseGitDetail(out)
	if d.Upstream != "" {
		d.Ahead = gitLog(cwd, "@{u}..HEAD", gitCommitsMax)
		d.Behind = gitLog(cwd, "HEAD..@{u}", gitCommitsMax)
	}
	d.Recent = gitLog(cwd, "HEAD", gitRecentMax)
	relayLogf("session_git", "files=%d ahead=%d behind=%d ms=%d", len(d.Files), len(d.Ahead), len(d.Behind), time.Since(start).Milliseconds())
	return d, nil
}

func gitOutput(cwd string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitDetailTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", append([]string{"-C", cwd}, args...)...).Output()
	return string(out), err
}

// gitLog: commits of a range, newest first; empty when the range fails.
func gitLog(cwd, rng string, n int) []gitCommit {
	// the body spans lines: one record per commit (RS), fields by US
	out, err := gitOutput(cwd, "log", "-n", strconv.Itoa(n), "--format=%h%x1f%s%x1f%an%x1f%ct%x1f%b%x1e", rng, "--")
	commits := []gitCommit{}
	if err != nil {
		return commits
	}
	for _, record := range strings.Split(out, "\x1e") {
		f := strings.SplitN(strings.TrimLeft(record, "\n"), "\x1f", 5)
		if len(f) != 5 {
			continue
		}
		at, _ := strconv.ParseInt(f[3], 10, 64)
		body := clip(strings.TrimSpace(f[4]), gitBodyMax)
		commits = append(commits, gitCommit{SHA: f[0], Subject: f[1], Body: body, Author: f[2], At: at * 1000})
	}
	return commits
}

// parseGitDetail: the counts (parseGitStatus) plus each file; a file both
// staged and modified is listed under both.
func parseGitDetail(out string) gitDetail {
	d := gitDetail{Status: parseGitStatus(out), Files: []gitFile{}, Ahead: []gitCommit{}, Behind: []gitCommit{}}
	add := func(path, state, code string) {
		if len(d.Files) >= gitFilesMax {
			d.Truncated = true
			return
		}
		d.Files = append(d.Files, gitFile{Path: path, State: state, Code: code})
	}
	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.HasPrefix(line, "# branch.head "):
			d.Branch = strings.TrimPrefix(line, "# branch.head ")
		case strings.HasPrefix(line, "# branch.upstream "):
			d.Upstream = strings.TrimPrefix(line, "# branch.upstream ")
		case strings.HasPrefix(line, "1 "), strings.HasPrefix(line, "2 "):
			n := 9
			if line[0] == '2' {
				n = 10
			}
			f := strings.SplitN(line, " ", n)
			if len(f) < n || len(f[1]) != 2 {
				continue
			}
			path, _, _ := strings.Cut(f[n-1], "\t") // a rename: "new\told"
			if x := f[1][0]; x != '.' {
				add(path, "staged", string(x))
			}
			if y := f[1][1]; y != '.' {
				add(path, "modified", string(y))
			}
		case strings.HasPrefix(line, "u "):
			if f := strings.SplitN(line, " ", 11); len(f) == 11 {
				add(f[10], "conflict", "U")
			}
		case strings.HasPrefix(line, "? "):
			add(strings.TrimPrefix(line, "? "), "untracked", "?")
		}
	}
	return d
}

package main

// `session.file {id, path, line_start?, line_end?}` (read): inspect a text,
// Markdown, or code file referenced by a session (Agy artifacts, Claude plans,
// Grok plans, or files inside the session's checkout / repository) from the
// web console — including remote mode over the relay.
//
// Security boundaries:
//   - only regular UTF-8 text files inside the session's allowed roots
//     (pane cwd, git repo root, this session's Agy brain dir, this session's
//     Grok session dir, or ~/.claude/plans/*.md), checked after EvalSymlinks;
//   - secret-like filenames (.env, *.pem, *.key, shared.env, kimi.env, …) are
//     refused, and common API tokens / private key blocks in content are
//     redacted before leaving the host;
//   - capped at sessionFileMaxBytes (256 KiB) with clean UTF-8 line truncation.

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	sessionFileMaxBytes = 256 << 10
	sessionFileMaxPath  = 1024
)

type sessionFileArgs struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	LineStart int    `json:"line_start,omitempty"`
	LineEnd   int    `json:"line_end,omitempty"`
}

type sessionFileReply struct {
	V          int    `json:"v"`
	OK         bool   `json:"ok"`
	Path       string `json:"path"`
	RelPath    string `json:"rel_path,omitempty"`
	Name       string `json:"name"`
	Kind       string `json:"kind"` // markdown | code | text
	Lang       string `json:"lang,omitempty"`
	Content    string `json:"content"`
	Size       int64  `json:"size"`
	TotalLines int    `json:"total_lines"`
	Truncated  bool   `json:"truncated,omitempty"`
	Redacted   bool   `json:"redacted,omitempty"`
	LineStart  int    `json:"line_start,omitempty"`
	LineEnd    int    `json:"line_end,omitempty"`
	Mtime      int64  `json:"mtime"`
}

var (
	fileLineFragRe = regexp.MustCompile(`#L(\d+)(?:-L?(\d+))?$`)
	secretPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----`),
		regexp.MustCompile(`\bsk-ant-[A-Za-z0-9_-]{20,}\b`),
		regexp.MustCompile(`\bsk-proj-[A-Za-z0-9_-]{20,}\b`),
		regexp.MustCompile(`\bsk-[A-Za-z0-9]{24,}\b`),
		regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{20,}\b`),
		regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{20,}\b`),
		regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{30,}\b`),
		regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),
	}
	fileLangByExt = map[string]string{
		"ts": "typescript", "mts": "typescript", "cts": "typescript", "tsx": "tsx",
		"js": "javascript", "mjs": "javascript", "cjs": "javascript", "jsx": "jsx",
		"go": "go", "sh": "shellscript", "bash": "shellscript", "zsh": "shellscript",
		"lua": "lua", "py": "python", "json": "json", "jsonc": "json",
		"css": "css", "md": "markdown", "markdown": "markdown", "mdx": "markdown",
		"yml": "yaml", "yaml": "yaml", "cs": "csharp", "toml": "toml",
		"html": "html", "ps1": "powershell", "rs": "rust", "sql": "sql",
	}
)

type allowedRoot struct {
	path     string
	mdOnly   bool
	labelRel bool
}

func parseFileRequestPath(raw string) (path string, lineStart, lineEnd int, err error) {
	s := strings.TrimSpace(raw)
	if s == "" || len(s) > sessionFileMaxPath || strings.ContainsRune(s, 0) {
		return "", 0, 0, errors.New("invalid file path")
	}
	if m := fileLineFragRe.FindStringSubmatchIndex(s); m != nil {
		lineStart, _ = strconv.Atoi(s[m[2]:m[3]])
		if m[4] >= 0 {
			lineEnd, _ = strconv.Atoi(s[m[4]:m[5]])
		}
		s = s[:m[0]]
	}
	if strings.HasPrefix(s, "file://") {
		u, parseErr := url.Parse(s)
		if parseErr != nil || (u.Host != "" && u.Host != "localhost") {
			return "", 0, 0, errors.New("invalid file URL")
		}
		s = u.Path
	}
	if s == "" || strings.ContainsRune(s, 0) {
		return "", 0, 0, errors.New("invalid file path")
	}
	return filepath.Clean(s), lineStart, lineEnd, nil
}

func sessionAllowedRoots(id, cwd, repoRoot, home string) []allowedRoot {
	var roots []allowedRoot
	seen := map[string]bool{}
	add := func(p string, mdOnly, labelRel bool) {
		if p == "" {
			return
		}
		realPath, err := filepath.EvalSymlinks(p)
		if err != nil {
			return
		}
		key := realPath + "|" + strconv.FormatBool(mdOnly)
		if seen[key] {
			return
		}
		seen[key] = true
		roots = append(roots, allowedRoot{path: realPath, mdOnly: mdOnly, labelRel: labelRel})
	}
	add(cwd, false, true)
	add(repoRoot, false, true)
	if home != "" && sessionIDPattern.MatchString(id) {
		add(filepath.Join(home, ".gemini", "antigravity-cli", "brain", id), false, false)
		add(filepath.Join(home, ".claude", "plans"), true, false)
		if matches, err := filepath.Glob(filepath.Join(home, ".grok", "sessions", "*", id)); err == nil {
			for _, m := range matches {
				add(m, false, false)
			}
		}
	}
	return roots
}

func pathWithinRoot(target, root string) bool {
	if target == root {
		return true
	}
	sep := string(filepath.Separator)
	if !strings.HasSuffix(root, sep) {
		root += sep
	}
	return strings.HasPrefix(target, root)
}

func isSecretFileName(path string) bool {
	base := strings.ToLower(filepath.Base(path))
	ext := strings.ToLower(filepath.Ext(base))
	if base == ".env" || strings.HasPrefix(base, ".env.") {
		switch base {
		case ".env.example", ".env.sample", ".env.template":
			return false
		default:
			return true
		}
	}
	switch base {
	case "shared.env", "kimi.env", "agent-tools.env",
		".npmrc", ".netrc", ".pypirc", ".git-credentials",
		"kubeconfig", "credentials.json", "auth.json",
		"id_rsa", "id_ed25519", "id_ecdsa", "id_dsa":
		return true
	}
	for _, prefix := range []string{"id_rsa.", "id_ed25519.", "id_ecdsa.", "id_dsa."} {
		if strings.HasPrefix(base, prefix) && ext != ".pub" {
			return true
		}
	}
	switch ext {
	case ".pem", ".key", ".p12", ".pfx", ".kdbx", ".jks":
		return true
	}
	if strings.Contains(base, "secret") || strings.Contains(base, "credential") {
		switch ext {
		case "", ".env", ".json", ".yaml", ".yml", ".toml", ".ini", ".conf", ".txt":
			return true
		}
	}
	return false
}

func redactFileSecrets(text string) (string, bool) {
	redacted := false
	out := text
	for _, re := range secretPatterns {
		if re.MatchString(out) {
			redacted = true
			out = re.ReplaceAllString(out, "«redacted»")
		}
	}
	return out, redacted
}

func classifyFile(path string) (kind, lang string) {
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(path)), ".")
	lang = fileLangByExt[ext]
	switch {
	case lang == "markdown":
		return "markdown", "markdown"
	case lang != "":
		return "code", lang
	default:
		return "text", ""
	}
}

func readSessionFile(id, rawPath string, lineStart, lineEnd int, cwd, repoRoot, home string) (*sessionFileReply, error) {
	cleanPath, fragStart, fragEnd, err := parseFileRequestPath(rawPath)
	if err != nil {
		return nil, err
	}
	if lineStart <= 0 && fragStart > 0 {
		lineStart = fragStart
	}
	if lineEnd <= 0 && fragEnd > 0 {
		lineEnd = fragEnd
	}
	if lineStart > 0 && lineEnd > 0 && lineEnd < lineStart {
		lineEnd = lineStart
	}

	target := cleanPath
	if !filepath.IsAbs(target) {
		baseDir := cwd
		if baseDir == "" {
			baseDir = repoRoot
		}
		if baseDir == "" {
			return nil, errors.New("relative file path requires an active session directory")
		}
		candidate := filepath.Join(baseDir, target)
		if _, statErr := os.Stat(candidate); statErr != nil && repoRoot != "" && repoRoot != baseDir {
			if alt := filepath.Join(repoRoot, target); func() bool { _, e := os.Stat(alt); return e == nil }() {
				candidate = alt
			}
		}
		target = candidate
	}

	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, errors.New("file not found")
		}
		return nil, errors.New("cannot resolve file path")
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, errors.New("file not found")
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	if isSecretFileName(resolved) {
		return nil, errors.New("refused to read a secret or credential file")
	}

	roots := sessionAllowedRoots(id, cwd, repoRoot, home)
	matched := false
	relPath := ""
	ext := strings.ToLower(filepath.Ext(resolved))
	for _, root := range roots {
		if !pathWithinRoot(resolved, root.path) {
			continue
		}
		if root.mdOnly && ext != ".md" && ext != ".markdown" {
			continue
		}
		matched = true
		if root.labelRel && relPath == "" {
			if rel, relErr := filepath.Rel(root.path, resolved); relErr == nil && !strings.HasPrefix(rel, "..") {
				relPath = filepath.ToSlash(rel)
			}
		}
	}
	if !matched {
		return nil, errors.New("file is outside this session's allowed scope")
	}

	f, err := os.Open(resolved)
	if err != nil {
		return nil, errors.New("cannot open file")
	}
	defer f.Close()

	raw, err := io.ReadAll(io.LimitReader(f, sessionFileMaxBytes+1))
	if err != nil {
		return nil, errors.New("cannot read file")
	}
	sample := raw
	if len(sample) > 8192 {
		sample = sample[:8192]
	}
	if bytes.IndexByte(sample, 0) >= 0 {
		return nil, errors.New("binary file cannot be previewed")
	}

	truncated := false
	if len(raw) > sessionFileMaxBytes {
		truncated = true
		raw = raw[:sessionFileMaxBytes]
		if nl := bytes.LastIndexByte(raw, '\n'); nl > 0 {
			raw = raw[:nl+1]
		} else {
			for len(raw) > 0 && !utf8.Valid(raw) {
				raw = raw[:len(raw)-1]
			}
		}
	}

	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	text, redacted := redactFileSecrets(text)
	kind, lang := classifyFile(resolved)
	return &sessionFileReply{
		V:          1,
		OK:         true,
		Path:       resolved,
		RelPath:    relPath,
		Name:       filepath.Base(resolved),
		Kind:       kind,
		Lang:       lang,
		Content:    text,
		Size:       info.Size(),
		TotalLines: lineCount(text),
		Truncated:  truncated,
		Redacted:   redacted,
		LineStart:  lineStart,
		LineEnd:    lineEnd,
		Mtime:      info.ModTime().UnixMilli(),
	}, nil
}

func sessionFile(args json.RawMessage) (any, error) {
	var a sessionFileArgs
	if json.Unmarshal(args, &a) != nil || !sessionIDPattern.MatchString(a.ID) {
		return nil, errors.New("invalid session id")
	}
	start := time.Now()
	active, recent, err := readAttentionDoc()
	if err != nil {
		return nil, err
	}
	entries := liveSessionsFrom(active, recent)
	cwd, repoRoot := "", ""
	if e, ok := entries[a.ID]; ok {
		if p, alive := paneInfo(e); alive && p != "" {
			cwd = p
			_, repoRoot, _ = gitRepoMeta(cwd)
		}
	} else {
		found := false
		for _, r := range recent {
			if r.SessionID == a.ID && !sessionWasClosed(a.ID) {
				found = true
				break
			}
		}
		if !found {
			return nil, errors.New("session not found (ended or not tracked)")
		}
	}
	home, _ := os.UserHomeDir()
	reply, err := readSessionFile(a.ID, a.Path, a.LineStart, a.LineEnd, cwd, repoRoot, home)
	if err != nil {
		relayLogf("session_file", "id=%s err=%q ms=%d", a.ID, err.Error(), time.Since(start).Milliseconds())
		return nil, err
	}
	relayLogf("session_file", "id=%s kind=%s bytes=%d truncated=%v redacted=%v ms=%d",
		a.ID, reply.Kind, len(reply.Content), reply.Truncated, reply.Redacted, time.Since(start).Milliseconds())
	return reply, nil
}

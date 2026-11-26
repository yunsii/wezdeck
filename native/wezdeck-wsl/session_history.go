package main

// `session.history {id}` (read): earlier Claude conversations of the same
// project, for the phone's 恢复会话 sheet — Claude's own /resume picker is a
// TUI list a phone cannot drive. The phone sends `/resume <id>` into the
// pane; the SessionStart resume hook then marks the old session cleared_to
// the resumed one and the page follows (docs/remote-sessions.md).
//
// The project is the directory of this session's transcript, or — a fresh
// session after /new has none yet — the pane's cwd in Claude's encoding
// (every non-alphanumeric becomes "-"). Newest first, at most historyMax.

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const historyMax = 30

type historyItem struct {
	ID     string `json:"id"`
	Title  string `json:"title,omitempty"`
	Prompt string `json:"prompt,omitempty"` // first human message
	At     int64  `json:"at"`               // last turn (ms)
	Open   bool   `json:"open,omitempty"`   // listed right now (a pane runs it)
}

var nonAlnum = regexp.MustCompile(`[^A-Za-z0-9]`)

func sessionHistory(args json.RawMessage) (any, error) {
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
	dir := ""
	if path, agent := findTranscript(a.ID); path != "" {
		if agent != "claude" {
			return nil, errors.New("only Claude sessions can be resumed from here")
		}
		dir = filepath.Dir(path)
	} else if _, cwd, _, _, _, alive := paneState(e); alive && cwd != "" {
		home, _ := os.UserHomeDir()
		root := filepath.Join(home, ".claude")
		for _, candidate := range []string{
			filepath.Join(home, ".config", "claude-profiles", "kimi-home"),
			filepath.Join(home, ".config", "claude-profiles", "home"),
		} {
			if matches, _ := filepath.Glob(filepath.Join(candidate, "projects", nonAlnum.ReplaceAllString(cwd, "-"), "*.jsonl")); len(matches) > 0 {
				root = candidate
				break
			}
		}
		dir = filepath.Join(root, "projects", nonAlnum.ReplaceAllString(cwd, "-"))
	}
	if dir == "" {
		return map[string]any{"v": 1, "ok": true, "sessions": []historyItem{}}, nil
	}
	return map[string]any{"v": 1, "ok": true, "sessions": projectHistory(dir, a.ID, live)}, nil
}

func projectHistory(dir, current string, live map[string]attentionEntry) []historyItem {
	paths, _ := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	items := []historyItem{}
	for _, path := range paths {
		id := strings.TrimSuffix(filepath.Base(path), ".jsonl")
		if id == current || !sessionIDPattern.MatchString(id) {
			continue
		}
		prompt := firstClaudePrompt(path)
		if prompt == "" {
			continue // never got a human message: nothing to resume
		}
		at := lastTurnAt(path, "claude")
		if at == 0 {
			if info, err := os.Stat(path); err == nil {
				at = info.ModTime().UnixMilli()
			}
		}
		_, open := live[id]
		items = append(items, historyItem{ID: id, Title: lastClaudeAITitle(path), Prompt: prompt, At: at, Open: open})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].At > items[j].At })
	if len(items) > historyMax {
		items = items[:historyMax]
	}
	return items
}

// firstClaudePrompt: the first thing a human typed (not a command, not
// harness text), from the head of the file.
func firstClaudePrompt(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for n := 0; n < 400 && scanner.Scan(); n++ {
		var line struct {
			Type    string `json:"type"`
			IsMeta  bool   `json:"isMeta"`
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(scanner.Bytes(), &line) != nil || line.Type != "user" || line.IsMeta {
			continue
		}
		var text string
		if json.Unmarshal(line.Message.Content, &text) != nil {
			var blocks []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}
			_ = json.Unmarshal(line.Message.Content, &blocks)
			for _, b := range blocks {
				if b.Type == "text" {
					text = b.Text
					break
				}
			}
		}
		text = strings.TrimSpace(unwrapPasted(text))
		if text != "" && !strings.HasPrefix(text, "<") {
			return clip(text, 160)
		}
	}
	return ""
}

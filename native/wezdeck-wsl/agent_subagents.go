package main

// Claude Code subagents (Agent tool, forked skills such as /code-review) for
// the phone: while one runs, the parent's transcript shows only a launch line,
// so the session page could not tell what was happening. Claude Code keeps
// each subagent next to the parent transcript:
//
//	<projects>/<proj>/<session>/subagents/agent-<id>.meta.json  description, type, background, finished
//	<projects>/<proj>/<session>/subagents/agent-<id>.jsonl      its own transcript
//
// subagentsOf summarises them (latest tool, call count, timing) for the
// session reply's `subagents`. Cached per file size: the page polls often.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type subagent struct {
	ID          string `json:"id"`
	Name        string `json:"name,omitempty"` // e.g. the skill name for a forked skill
	Description string `json:"description"`
	Type        string `json:"type"` // agentType: Explore, general-purpose, web-fetch …
	Background  bool   `json:"background"`
	// State: running | done | stale (not finished, but silent for a long time)
	State     string `json:"state"`
	Tools     int    `json:"tools"`               // tool calls so far
	LastTool  string `json:"last_tool,omitempty"` // "Bash go test ./…"
	StartedAt string `json:"started_at,omitempty"`
	ActiveAt  int64  `json:"active_at"` // ms, last write to its transcript
}

const (
	subagentStaleAfter = 30 * time.Minute
	subagentKeepDone   = 2 * time.Hour
	subagentsMax       = 8
)

type subagentScan struct {
	size     int64
	tools    int
	lastTool string
	started  string
}

var (
	subagentMu    sync.Mutex
	subagentCache = map[string]subagentScan{}
)

func scanSubagentTranscript(path string, size int64) subagentScan {
	subagentMu.Lock()
	if c, ok := subagentCache[path]; ok && c.size == size {
		subagentMu.Unlock()
		return c
	}
	subagentMu.Unlock()
	out := subagentScan{size: size}
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 32<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if !bytes.Contains(line, []byte(`"tool_use"`)) && out.started != "" {
			continue
		}
		var row struct {
			Type      string `json:"type"`
			Timestamp string `json:"timestamp"`
			Message   struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &row) != nil {
			continue
		}
		if out.started == "" {
			out.started = row.Timestamp
		}
		if row.Type != "assistant" {
			continue
		}
		var blocks []struct {
			Type  string         `json:"type"`
			Name  string         `json:"name"`
			Input map[string]any `json:"input"`
		}
		if json.Unmarshal(row.Message.Content, &blocks) != nil {
			continue
		}
		for _, b := range blocks {
			if b.Type == "tool_use" {
				out.tools++
				// toolSummary already leads with the tool name ("Bash go test …")
				summary := toolSummary(b.Name, b.Input)
				if summary == "" {
					summary = b.Name
				}
				out.lastTool = clip(summary, 120)
			}
		}
	}
	subagentMu.Lock()
	subagentCache[path] = out
	subagentMu.Unlock()
	return out
}

// subagentsOf lists the subagents of the Claude session whose transcript is
// at path: running ones first, then those finished within subagentKeepDone.
func subagentsOf(path string) []subagent {
	dir := filepath.Join(strings.TrimSuffix(path, ".jsonl"), "subagents")
	metas, _ := filepath.Glob(filepath.Join(dir, "agent-*.meta.json"))
	out := []subagent{}
	now := time.Now()
	for _, m := range metas {
		data, err := os.ReadFile(m)
		if err != nil {
			continue
		}
		var meta struct {
			AgentType    string `json:"agentType"`
			Description  string `json:"description"`
			Name         string `json:"name"`
			RequestShape string `json:"requestShape"`
			Finished     bool   `json:"finished"`
		}
		if json.Unmarshal(data, &meta) != nil {
			continue
		}
		id := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(m), "agent-"), ".meta.json")
		transcript := filepath.Join(dir, "agent-"+id+".jsonl")
		active := time.Time{}
		var scan subagentScan
		if info, err := os.Stat(transcript); err == nil {
			active = info.ModTime()
			scan = scanSubagentTranscript(transcript, info.Size())
		} else if info, err := os.Stat(m); err == nil {
			active = info.ModTime()
		}
		state := "running"
		switch {
		case meta.Finished:
			state = "done"
		case now.Sub(active) > subagentStaleAfter:
			state = "stale"
		}
		if state != "running" && now.Sub(active) > subagentKeepDone {
			continue
		}
		out = append(out, subagent{
			ID: id, Name: meta.Name, Description: clip(meta.Description, 120), Type: meta.AgentType,
			Background: meta.RequestShape == "background", State: state,
			Tools: scan.tools, LastTool: scan.lastTool, StartedAt: scan.started,
			ActiveAt: active.UnixMilli(),
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if (out[i].State == "running") != (out[j].State == "running") {
			return out[i].State == "running"
		}
		return out[i].ActiveAt > out[j].ActiveAt
	})
	if len(out) > subagentsMax {
		out = out[:subagentsMax]
	}
	return out
}

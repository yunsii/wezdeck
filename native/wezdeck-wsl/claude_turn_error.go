package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"sync"
)

type claudeTurnEnd struct {
	size     int64
	at       int64
	apiError bool
}

var (
	claudeTurnEndMu sync.Mutex
	claudeTurnEnds  = map[string]claudeTurnEnd{}
)

// Claude may write an API error and return to its prompt without firing Stop
// or idle_prompt. The latest conversation event is enough to settle that turn.
func claudeTurnAPIErrorAt(path string, turnStarted int64) int64 {
	if path == "" || turnStarted <= 0 {
		return 0
	}
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	claudeTurnEndMu.Lock()
	state, ok := claudeTurnEnds[path]
	claudeTurnEndMu.Unlock()
	if !ok || state.size != info.Size() {
		state = scanClaudeTurnEnd(path, info.Size())
		claudeTurnEndMu.Lock()
		claudeTurnEnds[path] = state
		claudeTurnEndMu.Unlock()
	}
	if state.apiError && state.at >= turnStarted {
		return state.at
	}
	return 0
}

func scanClaudeTurnEnd(path string, size int64) claudeTurnEnd {
	result := claudeTurnEnd{size: size}
	f, err := os.Open(path)
	if err != nil {
		return result
	}
	defer f.Close()
	start := size - turnTail
	if start < 0 {
		start = 0
	}
	buf := make([]byte, size-start)
	if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
		return result
	}
	lines := bytes.Split(buf, []byte("\n"))
	if start > 0 {
		lines = lines[1:]
	}
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if !bytes.Contains(line, []byte(`"timestamp"`)) ||
			(!bytes.Contains(line, []byte(`"type":"user"`)) && !bytes.Contains(line, []byte(`"type":"assistant"`))) {
			continue
		}
		var row struct {
			Type              string `json:"type"`
			Timestamp         string `json:"timestamp"`
			IsMeta            bool   `json:"isMeta"`
			IsAPIErrorMessage bool   `json:"isApiErrorMessage"`
			Message           struct {
				Model   string          `json:"model"`
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &row) != nil || row.IsMeta || (row.Type != "user" && row.Type != "assistant") {
			continue
		}
		at, valid := parseTranscriptMS(row.Timestamp)
		if !valid {
			continue
		}
		result.at = at
		result.apiError = row.Type == "assistant" && claudeAPIErrorText(row.IsAPIErrorMessage, row.Message.Model, claudeMessageText(row.Message.Content)) != ""
		return result
	}
	return result
}

func settleClaudeAPIError(e attentionEntry, path, agent string) attentionEntry {
	if agent == "claude" && e.busy() {
		if at := claudeTurnAPIErrorAt(path, e.TurnStarted); at > 0 {
			e.Status = "done"
			e.RunningKind = ""
			e.TS = at
		}
	}
	return e
}

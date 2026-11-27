package main

// Unified Web Push watcher (`push_watcher.go`):
// Observes `attention.json` (agent sessions) and `~/.agent/tickets/events.jsonl`
// (collab tickets) for edge transitions and emits privacy-safe `push.emit`
// frames to the HostRelay Durable Object.
//
// Privacy invariant: NEVER include prompt text, tool commands, code diffs,
// file paths, or error stack traces in push payloads — only clipped titles
// (<= 60 runes), repo names, status labels, relative URLs, and badge counts.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const (
	pushPollInterval   = 2 * time.Second
	pushDeskActiveSecs = 15
	pushLongTurnMinS   = 60
)

type pushEmitFrame struct {
	T            string `json:"t"`
	EventID      string `json:"event_id"`
	Kind         string `json:"kind"`
	Tag          string `json:"tag"`
	URL          string `json:"url"`
	TargetPath   string `json:"target_path,omitempty"`
	Title        string `json:"title"`
	Body         string `json:"body"`
	Badge        int    `json:"badge"`
	Silent       bool   `json:"silent,omitempty"`
	DeskActive   bool   `json:"desk_active,omitempty"`
	TurnElapsedS int    `json:"turn_elapsed_s,omitempty"`
}

type seenSessionState struct {
	Status        string
	WaitingKind   string
	TurnStartedMS int64
	TicketID      string
}

type pushWatcher struct {
	seeded       bool
	sessions     map[string]seenSessionState
	lastAttMod   int64
	lastAttSize  int64
	eventsOffset int64
	eventsSeeded bool
	lastBadge    int
	seq          int64
	emit         func(pushEmitFrame)
	deskActiveFn func() bool
}

func newPushWatcher(emit func(pushEmitFrame)) *pushWatcher {
	return &pushWatcher{
		sessions:     map[string]seenSessionState{},
		lastBadge:    -1,
		emit:         emit,
		deskActiveFn: isDeskRecentlyActive,
	}
}

func (r *relay) runPushWatcher(ctx context.Context) {
	w := newPushWatcher(func(frame pushEmitFrame) {
		r.sendPush(frame)
	})
	w.tick()
	ticker := time.NewTicker(pushPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.tick()
		}
	}
}

func (r *relay) sendPush(frame pushEmitFrame) {
	r.mu.Lock()
	conn := r.conn
	r.mu.Unlock()
	if conn == nil {
		return
	}
	body, err := json.Marshal(frame)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r.wmu.Lock()
	werr := conn.Write(ctx, websocket.MessageText, body)
	r.wmu.Unlock()
	r.logf("push_emit", "kind=%s tag=%s badge=%d silent=%t desk_active=%t err=%q",
		frame.Kind, frame.Tag, frame.Badge, frame.Silent, frame.DeskActive, errText(werr))
}

func (w *pushWatcher) nextEventID(prefix string) string {
	w.seq++
	return fmt.Sprintf("%s-%d-%d", prefix, time.Now().Unix(), w.seq)
}

func (w *pushWatcher) tick() {
	attPath := attentionFile()
	eventsPath := filepath.Join(ticketsRootDir(), "events.jsonl")
	w.pollAttention(attPath)
	w.pollTicketEvents(eventsPath)
}

func (w *pushWatcher) pollAttention(path string) {
	st, err := os.Stat(path)
	if err != nil {
		return
	}
	mod := st.ModTime().UnixNano()
	if w.seeded && mod == w.lastAttMod && st.Size() == w.lastAttSize {
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var doc struct {
		Entries map[string]struct {
			SessionID    string `json:"session_id"`
			Status       string `json:"status"`
			WaitingKind  string `json:"waiting_kind"`
			Repo         string `json:"repo"`
			AgentName    string `json:"agent_name"`
			TicketID     string `json:"ticket_id"`
			TS           int64  `json:"ts"`
			TurnStarted  int64  `json:"turn_started"`
			CustomTitle  string `json:"custom_title"`
			DisplayTitle string `json:"title"`
		} `json:"entries"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return
	}
	w.lastAttMod = mod
	w.lastAttSize = st.Size()

	waitingCount := 0
	for _, e := range doc.Entries {
		if e.Status == "waiting" {
			waitingCount++
		}
	}

	if !w.seeded {
		for id, e := range doc.Entries {
			w.sessions[id] = seenSessionState{
				Status:        e.Status,
				WaitingKind:   e.WaitingKind,
				TurnStartedMS: e.TurnStarted,
				TicketID:      e.TicketID,
			}
		}
		w.lastBadge = waitingCount
		w.seeded = true
		return
	}

	deskActive := w.deskActiveFn()
	emitted := false

	for id, e := range doc.Entries {
		prev, had := w.sessions[id]
		w.sessions[id] = seenSessionState{
			Status:        e.Status,
			WaitingKind:   e.WaitingKind,
			TurnStartedMS: e.TurnStarted,
			TicketID:      e.TicketID,
		}
		title := clipPushTitle(firstNonEmpty(e.DisplayTitle, e.CustomTitle, e.Repo, e.AgentName, "会话"))
		repo := strings.TrimSpace(e.Repo)

		// Edge 1: entered waiting state
		if e.Status == "waiting" && (!had || prev.Status != "waiting" || prev.WaitingKind != e.WaitingKind) {
			kind := "session_waiting"
			tag := "session:" + id
			targetPath := "/console/sessions/" + id
			pushTitle := "需要确认 · " + title
			pushBody := waitingKindLabel(e.WaitingKind)
			if repo != "" {
				pushBody += " · " + repo
			}
			// Dedup layer 1: manager session for a ticket routes to ticket deep link.
			if e.TicketID != "" {
				kind = "ticket_waiting"
				tag = "ticket:" + e.TicketID
				targetPath = "/console/collab/" + e.TicketID
				pushTitle = "工单等你回复 · " + title
			}
			w.emit(pushEmitFrame{
				T:          "push.emit",
				EventID:    w.nextEventID("att"),
				Kind:       kind,
				Tag:        tag,
				URL:        targetPath,
				TargetPath: targetPath,
				Title:      pushTitle,
				Body:       pushBody,
				Badge:      waitingCount,
				DeskActive: deskActive,
			})
			emitted = true
			continue
		}

		// Edge 2: transitioned from running to done after a long turn (>= 60s)
		if e.Status == "done" && had && prev.Status == "running" {
			startMS := prev.TurnStartedMS
			if startMS <= 0 {
				startMS = e.TurnStarted
			}
			elapsedS := 0
			if startMS > 0 {
				endMS := e.TS
				if endMS <= 0 {
					endMS = time.Now().UnixMilli()
				}
				if endMS > startMS {
					elapsedS = int((endMS - startMS) / 1000)
				}
			}
			if elapsedS >= pushLongTurnMinS {
				bodyParts := []string{}
				if e.AgentName != "" {
					bodyParts = append(bodyParts, e.AgentName)
				}
				bodyParts = append(bodyParts, "用时 "+formatPushDuration(elapsedS))
				if repo != "" {
					bodyParts = append(bodyParts, repo)
				}
				targetPath := "/console/sessions/" + id
				w.emit(pushEmitFrame{
					T:            "push.emit",
					EventID:      w.nextEventID("done"),
					Kind:         "session_done",
					Tag:          "session:" + id,
					URL:          targetPath,
					TargetPath:   targetPath,
					Title:        "已完成 · " + title,
					Body:         strings.Join(bodyParts, " · "),
					Badge:        waitingCount,
					DeskActive:   deskActive,
					TurnElapsedS: elapsedS,
				})
				emitted = true
			}
		}
	}

	// Prune vanished entries
	for id := range w.sessions {
		if _, ok := doc.Entries[id]; !ok {
			delete(w.sessions, id)
		}
	}

	// Sync app badge silently when waiting count drops (e.g. cleared at desk)
	if !emitted && w.lastBadge >= 0 && waitingCount != w.lastBadge {
		w.emit(pushEmitFrame{
			T:       "push.emit",
			EventID: w.nextEventID("badge"),
			Kind:    "badge",
			Tag:     "wezdeck:badge",
			URL:     "/console/sessions",
			Title:   "WezDeck",
			Body:    "",
			Badge:   waitingCount,
			Silent:  true,
		})
	}
	w.lastBadge = waitingCount
}

func (w *pushWatcher) pollTicketEvents(path string) {
	st, err := os.Stat(path)
	if err != nil {
		return
	}
	// On startup, jump straight to EOF so relay restarts never replay old events.
	if !w.eventsSeeded {
		w.eventsOffset = st.Size()
		w.eventsSeeded = true
		return
	}
	if st.Size() < w.eventsOffset {
		w.eventsOffset = 0
	}
	if st.Size() == w.eventsOffset {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	buf := make([]byte, st.Size()-w.eventsOffset)
	n, err := f.ReadAt(buf, w.eventsOffset)
	if err != nil && n == 0 {
		return
	}
	buf = buf[:n]
	end := bytes.LastIndexByte(buf, '\n')
	if end < 0 {
		return
	}
	w.eventsOffset += int64(end + 1)
	deskActive := w.deskActiveFn()

	sc := bufio.NewScanner(bytes.NewReader(buf[:end+1]))
	sc.Buffer(make([]byte, 64<<10), 2<<20)
	for sc.Scan() {
		var ev struct {
			Kind     string `json:"kind"`
			Ticket   string `json:"ticket"`
			Status   string `json:"status"`
			To       string `json:"to"`
			Count    int    `json:"count"`
			Conflict bool   `json:"conflict"`
			Passed   *bool  `json:"passed"`
		}
		if json.Unmarshal(sc.Bytes(), &ev) != nil || ev.Ticket == "" {
			continue
		}
		kind, titlePrefix, body := classifyTicketPushEvent(ev.Kind, ev.Status, ev.To, ev.Count, ev.Conflict, ev.Passed)
		if kind == "" {
			continue
		}
		tTitle := clipPushTitle(ticketDisplayTitle(ev.Ticket))
		targetPath := "/console/collab/" + ev.Ticket
		w.emit(pushEmitFrame{
			T:          "push.emit",
			EventID:    w.nextEventID("tkt"),
			Kind:       kind,
			Tag:        "ticket:" + ev.Ticket,
			URL:        targetPath,
			TargetPath: targetPath,
			Title:      titlePrefix + " · " + tTitle,
			Body:       body,
			Badge:      max(w.lastBadge, 1),
			DeskActive: deskActive,
		})
	}
}

func classifyTicketPushEvent(evKind, status, repo string, count int, conflict bool, passed *bool) (kind, titlePrefix, body string) {
	switch evKind {
	case "proposal_created":
		if count > 0 {
			return "ticket_proposal", "待批拆单", fmt.Sprintf("建议拆分为 %d 个子工单，等你确认", count)
		}
		return "ticket_proposal", "待批拆单", "拆单提案已生成，等你确认"
	case "challenge":
		return "ticket_waiting", "工单等你回复", joinNonEmpty(" · ", repo, "等待你的决定")
	case "status":
		switch status {
		case "waiting_initiator":
			return "ticket_waiting", "工单等你回复", joinNonEmpty(" · ", repo, "等待你的决定")
		case "failed":
			return "ticket_error", "工单异常", joinNonEmpty(" · ", repo, "执行失败")
		}
	case "merge":
		if conflict {
			return "ticket_error", "工单异常", joinNonEmpty(" · ", repo, "合并冲突")
		}
	case "error":
		return "ticket_error", "工单异常", joinNonEmpty(" · ", repo, "运行异常")
	case "verify_failed":
		return "ticket_error", "工单异常", joinNonEmpty(" · ", repo, "验收未通过")
	case "verify_done", "verify_passed":
		if passed == nil || *passed {
			return "ticket_verify", "工单待验收交付", joinNonEmpty(" · ", repo, "集成验证通过，等你确认交付")
		}
		return "ticket_error", "工单异常", joinNonEmpty(" · ", repo, "验收未通过")
	}
	return "", "", ""
}

func ticketDisplayTitle(tid string) string {
	raw, err := os.ReadFile(filepath.Join(ticketsRootDir(), "_data", tid, "ticket.md"))
	if err != nil {
		return tid
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "title:") {
			val := strings.TrimSpace(strings.TrimPrefix(line, "title:"))
			val = strings.Trim(val, `"'`)
			if val != "" {
				return val
			}
		}
		if strings.HasPrefix(line, "## ") {
			break
		}
	}
	return tid
}

func waitingKindLabel(kind string) string {
	switch kind {
	case "permission_prompt":
		return "权限审批"
	case "plan_approval":
		return "计划待确认"
	case "elicitation", "ask_user_question":
		return "提问等你回复"
	default:
		return "等你确认"
	}
}

func clipPushTitle(s string) string {
	s = strings.TrimSpace(s)
	runes := []rune(s)
	if len(runes) <= 60 {
		return s
	}
	return string(runes[:59]) + "…"
}

func formatPushDuration(sec int) string {
	if sec < 60 {
		return fmt.Sprintf("%ds", sec)
	}
	m := sec / 60
	s := sec % 60
	if s == 0 {
		return fmt.Sprintf("%dm", m)
	}
	return fmt.Sprintf("%dm %ds", m, s)
}

func joinNonEmpty(sep string, parts ...string) string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if s := strings.TrimSpace(p); s != "" {
			out = append(out, s)
		}
	}
	return strings.Join(out, sep)
}

func isDeskRecentlyActive() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tmux", "list-clients", "-F", "#{client_activity}").Output()
	if err != nil {
		return false
	}
	now := time.Now().Unix()
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		ts, perr := strconv.ParseInt(strings.TrimSpace(line), 10, 64)
		if perr == nil && ts > 0 && now-ts < pushDeskActiveSecs {
			return true
		}
	}
	return false
}

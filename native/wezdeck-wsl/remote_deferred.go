package main

// Messages held on the host until the current agent turn finishes. This is
// separate from sent-messages.json: a deferred item has not reached the TUI.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type deferredMessage struct {
	ID          string   `json:"id"`
	ClientOp    string   `json:"client_op"`
	SessionID   string   `json:"session_id"`
	Pane        string   `json:"pane"`
	Worktree    string   `json:"worktree"`
	Text        string   `json:"text"`
	Attachments []string `json:"attachments,omitempty"`
	Policy      string   `json:"policy"` // after_turn | after_review
	Status      string   `json:"status"` // queued | waiting_review | releasing | failed | sent | canceled | stale
	CreatedAt   int64    `json:"created_at"`
	ArmedAt     int64    `json:"armed_at,omitempty"`
	ReleaseAt   int64    `json:"release_at,omitempty"`
	RetryAt     int64    `json:"retry_at,omitempty"`
	Error       string   `json:"error,omitempty"`
}

type deferredStore struct {
	Version int               `json:"v"`
	Items   []deferredMessage `json:"items"`
}

var deferredMu sync.Mutex
var deferredRetryPattern = regexp.MustCompile(`retry in (\d+)s`)

func deferredFile() string {
	if p := os.Getenv("WEZDECK_DEFERRED_MESSAGES"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "state", "wezdeck", "deferred-messages.json")
}

func withDeferredStore(change func(*deferredStore) error) error {
	deferredMu.Lock()
	defer deferredMu.Unlock()
	path := deferredFile()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	s, err := readDeferredStore()
	if err != nil {
		return err
	}
	if err := change(&s); err != nil {
		return err
	}
	s.Version = 1
	cutoff := time.Now().Add(-30 * 24 * time.Hour).UnixMilli()
	kept := s.Items[:0]
	for _, item := range s.Items {
		if item.CreatedAt < cutoff && (item.Status == "sent" || item.Status == "canceled") {
			continue
		}
		kept = append(kept, item)
	}
	s.Items = kept
	if len(s.Items) > 500 {
		for i := 0; i < len(s.Items) && len(s.Items) > 500; {
			if s.Items[i].Status == "sent" || s.Items[i].Status == "canceled" {
				s.Items = append(s.Items[:i], s.Items[i+1:]...)
				continue
			}
			i++
		}
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".deferred-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func readDeferredStore() (deferredStore, error) {
	data, err := os.ReadFile(deferredFile())
	if os.IsNotExist(err) {
		return deferredStore{Version: 1}, nil
	}
	if err != nil {
		return deferredStore{}, err
	}
	var s deferredStore
	if err := json.Unmarshal(data, &s); err != nil {
		return deferredStore{}, fmt.Errorf("deferred queue is invalid: %w", err)
	}
	return s, nil
}

func deferredSnapshotForSession(id string) ([]deferredMessage, error) {
	s, err := readDeferredStore()
	if err != nil {
		return nil, err
	}
	out := make([]deferredMessage, 0)
	for _, item := range s.Items {
		if item.SessionID == id && item.Status != "sent" && item.Status != "canceled" {
			out = append(out, item)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out, nil
}

func deferredSnapshotWithReplaced(id string, previousIDs []string) ([]deferredMessage, error) {
	s, err := readDeferredStore()
	if err != nil {
		return nil, err
	}
	previous := make(map[string]bool, len(previousIDs))
	for _, previousID := range previousIDs {
		previous[previousID] = true
	}
	current := make([]deferredMessage, 0)
	for _, item := range s.Items {
		if item.Status == "sent" || item.Status == "canceled" ||
			(item.SessionID != id && !previous[item.SessionID]) {
			continue
		}
		if previous[item.SessionID] {
			item.Status = "stale"
			item.Error = "session was replaced; edit or remove this message"
		}
		current = append(current, item)
	}
	sort.SliceStable(current, func(i, j int) bool { return current[i].CreatedAt < current[j].CreatedAt })
	return current, nil
}

func deferredPredecessors(id string, e attentionEntry, recent []recentEntry) []string {
	seen := map[string]bool{id: true}
	previous := make([]string, 0)
	target := id
	for len(previous) < 20 {
		found := ""
		if target == id && e.ReplacedFrom != "" {
			found = e.ReplacedFrom
		} else {
			for _, r := range recent {
				if r.ClearedTo == target && r.TmuxPane == e.TmuxPane && r.TmuxSocket == e.TmuxSocket {
					found = r.SessionID
					break
				}
			}
		}
		if found == "" || seen[found] {
			break
		}
		seen[found] = true
		previous = append(previous, found)
		target = found
	}
	return previous
}

func openDeferredForSession(id string) []deferredMessage {
	items, err := deferredSnapshotForSession(id)
	if err != nil {
		relayLogf("deferred_read", "session=%s err=%q", id, errText(err))
		return []deferredMessage{}
	}
	return items
}

func enqueueDeferredMessage(args json.RawMessage, via, device, clientOp string) (any, error) {
	var a struct {
		ID          string   `json:"id"`
		Text        string   `json:"text"`
		Attachments []string `json:"attachments"`
		Policy      string   `json:"policy"`
	}
	if json.Unmarshal(args, &a) != nil || !sessionIDPattern.MatchString(a.ID) ||
		len(a.Text) > 20000 || (strings.TrimSpace(a.Text) == "" && len(a.Attachments) == 0) ||
		(a.Policy != "after_turn" && a.Policy != "after_review") || clientOp == "" || isSlashCommand(a.Text) {
		return nil, errors.New("invalid deferred message")
	}
	if _, err := attachmentNote(a.Attachments); err != nil {
		return nil, err
	}
	entries, err := liveSessions()
	if err != nil {
		return nil, err
	}
	e, ok := entries[a.ID]
	if !ok {
		return nil, errors.New("session not found")
	}
	_, _, _, _, _, alive := paneState(e)
	if !alive {
		return nil, errors.New("session pane is gone")
	}
	_, _, worktree := sessionRepoMeta(e)
	if worktree == "" {
		return nil, errors.New("session worktree is unavailable")
	}
	item := deferredMessage{
		ID: newSentID(), ClientOp: clientOp, SessionID: a.ID, Pane: e.TmuxPane,
		Worktree: worktree, Text: strings.TrimSpace(a.Text), Attachments: a.Attachments,
		Policy: a.Policy, Status: "queued", CreatedAt: time.Now().UnixMilli(),
	}
	if e.busy() {
		item.ArmedAt = e.TS
	}
	err = withDeferredStore(func(s *deferredStore) error {
		for _, existing := range s.Items {
			if existing.ClientOp == clientOp {
				if existing.SessionID != a.ID || existing.Text != strings.TrimSpace(a.Text) || existing.Policy != a.Policy {
					return errors.New("client operation belongs to another deferred message")
				}
				item = existing
				return nil
			}
		}
		active := 0
		for _, existing := range s.Items {
			if existing.Status != "sent" && existing.Status != "canceled" {
				active++
			}
		}
		if active >= 200 {
			return errors.New("deferred queue is full")
		}
		s.Items = append(s.Items, item)
		return nil
	})
	if err != nil {
		return nil, err
	}
	relayLogf("deferred_enqueue", "id=%s session=%s op_id=%s policy=%s chars=%d attachments=%d via=%s device=%s", item.ID, item.SessionID, clientOp, item.Policy, len([]rune(item.Text)), len(item.Attachments), via, device)
	return map[string]any{"v": 1, "ok": true, "item": item}, nil
}

func changeDeferredMessage(args json.RawMessage, action string) (any, error) {
	var a struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(args, &a) != nil || !strings.HasPrefix(a.ID, "sent-") {
		return nil, errors.New("invalid deferred id")
	}
	var item deferredMessage
	closed := false
	var alreadyReleasing = errors.New("deferred message is already releasing")
	err := withDeferredStore(func(s *deferredStore) error {
		for i := range s.Items {
			if s.Items[i].ID != a.ID {
				continue
			}
			if (action == "release" && s.Items[i].Status == "sent") ||
				(action == "cancel" && s.Items[i].Status == "canceled") {
				item = s.Items[i]
				closed = true
				return nil
			}
			if s.Items[i].Status == "sent" || s.Items[i].Status == "canceled" {
				return errors.New("deferred message is already closed")
			}
			if action == "cancel" && s.Items[i].Status == "releasing" {
				return errors.New("deferred message is already releasing")
			}
			if action == "cancel" {
				s.Items[i].Status = "canceled"
			} else if s.Items[i].Status == "releasing" && time.Now().UnixMilli()-s.Items[i].ReleaseAt < 30_000 {
				return alreadyReleasing
			} else {
				s.Items[i].Status = "releasing"
				s.Items[i].ReleaseAt = time.Now().UnixMilli()
				s.Items[i].RetryAt = 0
			}
			item = s.Items[i]
			if action == "release" {
				for j := range s.Items {
					if s.Items[j].SessionID == item.SessionID && s.Items[j].ID != item.ID && s.Items[j].Status == "queued" {
						s.Items[j].ArmedAt = 0
					}
				}
			}
			return nil
		}
		return errors.New("deferred message not found")
	})
	if errors.Is(err, alreadyReleasing) && action == "release" {
		return map[string]any{"v": 1, "ok": true, "in_progress": true}, nil
	}
	if err != nil {
		return nil, err
	}
	if closed {
		return map[string]any{"v": 1, "ok": true, "deduped": true}, nil
	}
	if action == "cancel" {
		relayLogf("deferred_cancel", "id=%s session=%s", item.ID, item.SessionID)
		return map[string]any{"v": 1, "ok": true}, nil
	}
	return deliverDeferredMessage(item)
}

func deliverDeferredMessage(item deferredMessage) (any, error) {
	entries, err := liveSessions()
	if err == nil {
		e, ok := entries[item.SessionID]
		if !ok || e.TmuxPane != item.Pane {
			err = errors.New("session or pane changed")
		} else if _, _, worktree := sessionRepoMeta(e); worktree != item.Worktree {
			err = errors.New("session worktree changed")
		}
	}
	if err != nil {
		_ = setDeferredResult(item.ID, "stale", err)
		return nil, err
	}
	args, _ := json.Marshal(map[string]any{
		"id": item.SessionID, "text": item.Text, "attachments": item.Attachments,
		"client_op": item.ClientOp,
	})
	result, err := sendToSessionWithMeta(args, "deferred", "host", item.ClientOp)
	if err != nil {
		status := "failed"
		if strings.Contains(err.Error(), "retry in ") || strings.Contains(err.Error(), "asking for a confirmation") {
			status = "queued"
		}
		_ = setDeferredResult(item.ID, status, err)
		return nil, err
	}
	if err := setDeferredResult(item.ID, "sent", nil); err != nil {
		return nil, err
	}
	return result, nil
}

func setDeferredResult(id, status string, cause error) error {
	err := withDeferredStore(func(s *deferredStore) error {
		for i := range s.Items {
			if s.Items[i].ID == id && s.Items[i].Status == "releasing" {
				s.Items[i].Status = status
				s.Items[i].Error = clip(errText(cause), 300)
				if status == "queued" {
					retrySeconds := 5
					if match := deferredRetryPattern.FindStringSubmatch(errText(cause)); len(match) == 2 {
						if n, err := strconv.Atoi(match[1]); err == nil {
							retrySeconds = n
						}
					}
					if retrySeconds < 2 {
						retrySeconds = 2
					}
					s.Items[i].RetryAt = time.Now().Add(time.Duration(retrySeconds) * time.Second).UnixMilli()
				}
				break
			}
		}
		return nil
	})
	relayLogf("deferred_release", "id=%s status=%s err=%q persist_err=%q", id, status, errText(cause), errText(err))
	return err
}

func processDeferredSession(e attentionEntry) {
	processDeferredSessionWith(e, func(item deferredMessage) {
		_, _ = changeDeferredMessage(json.RawMessage(fmt.Sprintf(`{"id":%q}`, item.ID)), "release")
	})
}

func processDeferredSessionWith(e attentionEntry, release func(deferredMessage)) {
	items := openDeferredForSession(e.SessionID)
	if len(items) == 0 {
		return
	}
	if e.busy() {
		needsArm := false
		for _, item := range items {
			needsArm = needsArm || (item.Status == "queued" && item.ArmedAt == 0)
		}
		if !needsArm {
			return
		}
		if err := withDeferredStore(func(s *deferredStore) error {
			for i := range s.Items {
				if s.Items[i].SessionID == e.SessionID && s.Items[i].Status == "queued" && s.Items[i].ArmedAt == 0 {
					s.Items[i].ArmedAt = e.TS
				}
			}
			return nil
		}); err != nil {
			relayLogf("deferred_arm", "session=%s err=%q", e.SessionID, errText(err))
		}
		return
	}
	if e.Status != "done" || e.WaitingKind != "" {
		return
	}
	first := items[0]
	if first.RetryAt > time.Now().UnixMilli() {
		return
	}
	if first.Status == "releasing" && time.Now().UnixMilli()-first.ReleaseAt < 30_000 {
		return
	}
	if first.ArmedAt == 0 && e.TurnStarted > first.CreatedAt {
		first.ArmedAt = e.TurnStarted
		if err := withDeferredStore(func(s *deferredStore) error {
			for i := range s.Items {
				if s.Items[i].ID == first.ID && s.Items[i].ArmedAt == 0 {
					s.Items[i].ArmedAt = first.ArmedAt
				}
			}
			return nil
		}); err != nil {
			relayLogf("deferred_arm", "session=%s err=%q", e.SessionID, errText(err))
			return
		}
	}
	if first.ArmedAt == 0 || e.TS <= first.ArmedAt {
		return
	}
	if first.Policy == "after_review" && first.Status == "queued" {
		if err := withDeferredStore(func(s *deferredStore) error {
			for i := range s.Items {
				item := &s.Items[i]
				if item.ID == first.ID {
					item.Status = "waiting_review"
				} else if item.SessionID == e.SessionID && item.Status == "queued" {
					item.ArmedAt = 0
				}
			}
			return nil
		}); err != nil {
			relayLogf("deferred_review", "session=%s err=%q", e.SessionID, errText(err))
			return
		}
		relayLogf("deferred_review", "id=%s session=%s", first.ID, e.SessionID)
		return
	}
	if first.Status == "queued" || first.Status == "releasing" {
		if err := withDeferredStore(func(s *deferredStore) error {
			for i := range s.Items {
				if s.Items[i].SessionID == e.SessionID && s.Items[i].ID != first.ID && s.Items[i].Status == "queued" {
					s.Items[i].ArmedAt = 0
				}
			}
			return nil
		}); err != nil {
			relayLogf("deferred_release", "session=%s err=%q", e.SessionID, errText(err))
			return
		}
		release(first)
	}
}

func runDeferredWatcher(ctxDone <-chan struct{}) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctxDone:
			return
		case <-ticker.C:
			s, err := readDeferredStore()
			if err != nil {
				continue
			}
			open := false
			for _, item := range s.Items {
				if item.Status == "queued" || item.Status == "releasing" {
					open = true
					break
				}
			}
			if !open {
				continue
			}
			entries, recent, err := readAttentionDoc()
			if err != nil {
				continue
			}
			candidate := map[string]bool{}
			for _, item := range s.Items {
				if item.Status == "queued" || item.Status == "releasing" {
					candidate[item.SessionID] = true
				}
			}
			for id, e := range entries {
				if candidate[id] {
					e.SessionID = id
					processDeferredSession(e)
				}
			}
			for _, r := range recent {
				if !candidate[r.SessionID] || r.LastStatus != "done" {
					continue
				}
				if _, active := entries[r.SessionID]; active {
					continue
				}
				e := r.attentionEntry
				e.Status = "done"
				e.TS = r.ArchivedTS
				processDeferredSession(e)
			}
		}
	}
}

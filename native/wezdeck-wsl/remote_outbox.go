package main

// Host-side sent message outbox (Phase 1): persists every message accepted by
// `send` / `session.new` in `~/.local/state/wezdeck/sent-messages.json` (0600,
// flock + atomic rename) so web-sent text and attachments survive page reloads,
// device switches, and TUI paste desyncs. `client_op` deduplicates retries;
// `reconcileSessionOutbox` matches pending records against the session's parsed
// transcript and returns unsettled records on `session` polls.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	outboxMaxRecords         = 500
	outboxKeep               = 30 * 24 * time.Hour
	outboxUnconfirmedAfterMs = 60_000
)

type sentRecord struct {
	ID                  string   `json:"id"`
	ClientOp            string   `json:"client_op,omitempty"`
	Kind                string   `json:"kind"` // message | session_new
	SessionID           string   `json:"session_id,omitempty"`
	RepoKey             string   `json:"repo_key,omitempty"`
	RepoLabel           string   `json:"repo_label,omitempty"`
	Worktree            string   `json:"worktree,omitempty"`
	Agent               string   `json:"agent,omitempty"`
	Pane                string   `json:"pane,omitempty"`
	Text                string   `json:"text"`
	Attachments         []string `json:"attachments,omitempty"`
	Via                 string   `json:"via,omitempty"`
	Device              string   `json:"device,omitempty"`
	CreatedAt           int64    `json:"created_at"` // ms
	Status              string   `json:"status"`     // pasting | pending | confirmed | unconfirmed | failed | dismissed
	Error               string   `json:"error,omitempty"`
	TranscriptEndAtSend int      `json:"transcript_end_at_send"`
	ConfirmedAt         int64    `json:"confirmed_at,omitempty"`
	ConfirmedMsgIndex   *int     `json:"confirmed_msg_index,omitempty"`
}

type outboxStore struct {
	Version int          `json:"v"`
	Items   []sentRecord `json:"items"`
}

var (
	outboxMu       sync.Mutex
	outboxCacheMu  sync.Mutex
	outboxCached   outboxStore
	outboxCacheKey struct {
		path    string
		modTime time.Time
		size    int64
		valid   bool
	}
	slashCommandPattern = regexp.MustCompile(`^/[a-zA-Z][\w:-]*(?:\s|$)`)
)

func isSlashCommand(text string) bool {
	return slashCommandPattern.MatchString(strings.TrimSpace(text))
}

func outboxFile() string {
	if p := os.Getenv("WEZDECK_SENT_MESSAGES"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "state", "wezdeck", "sent-messages.json")
}

// lockOutbox serializes read-modify-write across both `relay` and `serve`
// processes on the host.
func lockOutbox() func() {
	outboxMu.Lock()
	path := outboxFile() + ".lock"
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return func() { outboxMu.Unlock() }
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_EX)
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
		outboxMu.Unlock()
	}
}

func loadOutboxDisk() outboxStore {
	path := outboxFile()
	data, err := os.ReadFile(path)
	if err != nil {
		return outboxStore{Version: 1}
	}
	var s outboxStore
	if json.Unmarshal(data, &s) != nil {
		return outboxStore{Version: 1}
	}
	if s.Version == 0 {
		s.Version = 1
	}
	return s
}

func cloneOutboxStore(s outboxStore) outboxStore {
	out := outboxStore{Version: s.Version, Items: make([]sentRecord, len(s.Items))}
	for i, rec := range s.Items {
		if len(rec.Attachments) > 0 {
			rec.Attachments = append([]string(nil), rec.Attachments...)
		}
		if rec.ConfirmedMsgIndex != nil {
			idx := *rec.ConfirmedMsgIndex
			rec.ConfirmedMsgIndex = &idx
		}
		out.Items[i] = rec
	}
	return out
}

// readOutboxCached returns a snapshot of the outbox, reloading from disk only
// when the file's mtime/size changes — fast enough for the 1 s `session` poll.
func readOutboxCached() outboxStore {
	path := outboxFile()
	info, err := os.Stat(path)
	outboxCacheMu.Lock()
	defer outboxCacheMu.Unlock()
	if err != nil {
		if os.IsNotExist(err) {
			outboxCached = outboxStore{Version: 1}
			outboxCacheKey.path = path
			outboxCacheKey.valid = false
		}
		return outboxStore{Version: 1}
	}
	if outboxCacheKey.valid &&
		outboxCacheKey.path == path &&
		outboxCacheKey.modTime.Equal(info.ModTime()) &&
		outboxCacheKey.size == info.Size() {
		return cloneOutboxStore(outboxCached)
	}
	s := loadOutboxDisk()
	outboxCached = s
	outboxCacheKey.path = path
	outboxCacheKey.modTime = info.ModTime()
	outboxCacheKey.size = info.Size()
	outboxCacheKey.valid = true
	return cloneOutboxStore(s)
}

func pruneOutboxItems(items []sentRecord, nowMs int64) []sentRecord {
	cutoff := nowMs - outboxKeep.Milliseconds()
	kept := make([]sentRecord, 0, len(items))
	for _, rec := range items {
		if rec.CreatedAt > 0 && rec.CreatedAt < cutoff {
			continue
		}
		kept = append(kept, rec)
	}
	if len(kept) > outboxMaxRecords {
		kept = kept[:outboxMaxRecords]
	}
	return kept
}

func saveOutboxLocked(s outboxStore) error {
	path := outboxFile()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	s.Version = 1
	s.Items = pruneOutboxItems(s.Items, time.Now().UnixMilli())
	body, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp." + strconv.Itoa(os.Getpid()) + "." + newDiagID()[:6]
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if info, err := os.Stat(path); err == nil {
		outboxCacheMu.Lock()
		outboxCached = cloneOutboxStore(s)
		outboxCacheKey.path = path
		outboxCacheKey.modTime = info.ModTime()
		outboxCacheKey.size = info.Size()
		outboxCacheKey.valid = true
		outboxCacheMu.Unlock()
	}
	return nil
}

func newSentID() string {
	return fmt.Sprintf("sent-%s-%s", time.Now().Format("20060102-150405"), newDiagID()[:6])
}

// outboxRecordStart inserts a new record (newest first) or returns an existing
// non-failed record matching client_op to prevent duplicate pastes on retry.
func outboxRecordStart(rec sentRecord) (sentRecord, bool) {
	unlock := lockOutbox()
	defer unlock()
	s := loadOutboxDisk()
	if rec.ClientOp != "" {
		for _, existing := range s.Items {
			if existing.ClientOp == rec.ClientOp &&
				(existing.Status == "pasting" || existing.Status == "pending" || existing.Status == "confirmed") {
				return existing, true
			}
		}
	}
	if rec.ID == "" {
		rec.ID = newSentID()
	}
	if rec.CreatedAt == 0 {
		rec.CreatedAt = time.Now().UnixMilli()
	}
	if rec.Kind == "" {
		rec.Kind = "message"
	}
	if rec.Status == "" {
		rec.Status = "pasting"
	}
	if len(rec.Attachments) > 0 {
		rec.Attachments = append([]string(nil), rec.Attachments...)
	}
	s.Items = append([]sentRecord{rec}, s.Items...)
	_ = saveOutboxLocked(s)
	return rec, false
}

func outboxUpdate(id string, mutate func(*sentRecord)) (sentRecord, bool) {
	if id == "" {
		return sentRecord{}, false
	}
	unlock := lockOutbox()
	defer unlock()
	s := loadOutboxDisk()
	for i := range s.Items {
		if s.Items[i].ID == id {
			mutate(&s.Items[i])
			updated := s.Items[i]
			_ = saveOutboxLocked(s)
			return updated, true
		}
	}
	return sentRecord{}, false
}

// rebindOutboxSession moves unsettled records from a temporary session id
// (e.g. Agy `pending-<uuid>`) to the real session id once assigned.
func rebindOutboxSession(fromID, toID string) {
	if fromID == "" || toID == "" || fromID == toID {
		return
	}
	s := readOutboxCached()
	has := false
	for _, rec := range s.Items {
		if rec.SessionID == fromID {
			has = true
			break
		}
	}
	if !has {
		return
	}
	unlock := lockOutbox()
	defer unlock()
	s = loadOutboxDisk()
	changed := false
	for i := range s.Items {
		if s.Items[i].SessionID == fromID {
			s.Items[i].SessionID = toID
			s.Items[i].TranscriptEndAtSend = 0
			changed = true
		}
	}
	if changed {
		_ = saveOutboxLocked(s)
	}
}

func isUnsettledOutboxStatus(status string) bool {
	return status == "pasting" || status == "pending" || status == "unconfirmed" || status == "failed"
}

// hasUnsettledOutbox is a cheap mtime-cached check so sessionDetailFor only
// copies the full message slice when this session actually has unsettled sends.
func hasUnsettledOutbox(sessionID string) bool {
	if sessionID == "" {
		return false
	}
	s := readOutboxCached()
	for _, rec := range s.Items {
		if rec.SessionID == sessionID && isUnsettledOutboxStatus(rec.Status) {
			return true
		}
	}
	return false
}

var attachmentMarks = []string{"[网页附件]", "[手机附件]"}

func endsWithWebAttachmentNote(text, typed string) bool {
	for _, mark := range attachmentMarks {
		at := strings.Index(text, mark)
		if at < 0 {
			continue
		}
		if typed == "" {
			if at == 0 {
				return true
			}
			continue
		}
		if strings.TrimSpace(text[:at]) == typed {
			return true
		}
	}
	return false
}

func containsAllAttachments(text string, names []string) bool {
	for _, name := range names {
		if name == "" {
			continue
		}
		if !strings.Contains(text, name) {
			return false
		}
	}
	return true
}

func outboxMatchesUserLine(rec sentRecord, userText string) bool {
	typed := strings.TrimSpace(rec.Text)
	trimmed := strings.TrimSpace(userText)
	if trimmed == "" {
		return false
	}
	// Exact match or exact typed text followed by host attachment block.
	if typed != "" {
		if trimmed == typed || endsWithWebAttachmentNote(trimmed, typed) {
			return true
		}
	} else if len(rec.Attachments) > 0 && endsWithWebAttachmentNote(trimmed, "") {
		if containsAllAttachments(trimmed, rec.Attachments) {
			return true
		}
	}
	// Tolerance for terminal draft merge (e.g. half-typed text at desk + web paste).
	if len(rec.Attachments) > 0 {
		if !containsAllAttachments(trimmed, rec.Attachments) {
			return false
		}
		return typed == "" || strings.Contains(trimmed, typed)
	}
	return utf8.RuneCountInString(typed) >= 4 && strings.Contains(trimmed, typed)
}

type outboxTransition struct {
	id         string
	clientOp   string
	from       string
	to         string
	matchedIdx *int
	ageMs      int64
}

// reconcileSessionOutbox matches pending/unconfirmed records for sessionID
// against the full parsed transcript and transitions stale idle records to
// unconfirmed. Returns unsettled records for this session in chronological order.
func reconcileSessionOutbox(sessionID string, messages []chatMessage, busy bool, nowMs int64) []sentRecord {
	if sessionID == "" {
		return nil
	}
	s := readOutboxCached()
	hasCandidate := false
	for _, rec := range s.Items {
		if rec.SessionID == sessionID && isUnsettledOutboxStatus(rec.Status) {
			hasCandidate = true
			break
		}
	}
	if !hasCandidate {
		return nil
	}

	// Collect chronological candidates so oldest sent record claims the earliest
	// matching user line first (same FIFO semantics as web settleMatches).
	var candidates []sentRecord
	for i := len(s.Items) - 1; i >= 0; i-- {
		rec := s.Items[i]
		if rec.SessionID == sessionID && isUnsettledOutboxStatus(rec.Status) {
			candidates = append(candidates, rec)
		}
	}

	usedIdx := map[int]bool{}
	var transitions []outboxTransition
	unsettled := make([]sentRecord, 0, len(candidates))

	for _, rec := range candidates {
		if rec.Status == "pending" || rec.Status == "unconfirmed" {
			matched := -1
			for idx := rec.TranscriptEndAtSend; idx < len(messages); idx++ {
				if idx < 0 || usedIdx[idx] || messages[idx].Role != "user" {
					continue
				}
				if outboxMatchesUserLine(rec, messages[idx].Text) {
					matched = idx
					break
				}
			}
			if matched >= 0 {
				usedIdx[matched] = true
				m := matched
				transitions = append(transitions, outboxTransition{
					id: rec.ID, clientOp: rec.ClientOp, from: rec.Status, to: "confirmed",
					matchedIdx: &m, ageMs: nowMs - rec.CreatedAt,
				})
				continue
			}
			if rec.Status == "pending" && !busy && nowMs-rec.CreatedAt >= outboxUnconfirmedAfterMs {
				transitions = append(transitions, outboxTransition{
					id: rec.ID, clientOp: rec.ClientOp, from: rec.Status, to: "unconfirmed",
					ageMs: nowMs - rec.CreatedAt,
				})
				rec.Status = "unconfirmed"
			}
		}
		unsettled = append(unsettled, rec)
	}

	if len(transitions) > 0 {
		unlock := lockOutbox()
		fresh := loadOutboxDisk()
		changed := false
		byID := map[string]outboxTransition{}
		for _, tr := range transitions {
			byID[tr.id] = tr
		}
		for i := range fresh.Items {
			tr, ok := byID[fresh.Items[i].ID]
			if !ok {
				continue
			}
			if fresh.Items[i].Status != tr.from {
				continue
			}
			fresh.Items[i].Status = tr.to
			if tr.to == "confirmed" {
				fresh.Items[i].ConfirmedAt = nowMs
				fresh.Items[i].ConfirmedMsgIndex = tr.matchedIdx
			}
			changed = true
		}
		if changed {
			_ = saveOutboxLocked(fresh)
		}
		unlock()
		for _, tr := range transitions {
			idxVal := -1
			if tr.matchedIdx != nil {
				idxVal = *tr.matchedIdx
			}
			relayLogf("outbox_reconcile", "id=%s op_id=%s session=%s from=%s to=%s matched_idx=%d age_ms=%d",
				tr.id, tr.clientOp, sessionID, tr.from, tr.to, idxVal, tr.ageMs)
		}
	}

	if len(unsettled) == 0 {
		return nil
	}
	return unsettled
}

// outboxPinnedUploads returns bare attachment names referenced by active
// (non-dismissed) sent records so pruneUploads keeps them alive.
func outboxPinnedUploads() map[string]bool {
	s := readOutboxCached()
	pinned := map[string]bool{}
	for _, rec := range s.Items {
		if rec.Status == "dismissed" {
			continue
		}
		for _, name := range rec.Attachments {
			if name != "" {
				pinned[filepath.Base(name)] = true
			}
		}
	}
	return pinned
}

// sessionTranscriptLen returns the current parsed message count of a session
// (cached incrementally) to anchor future outbox reconciliation.
func sessionTranscriptLen(e attentionEntry) int {
	path, agent := findTranscript(e.SessionID)
	if path == "" {
		return 0
	}
	t, err := loadTranscript(path, agent)
	if err != nil {
		return 0
	}
	transcriptsMu.Lock()
	n := len(t.messages)
	transcriptsMu.Unlock()
	return n
}

func sessionRepoMeta(e attentionEntry) (repoKey, repoLabel, worktree string) {
	cwd, alive := paneInfo(e)
	if !alive || cwd == "" {
		return "", "", ""
	}
	repo, root, wt := gitRepoMeta(cwd)
	if root != "" {
		repoKey = root
	} else {
		repoKey = cwd
	}
	if wt != "" {
		worktree = wt
	} else {
		worktree = cwd
	}
	if repo != "" {
		repoLabel = repo
		if alias := parseRepoAliases(repoAliasSpec())[repo]; alias != "" {
			repoLabel = alias
		}
	}
	return repoKey, repoLabel, worktree
}

func resolveRepoKeyForSession(sessionID string, items []sentRecord) string {
	if sessionID == "" {
		return ""
	}
	if entries, err := liveSessions(); err == nil {
		if e, ok := entries[sessionID]; ok {
			if rk, _, _ := sessionRepoMeta(e); rk != "" {
				return rk
			}
		}
	}
	for _, rec := range items {
		if rec.SessionID == sessionID && rec.RepoKey != "" {
			return rec.RepoKey
		}
	}
	return ""
}

func listSentMessages(args json.RawMessage) (any, error) {
	var a struct {
		Scope   string `json:"scope"`   // session | repo | all
		Session string `json:"session"` // optional session id
		RepoKey string `json:"repo_key"`
		Status  string `json:"status"` // default | unsettled | all
		Limit   int    `json:"limit"`
		Before  int64  `json:"before"` // created_at ms cursor
	}
	if len(args) > 0 && json.Unmarshal(args, &a) != nil {
		return nil, errors.New("sent.list: bad arguments")
	}
	if a.Scope == "" {
		if a.Session != "" {
			a.Scope = "session"
		} else {
			a.Scope = "all"
		}
	}
	if a.Limit <= 0 {
		a.Limit = 50
	}
	if a.Limit > 200 {
		a.Limit = 200
	}
	s := readOutboxCached()
	repoKey := a.RepoKey
	if a.Scope == "repo" && repoKey == "" && a.Session != "" {
		repoKey = resolveRepoKeyForSession(a.Session, s.Items)
	}

	items := make([]sentRecord, 0, a.Limit)
	unsettledCount := 0
	hasMore := false

	for _, rec := range s.Items {
		switch a.Scope {
		case "session":
			if a.Session != "" && rec.SessionID != a.Session {
				continue
			}
		case "repo":
			if repoKey != "" && rec.RepoKey != repoKey {
				continue
			}
		case "all":
		default:
			return nil, fmt.Errorf("sent.list: unknown scope %q", a.Scope)
		}
		if isUnsettledOutboxStatus(rec.Status) {
			unsettledCount++
		}
		switch a.Status {
		case "", "default":
			if rec.Status == "dismissed" {
				continue
			}
		case "unsettled":
			if !isUnsettledOutboxStatus(rec.Status) {
				continue
			}
		case "all":
		default:
			return nil, fmt.Errorf("sent.list: unknown status %q", a.Status)
		}
		if a.Before > 0 && rec.CreatedAt >= a.Before {
			continue
		}
		if len(items) >= a.Limit {
			hasMore = true
			continue
		}
		items = append(items, rec)
	}

	return map[string]any{
		"v":               1,
		"ok":              true,
		"items":           items,
		"has_more":        hasMore,
		"unsettled_count": unsettledCount,
	}, nil
}

func writeSentAction(args json.RawMessage) (any, error) {
	var a struct {
		Op string `json:"op"` // dismiss | confirm | delete
		ID string `json:"id"`
	}
	if json.Unmarshal(args, &a) != nil || a.ID == "" {
		return nil, errors.New("sent.action: id and op required")
	}
	switch a.Op {
	case "dismiss":
		rec, ok := outboxUpdate(a.ID, func(r *sentRecord) {
			r.Status = "dismissed"
		})
		if !ok {
			return nil, errors.New("sent.action: record not found")
		}
		relayLogf("outbox_action", "op=dismiss id=%s session=%s", rec.ID, rec.SessionID)
		return map[string]any{"v": 1, "ok": true, "item": rec}, nil
	case "confirm":
		nowMs := time.Now().UnixMilli()
		rec, ok := outboxUpdate(a.ID, func(r *sentRecord) {
			r.Status = "confirmed"
			r.ConfirmedAt = nowMs
		})
		if !ok {
			return nil, errors.New("sent.action: record not found")
		}
		relayLogf("outbox_action", "op=confirm id=%s session=%s", rec.ID, rec.SessionID)
		return map[string]any{"v": 1, "ok": true, "item": rec}, nil
	case "delete":
		unlock := lockOutbox()
		defer unlock()
		s := loadOutboxDisk()
		idx := slices.IndexFunc(s.Items, func(r sentRecord) bool { return r.ID == a.ID })
		if idx < 0 {
			return nil, errors.New("sent.action: record not found")
		}
		removed := s.Items[idx]
		s.Items = slices.Delete(s.Items, idx, idx+1)
		if err := saveOutboxLocked(s); err != nil {
			return nil, err
		}
		relayLogf("outbox_action", "op=delete id=%s session=%s", removed.ID, removed.SessionID)
		return map[string]any{"v": 1, "ok": true, "deleted": removed.ID}, nil
	default:
		return nil, fmt.Errorf("sent.action: unknown op %q", a.Op)
	}
}

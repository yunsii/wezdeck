package main

// Session list projection helpers split out of remote_session.go:
//   - dropEmptyHandoffSplashes: hides idle empty splash cards when the prior
//     session still runs on another pane with real chat (short-circuits in O(N)
//     in-memory when no handoff target exists, avoiding transcript I/O).
//   - sessionRedirectsFromSnap: projects redirect edges strictly against the
//     live listed card set so live sessions are never hijacked away.

import "strings"

// sessionHasVisibleChat: at least one user/assistant/tool line the phone
// would render (harness-only user rows do not count).
func sessionHasVisibleChat(id string) bool {
	path, agent := findTranscript(id)
	if path == "" {
		return false
	}
	tr, err := loadTranscript(path, agent)
	if err != nil || tr == nil {
		return false
	}
	for _, m := range tr.messages {
		if m.Role == "user" || m.Role == "assistant" || m.Role == "tool" {
			return true
		}
	}
	return false
}

// dropEmptyHandoffSplashes removes idle empty cards that only exist because
// this pane's cleared_to pointed here, while the prior session id is still
// listed (alive on another pane) with real chat — the resume-to-splash case.
func dropEmptyHandoffSplashes(cards []sessionCard, recent []recentEntry) []sessionCard {
	listed := make(map[string]bool, len(cards))
	for _, c := range cards {
		listed[c.ID] = true
	}
	handoffTarget := map[string]bool{}
	for _, r := range recent {
		next := r.ClearedTo
		if !sessionIDPattern.MatchString(next) || !listed[next] || !listed[r.SessionID] {
			continue
		}
		handoffTarget[next] = true
	}
	if len(handoffTarget) == 0 {
		return cards
	}
	targetWorktrees := map[string]bool{}
	for _, c := range cards {
		if handoffTarget[c.ID] && c.Status == "idle" {
			key := c.Worktree
			if key == "" {
				key = c.Cwd
			}
			targetWorktrees[key] = true
		}
	}
	if len(targetWorktrees) == 0 {
		return cards
	}
	visible := map[string]bool{}
	hasContent := map[string]bool{}
	for _, c := range cards {
		key := c.Worktree
		if key == "" {
			key = c.Cwd
		}
		if !targetWorktrees[key] {
			continue
		}
		v := sessionHasVisibleChat(c.ID)
		visible[c.ID] = v
		if v {
			hasContent[key] = true
		}
	}
	out := make([]sessionCard, 0, len(cards))
	for _, c := range cards {
		key := c.Worktree
		if key == "" {
			key = c.Cwd
		}
		if !visible[c.ID] && c.Status == "idle" && hasContent[key] && handoffTarget[c.ID] {
			continue
		}
		out = append(out, c)
	}
	return out
}

// sessionRedirect: an old / phantom session id that a pane left behind, and
// the id that owns the pane now — the web console's sessions poll follows
// these so a detail URL that missed replaced_by still lands on the current
// conversation (docs/remote-sessions.md).
type sessionRedirect struct {
	From string `json:"from"`
	To   string `json:"to"`
}

func sessionRedirects(recent []recentEntry, entries map[string]attentionEntry) []sessionRedirect {
	sockets := map[string]bool{}
	for _, e := range entries {
		if e.TmuxSocket != "" {
			sockets[e.TmuxSocket] = true
		}
	}
	for _, r := range recent {
		if r.TmuxSocket != "" {
			sockets[r.TmuxSocket] = true
		}
	}
	return sessionRedirectsFromSnap(recent, entries, snapshotTmuxPanes(sockets), nil)
}

func sessionRedirectsFromSnap(recent []recentEntry, entries map[string]attentionEntry, snap map[string]tmuxPaneSnap, listed map[string]bool) []sessionRedirect {
	pins := agentSessionPinsFromSnap(snap)
	paneOwner := map[string]string{}
	for id, e := range entries {
		if e.TmuxPane != "" && (listed == nil || listed[id]) {
			paneOwner[e.TmuxSocket+"|"+e.TmuxPane] = id
		}
	}
	seen := map[string]bool{}
	var out []sessionRedirect
	add := func(from, to, fromPane, fromSocket string) {
		if from == "" || to == "" || from == to || !sessionIDPattern.MatchString(from) ||
			!sessionIDPattern.MatchString(to) || seen[from] {
			return
		}
		if listed != nil {
			if listed[from] {
				observeSuppressedRedirect(from, to, "from_live")
				return
			}
			if !listed[to] {
				observeSuppressedRedirect(from, to, "to_unlisted")
				return
			}
		} else {
			if _, fromLive := entries[from]; fromLive {
				observeSuppressedRedirect(from, to, "from_live")
				return
			}
			if toEntry, ok := entries[to]; !ok || (toEntry.TmuxPane == "" && toEntry.SessionID == "") {
				observeSuppressedRedirect(from, to, "to_unlisted")
				return
			}
		}
		// Still the live pin on another pane: not a handoff the web should follow.
		if pin, ok := pins[from]; ok &&
			(pin.TmuxPane != fromPane || pin.TmuxSocket != fromSocket) {
			observeSuppressedRedirect(from, to, "from_pinned_elsewhere")
			return
		}
		seen[from] = true
		out = append(out, sessionRedirect{From: from, To: to})
	}
	for _, r := range recent {
		if next := r.ClearedTo; sessionIDPattern.MatchString(next) {
			add(r.SessionID, next, r.TmuxPane, r.TmuxSocket)
			if strings.HasPrefix(next, "pending-") && r.TmuxPane != "" {
				if owner := paneOwner[r.TmuxSocket+"|"+r.TmuxPane]; owner != "" && owner != next {
					add(next, owner, r.TmuxPane, r.TmuxSocket)
				}
			}
		}
	}
	for id, e := range entries {
		if e.ReplacedFrom != "" {
			add(e.ReplacedFrom, id, e.TmuxPane, e.TmuxSocket)
		}
	}
	return out
}

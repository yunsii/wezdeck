package main

// Which messages a `session` reply carries. The page keeps the conversation
// in its own cache and asks only for what it lacks, instead of the last
// `limit` messages on every 1–2.5 s poll (100–500 KB each):
//
//	{id, limit}               full:   the last `limit` (default 60) — first open,
//	                                  and what pages from before this protocol send
//	{id, since: n}            since:  from message n on — what the poll needs.
//	                                  Starts earlier at a tool call still pending
//	                                  within the 40 before n: its result lands on
//	                                  a message the page already has
//	{id, before: s, limit}    before: the `limit` messages before index s —
//	                                  加载更早, without resending the rest
//
// The reply's `span` names the mode and `start` the index of its first
// message, so the page merges by index (lib/session-cache.ts).

type sessionArgs struct {
	ID          string `json:"id"`
	Limit       int    `json:"limit"`
	Since       *int   `json:"since"`
	Before      *int   `json:"before"`
	MessagesRev *int   `json:"messages_rev"`
}

const (
	sessionPendingLookback    = 40
	sessionLatestUserMaxExtra = 400
)

// Bump when an adapter's parser change alters historical messages so browsers
// replace stale IndexedDB cache pages instead of merging by old indexes.
const (
	codexMessagesRev = 1
	agyMessagesRev   = 2
)

func messagesRevFor(agent string) int {
	switch agent {
	case "codex":
		return codexMessagesRev
	case "agy":
		return agyMessagesRev
	default:
		return 0
	}
}

func (a sessionArgs) forMessagesRev(rev int) sessionArgs {
	if a.MessagesRev != nil && *a.MessagesRev != rev {
		a.Since, a.Before = nil, nil
	}
	return a
}

func sessionWindow(msgs []chatMessage, a sessionArgs) (start, end int, window string) {
	total := len(msgs)
	limit := a.Limit
	if limit <= 0 {
		limit = 60
	}
	if limit > 5000 {
		limit = 5000
	}
	switch {
	case a.Before != nil:
		end = min(max(*a.Before, 0), total)
		return max(end-limit, 0), end, "before"
	case a.Since != nil && *a.Since >= 0 && *a.Since <= total:
		start = *a.Since
		for i := max(start-sessionPendingLookback, 0); i < start; i++ {
			if msgs[i].Pending {
				start = i
				break
			}
		}
		return start, total, "since"
	}
	// first open, an old page, or a since past the end (the transcript was
	// rewritten): the last `limit`, extended back when needed so the user's
	// latest sent message is never truncated off a long tool-heavy turn.
	base := max(total-limit, 0)
	if base > 0 && !windowHasUser(msgs[base:total]) {
		floor := max(base-sessionLatestUserMaxExtra, 0)
		for i := base - 1; i >= floor; i-- {
			if msgs[i].Role == "user" {
				return i, total, "full"
			}
		}
	}
	return base, total, "full"
}

func windowHasUser(msgs []chatMessage) bool {
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "user" {
			return true
		}
	}
	return false
}

func sessionWindowLogged(id, agent string, msgs []chatMessage, a sessionArgs) (start, end int, window string) {
	start, end, window = sessionWindow(msgs, a)
	if window == "full" {
		limit := a.Limit
		if limit <= 0 {
			limit = 60
		}
		if limit > 5000 {
			limit = 5000
		}
		baseStart := max(len(msgs)-limit, 0)
		if start < baseStart {
			relayLogf("session_window", "id=%s agent=%s event=extend_latest_user base_start=%d start=%d total=%d", id, agent, baseStart, start, len(msgs))
		}
	}
	return start, end, window
}

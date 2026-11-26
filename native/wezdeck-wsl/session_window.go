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

const sessionPendingLookback = 40

// Bump when a Codex parser change removes, adds or reorders historical rows.
const codexMessagesRev = 1

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
	// rewritten): the last `limit`, and the page replaces what it had
	return max(total-limit, 0), total, "full"
}

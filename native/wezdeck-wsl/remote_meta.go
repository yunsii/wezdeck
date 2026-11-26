package main

// Session metadata for the phone's 会话信息 panel (the `meta` field of the
// session reply): everything the host knows about a session, grouped the way
// the panel shows it — the session itself, where it runs (cwd, repo,
// worktree, branch, tmux pane), its transcript, and its state. Usage,
// account limits, capabilities and the agent reference travel in their own
// fields. Empty values are left out so the panel shows only what is known.

import (
	"os"
	"strconv"
	"time"
)

type metaRow struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type metaGroup struct {
	Name string    `json:"name"` // session | location | transcript | state
	Rows []metaRow `json:"rows"`
}

func (g *metaGroup) add(key, value string) {
	if value != "" {
		g.Rows = append(g.Rows, metaRow{Key: key, Value: value})
	}
}

func msTime(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).Format(time.RFC3339)
}

func sessionMeta(e attentionEntry, path, agent string, t *transcript) []metaGroup {
	session := metaGroup{Name: "session"}
	session.add("id", e.SessionID)
	session.add("agent", agent)
	session.add("title", readSessionTitle(path, agent))
	session.add("agent_name", e.AgentName)
	session.add("window", e.WindowName)
	model, effort := "", ""
	if t != nil {
		model = t.usage.Model
	}
	if agent == "grok" {
		// no reply yet, no model in the transcript: Grok's summary.json
		var summaryModel string
		summaryModel, effort = grokSummaryModel(path)
		if model == "" {
			model = summaryModel
		}
	}
	session.add("model", model)
	session.add("effort", effort)

	location := metaGroup{Name: "location"}
	_, cwd, cmd, index, _, alive := paneState(e)
	location.add("cwd", cwd)
	if cwd != "" {
		repo, root, worktree := gitRepoMeta(cwd)
		location.add("repo", repo)
		location.add("repo_root", root)
		if worktree != "" && worktree != root {
			location.add("worktree", worktree)
		}
	}
	location.add("branch", e.GitBranch)
	location.add("tmux_socket", e.TmuxSocket)
	location.add("tmux_session", e.TmuxSession)
	location.add("tmux_pane", e.TmuxPane)
	if alive {
		location.add("pane_role", paneRole(index))
		location.add("pane_command", cmd)
	} else {
		location.add("pane", "gone")
	}

	file := metaGroup{Name: "transcript"}
	file.add("path", path)
	if path != "" {
		if info, err := os.Stat(path); err == nil {
			file.add("bytes", itoa(info.Size()))
			file.add("modified", info.ModTime().Format(time.RFC3339))
		}
		file.add("last_turn", msTime(lastTurnAt(path, agent)))
	}
	if t != nil {
		file.add("messages", itoa(int64(len(t.messages))))
		if n, _ := t.compactions(); n > 0 {
			file.add("compactions", itoa(int64(n)))
		}
		for _, m := range t.messages {
			if m.TS != "" {
				file.add("first_turn", m.TS)
				break
			}
		}
	}

	state := metaGroup{Name: "state"}
	state.add("status", e.Status)
	state.add("reason", e.Reason)
	state.add("running_kind", e.RunningKind)
	state.add("waiting_kind", e.WaitingKind)
	state.add("status_updated", msTime(e.TS))
	if act := deskActivity(e); act > 0 {
		state.add("desk_idle", (time.Since(time.Unix(act, 0)) / time.Second * time.Second).String())
	}
	if n := len(e.Bg.Tasks); n > 0 {
		state.add("background_tasks", itoa(int64(n)))
	}

	groups := []metaGroup{session, location, file, state}
	out := groups[:0]
	for _, g := range groups {
		if len(g.Rows) > 0 {
			out = append(out, g)
		}
	}
	return out
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

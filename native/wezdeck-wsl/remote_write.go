package main

// Writes into sessions and tickets, the one place they run. Two ways in:
//
//	relay (phone / tablet / a paired browser): the frame must carry an
//	  approved device's signature (verifyWrite), device = its key id
//	serve, domain "remote" (a browser on this computer, through the local
//	  Runtime's POST /api/v1/remote/<action>): no device key — the Runtime
//	  listens on loopback and refuses origins outside its allowlist, the same
//	  trust its other host actions (VS Code, focus) already run on; device =
//	  "local"
//
// Every guard inside the actions (one writer per pane, the 10 s desk-input
// hold, the ticket targets allowlist …) applies either way, and every write
// leaves one `event=write via=… device=…` row in relay.log.

import (
	"encoding/json"
	"regexp"
)

var clientOpPattern = regexp.MustCompile(`^[0-9a-f-]{36}$`)

func runWrite(action string, args json.RawMessage, via, device string, logf func(event, format string, args ...any)) (any, error) {
	var meta struct {
		ClientOp string `json:"client_op"`
	}
	_ = json.Unmarshal(args, &meta)
	if !clientOpPattern.MatchString(meta.ClientOp) {
		meta.ClientOp = ""
	}
	var result any
	var err error
	switch action {
	case "send":
		result, err = sendToSessionWithMeta(args, via, device, meta.ClientOp)
	case "deferred.enqueue":
		result, err = enqueueDeferredMessage(args, via, device, meta.ClientOp)
	case "deferred.release":
		result, err = changeDeferredMessage(args, "release")
	case "deferred.cancel":
		result, err = changeDeferredMessage(args, "cancel")
	case "key":
		result, err = keyToSessionWithOp(args, meta.ClientOp)
	case "sent.action":
		result, err = writeSentAction(args)
	case "upload":
		result, err = uploadChunk(args)
		if done, ok := result.(map[string]any); ok && done["name"] != nil {
			logf("upload", "via=%s device=%s name=%s bytes=%v", via, device, done["name"], done["bytes"])
		}
		if err == nil {
			return result, nil // one log row per finished file, not per chunk
		}
	case "attach":
		result, err = attachTicket(args)
	case "clear":
		result, err = clearAttention(args)
	case "session.new":
		result, err = startNewSession(args)
	case "session.new.trust":
		result, err = approveNewSessionTrust(args)
	case "agent.profile.configure":
		result, err = configureKimiProfile(args)
	case "agent.profile.model":
		result, err = configureAgentModel(args)
	case "agent.profile.settings":
		result, err = configureAgentProfileSettings(args)
	case "repo.agent.set":
		result, err = setRepoAgentProfile(args)
	case "session.delete":
		result, err = deleteGroupedSession(args)
	case "session.restart":
		result, err = restartSession(args)
	case "session.handoff":
		result, err = startSessionHandoff(args)
	case "session.autotitle.update":
		result, err = updateAutoTitle(args)
	case "ticket.draft":
		result, err = draftTicket(args)
	case "ticket.new":
		result, err = createTicket(args)
	case "ticket.close":
		result, err = closeTicket(args)
	case "ticket.manager.start":
		result, err = startTicketManager(args)
	case "ticket.manager.park":
		result, err = parkTicketManager(args)
	case "ticket.manager.send":
		result, err = sendTicketManager(args)
	case "host.warp.set":
		result, err = setWarp(args)
	case "worktree.describe":
		result, err = describeWorktree(args)
	case "worktree.recycle", "worktree.remove":
		result, err = manageWorktree(action, args)
	default:
		result, err = replyTicket(args)
	}
	if meta.ClientOp != "" {
		logf("write", "via=%s action=%q device=%s op_id=%s ok=%t err=%q", via, action, device, meta.ClientOp, err == nil, errText(err))
	} else {
		logf("write", "via=%s action=%q device=%s ok=%t err=%q", via, action, device, err == nil, errText(err))
	}
	return result, err
}

package main

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

// High-frequency loopback heartbeats stay silent on the happy fast path;
// slow calls and errors still log.
var bridgeQuietActions = map[string]bool{
	"bridge.status":       true,
	"remote.diag.pending": true,
}

func socketPath() string {
	if value := os.Getenv("WEZDECK_WSL_SOCKET"); value != "" {
		return value
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "state", "wezterm-runtime", "wsl.sock")
}

func serve() error {
	path := socketPath()
	if path == "" {
		return errors.New("socket path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	_ = os.Remove(path)
	listener, err := net.Listen("unix", path)
	if err != nil {
		return err
	}
	defer listener.Close()
	if err := os.Chmod(path, 0o600); err != nil {
		return err
	}
	defer initBridgeLog()()
	go exitWhenReplaced(listener)
	for {
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		go handle(conn)
	}
}

func handle(conn net.Conn) {
	defer conn.Close()
	for {
		body, err := readFrame(conn)
		if err != nil {
			return
		}
		var req request
		if err := json.Unmarshal(body, &req); err != nil {
			writeResponse(conn, response{Version: 2, OK: false, Status: "bad_frame", Error: err.Error()})
			continue
		}
		writeResponse(conn, dispatch(req))
	}
}

func writeResponse(w io.Writer, value response) {
	body, err := json.Marshal(value)
	if err != nil {
		return
	}
	_ = writeFrame(w, body)
}

func dispatch(req request) response {
	started := time.Now()
	var timing rpcTiming
	fullAction := req.Domain + "." + req.Action
	res := response{
		Version:      2,
		TraceID:      req.TraceID,
		Domain:       req.Domain,
		Action:       req.Action,
		DecisionPath: "wsl_socket",
	}
	defer func() {
		ms := time.Since(started).Milliseconds()
		slowMS := slowThresholdMS("WEZDECK_BRIDGE_SLOW_RPC_MS", bridgeSlowRPCDefaultMS)
		isSlow := slowMS > 0 && ms >= slowMS
		if !bridgeQuietActions[fullAction] || !res.OK || isSlow {
			relayLogf("bridge_rpc", "via=local action=%q ok=%t ms=%d err=%q", fullAction, res.OK, ms, res.Error)
		}
		if isSlow {
			relayLogf("bridge_rpc_slow", "via=local action=%q ok=%t ms=%d threshold_ms=%d%s err=%q", fullAction, res.OK, ms, slowMS, timing.suffix(), res.Error)
		}
	}()
	if req.Version != 2 {
		res.Status = "bad_version"
		res.Error = "version must be 2"
		return res
	}
	var err error
	switch fullAction {
	case "workspace.catalog":
		res.Result, err = runDump("dump-workspace-catalog.lua", nil, catalogEnv())
	case "git.status":
		var payload struct {
			Path string `json:"path"`
		}
		_ = json.Unmarshal(req.Payload, &payload)
		res.Result, err = runDump("dump-worktree-status.lua", []string{payload.Path}, nil)
	case "status.wakatime":
		res.Result, err = runDump("dump-wakatime-status.lua", nil, nil)
	case "collab.health", "collab.list", "collab.show", "collab.events",
		"collab.run", "collab.prompt", "collab.transcript", "collab.metrics":
		res.Result, err = runCollab(req.Action, req.Payload)
	case "remote.sessions":
		res.Result, err = listSessionsWithTiming(true, &timing)
	case "remote.session":
		res.Result, err = sessionDetailWithTiming(req.Payload, true, &timing)
	case "remote.upload.get", "remote.sent.list",
		"remote.repos", "remote.repo.links", "remote.agent.profiles", "remote.workstations", "remote.ticket.targets", "remote.session.new.job",
		"remote.session.handoff.job", "remote.session.autotitle.status", "remote.session.image", "remote.session.file",
		"remote.session.history", "remote.session.git", "remote.session.skills", "remote.host.warp.status", "remote.host.oppo.status",
		"remote.collab.run.chat", "remote.collab.diff", "remote.collab.manager.chat":
		// the relay's read-only actions for a browser on the host (readRPC)
		payload := req.Payload
		if len(payload) == 0 || string(payload) == "null" {
			payload = json.RawMessage("{}")
		}
		res.Result, _, err = readRPC(req.Action, payload, &timing)
	case "remote.devices":
		// local only: the relay never lists devices to a paired phone
		res.Result, err = listDevices()
	case "remote.device.approve", "remote.device.revoke":
		// local only, like remote.devices: 批准 / 撤销 from the host console
		payload := req.Payload
		if len(payload) == 0 || string(payload) == "null" {
			payload = json.RawMessage("{}")
		}
		res.Result, err = setDeviceState(req.Action, payload)
	case "remote.diag.pending":
		// the host's own page (local mode) asking for diagnostics requests
		// to answer (relay_diag.go localPending): it cannot be pushed to
		var a struct {
			Client string `json:"client"`
		}
		_ = json.Unmarshal(req.Payload, &a)
		res.Result, err = relayControlCall("GET", "/diag/pending?client="+url.QueryEscape(a.Client), nil)
	case "remote.diag.submit":
		// …and handing its snapshot back, chunk by chunk
		res.Result, err = relayControlCall("POST", "/diag/submit", req.Payload)
	case "remote.send", "remote.key", "remote.reply", "remote.attach", "remote.upload",
		"remote.sent.action", "remote.clear", "remote.session.new", "remote.session.new.trust", "remote.agent.profile.configure", "remote.agent.profile.model", "remote.agent.profile.settings", "remote.repo.agent.set", "remote.session.restart", "remote.session.delete",
		"remote.session.handoff", "remote.session.autotitle.update", "remote.ticket.draft", "remote.ticket.new", "remote.ticket.close", "remote.ticket.manager.start", "remote.ticket.manager.park", "remote.ticket.manager.send", "remote.worktree.describe", "remote.worktree.recycle", "remote.worktree.remove", "remote.host.warp.set":
		// a browser on this computer through the local Runtime (remote_write.go)
		payload := req.Payload
		if len(payload) == 0 || string(payload) == "null" {
			payload = json.RawMessage("{}")
		}
		res.Result, err = runWrite(req.Action, payload, "local", "local", relayLogf)
	case "bridge.status":
		res.Result = map[string]any{
			"available": true,
			"socket":    socketPath(),
			"pid":       os.Getpid(),
		}
	default:
		res.Status = "unknown_action"
		res.Error = req.Domain + "." + req.Action
		return res
	}
	if err != nil {
		res.Status = "error"
		res.Error = err.Error()
		return res
	}
	res.OK = true
	res.Status = "ok"
	return res
}

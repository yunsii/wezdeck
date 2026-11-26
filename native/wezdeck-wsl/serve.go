package main

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
)

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
	res := response{
		Version:      2,
		TraceID:      req.TraceID,
		Domain:       req.Domain,
		Action:       req.Action,
		DecisionPath: "wsl_socket",
	}
	if req.Version != 2 {
		res.Status = "bad_version"
		res.Error = "version must be 2"
		return res
	}
	var err error
	switch req.Domain + "." + req.Action {
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
		res.Result, err = listSessionsFor(true)
	case "remote.session":
		res.Result, err = sessionDetailFor(req.Payload, true)
	case "remote.upload.get", "remote.todos",
		"remote.repos", "remote.agent.profiles", "remote.workstations", "remote.ticket.targets", "remote.session.new.job",
		"remote.session.handoff.job", "remote.session.image",
		"remote.session.history", "remote.session.git", "remote.session.skills":
		// the relay's read-only actions for a browser on the host (readRPC)
		payload := req.Payload
		if len(payload) == 0 || string(payload) == "null" {
			payload = json.RawMessage("{}")
		}
		res.Result, _, err = readRPC(req.Action, payload)
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
		"remote.todo", "remote.clear", "remote.session.new", "remote.agent.profile.configure", "remote.session.restart",
		"remote.session.handoff", "remote.ticket.new", "remote.worktree.describe":
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

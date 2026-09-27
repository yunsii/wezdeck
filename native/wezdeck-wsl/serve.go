package main

import (
	"encoding/json"
	"errors"
	"io"
	"net"
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
	for {
		conn, err := listener.Accept()
		if err != nil {
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

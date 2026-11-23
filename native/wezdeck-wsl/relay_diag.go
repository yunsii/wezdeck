package main

// Pulling the phone's diagnostics from the host (docs/remote-sessions.md
// "Diagnostics on demand"): instead of asking the human to tap 诊断 and send,
// an agent runs
//
//	wezdeck-wsl diag [--wait 15] [--reason TEXT] [--steps JSON | --steps-file F] [--reload]
//
// --reload appends the `reload` step: the phone sends its snapshot (still the
// old build id), then reloads onto the newest deploy — no one taps 刷新.
//
// which asks the running relay over its local control socket to push
// {t:"diag.request", id, reason} to every phone seen in the last few minutes
// (over its DataChannel when open, else through the Durable Object by cid).
// Each phone answers with the same snapshot the 诊断 toggle attaches (no
// tokens, no message text; lib/client-trace.ts) as `diag.submit` chunks; the
// host accepts chunks only for a request it issued and that has not expired,
// stores diagnostics-<ts>-<id>-<phone>.json in the uploads dir and the CLI
// prints the paths. The phone shows a toast that the host read diagnostics.
//
// --steps first drives the phone's UI so a problem can be reproduced while it
// records (web lib/host-diag.ts): [{"do":"navigate","to":"/zh/console/now"},
// {"do":"click","text":"会话"}, {"do":"scroll","to":"bottom"}, {"do":"back"},
// {"do":"wait","ms":800}] — each step's frame timing (frames, longest gap,
// long tasks) lands in the snapshot. Clicks never hit write controls (inside
// a form or marked data-write) and navigation stays inside the app.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	phoneSeenWindow = 3 * time.Minute
	diagChunkMax    = 48 << 10
	diagChunksMax   = 64
	diagWaitMax     = 60 * time.Second
)

// phoneChan: one connected page (cid = its relay client id; the same id names
// its WebRTC peer, so one entry per phone tab).
type phoneChan struct {
	dc   *webrtc.DataChannel
	seen time.Time
}

func (r *relay) touchPhone(cid string) {
	if cid == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.phones == nil {
		r.phones = map[string]*phoneChan{}
	}
	p := r.phones[cid]
	if p == nil {
		p = &phoneChan{}
		r.phones[cid] = p
	}
	p.seen = time.Now()
}

func (r *relay) attachDataChannel(cid string, dc *webrtc.DataChannel) {
	r.touchPhone(cid)
	r.mu.Lock()
	r.phones[cid].dc = dc
	r.mu.Unlock()
}

func (r *relay) forgetPhone(cid string) {
	r.forgetAuth(cid)
	r.mu.Lock()
	delete(r.phones, cid)
	r.mu.Unlock()
}

// recentPhones: cids seen within phoneSeenWindow.
func (r *relay) recentPhones() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for cid, p := range r.phones {
		if time.Since(p.seen) <= phoneSeenWindow {
			out = append(out, cid)
		}
	}
	return out
}

// pushToPhones sends f to every phone seen recently; returns their cids.
func (r *relay) pushToPhones(f relayFrame) []string {
	r.mu.Lock()
	type target struct {
		cid string
		dc  *webrtc.DataChannel
	}
	var targets []target
	for cid, p := range r.phones {
		if time.Since(p.seen) > phoneSeenWindow {
			delete(r.phones, cid)
			continue
		}
		targets = append(targets, target{cid, p.dc})
	}
	r.mu.Unlock()
	var sent []string
	for _, t := range targets {
		if t.dc != nil && t.dc.ReadyState() == webrtc.DataChannelStateOpen {
			body, _ := json.Marshal(f)
			if t.dc.SendText(string(body)) == nil {
				sent = append(sent, t.cid)
				continue
			}
		}
		g := f
		g.Cid = t.cid
		r.send(g)
		sent = append(sent, t.cid)
	}
	return sent
}

type diagResult struct {
	Phone string `json:"phone"`
	File  string `json:"file"`
	Bytes int    `json:"bytes"`
}

type diagRequest struct {
	deadline time.Time
	targets  map[string]bool     // cids the request was pushed to: only they may answer
	parts    map[string][]string // cid → chunks
	answered map[string]bool     // one stored answer per cid
	results  []diagResult
	notify   chan struct{}
}

var (
	diagMu       sync.Mutex
	diagRequests = map[string]*diagRequest{}
)

func newDiagID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// diagSubmit: one chunk of a phone's answer (rpc `diag.submit`). Unsigned,
// so it is held to what the host itself asked: a live request id, from a cid
// that request was pushed to, one answer per cid. Another client holding the
// pairing token can neither inject a snapshot (an agent reads it) nor fill
// memory or the uploads dir under made-up phone ids.
func diagSubmit(args json.RawMessage, cid string, r *relay) (any, error) {
	var a struct {
		ID    string `json:"id"`
		Phone string `json:"phone"`
		Seq   int    `json:"seq"`
		Total int    `json:"total"`
		Data  string `json:"data"`
	}
	if json.Unmarshal(args, &a) != nil || !uploadIDPattern.MatchString(a.Phone) {
		return nil, errors.New("bad diagnostics chunk")
	}
	if a.Total < 1 || a.Total > diagChunksMax || a.Seq < 0 || a.Seq >= a.Total || len(a.Data) > diagChunkMax {
		return nil, errors.New("bad diagnostics chunk index")
	}
	diagMu.Lock()
	req := diagRequests[a.ID]
	if req == nil || time.Now().After(req.deadline) {
		diagMu.Unlock()
		return nil, errors.New("no such diagnostics request (expired?)")
	}
	if !req.targets[cid] || req.answered[cid] {
		diagMu.Unlock()
		return nil, errors.New("this client was not asked for diagnostics")
	}
	parts := req.parts[cid]
	if parts == nil || len(parts) != a.Total {
		parts = make([]string, a.Total)
		req.parts[cid] = parts
	}
	parts[a.Seq] = a.Data
	complete := true
	for _, p := range parts {
		if p == "" {
			complete = false
			break
		}
	}
	if !complete {
		diagMu.Unlock()
		return map[string]any{"received": a.Seq + 1, "total": a.Total}, nil
	}
	delete(req.parts, cid)
	req.answered[cid] = true
	diagMu.Unlock()

	body := []byte(strings.Join(parts, ""))
	if !json.Valid(body) {
		return nil, errors.New("diagnostics are not JSON")
	}
	dir := uploadDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	pruneUploads(dir)
	name := fmt.Sprintf("diagnostics-%s-%s-%s.json", time.Now().Format("20060102-150405"), a.ID[:8], a.Phone[:8])
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		return nil, err
	}
	r.logf("diag_received", "id=%s phone=%s bytes=%d", a.ID, a.Phone[:8], len(body))
	diagMu.Lock()
	req.results = append(req.results, diagResult{Phone: a.Phone[:8], File: path, Bytes: len(body)})
	select {
	case req.notify <- struct{}{}:
	default:
	}
	diagMu.Unlock()
	return map[string]any{"stored": name}, nil
}

// requestDiagnostics pushes a request and waits for the phones' answers.
func (r *relay) requestDiagnostics(wait time.Duration, reason string, steps json.RawMessage) map[string]any {
	id := newDiagID()
	req := &diagRequest{deadline: time.Now().Add(wait + 10*time.Second), targets: map[string]bool{},
		parts: map[string][]string{}, answered: map[string]bool{}, notify: make(chan struct{}, 8)}
	defer func() {
		// late chunks still land for a few seconds, then the id is dead
		time.AfterFunc(10*time.Second, func() {
			diagMu.Lock()
			delete(diagRequests, id)
			diagMu.Unlock()
		})
	}()
	if len(steps) == 0 || !json.Valid(steps) {
		steps = json.RawMessage("[]")
	}
	args, _ := json.Marshal(map[string]any{"reason": reason, "steps": steps})
	// register the targets before pushing: a fast phone may answer at once
	targets := r.recentPhones()
	for _, cid := range targets {
		req.targets[cid] = true
	}
	diagMu.Lock()
	diagRequests[id] = req
	diagMu.Unlock()
	phones := r.pushToPhones(relayFrame{T: "diag.request", ID: id, Data: args})
	r.logf("diag_request", "id=%s phones=%d reason=%q", id, len(phones), reason)
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for len(phones) > 0 {
		diagMu.Lock()
		got := len(req.results)
		diagMu.Unlock()
		if got >= len(phones) {
			break
		}
		select {
		case <-req.notify:
		case <-timer.C:
			goto done
		}
	}
done:
	diagMu.Lock()
	results := append([]diagResult(nil), req.results...)
	diagMu.Unlock()
	r.logf("diag_done", "id=%s phones=%d got=%d", id, len(phones), len(results))
	out := map[string]any{"id": id, "phones": len(phones), "results": results}
	if len(phones) == 0 {
		out["hint"] = "no phone connected in the last 3 minutes: open the web console on the phone"
	}
	return out
}

func relayControlPath() string {
	if p := os.Getenv("WEZDECK_RELAY_CONTROL"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local/state/wezdeck/relay.sock")
}

// serveControl: the relay's local control socket (0600, this user only).
func (r *relay) serveControl() {
	path := relayControlPath()
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		r.logf("control_error", "path=%s err=%q", path, err)
		return
	}
	_ = os.Chmod(path, 0o600)
	mux := http.NewServeMux()
	mux.HandleFunc("/diag", func(w http.ResponseWriter, req *http.Request) {
		var body struct {
			Wait   int             `json:"wait"`
			Reason string          `json:"reason"`
			Steps  json.RawMessage `json:"steps"`
		}
		_ = json.NewDecoder(io.LimitReader(req.Body, 64<<10)).Decode(&body)
		wait := 15 * time.Second
		if body.Wait > 0 {
			wait = min(time.Duration(body.Wait)*time.Second, diagWaitMax)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(r.requestDiagnostics(wait, body.Reason, body.Steps))
	})
	go func() { _ = http.Serve(ln, mux) }()
}

// runDiag is `wezdeck-wsl diag`: ask the running relay, print its JSON answer.
func runDiag(args []string) error {
	var body struct {
		Wait   int             `json:"wait"`
		Reason string          `json:"reason"`
		Steps  json.RawMessage `json:"steps,omitempty"`
	}
	body.Wait = 15
	usage := errors.New("usage: wezdeck-wsl diag [--wait SECONDS] [--reason TEXT] [--steps JSON | --steps-file FILE] [--reload]")
	reload := false
	for i := 0; i < len(args); i++ {
		if args[i] == "--reload" {
			reload = true
			continue
		}
		if i+1 >= len(args) {
			return usage
		}
		v := args[i+1]
		switch args[i] {
		case "--wait":
			n, err := strconv.Atoi(v)
			if err != nil {
				return usage
			}
			body.Wait = n
		case "--reason":
			body.Reason = v
		case "--steps":
			body.Steps = json.RawMessage(v)
		case "--steps-file":
			b, err := os.ReadFile(v)
			if err != nil {
				return err
			}
			body.Steps = b
		default:
			return usage
		}
		i++
	}
	if len(body.Steps) > 0 && !json.Valid(body.Steps) {
		return errors.New("--steps is not valid JSON")
	}
	if reload {
		// last step: the phone answers first, then reloads onto the new build
		var steps []json.RawMessage
		if len(body.Steps) > 0 && json.Unmarshal(body.Steps, &steps) != nil {
			return errors.New("--steps must be a JSON array to add --reload")
		}
		steps = append(steps, json.RawMessage(`{"do":"reload"}`))
		body.Steps, _ = json.Marshal(steps)
	}
	client := http.Client{
		Timeout: diagWaitMax + 15*time.Second,
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", relayControlPath())
		}},
	}
	payload, _ := json.Marshal(body)
	res, err := client.Post("http://relay/diag", "application/json", strings.NewReader(string(payload)))
	if err != nil {
		return fmt.Errorf("relay control socket %s: %w (is wezdeck-relay running?)", relayControlPath(), err)
	}
	defer res.Body.Close()
	_, err = io.Copy(os.Stdout, res.Body)
	return err
}

package main

// Pulling a web console page's diagnostics from the host (docs/remote-sessions.md
// "Diagnostics on demand"): instead of asking the human to tap 诊断 and send,
// an agent runs
//
//	wezdeck-wsl diag [--wait 15] [--reason TEXT] [--steps JSON | --steps-file F] [--reload]
//
// --reload appends the `reload` step: the page sends its snapshot (still the
// old build id), then reloads onto the newest deploy — no one taps 刷新.
//
// which asks the running relay over its local control socket to push
// {t:"diag.request", id, reason} to every web console page seen in the last few minutes
// (over its DataChannel when open, else through the Durable Object by cid).
// Each page answers with the same snapshot the 诊断 toggle attaches (no
// tokens, no message text; lib/client-trace.ts) as `diag.submit` chunks; the
// host accepts chunks only for a request it issued and that has not expired,
// stores diagnostics-<ts>-<id>-<client>.json in the uploads dir and the CLI
// prints the paths. The page shows a toast that the host read diagnostics.
//
// --steps first drives the page's UI so a problem can be reproduced while it
// records (web lib/host-diag.ts): [{"do":"navigate","to":"/zh/console/now"},
// {"do":"click","text":"会话"}, {"do":"scroll","to":"bottom"}, {"do":"back"},
// {"do":"wait","ms":800}] — each step's frame timing (frames, longest gap,
// long tasks) lands in the snapshot. Clicks never hit write controls (inside
// a form or marked data-write) and navigation stays inside the app.
// {"do":"query","selector":"…","attrs":["data-folded"]} reads what the page
// shows (up to ten elements: attributes, box, text). Each answer in the CLI
// output carries its gist — build vs the deployed one (`current`), page and
// step results — so verifying a fix on the person's own device is one call.

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
	clientSeenWindow = 3 * time.Minute
	diagChunkMax     = 48 << 10
	diagChunksMax    = 64
	diagWaitMax      = 60 * time.Second
)

// clientChan: one connected page (cid = its relay client id; the same id names
// its WebRTC peer, so one entry per browser tab).
type clientChan struct {
	dc   *webrtc.DataChannel
	seen time.Time
}

func (r *relay) touchClient(cid string) {
	if cid == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.clients == nil {
		r.clients = map[string]*clientChan{}
	}
	p := r.clients[cid]
	if p == nil {
		p = &clientChan{}
		r.clients[cid] = p
	}
	p.seen = time.Now()
}

func (r *relay) attachDataChannel(cid string, dc *webrtc.DataChannel) {
	r.touchClient(cid)
	r.mu.Lock()
	r.clients[cid].dc = dc
	r.mu.Unlock()
}

func (r *relay) forgetClient(cid string) {
	r.forgetAuth(cid)
	r.mu.Lock()
	delete(r.clients, cid)
	r.mu.Unlock()
}

// recentClients: approved cids seen within clientSeenWindow.
func (r *relay) recentClients() []string {
	r.mu.Lock()
	var candidates []string
	for cid, p := range r.clients {
		if time.Since(p.seen) <= clientSeenWindow {
			candidates = append(candidates, cid)
		}
	}
	r.mu.Unlock()
	var out []string
	for _, cid := range candidates {
		if r.readAllowed(cid) == nil {
			out = append(out, cid)
		}
	}
	return out
}

// pushToClients sends f to every approved web console page seen recently; returns their cids.
func (r *relay) pushToClients(f relayFrame) []string {
	r.mu.Lock()
	type target struct {
		cid string
		dc  *webrtc.DataChannel
	}
	var targets []target
	for cid, p := range r.clients {
		if time.Since(p.seen) > clientSeenWindow {
			delete(r.clients, cid)
			continue
		}
		targets = append(targets, target{cid, p.dc})
	}
	r.mu.Unlock()
	var sent []string
	for _, t := range targets {
		if r.readAllowed(t.cid) != nil {
			continue
		}
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
	Client string `json:"client"`
	File   string `json:"file"`
	Bytes  int    `json:"bytes"`
	// the gist, so the CLI answer says it without opening the file: the
	// build the page runs vs the one the site serves (current = it has the
	// fix), where it is, and each step's result (frames left in the file)
	Build    string           `json:"build,omitempty"`
	Deployed string           `json:"deployed,omitempty"`
	Current  *bool            `json:"current,omitempty"`
	Page     string           `json:"page,omitempty"`
	Steps    []map[string]any `json:"steps,omitempty"`
}

// diagGist: the summary fields of a stored snapshot.
func diagGist(body []byte) diagResult {
	var snap struct {
		Build       string `json:"build"`
		Page        string `json:"page"`
		HostRequest struct {
			Deployed string           `json:"deployed"`
			Steps    []map[string]any `json:"steps"`
		} `json:"hostRequest"`
	}
	if json.Unmarshal(body, &snap) != nil {
		return diagResult{}
	}
	g := diagResult{Build: snap.Build, Deployed: snap.HostRequest.Deployed, Page: snap.Page}
	if g.Build != "" && g.Deployed != "" {
		current := g.Build == g.Deployed
		g.Current = &current
	}
	for _, step := range snap.HostRequest.Steps {
		delete(step, "frames")
		g.Steps = append(g.Steps, step)
	}
	return g
}

type diagRequest struct {
	deadline time.Time
	id       string
	reason   string
	steps    json.RawMessage
	targets  map[string]bool     // cids the request was pushed to: only they may answer
	parts    map[string][]string // cid → chunks
	answered map[string]bool     // one stored answer per cid
	results  []diagResult
	notify   chan struct{}
}

// Local-mode pages (the host's own browser: reads and writes through the
// Runtime, never the relay) cannot be pushed to: they poll the control
// socket through the bridge (GET /diag/pending, every ~3 s while shown) and
// submit their chunks back the same way (POST /diag/submit). A page that
// polled lately counts as a target, like a relay client seen lately.
const localSeenFor = 15 * time.Second

var (
	localMu   sync.Mutex
	localSeen = map[string]time.Time{} // "local-<page id>" → last poll
)

func recentLocalPages() []string {
	localMu.Lock()
	defer localMu.Unlock()
	var out []string
	for cid, at := range localSeen {
		if time.Since(at) < localSeenFor {
			out = append(out, cid)
		} else {
			delete(localSeen, cid)
		}
	}
	return out
}

// localPending: the open requests this local page has not answered; the
// poll itself makes it a target of requests issued from now on.
func localPending(client string) []map[string]any {
	cid := "local-" + client
	localMu.Lock()
	localSeen[cid] = time.Now()
	localMu.Unlock()
	diagMu.Lock()
	defer diagMu.Unlock()
	out := []map[string]any{}
	for id, req := range diagRequests {
		if time.Now().After(req.deadline) || req.answered[cid] {
			continue
		}
		req.targets[cid] = true
		out = append(out, map[string]any{"id": id, "reason": req.reason, "steps": req.steps})
	}
	return out
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

// diagSubmit: one chunk of a web console page's answer (rpc `diag.submit`). Unsigned,
// so it is held to what the host itself asked: a live request id, from a cid
// that request was pushed to, one answer per cid. Another client holding the
// pairing token can neither inject a snapshot (an agent reads it) nor fill
// memory or the uploads dir under made-up page ids.
func diagSubmit(args json.RawMessage, cid string, r *relay) (any, error) {
	// Remote clients must still be approved when submitting chunks (a device
	// revoked mid-request cannot write diagnostics files onto the host).
	if !strings.HasPrefix(cid, "local-") {
		if err := r.readAllowed(cid); err != nil {
			return nil, err
		}
	}
	var a struct {
		ID     string `json:"id"`
		Client string `json:"client"`
		// Phone: the page id's old name (until 2026-11-24). A page still
		// open from an older build answers with it — the release's own
		// reload asks those pages — so it is taken, with a warning row;
		// remove once diag_legacy_field stops appearing in relay.log
		// (docs/diagnostics.md open questions).
		Phone string `json:"phone"`
		Seq   int    `json:"seq"`
		Total int    `json:"total"`
		Data  string `json:"data"`
	}
	if json.Unmarshal(args, &a) != nil {
		return nil, errors.New("bad diagnostics chunk")
	}
	if a.Client == "" && a.Phone != "" {
		if a.Seq == 0 {
			r.logf("diag_legacy_field", "id=%s field=phone want=client cid=%s", a.ID, cid)
		}
		a.Client = a.Phone
	}
	if !uploadIDPattern.MatchString(a.Client) {
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
	name := fmt.Sprintf("diagnostics-%s-%s-%s.json", time.Now().Format("20060102-150405"), a.ID[:8], a.Client[:8])
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		return nil, err
	}
	r.logf("diag_received", "id=%s client=%s bytes=%d", a.ID, a.Client[:8], len(body))
	diagMu.Lock()
	gist := diagGist(body)
	gist.Client, gist.File, gist.Bytes = a.Client[:8], path, len(body)
	req.results = append(req.results, gist)
	select {
	case req.notify <- struct{}{}:
	default:
	}
	diagMu.Unlock()
	return map[string]any{"stored": name}, nil
}

// requestDiagnostics pushes a request and waits for the web consoles' answers.
func (r *relay) requestDiagnostics(wait time.Duration, reason string, steps json.RawMessage) map[string]any {
	id := newDiagID()
	if len(steps) == 0 || !json.Valid(steps) {
		steps = json.RawMessage("[]")
	}
	req := &diagRequest{deadline: time.Now().Add(wait + 10*time.Second), id: id, reason: reason, steps: steps,
		targets: map[string]bool{}, parts: map[string][]string{}, answered: map[string]bool{}, notify: make(chan struct{}, 8)}
	defer func() {
		// late chunks still land for a few seconds, then the id is dead
		time.AfterFunc(10*time.Second, func() {
			diagMu.Lock()
			delete(diagRequests, id)
			diagMu.Unlock()
		})
	}()
	args, _ := json.Marshal(map[string]any{"reason": reason, "steps": steps})
	// register the targets before pushing: a fast page may answer at once
	targets := r.recentClients()
	for _, cid := range targets {
		req.targets[cid] = true
	}
	diagMu.Lock()
	diagRequests[id] = req
	diagMu.Unlock()
	clients := r.pushToClients(relayFrame{T: "diag.request", ID: id, Data: args})
	// the host's own pages (local mode) pick it up on their next poll
	locals := recentLocalPages()
	diagMu.Lock()
	for _, cid := range locals {
		req.targets[cid] = true
	}
	diagMu.Unlock()
	clients = append(clients, locals...)
	r.logf("diag_request", "id=%s clients=%d local=%d reason=%q", id, len(clients), len(locals), reason)
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for len(clients) > 0 {
		diagMu.Lock()
		got := len(req.results)
		diagMu.Unlock()
		if got >= len(clients) {
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
	r.logf("diag_done", "id=%s clients=%d got=%d", id, len(clients), len(results))
	out := map[string]any{"id": id, "clients": len(clients), "results": results}
	if len(clients) == 0 {
		out["hint"] = "no web console connected in the last 3 minutes: open it on the device"
	} else if missing := len(clients) - len(results); missing > 0 {
		// pushed, never answered: a locked phone or a page in the
		// background has its scripts paused
		out["unanswered"] = missing
		out["hint"] = fmt.Sprintf("%d of %d web consoles did not answer in time: likely locked or in the background — bring the page to the front and retry", missing, len(clients))
	}
	if results == nil {
		out["results"] = []diagResult{}
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
	// local-mode pages, through the bridge (serve.go remote.diag.*)
	mux.HandleFunc("/diag/pending", func(w http.ResponseWriter, req *http.Request) {
		client := req.URL.Query().Get("client")
		w.Header().Set("Content-Type", "application/json")
		if !uploadIDPattern.MatchString(client) {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "bad client"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"requests": localPending(client)})
	})
	mux.HandleFunc("/diag/submit", func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(req.Body, diagChunkMax+4096))
		var head struct {
			Client string `json:"client"`
		}
		_ = json.Unmarshal(body, &head)
		w.Header().Set("Content-Type", "application/json")
		if !uploadIDPattern.MatchString(head.Client) {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "bad client"})
			return
		}
		out, err := diagSubmit(body, "local-"+head.Client, r)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(out)
	})
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
	usage := errors.New("usage: wezdeck-wsl diag [--wait SECONDS] [--reason TEXT] [--steps JSON | --steps-file FILE] [--reload | --notify-update]")
	reload := false
	notifyUpdate := false
	for i := 0; i < len(args); i++ {
		if args[i] == "--reload" {
			reload = true
			continue
		}
		if args[i] == "--notify-update" {
			notifyUpdate = true
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
	if reload || notifyUpdate {
		// last step: the page answers first, then reloads (or shows a non-disruptive update banner)
		var steps []json.RawMessage
		if len(body.Steps) > 0 && json.Unmarshal(body.Steps, &steps) != nil {
			return errors.New("--steps must be a JSON array to add --reload/--notify-update")
		}
		if reload {
			steps = append(steps, json.RawMessage(`{"do":"reload"}`))
		} else {
			steps = append(steps, json.RawMessage(`{"do":"notify-update"}`))
		}
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

// relayControlCall: the bridge asking the running relay over its control
// socket (local-mode diagnostics: serve.go remote.diag.pending / submit).
func relayControlCall(method, path string, body []byte) (any, error) {
	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", relayControlPath())
		}},
	}
	req, err := http.NewRequest(method, "http://relay"+path, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("relay control socket: %w (is wezdeck-relay running?)", err)
	}
	defer res.Body.Close()
	var out any
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out); err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		if m, ok := out.(map[string]any); ok {
			if msg, ok := m["error"].(string); ok {
				return nil, errors.New(msg)
			}
		}
		return nil, fmt.Errorf("relay control: %s", res.Status)
	}
	return out, nil
}

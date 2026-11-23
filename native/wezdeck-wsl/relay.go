package main

// `wezdeck-wsl relay` keeps one outbound WebSocket to the wezdeck.yuns.love
// Durable Object so a phone can read collab tickets without reaching this
// machine directly. The same socket carries WebRTC signaling: when the phone
// offers a DataChannel, requests move onto the direct (DTLS) channel and the
// Cloudflare relay only stays as the fallback. Design: docs/remote-access.md.
//
// Messages are JSON objects with a "t" field:
//   DO → host  {t:"rpc", cid, id, action, args} | {t:"sig", cid, data} | {t:"ping", cid, id} | {t:"bye", cid}
//   host → DO  {t:"res", cid, id, ok, result|error} | {t:"sig", cid, data} | {t:"pong", cid, id} | {t:"hello", ...}
// The DataChannel carries the same rpc/res and ping/pong frames without cid.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

const relayDefaultURL = "wss://wezdeck.yuns.love/relay/host"

type relayFrame struct {
	T      string          `json:"t"`
	Cid    string          `json:"cid,omitempty"`
	ID     string          `json:"id,omitempty"`
	Action string          `json:"action,omitempty"`
	Args   json.RawMessage `json:"args,omitempty"`
	Data   json.RawMessage `json:"data,omitempty"`
	OK     *bool           `json:"ok,omitempty"`
	Result any             `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
	Host   string          `json:"host,omitempty"`
	Ver    string          `json:"ver,omitempty"`
}

type relaySignal struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
	// SamePublic (answer only): "yes" | "no" | "unknown", so the page knows
	// whether a LAN path (mic grant) can help at all.
	SamePublic string `json:"samePublic,omitempty"`
}

type relay struct {
	wmu   sync.Mutex // serializes socket writes
	mu    sync.Mutex
	conn  *websocket.Conn
	peers map[string]*webrtc.PeerConnection
	// phones: pages seen recently, for host → phone pushes (relay_diag.go)
	phones map[string]*phoneChan
	// authed: cid → the approved device that said hello on it (relay_auth.go)
	authed map[string]string
	log    *os.File
}

func relayLogPath() string {
	if dir := os.Getenv("WEZDECK_RELAY_LOG_DIR"); dir != "" {
		return filepath.Join(dir, "relay.log")
	}
	if path := socketPath(); path != "" {
		return filepath.Join(filepath.Dir(path), "logs", "relay.log")
	}
	return ""
}

// logf writes one `ts category=relay event=… key=value` row (docs/logging-conventions.md).
func (r *relay) logf(event string, format string, args ...any) {
	line := fmt.Sprintf("%s category=relay event=%s %s\n", time.Now().Format(time.RFC3339Nano), event, fmt.Sprintf(format, args...))
	fmt.Fprint(os.Stderr, line)
	if r.log != nil {
		_, _ = r.log.WriteString(line)
	}
}

// activeRelay: the running relay, for background work (session_new.go) that
// logs after its RPC has returned
var activeRelay *relay

func relayLogf(event, format string, args ...any) {
	if r := activeRelay; r != nil {
		r.logf(event, format, args...)
		return
	}
	// no relay in this process (the Runtime bridge, `serve`): the same row
	// goes to relay.log, so local writes are on record next to remote ones
	line := fmt.Sprintf("%s category=relay event=%s %s\n", time.Now().Format(time.RFC3339Nano), event, fmt.Sprintf(format, args...))
	fmt.Fprint(os.Stderr, line)
	if path := relayLogPath(); path != "" {
		if f, err := openRelayLog(path); err == nil {
			_, _ = f.WriteString(line)
			_ = f.Close()
		}
	}
}

// openRelayLog: owner-only. The rows name devices, attachments, worktree
// paths and ticket ids, and carry CLI error text; a file made 0644 before
// is tightened when opened.
func openRelayLog(path string) (*os.File, error) {
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err == nil {
		_ = f.Chmod(0o600)
	}
	return f, err
}

func runRelay() error {
	token := os.Getenv("WEZDECK_RELAY_HOST_TOKEN")
	if token == "" {
		return errors.New("WEZDECK_RELAY_HOST_TOKEN is empty (see docs/remote-access.md)")
	}
	url := os.Getenv("WEZDECK_RELAY_URL")
	if url == "" {
		url = relayDefaultURL
	}
	r := &relay{peers: map[string]*webrtc.PeerConnection{}, phones: map[string]*phoneChan{}}
	activeRelay = r
	if path := relayLogPath(); path != "" {
		if f, err := openRelayLog(path); err == nil {
			r.log = f
			defer f.Close()
		}
	}
	r.serveControl()
	backoff := time.Second
	for {
		started := time.Now()
		err := r.session(url, token)
		r.closePeers()
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		wait := backoff + time.Duration(rand.Int63n(int64(backoff/2)+1))
		r.logf("disconnected", "err=%q retry_in_ms=%d", errText(err), wait.Milliseconds())
		time.Sleep(wait)
		if backoff < time.Minute {
			backoff *= 2
		}
	}
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (r *relay) session(url, token string) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dialCtx, dialCancel := context.WithTimeout(ctx, 15*time.Second)
	conn, _, err := websocket.Dial(dialCtx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + token}},
	})
	dialCancel()
	if err != nil {
		return err
	}
	conn.SetReadLimit(4 << 20)
	r.mu.Lock()
	r.conn = conn
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		r.conn = nil
		r.mu.Unlock()
		conn.CloseNow()
	}()
	host, _ := os.Hostname()
	r.send(relayFrame{T: "hello", Host: host, Ver: "1"})
	r.logf("connected", "url=%s version=%s", url, buildVersion)

	// Keepalive: the DO answers the literal "ping" with "pong" without waking
	// (setWebSocketAutoResponse). Any inbound frame counts as liveness.
	lastRead := time.Now()
	var lastMu sync.Mutex
	go func() {
		tick := time.NewTicker(30 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				lastMu.Lock()
				idle := time.Since(lastRead)
				lastMu.Unlock()
				if idle > 75*time.Second {
					r.logf("stale", "idle_ms=%d", idle.Milliseconds())
					conn.CloseNow()
					return
				}
				wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
				r.wmu.Lock()
				_ = conn.Write(wctx, websocket.MessageText, []byte("ping"))
				r.wmu.Unlock()
				wcancel()
			}
		}
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		lastMu.Lock()
		lastRead = time.Now()
		lastMu.Unlock()
		if string(data) == "pong" {
			continue
		}
		var f relayFrame
		if json.Unmarshal(data, &f) != nil {
			continue
		}
		switch f.T {
		case "rpc":
			r.touchPhone(f.Cid)
			go func(f relayFrame) {
				res := handleRPC(f, "websocket", r)
				res.Cid = f.Cid
				r.send(res)
			}(f)
		case "ping":
			r.touchPhone(f.Cid)
			r.send(relayFrame{T: "pong", Cid: f.Cid, ID: f.ID})
		case "sig":
			go r.answer(f.Cid, f.Data)
		case "bye":
			r.dropPeer(f.Cid)
			r.forgetPhone(f.Cid)
		}
	}
}

func (r *relay) send(f relayFrame) {
	r.mu.Lock()
	conn := r.conn
	r.mu.Unlock()
	if conn == nil {
		return
	}
	body, _ := json.Marshal(f)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	r.wmu.Lock()
	defer r.wmu.Unlock()
	_ = conn.Write(ctx, websocket.MessageText, body)
}

// readRPC answers the read-only session actions. The relay serves them to
// paired devices; the Runtime bridge (serve.go, domain "remote") serves the
// same set to a browser on the host itself, which reads over loopback and
// never pairs. Writes are not here: they need an approved device's signature.
func readRPC(action string, args json.RawMessage) (any, bool, error) {
	var result any
	var err error
	switch action {
	case "sessions":
		result, err = listSessions()
	case "session":
		result, err = sessionDetail(args)
	case "upload.get":
		result, err = uploadGet(args)
	case "todos":
		result, err = listTodos(args)
	case "repos":
		result, err = listRepos()
	case "ticket.targets":
		result, err = listTicketTargets()
	case "session.new.job":
		result, err = newSessionJobStatus(args)
	case "session.history":
		result, err = sessionHistory(args)
	case "session.image":
		result, err = sessionImage(args)
	default:
		return nil, false, nil
	}
	return result, true, err
}

// dispatchRPC routes one request. Open: device.register, device.hello,
// diag.submit. Reads (`ticket api` actions from the Runtime bridge's
// allowlist, sessions, …) need a connection that said hello as an approved
// device (relay_auth.go); writes (send / key / reply / attach / upload …)
// carry their own signature from an approved device (remote_session.go).
func dispatchRPC(f relayFrame, via string, r *relay) (any, error) {
	switch f.Action {
	case "device.register":
		result, err := registerDevice(f.Args)
		if m, ok := result.(map[string]any); ok {
			r.logf("device_register", "via=%s cid=%s device=%v state=%v", via, f.Cid, m["id"], m["state"])
		}
		return result, err
	case "device.hello":
		return r.deviceHello(f.Args, f.Cid, via)
	case "diag.submit":
		return diagSubmit(f.Args, f.Cid, r)
	}
	if !signedActions[f.Action] {
		if err := r.readAllowed(f.Cid); err != nil {
			r.logf("read_denied", "via=%s cid=%s action=%q", via, f.Cid, f.Action)
			return nil, err
		}
	}
	if result, ok, err := readRPC(f.Action, f.Args); ok {
		return result, err
	}
	switch f.Action {
	case "usage":
		return fetchUsage()
	case "send", "key", "reply", "attach", "upload", "todo", "clear", "session.new", "ticket.new":
		w, device, err := verifyWrite(f.Action, f.Args)
		if err != nil {
			r.logf("write_denied", "via=%s action=%q err=%q", via, f.Action, err)
			return nil, err
		}
		return runWrite(w.Action, w.Args, via, device, r.logf)
	}
	return runCollab(f.Action, f.Args)
}

// signedActions carry a per-request device signature (verifyWrite), so
// they need no hello.
var signedActions = map[string]bool{
	"send": true, "key": true, "reply": true, "attach": true, "upload": true,
	"todo": true, "clear": true, "session.new": true, "ticket.new": true,
}

// handleRPC answers one request frame and logs it.
func handleRPC(f relayFrame, via string, r *relay) relayFrame {
	started := time.Now()
	result, err := dispatchRPC(f, via, r)
	ok := err == nil
	r.logf("rpc", "via=%s action=%q ok=%t ms=%d err=%q", via, f.Action, ok, time.Since(started).Milliseconds(), errText(err))
	if err != nil {
		return relayFrame{T: "res", ID: f.ID, OK: &ok, Error: err.Error()}
	}
	return relayFrame{T: "res", ID: f.ID, OK: &ok, Result: result}
}

func relayICEServers() []webrtc.ICEServer {
	if os.Getenv("WEZDECK_RELAY_STUN") == "0" {
		return nil
	}
	return []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478"}}}
}

// answer accepts one phone offer (non-trickle: the SDP already carries every
// candidate) and replies with a fully gathered answer over the relay socket.
func (r *relay) answer(cid string, data json.RawMessage) {
	var sig relaySignal
	if json.Unmarshal(data, &sig) != nil || sig.Type != "offer" {
		return
	}
	r.dropPeer(cid)
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: relayICEServers()})
	if err != nil {
		r.logf("rtc_error", "cid=%s err=%q", cid, err)
		return
	}
	r.mu.Lock()
	r.peers[cid] = pc
	r.mu.Unlock()
	started := time.Now()
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		r.logf("rtc_state", "cid=%s state=%s ms=%d", cid, s.String(), time.Since(started).Milliseconds())
		if s == webrtc.PeerConnectionStateFailed {
			go r.dropPeerIf(cid, pc)
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		r.attachDataChannel(cid, dc)
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			var f relayFrame
			if json.Unmarshal(msg.Data, &f) != nil {
				return
			}
			r.touchPhone(cid)
			switch f.T {
			case "ping":
				body, _ := json.Marshal(relayFrame{T: "pong", ID: f.ID})
				_ = dc.SendText(string(body))
			case "rpc":
				// the DataChannel belongs to this cid: requests carry it like the
				// DO path does (diag.submit only accepts the cids it asked)
				f.Cid = cid
				go func() {
					res := handleRPC(f, "webrtc", r)
					res.Cid = ""
					body, _ := json.Marshal(res)
					if err := sendOverDC(dc, f.ID, body); err != nil {
						r.logf("rtc_send_error", "cid=%s action=%q bytes=%d err=%q", cid, f.Action, len(body), err)
					}
				}()
			}
		})
	})
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sig.SDP}); err != nil {
		r.logf("rtc_error", "cid=%s step=remote err=%q", cid, err)
		return
	}
	ans, err := pc.CreateAnswer(nil)
	if err != nil {
		r.logf("rtc_error", "cid=%s step=answer err=%q", cid, err)
		return
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(ans); err != nil {
		r.logf("rtc_error", "cid=%s step=local err=%q", cid, err)
		return
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
	}
	body, _ := json.Marshal(relaySignal{Type: "answer", SDP: pc.LocalDescription().SDP, SamePublic: samePublic(sig.SDP, pc.LocalDescription().SDP)})
	r.send(relayFrame{T: "sig", Cid: cid, Data: body})
	r.logf("rtc_answer", "cid=%s gather_ms=%d offer_cands=%q answer_cands=%q same_public=%s", cid, time.Since(started).Milliseconds(), candidateSummary(sig.SDP), candidateSummary(pc.LocalDescription().SDP), samePublic(sig.SDP, pc.LocalDescription().SDP))
}

// candidateSummary counts ICE candidates by type for the log, e.g.
// "host=2(mdns=2) srflx=1": shows whether the phone hid its LAN address
// behind mDNS or offered a public one, without logging the addresses.
func candidateSummary(sdp string) string {
	counts := map[string]int{}
	mdns := 0
	for _, line := range strings.Split(sdp, "\n") {
		if !strings.HasPrefix(line, "a=candidate:") {
			continue
		}
		fields := strings.Fields(line)
		for i := 0; i+1 < len(fields); i++ {
			if fields[i] == "typ" {
				counts[fields[i+1]]++
				if fields[i+1] == "host" && len(fields) > 4 && strings.HasSuffix(fields[4], ".local") {
					mdns++
				}
			}
		}
	}
	parts := []string{}
	for _, typ := range []string{"host", "srflx", "prflx", "relay"} {
		if counts[typ] == 0 {
			continue
		}
		part := fmt.Sprintf("%s=%d", typ, counts[typ])
		if typ == "host" && mdns > 0 {
			part += fmt.Sprintf("(mdns=%d)", mdns)
		}
		parts = append(parts, part)
	}
	return strings.Join(parts, " ")
}

func srflxAddresses(sdp string) map[string]bool {
	out := map[string]bool{}
	for _, line := range strings.Split(sdp, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) > 7 && strings.HasPrefix(fields[0], "a=candidate:") && fields[6] == "typ" && fields[7] == "srflx" {
			out[fields[4]] = true
		}
	}
	return out
}

// samePublic tells whether both sides reported the same public (STUN) address:
// "yes" = same network, direct needs a LAN path or router hairpinning; "no" =
// different networks, direct needs hole punching; "unknown" = a side had none.
// Addresses themselves stay out of the log.
func samePublic(offer, answer string) string {
	a, b := srflxAddresses(offer), srflxAddresses(answer)
	if len(a) == 0 || len(b) == 0 {
		return "unknown"
	}
	for addr := range a {
		if b[addr] {
			return "yes"
		}
	}
	return "no"
}

func (r *relay) dropPeer(cid string) {
	r.mu.Lock()
	pc := r.peers[cid]
	delete(r.peers, cid)
	r.mu.Unlock()
	if pc != nil {
		_ = pc.Close()
	}
}

// dropPeerIf closes pc only if it is still the current peer for cid (a newer
// offer may already have replaced it).
func (r *relay) dropPeerIf(cid string, pc *webrtc.PeerConnection) {
	r.mu.Lock()
	if r.peers[cid] == pc {
		delete(r.peers, cid)
	}
	r.mu.Unlock()
	_ = pc.Close()
}

func (r *relay) closePeers() {
	r.mu.Lock()
	ids := make([]string, 0, len(r.peers))
	for id := range r.peers {
		ids = append(ids, id)
	}
	r.mu.Unlock()
	for _, id := range ids {
		r.dropPeer(id)
	}
}

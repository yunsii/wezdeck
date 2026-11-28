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
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

const relayDrainTimeout = 5 * time.Second
const relaySlowRPCDefaultMS int64 = 300
const bridgeSlowRPCDefaultMS int64 = 300

const relayDefaultURL = "wss://wezdeck.yuns.love/relay/host"

// relayURL: WEZDECK_RELAY_URL, else the production relay. The installed unit
// does not set it, so every reader (the session, the usage fetch) goes here.
func relayURL() string {
	if url := os.Getenv("WEZDECK_RELAY_URL"); url != "" {
		return url
	}
	return relayDefaultURL
}

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
	HostMS *int64          `json:"host_ms,omitempty"`
	Host   string          `json:"host,omitempty"`
	Ver    string          `json:"ver,omitempty"`
}

// rpcTiming collects optional per-phase millisecond breakdowns for hot-path
// RPCs; formatted only when an RPC crosses the slow threshold.
type rpcTiming struct {
	parts []string
}

func (t *rpcTiming) add(name string, d time.Duration) {
	if t == nil {
		return
	}
	t.parts = append(t.parts, fmt.Sprintf("%s=%d", name, d.Milliseconds()))
}

func (t *rpcTiming) suffix() string {
	if t == nil || len(t.parts) == 0 {
		return ""
	}
	return " " + strings.Join(t.parts, " ")
}

func slowThresholdMS(envKey string, fallback int64) int64 {
	raw := strings.TrimSpace(os.Getenv(envKey))
	if raw == "" {
		return fallback
	}
	if v, err := strconv.ParseInt(raw, 10, 64); err == nil {
		return v
	}
	return fallback
}

type relaySignal struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
	// SamePublic (answer only): "yes" | "no" | "unknown", so the page knows
	// whether a LAN path (mic grant) can help at all.
	SamePublic string `json:"samePublic,omitempty"`
}

type relay struct {
	wmu      sync.Mutex // serializes socket writes
	mu       sync.Mutex
	conn     *websocket.Conn
	peers    map[string]*webrtc.PeerConnection
	inflight sync.WaitGroup
	// clients: web console pages seen recently, for host → page pushes
	// (relay_diag.go)
	clients map[string]*clientChan
	// authed: cid → the approved device that said hello on it (relay_auth.go)
	authed map[string]string
	log    *os.File
}

// waitInflight waits for in-flight RPCs to finish up to timeout so a relay
// restart never cuts off a message send or permission key mid-execution.
func (r *relay) waitInflight(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		r.inflight.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
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

var (
	bridgeLogMu   sync.Mutex
	bridgeLogFile *os.File
)

func initBridgeLog() func() {
	path := relayLogPath()
	if path == "" {
		return func() {}
	}
	f, err := openRelayLog(path)
	if err != nil {
		return func() {}
	}
	bridgeLogMu.Lock()
	bridgeLogFile = f
	bridgeLogMu.Unlock()
	return func() {
		bridgeLogMu.Lock()
		if bridgeLogFile == f {
			bridgeLogFile = nil
		}
		bridgeLogMu.Unlock()
		_ = f.Close()
	}
}

func relayLogf(event, format string, args ...any) {
	if r := activeRelay; r != nil {
		r.logf(event, format, args...)
		return
	}
	// no relay in this process (the Runtime bridge, `serve`): the same row
	// goes to relay.log, so local writes and timings are on record next to remote ones
	line := fmt.Sprintf("%s category=relay event=%s %s\n", time.Now().Format(time.RFC3339Nano), event, fmt.Sprintf(format, args...))
	fmt.Fprint(os.Stderr, line)
	bridgeLogMu.Lock()
	f := bridgeLogFile
	bridgeLogMu.Unlock()
	if f != nil {
		_, _ = f.WriteString(line)
		return
	}
	if path := relayLogPath(); path != "" {
		if opened, err := openRelayLog(path); err == nil {
			_, _ = opened.WriteString(line)
			_ = opened.Close()
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
	url := relayURL()
	r := &relay{peers: map[string]*webrtc.PeerConnection{}, clients: map[string]*clientChan{}}
	r.loadAuthed()
	activeRelay = r
	if path := relayLogPath(); path != "" {
		if f, err := openRelayLog(path); err == nil {
			r.log = f
			defer f.Close()
		}
	}
	rootCtx, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stopSignals()

	cleanupControl := r.serveControl()
	defer cleanupControl()
	go startAutoTitler(rootCtx)
	go r.runPushWatcher(rootCtx)

	backoff := 250 * time.Millisecond
	for {
		if rootCtx.Err() != nil {
			break
		}
		started := time.Now()
		err := r.session(rootCtx, url, token)
		if rootCtx.Err() != nil {
			break
		}
		// Close code 4000 means a newer host relay replaced us during overlap
		// handoff: drain in-flight RPCs and exit cleanly instead of fighting it.
		if websocket.CloseStatus(err) == 4000 {
			r.logf("replaced_draining", "timeout_ms=%d", relayDrainTimeout.Milliseconds())
			drained := r.waitInflight(relayDrainTimeout)
			r.closePeers()
			r.logf("replaced_drained", "clean=%t", drained)
			return nil
		}
		// Keep healthy P2P WebRTC peers alive across transient WS disconnects
		// (e.g. Cloudflare DO recycle); ICE failure detection cleans up dead ones.
		if time.Since(started) > 10*time.Second {
			backoff = 250 * time.Millisecond
		}
		wait := backoff + time.Duration(rand.Int63n(int64(backoff/2)+1))
		r.logf("disconnected", "err=%q retry_in_ms=%d", errText(err), wait.Milliseconds())
		select {
		case <-rootCtx.Done():
		case <-time.After(wait):
		}
		if backoff < time.Minute {
			backoff *= 2
		}
	}

	// Drain any remaining in-flight RPCs (e.g. if SIGTERM arrived while
	// disconnected or over WebRTC DataChannel) before closing peers and exit.
	drained := r.waitInflight(relayDrainTimeout)
	r.saveAuthed()
	r.closePeers()
	r.logf("shutdown", "drained=%t", drained)
	return nil
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (r *relay) session(parent context.Context, url, token string) error {
	ctx, cancel := context.WithCancel(parent)
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
		// On SIGTERM/SIGINT, keep the WebSocket open while draining in-flight
		// RPCs so their replies actually reach waiting browsers before close.
		if parent.Err() != nil {
			r.logf("draining", "timeout_ms=%d", relayDrainTimeout.Milliseconds())
			drained := r.waitInflight(relayDrainTimeout)
			r.logf("drained", "clean=%t", drained)
		}
		r.mu.Lock()
		r.conn = nil
		r.mu.Unlock()
		if parent.Err() != nil {
			_ = conn.Close(websocket.StatusNormalClosure, "relay shutting down")
		} else {
			conn.CloseNow()
		}
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
				werr := conn.Write(wctx, websocket.MessageText, []byte("ping"))
				r.wmu.Unlock()
				wcancel()
				if werr != nil && ctx.Err() == nil {
					r.logf("ping_error", "err=%q", errText(werr))
				}
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
			r.touchClient(f.Cid)
			r.inflight.Add(1)
			go func(f relayFrame) {
				defer r.inflight.Done()
				res := handleRPC(f, "websocket", r)
				res.Cid = f.Cid
				r.send(res)
			}(f)
		case "ping":
			r.touchClient(f.Cid)
			r.send(relayFrame{T: "pong", Cid: f.Cid, ID: f.ID})
		case "sig":
			go r.answer(f.Cid, f.Data)
		case "bye":
			r.dropPeer(f.Cid)
			r.forgetClient(f.Cid)
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
	err := conn.Write(ctx, websocket.MessageText, body)
	r.wmu.Unlock()
	if err != nil {
		r.logf("send_error", "t=%s cid=%s action=%q err=%q", f.T, f.Cid, f.Action, errText(err))
	}
}

// readRPC answers the read-only session actions. The relay serves them to
// paired devices; the Runtime bridge (serve.go, domain "remote") serves the
// same set to a browser on the host itself, which reads over loopback and
// never pairs. Writes are not here: they need an approved device's signature.
func firstTiming(list []*rpcTiming) *rpcTiming {
	if len(list) == 0 {
		return nil
	}
	return list[0]
}

func readRPC(action string, args json.RawMessage, timingOpt ...*rpcTiming) (any, bool, error) {
	timing := firstTiming(timingOpt)
	var result any
	var err error
	switch action {
	case "host.warp.status":
		result, err = warpStatus()
	case "host.oppo.status":
		result = oppoStatus()
	case "sessions":
		result, err = listSessionsWithTiming(false, timing)
	case "session":
		result, err = sessionDetailWithTiming(args, false, timing)
	case "upload.get":
		result, err = uploadGet(args)
	case "sent.list":
		result, err = listSentMessages(args)
	case "repos":
		result, err = listRepos()
	case "repo.links":
		result, err = repoLinks(args)
	case "agent.profiles":
		result, err = listAgentProfiles()
	case "workstations":
		result, err = listWorkstations(args)
	case "ticket.targets":
		result, err = listTicketTargets(args)
	case "session.new.job":
		result, err = newSessionJobStatus(args)
	case "session.handoff.job":
		result, err = handoffJobStatus(args)
	case "session.autotitle.status":
		result, err = autoTitleStatus()
	case "session.history":
		result, err = sessionHistory(args)
	case "session.git":
		result, err = sessionGit(args)
	case "session.skills":
		result, err = sessionSkills(args)
	case "session.image":
		result, err = sessionImage(args)
	case "session.file":
		result, err = sessionFile(args)
	case "collab.run.chat":
		result, err = collabRunChat(args)
	case "collab.diff":
		result, err = collabDiff(args)
	case "collab.manager.chat":
		result, err = collabManagerChat(args)
	default:
		return nil, false, nil
	}
	return result, true, err
}

// dispatchRPC routes one request. Open: device.register, device.hello,
// diag.submit. Reads (`ticket api` actions from the Runtime bridge's
// allowlist, sessions, …) need a connection that said hello as an approved
// device (relay_auth.go); writes (send / key / reply / attach / upload …)
// carry their own signature from an approved device (remote_device_keys.go).
func dispatchRPC(f relayFrame, via string, r *relay, timingOpt ...*rpcTiming) (any, error) {
	timing := firstTiming(timingOpt)
	switch f.Action {
	case "device.register":
		out, err := registerDeviceOutcome(f.Args)
		if err != nil {
			r.logf("device_register_denied", "via=%s cid=%s device=%s reason=%s approved=%d pending=%d err=%q",
				via, f.Cid, out.DeviceID, out.DeniedReason, out.ApprovedCount, out.PendingCount, errText(err))
			return nil, err
		}
		r.logf("device_register", "via=%s cid=%s device=%s state=%s invite_bound=%t",
			via, f.Cid, out.DeviceID, out.State, out.InviteBound)
		return out.Result, nil
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
	if result, ok, err := readRPC(f.Action, f.Args, timing); ok {
		return result, err
	}
	switch f.Action {
	case "usage":
		return fetchUsage()
	case "send", "key", "reply", "attach", "upload", "sent.action", "clear", "session.new", "session.new.trust", "agent.profile.configure", "agent.profile.model", "agent.profile.settings", "repo.agent.set", "session.restart", "session.delete",
		"session.handoff", "session.autotitle.update", "ticket.draft", "ticket.new", "ticket.close", "ticket.manager.start", "ticket.manager.park", "ticket.manager.send", "worktree.describe", "worktree.recycle", "worktree.remove", "host.warp.set":
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
	"sent.action": true, "clear": true, "session.new": true, "session.new.trust": true, "agent.profile.configure": true, "agent.profile.model": true, "agent.profile.settings": true, "repo.agent.set": true, "session.restart": true, "session.delete": true,
	"session.handoff": true, "session.autotitle.update": true, "ticket.draft": true, "ticket.new": true, "ticket.close": true, "ticket.manager.start": true, "ticket.manager.park": true, "ticket.manager.send": true, "worktree.describe": true, "worktree.recycle": true, "worktree.remove": true, "host.warp.set": true,
}

// handleRPC answers one request frame and logs it. Slow RPCs also emit a
// threshold-gated `rpc_slow` row with optional phase breakdowns, and every
// response carries `host_ms` so the browser can separate host time from RTT.
func handleRPC(f relayFrame, via string, r *relay) relayFrame {
	started := time.Now()
	var timing rpcTiming
	result, err := dispatchRPC(f, via, r, &timing)
	ok := err == nil
	ms := time.Since(started).Milliseconds()
	r.logf("rpc", "via=%s action=%q ok=%t ms=%d err=%q", via, f.Action, ok, ms, errText(err))
	if slowMS := slowThresholdMS("WEZDECK_RELAY_SLOW_RPC_MS", relaySlowRPCDefaultMS); slowMS > 0 && ms >= slowMS {
		r.logf("rpc_slow", "via=%s action=%q ok=%t ms=%d threshold_ms=%d%s err=%q", via, f.Action, ok, ms, slowMS, timing.suffix(), errText(err))
	}
	if err != nil {
		return relayFrame{T: "res", ID: f.ID, OK: &ok, Error: err.Error(), HostMS: &ms}
	}
	return relayFrame{T: "res", ID: f.ID, OK: &ok, Result: result, HostMS: &ms}
}

func relayICEServers() []webrtc.ICEServer {
	if os.Getenv("WEZDECK_RELAY_STUN") == "0" {
		return nil
	}
	return []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478"}}}
}

const maxRelayPeers = 16

// answer accepts one phone offer (non-trickle: the SDP already carries every
// candidate) and replies with a fully gathered answer over the relay socket.
func (r *relay) answer(cid string, data json.RawMessage) {
	if err := r.readAllowed(cid); err != nil {
		r.logf("rtc_denied", "cid=%s err=%q", cid, err)
		return
	}
	var sig relaySignal
	if json.Unmarshal(data, &sig) != nil || sig.Type != "offer" {
		return
	}
	r.dropPeer(cid)
	r.mu.Lock()
	peerCount := len(r.peers)
	r.mu.Unlock()
	if peerCount >= maxRelayPeers {
		r.logf("rtc_denied", "cid=%s err=%q peers=%d", cid, "too many peers", peerCount)
		return
	}
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: relayICEServers()})
	if err != nil {
		r.logf("rtc_error", "cid=%s err=%q", cid, err)
		return
	}
	r.mu.Lock()
	if r.peers == nil {
		r.peers = map[string]*webrtc.PeerConnection{}
	}
	if len(r.peers) >= maxRelayPeers {
		r.mu.Unlock()
		_ = pc.Close()
		r.logf("rtc_denied", "cid=%s err=%q", cid, "too many peers")
		return
	}
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
			r.touchClient(cid)
			switch f.T {
			case "ping":
				body, _ := json.Marshal(relayFrame{T: "pong", ID: f.ID})
				_ = dc.SendText(string(body))
			case "rpc":
				// the DataChannel belongs to this cid: requests carry it like the
				// DO path does (diag.submit only accepts the cids it asked)
				f.Cid = cid
				r.inflight.Add(1)
				go func() {
					defer r.inflight.Done()
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

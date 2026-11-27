package main

// Reads need an approved device too (2026-11-24). The pairing token lets a
// browser reach the relay at all; it is one secret shared by every paired
// browser, so revoking a device used to remove only its write key while it
// kept reading every session, transcript and ticket. Now each connection
// (cid: one relay socket, and the DataChannel that belongs to it) proves
// once which device it is — `device.hello`, signed like a write (device key,
// ts, nonce) — and every read checks that this device is still approved. A
// revoke therefore cuts reads on the next request, no reconnect needed.
//
// Open without a hello: device.register (a new device asking), device.hello
// itself, diag.submit (accepted only for a live host request id). Writes
// keep their own per-request signature.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

const (
	relayAuthedTTL = 2 * time.Hour
	relayAuthedMax = 128
)

type persistedAuthEntry struct {
	Device string `json:"device"`
	At     int64  `json:"at"`
}

func relayAuthedPath() string {
	return filepath.Join(filepath.Dir(relayControlPath()), "relay-authed.json")
}

// loadAuthed restores recent cid -> device bindings across relay restarts so
// DO-buffered RPCs succeed on the first try without read_denied storms. Every
// readAllowed() call still checks loadDevices().Approved, so revokes take
// effect immediately.
func (r *relay) loadAuthed() {
	raw, err := os.ReadFile(relayAuthedPath())
	if err != nil {
		return
	}
	var stored map[string]persistedAuthEntry
	if json.Unmarshal(raw, &stored) != nil {
		return
	}
	cutoff := time.Now().Add(-relayAuthedTTL).Unix()
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.authed == nil {
		r.authed = map[string]string{}
	}
	for cid, entry := range stored {
		if cid == "" || entry.Device == "" || entry.At < cutoff {
			continue
		}
		r.authed[cid] = entry.Device
	}
}

func (r *relay) saveAuthed() {
	r.mu.Lock()
	if len(r.authed) == 0 {
		r.mu.Unlock()
		_ = os.Remove(relayAuthedPath())
		return
	}
	now := time.Now().Unix()
	out := make(map[string]persistedAuthEntry, len(r.authed))
	count := 0
	for cid, device := range r.authed {
		if cid == "" || device == "" {
			continue
		}
		out[cid] = persistedAuthEntry{Device: device, At: now}
		count++
		if count >= relayAuthedMax {
			break
		}
	}
	r.mu.Unlock()

	data, err := json.Marshal(out)
	if err != nil {
		return
	}
	path := relayAuthedPath()
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	tmp, err := os.CreateTemp(filepath.Dir(path), ".relay-authed-*.tmp")
	if err != nil {
		return
	}
	tmpName := tmp.Name()
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		_ = os.Remove(tmpName)
		return
	}
	_ = os.Chmod(tmpName, 0o600)
	if os.Rename(tmpName, path) != nil {
		_ = os.Remove(tmpName)
	}
}

// errNotApproved is matched by the page (remote-link.ts) to say which
// device id to approve; keep the prefix stable.
var errNotApproved = errors.New("device not approved: run install-remote-relay.sh --approve on the host")

// openReads: a throwaway test relay (remote-test-stack.sh) whose browsers
// cannot be pre-approved — their keys are made in the page, non-extractable.
// Honoured only with a private attention file, so a production relay cannot
// be opened by one stray variable.
func openReads() bool {
	return os.Getenv("WEZDECK_RELAY_OPEN_READS") == "1" && os.Getenv("WEZDECK_ATTENTION_FILE") != ""
}

func (r *relay) authorize(cid, device string) {
	r.mu.Lock()
	if r.authed == nil {
		r.authed = map[string]string{}
	}
	r.authed[cid] = device
	r.mu.Unlock()
	r.saveAuthed()
}

func (r *relay) forgetAuth(cid string) {
	r.mu.Lock()
	_, existed := r.authed[cid]
	delete(r.authed, cid)
	r.mu.Unlock()
	if existed {
		r.saveAuthed()
	}
}

func (r *relay) deviceOf(cid string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.authed[cid]
}

// readAllowed: this connection said hello as a device that is still on the
// approved list (re-read on every request: a revoke takes effect at once).
func (r *relay) readAllowed(cid string) error {
	if openReads() {
		return nil
	}
	device := r.deviceOf(cid)
	if device == "" {
		return errNotApproved
	}
	for _, d := range loadDevices().Approved {
		if d.ID == device {
			return nil
		}
	}
	r.forgetAuth(cid)
	r.dropPeer(cid)
	return errNotApproved
}

// deviceHello binds this connection to the device whose key signed it.
func (r *relay) deviceHello(args json.RawMessage, cid, via string) (any, error) {
	_, device, err := verifyWrite("device.hello", args)
	if err != nil {
		r.logf("device_hello", "via=%s cid=%s ok=false err=%q", via, cid, err)
		return nil, err
	}
	r.authorize(cid, device)
	r.logf("device_hello", "via=%s cid=%s device=%s ok=true", via, cid, device)
	return map[string]any{"v": 1, "ok": true, "id": device, "state": "approved"}, nil
}

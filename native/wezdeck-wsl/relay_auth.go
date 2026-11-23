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
)

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
	defer r.mu.Unlock()
	if r.authed == nil {
		r.authed = map[string]string{}
	}
	r.authed[cid] = device
}

func (r *relay) forgetAuth(cid string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.authed, cid)
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

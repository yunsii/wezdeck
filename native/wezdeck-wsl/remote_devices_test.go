package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestListDevicesOmitsKeysAndOrdersPendingFirst(t *testing.T) {
	path := filepath.Join(t.TempDir(), "remote-devices.json")
	t.Setenv("WEZDECK_REMOTE_DEVICES", path)
	store := deviceStore{
		Approved: []deviceRecord{{ID: "aaaa", Name: "Linux", PublicKey: "SECRETKEY", At: "2026-11-20T10:00:00Z",
			SeenAt: "2026-11-24T08:00:00Z", Info: &deviceInfo{Browser: "Chrome 157", OS: "Android 16", Mobile: true}}},
		Pending: []deviceRecord{{ID: "bbbb", Name: "ev\x1bil", PublicKey: "OTHERKEY", At: "2026-11-24T09:00:00Z"}},
	}
	data, _ := json.Marshal(store)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := listDevices()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(got)
	if strings.Contains(string(raw), "KEY") {
		t.Fatalf("public key leaked: %s", raw)
	}
	devices := got.(map[string]any)["devices"].([]deviceView)
	if len(devices) != 2 || devices[0].ID != "bbbb" || devices[0].State != "pending" ||
		devices[1].State != "approved" || devices[1].Info.Browser != "Chrome 157" {
		t.Fatalf("unexpected list: %s", raw)
	}
	if devices[0].Name != "evil" {
		t.Fatalf("control characters kept: %q", devices[0].Name)
	}
}

func TestListDevicesEmptyStore(t *testing.T) {
	t.Setenv("WEZDECK_REMOTE_DEVICES", filepath.Join(t.TempDir(), "none.json"))
	got, _ := listDevices()
	raw, _ := json.Marshal(got)
	if string(raw) != `{"devices":[]}` {
		t.Fatalf("got %s", raw)
	}
}

func TestRelayDoesNotServeDeviceList(t *testing.T) {
	if _, ok, _ := readRPC("devices", json.RawMessage("{}")); ok {
		t.Fatal("devices must stay local (serve.go), not a relay read")
	}
}

func TestSetDeviceStateApproveRevoke(t *testing.T) {
	path := filepath.Join(t.TempDir(), "remote-devices.json")
	t.Setenv("WEZDECK_REMOTE_DEVICES", path)
	data, _ := json.Marshal(deviceStore{Pending: []deviceRecord{{ID: "cccc", PublicKey: "K"}}})
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := setDeviceState("device.revoke", json.RawMessage(`{"id":"cccc"}`)); err == nil {
		t.Fatal("revoking a pending device should fail")
	}
	if _, err := setDeviceState("device.approve", json.RawMessage(`{"id":"cccc"}`)); err != nil {
		t.Fatal(err)
	}
	s := loadDevices()
	if len(s.Pending) != 0 || len(s.Approved) != 1 || s.Approved[0].PublicKey != "K" {
		t.Fatalf("approve: %+v", s)
	}
	if _, err := setDeviceState("device.approve", json.RawMessage(`{"id":"cccc"}`)); err == nil {
		t.Fatal("approving twice should fail")
	}
	if _, err := setDeviceState("device.revoke", json.RawMessage(`{"id":"cccc"}`)); err != nil {
		t.Fatal(err)
	}
	if s := loadDevices(); len(s.Approved) != 0 {
		t.Fatalf("revoke: %+v", s)
	}
	if _, err := setDeviceState("device.approve", json.RawMessage(`{}`)); err == nil {
		t.Fatal("missing id should fail")
	}
}

func TestRelayDoesNotChangeDevices(t *testing.T) {
	for _, action := range []string{"device.approve", "device.revoke"} {
		if _, ok, _ := readRPC(action, json.RawMessage("{}")); ok {
			t.Fatalf("%s must stay local", action)
		}
		if signedActions[action] {
			t.Fatalf("%s must not be a relay write", action)
		}
	}
}

func TestPairingInviteGateBlocksBoundLinks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "remote-devices.json")
	t.Setenv("WEZDECK_REMOTE_DEVICES", path)
	t.Setenv("WEZDECK_RELAY_OPEN_READS", "")

	phone := newTestDevice(t)
	tablet := newTestDevice(t)
	stranger := newTestDevice(t)
	regArgs := func(d testDevice, invite string) json.RawMessage {
		m := map[string]any{"public_key": d.pub, "name": "test"}
		if invite != "" {
			m["invite"] = invite
		}
		b, _ := json.Marshal(m)
		return b
	}

	// 1. Empty store allows the first device to bootstrap.
	out, err := registerDeviceOutcome(regArgs(phone, ""))
	if err != nil || out.State != "pending" {
		t.Fatalf("initial bootstrap failed: out=%+v err=%v", out, err)
	}
	if _, err := setDeviceState("device.approve", json.RawMessage(`{"id":"`+phone.id+`"}`)); err != nil {
		t.Fatal(err)
	}

	// 2. Once bound, a bare #pair link without an invite cannot submit a new approval.
	out, err = registerDeviceOutcome(regArgs(stranger, ""))
	if !errors.Is(err, errPairingAlreadyBound) || out.DeniedReason != "pairing_already_bound" {
		t.Fatalf("expected pairing_already_bound, got out=%+v err=%v", out, err)
	}
	if s := loadDevices(); len(s.Pending) != 0 {
		t.Fatalf("rejected stranger entered pending: %+v", s.Pending)
	}

	// 3. A fresh single-use invite allows one new device (tablet) and binds to it.
	rawInvite := "fresh-one-time-invite-123456"
	s := loadDevices()
	s.Invites = append(s.Invites, pairingInvite{
		Hash:      inviteHash(rawInvite),
		CreatedAt: time.Now().Format(time.RFC3339),
		ExpiresAt: time.Now().Add(time.Hour).Format(time.RFC3339),
	})
	if err := saveDevices(s); err != nil {
		t.Fatal(err)
	}
	out, err = registerDeviceOutcome(regArgs(tablet, rawInvite))
	if err != nil || out.State != "pending" || !out.InviteBound {
		t.Fatalf("tablet register with valid invite failed: out=%+v err=%v", out, err)
	}

	// 4. Reusing that already-bound invite on a second device is rejected.
	out, err = registerDeviceOutcome(regArgs(stranger, rawInvite))
	if !errors.Is(err, errPairingAlreadyBound) || out.DeniedReason != "invite_already_used" {
		t.Fatalf("expected invite_already_used, got out=%+v err=%v", out, err)
	}

	// 5. Same pending device can still refresh status cleanly.
	out, err = registerDeviceOutcome(regArgs(tablet, rawInvite))
	if err != nil || out.State != "pending" {
		t.Fatalf("pending refresh failed: out=%+v err=%v", out, err)
	}

	// 6. Expired invite is rejected.
	expiredInvite := "expired-one-time-invite-1234"
	s = loadDevices()
	s.Invites = append(s.Invites, pairingInvite{
		Hash:      inviteHash(expiredInvite),
		CreatedAt: time.Now().Add(-2 * time.Hour).Format(time.RFC3339),
		ExpiresAt: time.Now().Add(-time.Minute).Format(time.RFC3339),
	})
	_ = saveDevices(s)
	out, err = registerDeviceOutcome(regArgs(stranger, expiredInvite))
	if !errors.Is(err, errPairingInviteInvalid) || out.DeniedReason != "invite_expired" {
		t.Fatalf("expected invite_expired, got out=%+v err=%v", out, err)
	}

	// 7. An already-approved device re-pairing with a fresh invite succeeds AND
	//    consumes that invite so a stranger cannot later abuse the shared link.
	repairInvite := "repair-approved-invite-12345"
	s = loadDevices()
	s.Invites = append(s.Invites, pairingInvite{
		Hash:      inviteHash(repairInvite),
		CreatedAt: time.Now().Format(time.RFC3339),
		ExpiresAt: time.Now().Add(time.Hour).Format(time.RFC3339),
	})
	_ = saveDevices(s)
	out, err = registerDeviceOutcome(regArgs(phone, repairInvite))
	if err != nil || out.State != "approved" || !out.InviteBound {
		t.Fatalf("approved re-pair should succeed and bind invite: out=%+v err=%v", out, err)
	}
	out, err = registerDeviceOutcome(regArgs(stranger, repairInvite))
	if !errors.Is(err, errPairingAlreadyBound) || out.DeniedReason != "invite_already_used" {
		t.Fatalf("stranger must not reuse invite consumed by approved device: out=%+v err=%v", out, err)
	}
}

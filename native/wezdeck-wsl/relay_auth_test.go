package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// a device key as the page makes it (P-256), its id, and a signed hello
type testDevice struct {
	key *ecdsa.PrivateKey
	pub string
	id  string
}

func newTestDevice(t *testing.T) testDevice {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	raw := elliptic.Marshal(elliptic.P256(), key.X, key.Y) //nolint:staticcheck // the page sends this exact form
	return testDevice{key: key, pub: base64.RawURLEncoding.EncodeToString(raw), id: deviceID(raw)}
}

func (d testDevice) hello(t *testing.T, nonce string) json.RawMessage {
	payload, _ := json.Marshal(map[string]any{"action": "device.hello", "args": map[string]any{}, "ts": time.Now().UnixMilli(), "nonce": nonce})
	digest := sha256.Sum256(payload)
	r, s, err := ecdsa.Sign(rand.Reader, d.key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	args, _ := json.Marshal(map[string]string{"device": d.id, "payload": string(payload), "sig": base64.RawURLEncoding.EncodeToString(sig)})
	return args
}

func writeDevices(t *testing.T, path string, approved ...testDevice) {
	s := deviceStore{Approved: []deviceRecord{}, Pending: []deviceRecord{}}
	for _, d := range approved {
		s.Approved = append(s.Approved, deviceRecord{ID: d.id, PublicKey: d.pub, Name: "t"})
	}
	data, _ := json.Marshal(s)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestReadsNeedAnApprovedDevice(t *testing.T) {
	path := filepath.Join(t.TempDir(), "remote-devices.json")
	t.Setenv("WEZDECK_REMOTE_DEVICES", path)
	t.Setenv("WEZDECK_RELAY_OPEN_READS", "")
	phone, stranger := newTestDevice(t), newTestDevice(t)
	writeDevices(t, path, phone)
	r := &relay{}

	// a paired browser that never said hello reads nothing; the request is
	// refused before it runs
	if _, err := dispatchRPC(relayFrame{Action: "sessions", Cid: "c1"}, "test", r); !errors.Is(err, errNotApproved) {
		t.Fatalf("read without hello: %v", err)
	}
	// a key that is not on the list cannot say hello
	if _, err := r.deviceHello(stranger.hello(t, "n-stranger"), "c2", "test"); err == nil {
		t.Fatal("an unapproved device said hello")
	}
	if r.readAllowed("c2") == nil {
		t.Fatal("unapproved connection may read")
	}
	// the approved phone says hello and may read on that connection only
	if _, err := r.deviceHello(phone.hello(t, "n-phone"), "c1", "test"); err != nil {
		t.Fatalf("hello: %v", err)
	}
	if err := r.readAllowed("c1"); err != nil {
		t.Fatalf("approved read: %v", err)
	}
	if r.readAllowed("c3") == nil {
		t.Fatal("another connection inherited the phone's hello")
	}
	// the same signed hello cannot be replayed onto another connection
	if _, err := r.deviceHello(phone.hello(t, "n-phone"), "c3", "test"); err == nil {
		t.Fatal("replayed hello accepted")
	}
	// revoke: the next read is refused, without a reconnect
	writeDevices(t, path)
	if !errors.Is(r.readAllowed("c1"), errNotApproved) {
		t.Fatal("revoked device still reads")
	}
	// the connection ends: its binding goes
	writeDevices(t, path, phone)
	_, _ = r.deviceHello(phone.hello(t, "n-phone-2"), "c1", "test")
	r.forgetClient("c1")
	if r.readAllowed("c1") == nil {
		t.Fatal("a closed connection's hello survived")
	}
}

func TestOpenReadsOnlyOnAThrowawayRelay(t *testing.T) {
	t.Setenv("WEZDECK_RELAY_OPEN_READS", "1")
	t.Setenv("WEZDECK_ATTENTION_FILE", "")
	if openReads() {
		t.Fatal("open reads without a private attention file")
	}
	t.Setenv("WEZDECK_ATTENTION_FILE", filepath.Join(t.TempDir(), "attention.json"))
	if !openReads() {
		t.Fatal("test relay should be open")
	}
}

func TestUsageURL(t *testing.T) {
	got, err := usageURL("wss://wezdeck.example/relay/host?room=test")
	if err != nil || got != "https://wezdeck.example/relay/usage?room=test" {
		t.Fatalf("got %q %v", got, err)
	}
	if got, _ := usageURL("ws://127.0.0.1:3018/relay/host"); got != "http://127.0.0.1:3018/relay/usage" {
		t.Fatalf("local: %q", got)
	}
	// the installed unit sets no WEZDECK_RELAY_URL: usage must follow the
	// same default as the relay session ("WEZDECK_RELAY_URL is not a URL")
	t.Setenv("WEZDECK_RELAY_URL", "")
	if got, err := usageURL(relayURL()); err != nil || got != "https://wezdeck.yuns.love/relay/usage" {
		t.Fatalf("default: %q %v", got, err)
	}
	// usage is a gated read: an unapproved connection is refused before the fetch
	t.Setenv("WEZDECK_RELAY_OPEN_READS", "")
	t.Setenv("WEZDECK_REMOTE_DEVICES", filepath.Join(t.TempDir(), "d.json"))
	if _, err := dispatchRPC(relayFrame{Action: "usage", Cid: "x"}, "test", &relay{}); !errors.Is(err, errNotApproved) {
		t.Fatalf("usage without hello: %v", err)
	}
}

func TestWebRTCSignalingRequiresApprovedDeviceAndCapsPeers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "remote-devices.json")
	t.Setenv("WEZDECK_REMOTE_DEVICES", path)
	t.Setenv("WEZDECK_RELAY_OPEN_READS", "")
	t.Setenv("WEZDECK_RELAY_STUN", "0")
	phone := newTestDevice(t)
	writeDevices(t, path, phone)

	logFile, err := os.CreateTemp(t.TempDir(), "relay.log")
	if err != nil {
		t.Fatal(err)
	}
	r := &relay{peers: map[string]*webrtc.PeerConnection{}, log: logFile}
	offer, _ := json.Marshal(relaySignal{Type: "offer", SDP: "v=0\r\n"})

	// Unapproved cid must be rejected before allocating any PeerConnection.
	r.answer("cid-unapproved", offer)
	if len(r.peers) != 0 {
		t.Fatalf("unapproved cid allocated peer: %d", len(r.peers))
	}
	logged, _ := os.ReadFile(logFile.Name())
	if !strings.Contains(string(logged), "event=rtc_denied cid=cid-unapproved") {
		t.Fatalf("expected rtc_denied log, got %q", logged)
	}

	// Peer cap prevents an approved device from exhausting peers.
	if _, err := r.deviceHello(phone.hello(t, "n-rtc-cap"), "cid-cap", "test"); err != nil {
		t.Fatalf("hello: %v", err)
	}
	for i := 0; i < maxRelayPeers; i++ {
		r.peers[strings.Repeat("p", i+1)] = nil
	}
	r.answer("cid-cap", offer)
	if _, exists := r.peers["cid-cap"]; exists {
		t.Fatal("peer allocated past maxRelayPeers cap")
	}
	logged, _ = os.ReadFile(logFile.Name())
	if !strings.Contains(string(logged), "too many peers") {
		t.Fatalf("expected too many peers log, got %q", logged)
	}

	// Revoking an approved device drops its existing peer on the next readAllowed check.
	r.peers = map[string]*webrtc.PeerConnection{"cid-cap": nil}
	writeDevices(t, path)
	if !errors.Is(r.readAllowed("cid-cap"), errNotApproved) {
		t.Fatal("revoked cid still allowed")
	}
	if _, exists := r.peers["cid-cap"]; exists {
		t.Fatal("revoked cid's peer was not dropped")
	}
}

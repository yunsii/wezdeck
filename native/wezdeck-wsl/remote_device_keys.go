package main

// Device keys (split out of remote_session.go, 2026-11-24): a web console
// registers an ECDSA P-256 key, the host approves it, and every write is
// signed by it (verifyWrite) — the private key never leaves the device.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
)

type deviceRecord struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	PublicKey string `json:"public_key"` // base64url, uncompressed P-256 point
	At        string `json:"at"`
	// Info: what the browser says it is (UA client hints, else the UA), so
	// `--devices` tells "Chrome 157 · Android 16" from "Firefox 162 ·
	// Android 16" — the name alone ("Linux") could not; SeenAt: its last
	// register (every page load), to spot a device no longer used.
	Info   *deviceInfo `json:"info,omitempty"`
	SeenAt string      `json:"seen_at,omitempty"`
}

type deviceInfo struct {
	Browser    string `json:"browser,omitempty"`
	OS         string `json:"os,omitempty"`
	Model      string `json:"model,omitempty"`
	Mobile     bool   `json:"mobile,omitempty"`
	Standalone bool   `json:"standalone,omitempty"`
	Language   string `json:"language,omitempty"`
	Screen     string `json:"screen,omitempty"`
	UA         string `json:"ua,omitempty"`
}

// clean: what a client sent, safe to store and print (no control
// characters, so `--devices` cannot be spoofed with escape sequences).
func (i *deviceInfo) clean() *deviceInfo {
	if i == nil {
		return nil
	}
	return &deviceInfo{
		Browser: clip(printable(i.Browser), 40), OS: clip(printable(i.OS), 40),
		Model: clip(printable(i.Model), 40), Mobile: i.Mobile, Standalone: i.Standalone,
		Language: clip(printable(i.Language), 20), Screen: clip(printable(i.Screen), 20),
		UA: clip(printable(i.UA), 300),
	}
}

// seen refreshes a known device's info and last-seen time; it reports
// whether the file needs writing (changed info, or an hour since last seen —
// not every page load).
func (d *deviceRecord) seen(info *deviceInfo, now time.Time) bool {
	changed := info != nil && (d.Info == nil || *d.Info != *info)
	if changed {
		d.Info = info
	}
	last, err := time.Parse(time.RFC3339, d.SeenAt)
	if changed || err != nil || now.Sub(last) > time.Hour {
		d.SeenAt = now.Format(time.RFC3339)
		return true
	}
	return false
}

type deviceStore struct {
	Approved []deviceRecord `json:"approved"`
	Pending  []deviceRecord `json:"pending"`
}

var deviceMu sync.Mutex

func deviceFile() string {
	if p := os.Getenv("WEZDECK_REMOTE_DEVICES"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "wezdeck", "remote-devices.json")
}

func loadDevices() deviceStore {
	var s deviceStore
	if data, err := os.ReadFile(deviceFile()); err == nil {
		_ = json.Unmarshal(data, &s)
	}
	return s
}

// lockDevices takes the cross-process lock on the device store. The relay
// (register) and install-remote-relay.sh (--approve / --revoke) both
// read-modify-write the file; without a shared lock a register racing a
// revoke could write the revoked device back as approved.
func lockDevices() (unlock func()) {
	path := deviceFile() + ".lock"
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return func() {}
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_EX)
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		f.Close()
	}
}

// printable drops control characters (ESC, CR, BEL …): a device name is
// attacker-chosen and is printed in the owner's terminal by --devices.
func printable(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '\u2028' || r == '\u2029' {
			return -1
		}
		return r
	}, s)
}

func saveDevices(s deviceStore) error {
	// empty lists stay [] (not null) so other readers can iterate them
	if s.Approved == nil {
		s.Approved = []deviceRecord{}
	}
	if s.Pending == nil {
		s.Pending = []deviceRecord{}
	}
	_ = os.MkdirAll(filepath.Dir(deviceFile()), 0o700)
	data, _ := json.MarshalIndent(s, "", "  ")
	// write-then-rename: a reader never sees a half-written store
	tmp := deviceFile() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, deviceFile())
}

func deviceID(pub []byte) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:8])
}

func parsePublicKey(b64 string) (*ecdsa.PublicKey, []byte, error) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(b64, "="))
	if err != nil || len(raw) != 65 || raw[0] != 4 {
		return nil, nil, errors.New("public key must be an uncompressed P-256 point")
	}
	x := new(big.Int).SetBytes(raw[1:33])
	y := new(big.Int).SetBytes(raw[33:])
	if !elliptic.P256().IsOnCurve(x, y) {
		return nil, nil, errors.New("public key is not on P-256")
	}
	return &ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, raw, nil
}

// registerDevice records a pending key; approval happens on the host
// (install-remote-relay.sh --approve).
func registerDevice(args json.RawMessage) (any, error) {
	var a struct {
		PublicKey string      `json:"public_key"`
		Name      string      `json:"name"`
		Info      *deviceInfo `json:"info"`
	}
	if json.Unmarshal(args, &a) != nil {
		return nil, errors.New("invalid payload")
	}
	info := a.Info.clean()
	now := time.Now()
	_, raw, err := parsePublicKey(a.PublicKey)
	if err != nil {
		return nil, err
	}
	id := deviceID(raw)
	deviceMu.Lock()
	defer deviceMu.Unlock()
	defer lockDevices()()
	s := loadDevices()
	for i := range s.Approved {
		if s.Approved[i].ID == id {
			if s.Approved[i].seen(info, now) {
				_ = saveDevices(s)
			}
			return map[string]any{"v": 1, "ok": true, "id": id, "state": "approved"}, nil
		}
	}
	for i := range s.Pending {
		if s.Pending[i].ID == id {
			if s.Pending[i].seen(info, now) {
				_ = saveDevices(s)
			}
			return map[string]any{"v": 1, "ok": true, "id": id, "state": "pending"}, nil
		}
	}
	if len(s.Pending) >= 5 {
		s.Pending = s.Pending[1:]
	}
	s.Pending = append(s.Pending, deviceRecord{ID: id, Name: clip(printable(a.Name), 40), PublicKey: a.PublicKey,
		At: now.Format(time.RFC3339), Info: info, SeenAt: now.Format(time.RFC3339)})
	if err := saveDevices(s); err != nil {
		return nil, err
	}
	return map[string]any{"v": 1, "ok": true, "id": id, "state": "pending"}, nil
}

var (
	nonceMu   sync.Mutex
	nonceSeen = map[string]time.Time{}
)

type signedWrite struct {
	Action string          `json:"action"`
	Args   json.RawMessage `json:"args"`
	TS     int64           `json:"ts"`
	Nonce  string          `json:"nonce"`
}

// verifyWrite checks the frame's signature over its exact payload text and
// returns the signed action and args (unsigned frame fields are ignored).
func verifyWrite(frameAction string, args json.RawMessage) (*signedWrite, string, error) {
	var env struct {
		Device  string `json:"device"`
		Payload string `json:"payload"`
		Sig     string `json:"sig"`
	}
	if json.Unmarshal(args, &env) != nil || env.Payload == "" || env.Sig == "" {
		return nil, "", errors.New("write is not signed: enable writing on this device first")
	}
	s := loadDevices()
	var pub *ecdsa.PublicKey
	for _, d := range s.Approved {
		if d.ID == env.Device {
			pub, _, _ = parsePublicKey(d.PublicKey)
		}
	}
	if pub == nil {
		return nil, "", errors.New("device not approved: run install-remote-relay.sh --approve on the host")
	}
	sig, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(env.Sig, "="))
	if err != nil || len(sig) != 64 {
		return nil, "", errors.New("bad signature encoding")
	}
	digest := sha256.Sum256([]byte(env.Payload))
	if !ecdsa.Verify(pub, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		return nil, "", errors.New("signature does not verify")
	}
	var w signedWrite
	if json.Unmarshal([]byte(env.Payload), &w) != nil || w.Action != frameAction {
		return nil, "", errors.New("signed payload does not match the request")
	}
	skew := time.Since(time.UnixMilli(w.TS))
	if skew > 2*time.Minute || skew < -2*time.Minute {
		return nil, "", errors.New("request expired: check the phone's clock")
	}
	nonceMu.Lock()
	defer nonceMu.Unlock()
	loadNonces()
	for k, at := range nonceSeen {
		if time.Since(at) > 5*time.Minute {
			delete(nonceSeen, k)
		}
	}
	if _, dup := nonceSeen[w.Nonce]; dup || w.Nonce == "" {
		return nil, "", errors.New("replayed request")
	}
	nonceSeen[w.Nonce] = time.Now()
	saveNonces()
	return &w, env.Device, nil
}

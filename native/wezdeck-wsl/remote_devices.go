package main

// listDevices: the device store (remote-devices.json) as a list for the
// console's 设备授权 page on the host itself. Local only: serve.go answers
// it for the loopback Runtime; the relay does not (not in readRPC), so a
// paired phone cannot list the other devices. Public keys stay out.

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
)

type deviceView struct {
	ID     string      `json:"id"`
	State  string      `json:"state"` // approved | pending
	Name   string      `json:"name,omitempty"`
	At     string      `json:"at,omitempty"`
	SeenAt string      `json:"seen_at,omitempty"`
	Info   *deviceInfo `json:"info,omitempty"`
}

func listDevices() (any, error) {
	store := loadDevices()
	out := make([]deviceView, 0, len(store.Pending)+len(store.Approved))
	add := func(state string, list []deviceRecord) {
		for _, d := range list {
			out = append(out, deviceView{
				ID: printable(d.ID), State: state, Name: printable(d.Name),
				At: d.At, SeenAt: d.SeenAt, Info: d.Info.clean(),
			})
		}
	}
	add("pending", store.Pending)
	add("approved", store.Approved)
	return map[string]any{"devices": out}, nil
}

// setDeviceState: 批准 / 撤销 from the console on the host, the same edit
// as install-remote-relay.sh --approve / --revoke (same lock, atomic save).
// Local only like listDevices: serve.go answers it for the loopback
// Runtime's write path; the relay never does. The relay re-reads the store
// on every read and write, so a revoke cuts that device at once.
func setDeviceState(action string, args json.RawMessage) (any, error) {
	var a struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &a); err != nil || a.ID == "" {
		return nil, fmt.Errorf("id required")
	}
	unlock := lockDevices()
	defer unlock()
	store := loadDevices()
	switch action {
	case "device.approve":
		i := slices.IndexFunc(store.Pending, func(d deviceRecord) bool { return d.ID == a.ID })
		if i < 0 {
			return nil, fmt.Errorf("no pending device %s", a.ID)
		}
		store.Approved = append(store.Approved, store.Pending[i])
		store.Pending = slices.Delete(store.Pending, i, i+1)
	case "device.revoke":
		before := len(store.Approved)
		store.Approved = slices.DeleteFunc(store.Approved, func(d deviceRecord) bool { return d.ID == a.ID })
		if len(store.Approved) == before {
			return nil, fmt.Errorf("no approved device %s", a.ID)
		}
	default:
		return nil, fmt.Errorf("unknown action %s", action)
	}
	if err := saveDevices(store); err != nil {
		return nil, err
	}
	relayLogf("device_"+strings.TrimPrefix(action, "device."), "via=local device=%s", printable(a.ID))
	return listDevices()
}

package main

// listDevices: the device store (remote-devices.json) as a list for the
// console's 设备授权 page on the host itself. Local only: serve.go answers
// it for the loopback Runtime; the relay does not (not in readRPC), so a
// paired phone cannot list the other devices. Public keys stay out.

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

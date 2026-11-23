package main

// `usage` (2026-11-24): today's Cloudflare usage, for approved devices only.
// The Worker reads it with its own analytics token, but used to hand it to
// anyone holding the shared client token — a revoked or never-approved
// browser included. Now the page asks the host over the relay (the read
// gate applies, relay_auth.go) and the host fetches /relay/usage with the
// host token, the only credential the Worker accepts there.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"
)

// usageURL: the relay URL (wss://…/relay/host?room=…) → https://…/relay/usage?room=…
func usageURL(relayURL string) (string, error) {
	u, err := url.Parse(relayURL)
	if err != nil || u.Host == "" {
		return "", errors.New("the relay URL is not a URL")
	}
	switch u.Scheme {
	case "wss":
		u.Scheme = "https"
	case "ws":
		u.Scheme = "http"
	}
	u.Path = "/relay/usage"
	return u.String(), nil
}

var usageClient = &http.Client{Timeout: 15 * time.Second}

func fetchUsage() (any, error) {
	target, err := usageURL(relayURL())
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("WEZDECK_RELAY_HOST_TOKEN"))
	res, err := usageClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("usage: %w", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("usage: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("usage: HTTP %d", res.StatusCode)
	}
	if !json.Valid(body) {
		return nil, errors.New("usage: not JSON")
	}
	return json.RawMessage(body), nil
}

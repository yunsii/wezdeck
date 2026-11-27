package main

// Configuration, status read and management write actions for the background
// session auto-titler (`session.autotitle.status` / `session.autotitle.update`).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

type autoTitleConfig struct {
	Enabled   bool   `json:"enabled"`
	Provider  string `json:"provider,omitempty"`   // "" (auto) | "grok" | "claude" | "codex"
	IntervalS int    `json:"interval_s,omitempty"` // 10..600; 0 = default (20s)
}

type autoTitleProviderInfo struct {
	ID        string `json:"id"`
	Available bool   `json:"available"`
	Model     string `json:"model"`
}

type autoTitleStatusItem struct {
	SessionID string `json:"session_id"`
	Agent     string `json:"agent"`
	Title     string `json:"title"`
	Source    string `json:"source"` // "auto" | "locked" | "native"
	Provider  string `json:"provider,omitempty"`
	UpdatedAt int64  `json:"updated_at,omitempty"`
	UserTurns int    `json:"user_turns,omitempty"`
	Locked    bool   `json:"locked,omitempty"`
	Active    bool   `json:"active"`
}

var (
	autoTitleCfgMu sync.Mutex
	activeTitler   *autoTitler
	activeTitlerMu sync.Mutex
)

func setActiveTitler(t *autoTitler) {
	activeTitlerMu.Lock()
	activeTitler = t
	activeTitlerMu.Unlock()
}

func getActiveTitler() *autoTitler {
	activeTitlerMu.Lock()
	defer activeTitlerMu.Unlock()
	if activeTitler == nil {
		activeTitler = newAutoTitler()
	}
	return activeTitler
}

func autoTitleConfigPath() string {
	if p := strings.TrimSpace(os.Getenv("WEZDECK_AUTOTITLE_CONFIG_FILE")); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".local", "state", "wezdeck", "autotitle-config.json")
}

func loadAutoTitleConfig() autoTitleConfig {
	cfg := autoTitleConfig{
		Enabled:   strings.TrimSpace(os.Getenv("WEZDECK_AUTOTITLE")) != "0",
		Provider:  strings.TrimSpace(os.Getenv("WEZDECK_AUTOTITLE_PROVIDER")),
		IntervalS: int(autoTitleInterval().Seconds()),
	}
	path := autoTitleConfigPath()
	if path == "" {
		return cfg
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg
	}
	var disk struct {
		Enabled   *bool   `json:"enabled"`
		Provider  *string `json:"provider"`
		IntervalS *int    `json:"interval_s"`
	}
	if json.Unmarshal(data, &disk) != nil {
		return cfg
	}
	if disk.Enabled != nil {
		cfg.Enabled = *disk.Enabled
	}
	if disk.Provider != nil {
		cfg.Provider = strings.TrimSpace(*disk.Provider)
	}
	if disk.IntervalS != nil && *disk.IntervalS >= 10 && *disk.IntervalS <= 600 {
		cfg.IntervalS = *disk.IntervalS
	}
	return cfg
}

func saveAutoTitleConfig(cfg autoTitleConfig) error {
	path := autoTitleConfigPath()
	if path == "" {
		return errors.New("autotitle config path unavailable")
	}
	autoTitleCfgMu.Lock()
	defer autoTitleCfgMu.Unlock()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	body, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".autotitle-config-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(append(body, '\n')); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	_ = tmp.Chmod(0o600)
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

func autoTitleProviderExists(bin string) bool {
	if _, err := exec.LookPath(bin); err == nil {
		return true
	}
	home, _ := os.UserHomeDir()
	if home == "" {
		return false
	}
	for _, dir := range []string{".local/bin", ".grok/bin", ".codex/bin"} {
		p := filepath.Join(home, dir, bin)
		if info, err := os.Stat(p); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return true
		}
	}
	return false
}

func envOrDefault(keys []string, fallback string) string {
	for _, k := range keys {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
	}
	return fallback
}

func listAutoTitleProviders() []autoTitleProviderInfo {
	return []autoTitleProviderInfo{
		{
			ID:        "grok",
			Available: autoTitleProviderExists("grok"),
			Model:     envOrDefault([]string{"WEZDECK_AUTOTITLE_MODEL_GROK", "ADV_MODEL_GROK"}, "grok-4.5"),
		},
		{
			ID:        "claude",
			Available: autoTitleProviderExists("claude"),
			Model:     envOrDefault([]string{"WEZDECK_AUTOTITLE_MODEL_CLAUDE", "ADV_MODEL_CLAUDE"}, "claude-opus-5[1m]"),
		},
		{
			ID:        "codex",
			Available: autoTitleProviderExists("codex"),
			Model:     envOrDefault([]string{"WEZDECK_AUTOTITLE_MODEL_CODEX", "ADV_MODEL_CODEX"}, "gpt-5.5"),
		},
	}
}

func resolveEffectiveAutoTitleProvider(cfgProvider string, providers []autoTitleProviderInfo) (id, model string) {
	if cfgProvider != "" {
		for _, p := range providers {
			if p.ID == cfgProvider {
				return p.ID, p.Model
			}
		}
		return cfgProvider, ""
	}
	for _, p := range providers {
		if p.Available {
			return p.ID, p.Model
		}
	}
	return "", ""
}

// resolveSessionTitleSource describes where resolveSessionTitle got its title,
// surfaced in 会话信息 (remote_meta.go) so users can see whether a title is
// automatic (and which CLI wrote it), manually locked, or native.
func resolveSessionTitleSource(sessionID, path, agent string) string {
	if agent == "claude" && path != "" && claudeCustomTitle(path) != "" {
		return "manual"
	}
	if sessionID != "" {
		if entries := loadAutoTitles(); entries != nil {
			if rec, ok := entries[sessionID]; ok && rec.Title != "" {
				if rec.Locked {
					return "manual"
				}
				if rec.Provider != "" {
					return "auto · " + rec.Provider
				}
				return "auto"
			}
		}
	}
	if readSessionTitle(path, agent) != "" {
		return "native"
	}
	return ""
}

func autoTitleStatus() (any, error) {
	cfg := loadAutoTitleConfig()
	providers := listAutoTitleProviders()
	effID, effModel := resolveEffectiveAutoTitleProvider(cfg.Provider, providers)
	saved := loadAutoTitles()
	live, _ := liveSessions()

	seen := map[string]bool{}
	items := make([]autoTitleStatusItem, 0, len(live)+len(saved))

	for id, e := range live {
		seen[id] = true
		path, agent := findTranscript(id)
		if agent == "" {
			agent = strings.ToLower(strings.TrimSpace(e.AgentName))
		}
		rec, hasRec := saved[id]
		source := "native"
		provider := ""
		locked := false
		var updatedAt int64
		userTurns := 0
		if agent == "claude" && path != "" && claudeCustomTitle(path) != "" {
			source = "locked"
			locked = true
		} else if hasRec && rec.Title != "" {
			if rec.Locked {
				source = "locked"
				locked = true
			} else {
				source = "auto"
				provider = rec.Provider
			}
			updatedAt = rec.UpdatedAt
			userTurns = rec.UserTurns
		}
		title := resolveSessionTitle(id, path, agent)
		if title == "" && !hasRec {
			continue
		}
		items = append(items, autoTitleStatusItem{
			SessionID: id,
			Agent:     agent,
			Title:     title,
			Source:    source,
			Provider:  provider,
			UpdatedAt: updatedAt,
			UserTurns: userTurns,
			Locked:    locked,
			Active:    true,
		})
	}

	for id, rec := range saved {
		if seen[id] || rec.Title == "" {
			continue
		}
		source := "auto"
		if rec.Locked {
			source = "locked"
		}
		items = append(items, autoTitleStatusItem{
			SessionID: id,
			Agent:     rec.Agent,
			Title:     rec.Title,
			Source:    source,
			Provider:  rec.Provider,
			UpdatedAt: rec.UpdatedAt,
			UserTurns: rec.UserTurns,
			Locked:    rec.Locked,
			Active:    false,
		})
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].Active != items[j].Active {
			return items[i].Active
		}
		if items[i].UpdatedAt != items[j].UpdatedAt {
			return items[i].UpdatedAt > items[j].UpdatedAt
		}
		return items[i].SessionID < items[j].SessionID
	})
	if len(items) > 40 {
		items = items[:40]
	}

	return map[string]any{
		"enabled":            cfg.Enabled,
		"provider":           cfg.Provider,
		"effective_provider": effID,
		"effective_model":    effModel,
		"interval_s":         cfg.IntervalS,
		"providers":          providers,
		"entries":            items,
	}, nil
}

func unlockSessionTitle(sessionID string) error {
	path := autoTitleStorePath()
	if path == "" || sessionID == "" {
		return nil
	}
	autoTitleCache.mu.Lock()
	defer autoTitleCache.mu.Unlock()
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var doc autoTitleFile
	if json.Unmarshal(data, &doc) != nil || doc.Entries == nil {
		return nil
	}
	rec, ok := doc.Entries[sessionID]
	if !ok {
		return nil
	}
	rec.Locked = false
	rec.LastDigest = ""
	doc.Entries[sessionID] = rec
	body, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".session-titles-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(append(body, '\n')); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	_ = tmp.Chmod(0o600)
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if info, err := os.Stat(path); err == nil {
		autoTitleCache.path = path
		autoTitleCache.info = info
		autoTitleCache.entries = cloneAutoTitles(doc.Entries)
	}
	return nil
}

func updateAutoTitle(args json.RawMessage) (any, error) {
	var req struct {
		Op        string  `json:"op"`
		Enabled   *bool   `json:"enabled"`
		Provider  *string `json:"provider"`
		IntervalS *int    `json:"interval_s"`
		SessionID string  `json:"session_id"`
	}
	if err := json.Unmarshal(args, &req); err != nil {
		return nil, errors.New("invalid autotitle update payload")
	}
	switch req.Op {
	case "", "configure":
		cfg := loadAutoTitleConfig()
		if req.Enabled != nil {
			cfg.Enabled = *req.Enabled
		}
		if req.Provider != nil {
			p := strings.ToLower(strings.TrimSpace(*req.Provider))
			if p != "" && p != "grok" && p != "claude" && p != "codex" {
				return nil, fmt.Errorf("unsupported provider: %s", p)
			}
			cfg.Provider = p
		}
		if req.IntervalS != nil {
			if *req.IntervalS < 10 || *req.IntervalS > 600 {
				return nil, errors.New("interval_s must be between 10 and 600")
			}
			cfg.IntervalS = *req.IntervalS
		}
		if err := saveAutoTitleConfig(cfg); err != nil {
			return nil, err
		}
		relayLogf("session_title_auto", "outcome=configured enabled=%t provider=%q interval_s=%d",
			cfg.Enabled, cfg.Provider, cfg.IntervalS)
		return autoTitleStatus()

	case "unlock":
		if !sessionIDPattern.MatchString(req.SessionID) {
			return nil, errors.New("invalid session_id")
		}
		if err := unlockSessionTitle(req.SessionID); err != nil {
			return nil, err
		}
		relayLogf("session_title_auto", "session_id=%s outcome=unlocked", req.SessionID)
		return autoTitleStatus()

	case "refresh":
		titler := getActiveTitler()
		if req.SessionID != "" {
			if !sessionIDPattern.MatchString(req.SessionID) {
				return nil, errors.New("invalid session_id")
			}
			entries, err := liveSessions()
			if err != nil {
				return nil, err
			}
			e, ok := entries[req.SessionID]
			if !ok {
				return nil, errors.New("session is not active")
			}
			path, agent := findTranscript(req.SessionID)
			if path == "" || agent == "" {
				return nil, errors.New("session has no transcript yet")
			}
			if agent == "claude" && claudeCustomTitle(path) != "" {
				return nil, errors.New("session has a manual /rename title")
			}
			saved := loadAutoTitles()
			prev, hasPrev := saved[req.SessionID]
			if hasPrev && prev.Locked {
				return nil, errors.New("session title is locked; unlock it first")
			}
			currentTitle := prev.Title
			if currentTitle == "" {
				currentTitle = readSessionTitle(path, agent)
			}
			tctx := buildAutoTitleContext(e, path, agent, currentTitle)
			if tctx.substantiveUsers == 0 {
				return nil, errors.New("session has no substantive user message yet")
			}
			go titler.runCandidate(context.Background(), autoTitleCandidate{
				id: req.SessionID, entry: e, path: path, agent: agent,
				currentTitle: currentTitle, prev: prev, hasPrev: hasPrev,
				ctx: tctx, trigger: "manual",
			})
			return map[string]any{"ok": true, "queued": 1}, nil
		}
		go func() {
			if entries, err := liveSessions(); err == nil && len(entries) > 0 {
				titler.sweep(context.Background(), entries)
			}
		}()
		return map[string]any{"ok": true, "queued": "sweep"}, nil

	default:
		return nil, fmt.Errorf("unknown op: %s", req.Op)
	}
}

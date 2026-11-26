package main

// Local loopback OTLP/HTTP collector (`wezdeck-wsl otel`) for host-side agent
// token output-rate observability.
//
// Listens strictly on loopback (default 127.0.0.1:43180) and accepts OTLP/HTTP
// JSON and Protobuf log records on /v1/logs (Claude Code, Codex CLI, Grok
// Build). Extracts ONLY timing and token-count telemetry — prompt/response text
// is never stored — writes rotated NDJSON samples to WSL ext4 and publishes an
// atomic status.json snapshot for CLI reports, badges and the Web console.

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultOTelListen       = "127.0.0.1:43180"
	otelLogRotateBytes      = 10 << 20 // 10 MiB
	otelLogRotateBackups    = 3
	otelStatusSessionMaxAge = 2 * time.Hour
	otelStatusSessionCap    = 64
	otelRateMinTokens       = 20
	otelRateMinDurationMS   = 200
)

type tokenRateSample struct {
	TS              string  `json:"ts"`
	TSMS            int64   `json:"ts_ms"`
	Source          string  `json:"source"` // otel | transcript
	Provider        string  `json:"provider"`
	Profile         string  `json:"profile"`
	Model           string  `json:"model"`
	SessionID       string  `json:"session_id,omitempty"`
	PaneID          string  `json:"pane_id,omitempty"`
	EventName       string  `json:"event_name,omitempty"`
	EventKind       string  `json:"event_kind,omitempty"`
	QuerySource     string  `json:"query_source,omitempty"`
	OutputTokens    int     `json:"output_tokens"`
	ReasoningTokens int     `json:"reasoning_tokens,omitempty"`
	InputTokens     int     `json:"input_tokens,omitempty"`
	CacheReadTokens int     `json:"cache_read_tokens,omitempty"`
	DurationMS      int64   `json:"duration_ms"`
	TTFTMS          int64   `json:"ttft_ms,omitempty"`
	TokPerS         float64 `json:"tok_per_s"`
	DecodeTokPerS   float64 `json:"decode_tok_per_s,omitempty"`
	Noisy           bool    `json:"noisy,omitempty"`
}

type otelSessionRate struct {
	Provider          string  `json:"provider"`
	Profile           string  `json:"profile"`
	Model             string  `json:"model"`
	TSMS              int64   `json:"ts_ms"`
	LastTokPerS       float64 `json:"last_tok_per_s"`
	EWMATokPerS       float64 `json:"ewma_tok_per_s"`
	LastDecodeTokPerS float64 `json:"last_decode_tok_per_s,omitempty"`
	LastOutputTokens  int     `json:"last_output_tokens"`
	LastDurationMS    int64   `json:"last_duration_ms"`
	LastTTFTMS        int64   `json:"last_ttft_ms,omitempty"`
	Samples           int     `json:"samples"`
}

type otelStatusSnapshot struct {
	SchemaVersion   int                         `json:"schema_version"`
	HeartbeatAtMS   int64                       `json:"heartbeat_at_ms"`
	StartedAtMS     int64                       `json:"started_at_ms"`
	PID             int                         `json:"pid"`
	Listen          string                      `json:"listen"`
	Version         string                      `json:"version"`
	ReceivedRecords int64                       `json:"received_records"`
	AcceptedSamples int64                       `json:"accepted_samples"`
	RecentSessions  map[string]*otelSessionRate `json:"recent_sessions"`
}

type codexStreamAcc struct {
	updatedAtMS   int64
	apiDurationMS int64
	sseDurationMS int64
	firstTSNS     uint64
	lastTSNS      uint64
}

type otelCollector struct {
	mu              sync.Mutex
	listen          string
	logPath         string
	statusPath      string
	captureRawPath  string
	startedAtMS     int64
	receivedRecords int64
	acceptedSamples int64
	sessions        map[string]*otelSessionRate
	codexStreams    map[string]*codexStreamAcc
	lastStatusWrite time.Time
	nowFunc         func() time.Time
}

func defaultOTelPaths() (logPath, statusPath string) {
	stateRoot := os.Getenv("XDG_STATE_HOME")
	if strings.TrimSpace(stateRoot) == "" {
		home, _ := os.UserHomeDir()
		stateRoot = filepath.Join(home, ".local", "state")
	}
	base := filepath.Join(stateRoot, "wezterm-runtime")
	logPath = os.Getenv("WEZDECK_TOKEN_RATE_LOG")
	if strings.TrimSpace(logPath) == "" {
		logPath = filepath.Join(base, "logs", "agent-token-rate.jsonl")
	}
	statusPath = os.Getenv("WEZDECK_TOKEN_RATE_STATUS")
	if strings.TrimSpace(statusPath) == "" {
		statusPath = filepath.Join(base, "state", "agent-token-rate", "status.json")
	}
	return logPath, statusPath
}

func newOTelCollector(listen, logPath, statusPath, captureRawPath string) *otelCollector {
	now := time.Now()
	return &otelCollector{
		listen:         listen,
		logPath:        logPath,
		statusPath:     statusPath,
		captureRawPath: captureRawPath,
		startedAtMS:    now.UnixMilli(),
		sessions:       map[string]*otelSessionRate{},
		codexStreams:   map[string]*codexStreamAcc{},
		nowFunc:        time.Now,
	}
}

func (c *otelCollector) now() time.Time {
	if c.nowFunc != nil {
		return c.nowFunc()
	}
	return time.Now()
}

func round1(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(v*10) / 10
}

func attrString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		v, ok := m[k]
		if !ok || v == nil {
			continue
		}
		switch t := v.(type) {
		case string:
			if s := strings.TrimSpace(t); s != "" {
				return s
			}
		case int64:
			return strconv.FormatInt(t, 10)
		case float64:
			return strconv.FormatFloat(t, 'f', -1, 64)
		case bool:
			if t {
				return "true"
			}
			return "false"
		}
	}
	return ""
}

func attrFloat(m map[string]any, keys ...string) (float64, bool) {
	for _, k := range keys {
		v, ok := m[k]
		if !ok || v == nil {
			continue
		}
		switch t := v.(type) {
		case int64:
			return float64(t), true
		case int:
			return float64(t), true
		case float64:
			if !math.IsNaN(t) && !math.IsInf(t, 0) {
				return t, true
			}
		case string:
			s := strings.TrimSpace(t)
			if s == "" {
				continue
			}
			if f, err := strconv.ParseFloat(s, 64); err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) {
				return f, true
			}
		}
	}
	return 0, false
}

func attrInt(m map[string]any, keys ...string) int {
	if f, ok := attrFloat(m, keys...); ok {
		return int(math.Round(f))
	}
	return 0
}

func attrInt64(m map[string]any, keys ...string) int64 {
	if f, ok := attrFloat(m, keys...); ok {
		return int64(math.Round(f))
	}
	return 0
}

func inferProvider(merged map[string]any, eventName, scopeName string) string {
	if p := strings.ToLower(attrString(merged, "wezdeck.provider")); p != "" {
		return p
	}
	hay := strings.ToLower(strings.Join([]string{
		attrString(merged, "service.name"),
		eventName,
		scopeName,
	}, " "))
	switch {
	case strings.Contains(hay, "claude"):
		return "claude"
	case strings.Contains(hay, "codex"):
		return "codex"
	case strings.Contains(hay, "grok"):
		return "grok"
	case strings.Contains(hay, "agy") || strings.Contains(hay, "antigravity"):
		return "agy"
	default:
		if svc := attrString(merged, "service.name"); svc != "" {
			return strings.ToLower(svc)
		}
		return "unknown"
	}
}

// extractTokenRateSample normalizes a single OTLP log record into a
// tokenRateSample when it carries both output tokens and duration.
// Optional codexStreams tracks Codex 0.172+ multi-event SSE streams where
// `codex.api_request` + per-chunk `codex.sse_event` carry `duration_ms` and
// the terminal `response.completed` summary carries `output_token_count`.
func extractTokenRateSample(rec otelLogRecord, fallbackNow time.Time, codexStreams map[string]*codexStreamAcc) (tokenRateSample, bool) {
	merged := make(map[string]any, len(rec.Resource)+len(rec.Attributes))
	for k, v := range rec.Resource {
		merged[k] = v
	}
	for k, v := range rec.Attributes {
		merged[k] = v
	}

	// Prefer explicit attribute `event.name` over LogRecord.event_name when the
	// latter is a Rust call-site path (Codex sets event_name="event otel/src/...").
	eventName := attrString(merged, "event.name", "event_name")
	if eventName == "" {
		eventName = strings.TrimSpace(rec.EventName)
	}
	if eventName == "" {
		if s, ok := rec.Body.(string); ok && len(s) <= 80 && !strings.ContainsAny(s, "\r\n") {
			eventName = strings.TrimSpace(s)
		}
	}
	eventKind := attrString(merged, "event.kind", "event_kind")
	provider := inferProvider(merged, eventName, rec.ScopeName)
	sessionID := attrString(merged,
		"session.id",
		"conversation.id",
		"session_id",
		"thread.id",
		"thread_id",
	)

	// Accumulate Codex multi-event stream timing (api_request + per-chunk sse_event).
	if provider == "codex" && codexStreams != nil && sessionID != "" {
		nowMS := fallbackNow.UnixMilli()
		switch eventName {
		case "codex.api_request", "codex.websocket_request":
			statusCode := attrInt(merged, "http.response.status_code", "status_code")
			if statusCode == 0 || (statusCode >= 200 && statusCode < 300) {
				codexStreams[sessionID] = &codexStreamAcc{
					updatedAtMS:   nowMS,
					apiDurationMS: attrInt64(merged, "duration_ms"),
					firstTSNS:     rec.TimeUnixNano,
					lastTSNS:      rec.TimeUnixNano,
				}
			}
		case "codex.sse_event", "codex.websocket_event":
			if d := attrInt64(merged, "duration_ms"); d > 0 {
				acc := codexStreams[sessionID]
				if acc == nil {
					acc = &codexStreamAcc{firstTSNS: rec.TimeUnixNano}
					codexStreams[sessionID] = acc
				}
				acc.updatedAtMS = nowMS
				acc.sseDurationMS += d
				if rec.TimeUnixNano > 0 {
					if acc.firstTSNS == 0 {
						acc.firstTSNS = rec.TimeUnixNano
					}
					acc.lastTSNS = rec.TimeUnixNano
				}
			}
		}
	}

	// Codex emits intermediate SSE delta events without final usage; only
	// terminal events or events carrying output tokens produce a sample.
	outputTokens := attrInt(merged,
		"output_tokens",
		"output_token_count",
		"gen_ai.usage.output_tokens",
		"outputTokens",
		"completion_tokens",
		"llm.usage.completion_tokens",
	)
	reasoningTokens := attrInt(merged,
		"reasoning_output_tokens",
		"reasoning_token_count",
		"reasoning_tokens",
		"reasoningTokens",
		"thinking_tokens",
	)
	if outputTokens <= 0 && reasoningTokens > 0 {
		outputTokens = reasoningTokens
	}
	if outputTokens <= 0 {
		return tokenRateSample{}, false
	}

	durationMS := attrInt64(merged,
		"duration_ms",
		"durationMs",
		"api_duration_ms",
		"latency_ms",
		"codex.api_request.duration_ms",
		"response_ms",
	)
	if durationMS <= 0 {
		if sec, ok := attrFloat(merged, "duration_s", "duration_seconds"); ok && sec > 0 {
			durationMS = int64(math.Round(sec * 1000))
		}
	}

	var pureStreamMS int64
	var codexAPIMS int64
	if provider == "codex" && codexStreams != nil && sessionID != "" {
		if acc := codexStreams[sessionID]; acc != nil {
			delete(codexStreams, sessionID)
			codexAPIMS = acc.apiDurationMS
			if acc.sseDurationMS > 0 {
				pureStreamMS = acc.sseDurationMS
			}
			if durationMS <= 0 {
				if acc.apiDurationMS+acc.sseDurationMS > 0 {
					durationMS = acc.apiDurationMS + acc.sseDurationMS
				} else if rec.TimeUnixNano > acc.firstTSNS && acc.firstTSNS > 0 {
					durationMS = int64((rec.TimeUnixNano - acc.firstTSNS) / 1_000_000)
				}
			}
		}
	}
	if durationMS <= 0 {
		return tokenRateSample{}, false
	}

	ttftMS := attrInt64(merged,
		"ttft_ms",
		"ttftMs",
		"time_to_first_token_ms",
		"first_token_ms",
		"codex.turn.ttft.duration_ms",
	)
	// Codex's sse_event ttft_ms measures time after the HTTP 200 stream opened;
	// add codex.api_request duration_ms so ttft_ms matches Claude's end-to-end
	// request-to-first-token definition.
	if provider == "codex" && codexAPIMS > 0 {
		ttftMS += codexAPIMS
	}

	inputTokens := attrInt(merged,
		"input_tokens",
		"input_token_count",
		"gen_ai.usage.input_tokens",
		"inputTokens",
		"prompt_tokens",
	)
	cacheReadTokens := attrInt(merged,
		"cache_read_tokens",
		"cached_token_count",
		"cached_input_tokens",
		"cache_read_input_tokens",
		"cachedReadTokens",
	)

	ts := fallbackNow.UTC()
	if rec.TimeUnixNano > 0 {
		ts = time.Unix(0, int64(rec.TimeUnixNano)).UTC()
	}

	profile := attrString(merged, "wezdeck.profile")
	if profile == "" {
		profile = provider
	}
	model := attrString(merged,
		"model",
		"gen_ai.response.model",
		"gen_ai.request.model",
		"model_id",
		"llm.model",
	)
	paneID := attrString(merged, "wezdeck.pane")
	querySource := attrString(merged, "query_source")

	tokPerS := round1(float64(outputTokens) / (float64(durationMS) / 1000.0))
	var decodeTokPerS float64
	if pureStreamMS > 0 {
		decodeTokPerS = round1(float64(outputTokens) / (float64(pureStreamMS) / 1000.0))
	} else if ttftMS > 0 && durationMS > ttftMS {
		decodeTokPerS = round1(float64(outputTokens) / (float64(durationMS-ttftMS) / 1000.0))
	}
	noisy := outputTokens < otelRateMinTokens || durationMS < otelRateMinDurationMS

	return tokenRateSample{
		TS:              ts.Format(time.RFC3339Nano),
		TSMS:            ts.UnixMilli(),
		Source:          "otel",
		Provider:        provider,
		Profile:         profile,
		Model:           model,
		SessionID:       sessionID,
		PaneID:          paneID,
		EventName:       eventName,
		EventKind:       eventKind,
		QuerySource:     querySource,
		OutputTokens:    outputTokens,
		ReasoningTokens: reasoningTokens,
		InputTokens:     inputTokens,
		CacheReadTokens: cacheReadTokens,
		DurationMS:      durationMS,
		TTFTMS:          ttftMS,
		TokPerS:         tokPerS,
		DecodeTokPerS:   decodeTokPerS,
		Noisy:           noisy,
	}, true
}

// safeSchemaStringKeys limits what string values are kept in opt-in
// `--capture-raw` schema calibration logs so prompts/code/tokens never land on
// disk even during debugging.
var safeSchemaStringKeys = map[string]bool{
	"event.name":             true,
	"event_name":             true,
	"event.kind":             true,
	"event_kind":             true,
	"model":                  true,
	"gen_ai.request.model":   true,
	"gen_ai.response.model":  true,
	"model_id":               true,
	"query_source":           true,
	"service.name":           true,
	"service.version":        true,
	"app.version":            true,
	"success":                true,
	"status":                 true,
	"status_code":            true,
	"http.status_code":       true,
	"stop_reason":            true,
	"wezdeck.provider":       true,
	"wezdeck.profile":        true,
	"wezdeck.pane":           true,
}

func sanitizeAttrsForSchema(attrs map[string]any) map[string]any {
	out := make(map[string]any, len(attrs))
	for k, v := range attrs {
		switch t := v.(type) {
		case int64, int, float64, bool:
			out[k] = t
		case string:
			if safeSchemaStringKeys[k] && len(t) <= 80 && !strings.ContainsAny(t, "\r\n") {
				out[k] = t
			} else if _, err := strconv.ParseFloat(strings.TrimSpace(t), 64); err == nil && len(t) <= 24 {
				out[k] = t
			} else {
				out[k] = fmt.Sprintf("str(len=%d)", len(t))
			}
		case map[string]any:
			out[k] = sanitizeAttrsForSchema(t)
		case []any:
			out[k] = fmt.Sprintf("arr(len=%d)", len(t))
		default:
			out[k] = fmt.Sprintf("type(%T)", v)
		}
	}
	return out
}

func (c *otelCollector) ingestRecords(records []otelLogRecord, contentType string) (accepted int) {
	now := c.now()
	var lines [][]byte
	var rawLines [][]byte

	c.mu.Lock()
	for _, rec := range records {
		c.receivedRecords++
		sample, ok := extractTokenRateSample(rec, now, c.codexStreams)
		if ok {
			accepted++
			c.acceptedSamples++
			if b, err := json.Marshal(sample); err == nil {
				lines = append(lines, b)
			}
			if !sample.Noisy && sample.SessionID != "" {
				c.updateSessionLocked(sample)
			}
		}
		if c.captureRawPath != "" {
			evName := strings.TrimSpace(rec.EventName)
			if evName == "" {
				evName = attrString(rec.Attributes, "event.name", "event_name")
			}
			entry := map[string]any{
				"ts":           now.UTC().Format(time.RFC3339Nano),
				"content_type": contentType,
				"scope":        rec.ScopeName,
				"event_name":   evName,
				"matched":      ok,
				"resource":     sanitizeAttrsForSchema(rec.Resource),
				"attributes":   sanitizeAttrsForSchema(rec.Attributes),
			}
			if b, err := json.Marshal(entry); err == nil {
				rawLines = append(rawLines, b)
			}
		}
	}
	shouldWriteStatus := accepted > 0 && time.Since(c.lastStatusWrite) >= 500*time.Millisecond
	c.mu.Unlock()

	if len(lines) > 0 {
		_ = appendJSONLRotated(c.logPath, lines, otelLogRotateBytes, otelLogRotateBackups)
	}
	if len(rawLines) > 0 && c.captureRawPath != "" {
		_ = appendJSONLRotated(c.captureRawPath, rawLines, otelLogRotateBytes, 2)
	}
	if shouldWriteStatus {
		_ = c.writeStatus()
	}
	return accepted
}

func (c *otelCollector) updateSessionLocked(s tokenRateSample) {
	prev, ok := c.sessions[s.SessionID]
	if !ok {
		c.sessions[s.SessionID] = &otelSessionRate{
			Provider:          s.Provider,
			Profile:           s.Profile,
			Model:             s.Model,
			TSMS:              s.TSMS,
			LastTokPerS:       s.TokPerS,
			EWMATokPerS:       s.TokPerS,
			LastDecodeTokPerS: s.DecodeTokPerS,
			LastOutputTokens:  s.OutputTokens,
			LastDurationMS:    s.DurationMS,
			LastTTFTMS:        s.TTFTMS,
			Samples:           1,
		}
	} else {
		prev.Provider = s.Provider
		prev.Profile = s.Profile
		if s.Model != "" {
			prev.Model = s.Model
		}
		prev.TSMS = s.TSMS
		prev.LastTokPerS = s.TokPerS
		// EWMA alpha=0.4 favors recent steps while damping single-step jitter.
		prev.EWMATokPerS = round1(0.4*s.TokPerS + 0.6*prev.EWMATokPerS)
		if s.DecodeTokPerS > 0 {
			prev.LastDecodeTokPerS = s.DecodeTokPerS
		}
		prev.LastOutputTokens = s.OutputTokens
		prev.LastDurationMS = s.DurationMS
		if s.TTFTMS > 0 {
			prev.LastTTFTMS = s.TTFTMS
		}
		prev.Samples++
	}
	c.pruneSessionsLocked(s.TSMS)
}

func (c *otelCollector) pruneSessionsLocked(nowMS int64) {
	cutoff := nowMS - otelStatusSessionMaxAge.Milliseconds()
	for id, st := range c.sessions {
		if st.TSMS < cutoff {
			delete(c.sessions, id)
		}
	}
	streamCutoff := nowMS - (30 * time.Minute).Milliseconds()
	for id, acc := range c.codexStreams {
		if acc.updatedAtMS < streamCutoff {
			delete(c.codexStreams, id)
		}
	}
	for len(c.sessions) > otelStatusSessionCap {
		var oldestID string
		var oldestTS int64 = math.MaxInt64
		for id, st := range c.sessions {
			if st.TSMS < oldestTS {
				oldestTS = st.TSMS
				oldestID = id
			}
		}
		if oldestID == "" {
			break
		}
		delete(c.sessions, oldestID)
	}
}

func (c *otelCollector) snapshot() otelStatusSnapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	nowMS := c.now().UnixMilli()
	c.pruneSessionsLocked(nowMS)
	sessions := make(map[string]*otelSessionRate, len(c.sessions))
	for k, v := range c.sessions {
		cp := *v
		sessions[k] = &cp
	}
	return otelStatusSnapshot{
		SchemaVersion:   1,
		HeartbeatAtMS:   nowMS,
		StartedAtMS:     c.startedAtMS,
		PID:             os.Getpid(),
		Listen:          c.listen,
		Version:         buildVersion,
		ReceivedRecords: c.receivedRecords,
		AcceptedSamples: c.acceptedSamples,
		RecentSessions:  sessions,
	}
}

func (c *otelCollector) writeStatus() error {
	if c.statusPath == "" {
		return nil
	}
	snap := c.snapshot()
	data, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(c.statusPath), 0o755); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp.%d", c.statusPath, os.Getpid())
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, c.statusPath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	c.mu.Lock()
	c.lastStatusWrite = c.now()
	c.mu.Unlock()
	return nil
}

func appendJSONLRotated(path string, lines [][]byte, maxBytes int64, backups int) error {
	if path == "" || len(lines) == 0 {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if maxBytes > 0 {
		if info, err := os.Stat(path); err == nil && info.Size() >= maxBytes {
			for i := backups; i >= 1; i-- {
				dst := fmt.Sprintf("%s.%d", path, i)
				src := path
				if i > 1 {
					src = fmt.Sprintf("%s.%d", path, i-1)
				}
				_ = os.Rename(src, dst)
			}
		}
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	for _, line := range lines {
		if _, err := f.Write(line); err != nil {
			return err
		}
		if _, err := f.Write([]byte{'\n'}); err != nil {
			return err
		}
	}
	return nil
}

func (c *otelCollector) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(c.snapshot())
	})
	mux.HandleFunc("/v1/logs", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := readHTTPBody(r.Body, r.Header.Get("Content-Encoding"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		ct := r.Header.Get("Content-Type")
		records, err := decodeOTLPLogs(body, ct)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		c.ingestRecords(records, ct)
		writeOTLPAck(w, ct)
	})
	// Accept /v1/metrics and /v1/traces quietly so multi-signal OTel configs
	// never spam exporters with 404 retry errors.
	ackOnly := func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		_, _ = readHTTPBody(r.Body, r.Header.Get("Content-Encoding"))
		writeOTLPAck(w, r.Header.Get("Content-Type"))
	}
	mux.HandleFunc("/v1/metrics", ackOnly)
	mux.HandleFunc("/v1/traces", ackOnly)
	return mux
}

func writeOTLPAck(w http.ResponseWriter, reqContentType string) {
	if strings.Contains(strings.ToLower(reqContentType), "protobuf") {
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(http.StatusOK)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{}`))
}

func isLoopbackListen(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func runOTel(args []string) error {
	defaultLog, defaultStatus := defaultOTelPaths()
	defaultListen := os.Getenv("WEZDECK_OTEL_LISTEN")
	if strings.TrimSpace(defaultListen) == "" {
		defaultListen = defaultOTelListen
	}
	defaultCapture := os.Getenv("WEZDECK_OTEL_CAPTURE_RAW")
	if defaultCapture == "1" || strings.EqualFold(defaultCapture, "true") {
		defaultCapture = filepath.Join(filepath.Dir(defaultLog), "otel-schema-capture.jsonl")
	}

	fs := flag.NewFlagSet("otel", flag.ContinueOnError)
	listen := fs.String("listen", defaultListen, "loopback listen address (host:port)")
	logPath := fs.String("log", defaultLog, "output NDJSON sample log path")
	statusPath := fs.String("status", defaultStatus, "atomic status.json path")
	captureRaw := fs.String("capture-raw", defaultCapture, "optional sanitized schema-capture NDJSON path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !isLoopbackListen(*listen) {
		return fmt.Errorf("refusing non-loopback listen address %q", *listen)
	}

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		return fmt.Errorf("otel listen %s: %w", *listen, err)
	}
	c := newOTelCollector(ln.Addr().String(), *logPath, *statusPath, *captureRaw)
	if err := c.writeStatus(); err != nil {
		_ = ln.Close()
		return err
	}

	srv := &http.Server{
		Handler:           c.handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				_ = c.writeStatus()
			case <-done:
				return
			}
		}
	}()
	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	fmt.Fprintf(os.Stderr, "wezdeck-wsl otel listening on http://%s log=%s status=%s\n",
		c.listen, c.logPath, c.statusPath)
	err = srv.Serve(ln)
	close(done)
	_ = c.writeStatus()
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

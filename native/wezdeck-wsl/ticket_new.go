package main

// New collab ticket from the web console (agent-collab `ticket create`):
// supports both quick single-repo / cross-repo AI-assisted capture (`mode: "quick"`,
// 0-wait create + async background AI enrichment) and manual / pre-drafted fields,
// with optional image attachments copied into `_data/<id>/attachments/`.
// Optionally the headless run starts right away in its own transient systemd unit
// (`systemd-run --user`), so runs outlive relay restarts.
//
//   ticket.targets  read   {session?} → {targets: [{key, path}], session_target?}
//   ticket.draft    write  {to, text, attachments?, session?, include_context?} → structured draft
//   ticket.new      write  {mode?, from?, to, text?, attachments?, title?, summary?, observed?, assumed?, origin_session?, include_context?, run?, enrich?} → {id, run, enriching?}
//
// WEZDECK_TICKET_RUN_CMD replaces the systemd-run launch (tests).

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

type ticketTarget struct {
	Key  string `json:"key"`
	Path string `json:"path"`
}

func ticketsRoot() string {
	if p := os.Getenv("TICKETS_ROOT"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".agent", "tickets")
}

var (
	targetKeyLine  = regexp.MustCompile(`^  ([A-Za-z0-9_-]+):\s*$`)
	targetPathLine = regexp.MustCompile(`^    path:\s*(.+?)\s*$`)
)

// ticketTargets reads targets.<key>.path — the subset of YAML the ticket CLI
// itself parses (skills/agent-collab/lib/common.sh).
func ticketTargets() []ticketTarget {
	f, err := os.Open(filepath.Join(ticketsRoot(), "config.yml"))
	if err != nil {
		return nil
	}
	defer f.Close()
	home, _ := os.UserHomeDir()
	var out []ticketTarget
	inTargets := false
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.TrimSpace(line) == "" || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		if !strings.HasPrefix(line, " ") {
			inTargets = strings.HasPrefix(line, "targets:")
			continue
		}
		if !inTargets {
			continue
		}
		if m := targetKeyLine.FindStringSubmatch(line); m != nil {
			out = append(out, ticketTarget{Key: m[1]})
			continue
		}
		if m := targetPathLine.FindStringSubmatch(line); m != nil && len(out) > 0 {
			p := strings.Trim(m[1], `"'`)
			if strings.HasPrefix(p, "~/") {
				p = filepath.Join(home, p[2:])
			}
			out[len(out)-1].Path = p
		}
	}
	return out
}

func listTicketTargets(args json.RawMessage) (any, error) {
	var a struct {
		Session string `json:"session"`
	}
	if len(args) > 0 {
		_ = json.Unmarshal(args, &a)
	}
	targets := ticketTargets()
	if targets == nil {
		targets = []ticketTarget{}
	}
	out := map[string]any{"v": 1, "ok": true, "targets": targets}
	if sessionTarget := resolveTargetForSession(strings.TrimSpace(a.Session), targets); sessionTarget != "" {
		out["session_target"] = sessionTarget
	}
	return out, nil
}

func oneLine(s string, max int) bool {
	return s != "" && utf8.RuneCountInString(s) <= max && !strings.ContainsAny(s, "\r\n")
}

func createTicket(args json.RawMessage) (any, error) {
	var a struct {
		Mode           string   `json:"mode"`
		From           string   `json:"from"`
		To             string   `json:"to"`
		Text           string   `json:"text"`
		Attachments    []string `json:"attachments"`
		Title          string   `json:"title"`
		Summary        string   `json:"summary"`
		Observed       string   `json:"observed"`
		Assumed        string   `json:"assumed"`
		OriginSession  string   `json:"origin_session"`
		IncludeContext bool     `json:"include_context"`
		Run            bool     `json:"run"`
		Enrich         *bool    `json:"enrich"`
	}
	if json.Unmarshal(args, &a) != nil {
		return nil, errors.New("ticket.new: bad arguments")
	}
	a.Mode = strings.TrimSpace(a.Mode)
	a.From = strings.TrimSpace(a.From)
	a.To = strings.TrimSpace(a.To)
	a.Text = strings.TrimSpace(a.Text)
	a.Title = strings.TrimSpace(a.Title)
	a.Summary = strings.TrimSpace(a.Summary)
	a.Observed = strings.TrimSpace(a.Observed)
	a.Assumed = strings.TrimSpace(a.Assumed)
	a.OriginSession = strings.TrimSpace(a.OriginSession)

	targets := ticketTargets()
	known := map[string]bool{}
	for _, t := range targets {
		known[t.Key] = true
	}
	if !known[a.To] {
		return nil, errors.New("ticket.new: to must be a configured target")
	}
	// Normalize source: allow configured targets, "web", "human", or default to "web"
	// (including single-repo tickets where source equals target).
	switch {
	case a.From == "" || a.From == a.To:
		a.From = "web"
	case a.From == "web" || a.From == "human" || known[a.From]:
	default:
		return nil, errors.New("ticket.new: from must be a configured target or web")
	}
	if a.OriginSession != "" && !sessionIDPattern.MatchString(a.OriginSession) {
		return nil, errors.New("ticket.new: invalid origin_session")
	}

	attPaths, err := resolveAttachmentPaths(a.Attachments)
	if err != nil {
		return nil, fmt.Errorf("ticket.new: %w", err)
	}

	isQuick := a.Mode == "quick" || (a.Mode == "" && a.Title == "" && (a.Text != "" || len(attPaths) > 0))
	shouldEnrich := false
	if isQuick {
		if a.Text == "" && len(attPaths) == 0 {
			return nil, errors.New("ticket.new: text or attachments required")
		}
		if utf8.RuneCountInString(a.Text) > 8000 {
			return nil, errors.New("ticket.new: text needs 1–8000 characters")
		}
		if a.Title == "" {
			a.Title = deriveQuickTitle(a.Text, len(attPaths))
		}
		if a.Summary == "" {
			a.Summary = a.Title
		}
		if a.Observed == "" {
			if a.Text != "" {
				a.Observed = a.Text
			} else {
				a.Observed = fmt.Sprintf("附带 %d 张截图，详见附件。", len(attPaths))
			}
		}
		if a.Assumed == "" {
			a.Assumed = "按原始描述与附件完成处理并验证。"
		}
		shouldEnrich = !a.Run && (a.Enrich == nil || *a.Enrich)
	} else {
		switch {
		case !oneLine(a.Title, 120):
			return nil, errors.New("ticket.new: the title needs 1–120 characters, one line")
		case a.Observed == "" || a.Assumed == "" ||
			utf8.RuneCountInString(a.Observed) > 8000 || utf8.RuneCountInString(a.Assumed) > 8000:
			return nil, errors.New("ticket.new: what you saw and what you assume both need 1–8000 characters")
		}
	}

	cliArgs := []string{
		"create",
		"--from", a.From,
		"--to", a.To,
		"--title", a.Title,
		"--observed", a.Observed,
		"--assumed", a.Assumed,
	}
	if a.Summary != "" {
		cliArgs = append(cliArgs, "--summary", a.Summary)
	}
	if a.Text != "" {
		cliArgs = append(cliArgs, "--original", a.Text)
	}
	if a.OriginSession != "" {
		cliArgs = append(cliArgs, "--origin-session", a.OriginSession)
	}
	if shouldEnrich {
		cliArgs = append(cliArgs, "--enrich-status", "pending")
	}
	for _, p := range attPaths {
		cliArgs = append(cliArgs, "--attachment", p)
	}

	created, err := runTicketCLI("ticket create", cliArgs)
	if err != nil {
		return nil, err
	}
	res, _ := created.(map[string]any)
	id, _ := res["id"].(string)
	if !ticketIDPattern.MatchString(id) {
		return nil, errors.New("ticket.new: created, but the CLI answered no ticket id")
	}
	out := map[string]any{"v": 1, "ok": true, "id": id, "run": "none", "enriching": shouldEnrich}
	if a.Run {
		if err := startTicketRun(id); err != nil {
			out["run"] = "failed"
			out["run_error"] = clip(err.Error(), 300)
		} else {
			out["run"] = "started"
		}
	}
	if shouldEnrich {
		go enrichTicketAsync(id, a.To, a.Text, a.Attachments, a.OriginSession, a.IncludeContext)
	}
	modeTag := "manual"
	if isQuick {
		modeTag = "quick"
	}
	relayLogf("ticket_new", "id=%s mode=%s from=%s to=%s attachments=%d enriching=%t run=%v",
		id, modeTag, a.From, a.To, len(attPaths), shouldEnrich, out["run"])
	return out, nil
}

// startTicketRun starts `ticket run --phase auto` in its own transient user
// unit, so it outlives relay restarts; journalctl --user -u wezdeck-ticket-<id>.
func startTicketRun(id string) error {
	ticket := filepath.Join(repoRoot(), "skills", "agent-collab", "ticket")
	var cmd *exec.Cmd
	if fake := os.Getenv("WEZDECK_TICKET_RUN_CMD"); fake != "" {
		cmd = exec.Command(fake, id)
	} else {
		argv := []string{"--user", "--collect", "--quiet", "--unit", "wezdeck-ticket-" + strings.ToLower(id),
			"--setenv=TICKET_TRIGGER_SOURCE=mobile", "--setenv=PATH=" + os.Getenv("PATH")}
		if root := os.Getenv("TICKETS_ROOT"); root != "" {
			argv = append(argv, "--setenv=TICKETS_ROOT="+root)
		}
		argv = append(argv, ticket, "run", "--id", id, "--phase", "auto")
		cmd = exec.Command("systemd-run", argv...)
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

package main

// New collab ticket from the phone (agent-collab `ticket create`): from one
// repository to another, both from the ticket config's targets — the same
// allowlist the CLI resolves against — with the assumption gate's two
// fields (what you saw, what you assume). Optionally the run starts right
// away, in its own transient systemd unit (`systemd-run --user`): runs last
// minutes, and a child of the relay would die with it on the next restart.
//
//   ticket.targets  read   [{key, path}] from $TICKETS_ROOT/config.yml
//   ticket.new      write  {from, to, title, observed, assumed, run} → {id, run}
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

func listTicketTargets() (any, error) {
	targets := ticketTargets()
	if targets == nil {
		targets = []ticketTarget{}
	}
	return map[string]any{"v": 1, "ok": true, "targets": targets}, nil
}

func oneLine(s string, max int) bool {
	return s != "" && utf8.RuneCountInString(s) <= max && !strings.ContainsAny(s, "\r\n")
}

func createTicket(args json.RawMessage) (any, error) {
	var a struct {
		From     string `json:"from"`
		To       string `json:"to"`
		Title    string `json:"title"`
		Observed string `json:"observed"`
		Assumed  string `json:"assumed"`
		Run      bool   `json:"run"`
	}
	if json.Unmarshal(args, &a) != nil {
		return nil, errors.New("ticket.new: bad arguments")
	}
	a.Title, a.Observed, a.Assumed = strings.TrimSpace(a.Title), strings.TrimSpace(a.Observed), strings.TrimSpace(a.Assumed)
	known := map[string]bool{}
	for _, t := range ticketTargets() {
		known[t.Key] = true
	}
	switch {
	case !known[a.From] || !known[a.To]:
		return nil, errors.New("ticket.new: from and to must be configured targets")
	case a.From == a.To:
		return nil, errors.New("ticket.new: a ticket goes to another repository")
	case !oneLine(a.Title, 120):
		return nil, errors.New("ticket.new: the title needs 1–120 characters, one line")
	case a.Observed == "" || a.Assumed == "" ||
		utf8.RuneCountInString(a.Observed) > 8000 || utf8.RuneCountInString(a.Assumed) > 8000:
		return nil, errors.New("ticket.new: what you saw and what you assume both need 1–8000 characters")
	}
	created, err := runTicketCLI("ticket create", []string{"create", "--from", a.From, "--to", a.To,
		"--title", a.Title, "--observed", a.Observed, "--assumed", a.Assumed})
	if err != nil {
		return nil, err
	}
	res, _ := created.(map[string]any)
	id, _ := res["id"].(string)
	if !ticketIDPattern.MatchString(id) {
		return nil, errors.New("ticket.new: created, but the CLI answered no ticket id")
	}
	out := map[string]any{"v": 1, "ok": true, "id": id, "run": "none"}
	if a.Run {
		if err := startTicketRun(id); err != nil {
			out["run"] = "failed"
			out["run_error"] = clip(err.Error(), 300)
		} else {
			out["run"] = "started"
		}
	}
	relayLogf("ticket_new", "id=%s from=%s to=%s run=%v", id, a.From, a.To, out["run"])
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

package main

// `session.skills {id}` (read): the skills the session's agent actually has —
// the web console's 能力 sheet and the composer's `/` completion. Never a
// guess from scanning skill directories (plugin and built-in skills are not
// on disk, and each agent scans different roots): each agent's own record.
//
//   - Claude: the transcript's `attachment.type=skill_listing` lines (an
//     initial one, then deltas for skills added mid-session) — what the
//     model was shown.
//   - Codex: the developer message of the rollout holding "### Available
//     skills" (one `- name: description (file: rN/…/SKILL.md)` per line,
//     with the `rN` roots listed above it).
//   - Grok: no record in the session; `grok --cwd <dir> inspect --json`,
//     cached per directory.
//
// On demand only: the session poll carries `skills_rev` (count + names
// hash) so the page refetches when the list changes, not the list itself.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"hash/fnv"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type skillInfo struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// Origin: wezdeck (a platform skill of skills/manifest.tsv) | project
	// (the checkout's own) | user (a user-level skill dir) | plugin
	// (`plugin:skill`) | builtin (the agent's own, nothing on disk)
	Origin string `json:"origin"`
	Path   string `json:"path,omitempty"` // SKILL.md when the agent names it
}

// skillLister: an adapter that can say which skills a session has. trigger
// is how its TUI invokes one by name ("/" or "$").
type skillLister interface {
	Skills(transcriptPath, cwd string) ([]skillInfo, error)
	SkillTrigger() string
}

const skillDescMax = 600

func sessionSkills(args json.RawMessage) (any, error) {
	var a struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(args, &a) != nil || !sessionIDPattern.MatchString(a.ID) {
		return nil, errors.New("invalid session id")
	}
	live, err := liveSessions()
	if err != nil {
		return nil, err
	}
	e, ok := live[a.ID]
	if !ok {
		return nil, errors.New("session not found (ended or not tracked)")
	}
	path, agent := findTranscript(e.SessionID)
	cwd, _ := paneInfo(e)
	if path == "" {
		if _, _, cmd, _, _, alive := paneState(e); alive && agentCommands[cmd] {
			agent = strings.TrimSuffix(cmd, ".real")
		}
	}
	lister, ok := adapterFor(agent).(skillLister)
	if !ok {
		return map[string]any{"v": 1, "ok": true, "agent": agent, "skills": []skillInfo{}}, nil
	}
	start := time.Now()
	list, err := lister.Skills(path, cwd)
	if err != nil {
		relayLogf("session_skills", "agent=%s err=%q ms=%d", agent, err, time.Since(start).Milliseconds())
		return nil, err
	}
	list = classifySkills(list, cwd)
	relayLogf("session_skills", "agent=%s n=%d ms=%d", agent, len(list), time.Since(start).Milliseconds())
	return map[string]any{"v": 1, "ok": true, "agent": agent, "trigger": lister.SkillTrigger(),
		"skills": list, "rev": skillsRev(list)}, nil
}

// skillsRev: changes when the set of names does (the poll's `skills_rev`).
func skillsRev(list []skillInfo) string {
	if len(list) == 0 {
		return ""
	}
	h := fnv.New32a()
	for _, s := range list {
		h.Write([]byte(s.Name))
		h.Write([]byte{0})
	}
	return strconv.Itoa(len(list)) + "-" + strconv.FormatUint(uint64(h.Sum32()), 36)
}

// --- Claude -----------------------------------------------------------------

func (claudeAdapter) SkillTrigger() string { return "/" }
func (claudeAdapter) Skills(path, _ string) ([]skillInfo, error) {
	return transcriptSkills(path, "claude")
}

func (codexAdapter) SkillTrigger() string { return "$" }
func (codexAdapter) Skills(path, _ string) ([]skillInfo, error) {
	return transcriptSkills(path, "codex")
}

func transcriptSkills(path, agent string) ([]skillInfo, error) {
	if path == "" {
		return []skillInfo{}, nil
	}
	t, err := loadTranscript(path, agent)
	if err != nil {
		return nil, err
	}
	transcriptsMu.Lock()
	defer transcriptsMu.Unlock()
	return append([]skillInfo{}, t.skills...), nil
}

// feedClaudeSkillListing: one Claude skill_listing attachment. An initial one
// replaces the list (a new session, after /clear); a delta adds to it.
func (t *transcript) feedClaudeSkillListing(content string, names []string, initial bool) {
	parsed := parseClaudeSkillListing(content, names)
	if initial {
		t.skills = parsed
		return
	}
	seen := map[string]int{}
	for i, s := range t.skills {
		seen[s.Name] = i
	}
	for _, s := range parsed {
		if i, ok := seen[s.Name]; ok {
			t.skills[i] = s
			continue
		}
		t.skills = append(t.skills, s)
	}
}

// parseClaudeSkillListing: `- name: description` entries (a description may run
// over several lines; plugin skills may have none). names says where each
// entry starts, so a description line starting with "- " is not split.
func parseClaudeSkillListing(content string, names []string) []skillInfo {
	type mark struct {
		name     string
		at, body int
	}
	var marks []mark
	pos := 0
	for _, name := range names {
		if at := skillEntryAt(content, "- "+name, pos); at >= 0 {
			body := at + len(name) + 2
			if body < len(content) && content[body] == ':' {
				body++
			}
			marks = append(marks, mark{name, at, body})
			pos = body
		}
	}
	desc := map[string]string{}
	for i, m := range marks {
		end := len(content)
		if i+1 < len(marks) {
			end = marks[i+1].at
		}
		if m.body < end {
			desc[m.name] = clip(strings.TrimSpace(content[m.body:end]), skillDescMax)
		}
	}
	out := make([]skillInfo, 0, len(names))
	for _, name := range names {
		out = append(out, skillInfo{Name: name, Description: desc[name]})
	}
	return out
}

// skillEntryAt: where head ("- name") starts a line at or after from and is
// followed by ':' or the line's end; -1 when it does not.
func skillEntryAt(content, head string, from int) int {
	for from <= len(content) {
		i := strings.Index(content[from:], head)
		if i < 0 {
			return -1
		}
		i += from
		end := i + len(head)
		if (i == 0 || content[i-1] == '\n') && (end == len(content) || content[end] == ':' || content[end] == '\n') {
			return i
		}
		from = i + 1
	}
	return -1
}

// --- Codex ------------------------------------------------------------------

var (
	codexSkillRoot = regexp.MustCompile("(?m)^- `(r\\d+)` = `([^`]+)`")
	codexSkillLine = regexp.MustCompile(`^- ([^:\s][^:]*?): (.*?)(?: \(file: ([^)]+)\))?$`)
)

// feedCodexSkills: the "### Available skills" block of a developer message;
// false when text has none. The newest block wins.
func (t *transcript) feedCodexSkills(text string) bool {
	i := strings.Index(text, "### Available skills\n")
	if i < 0 {
		return false
	}
	roots := map[string]string{}
	for _, m := range codexSkillRoot.FindAllStringSubmatch(text[:i], -1) {
		roots[m[1]] = m[2]
	}
	var list []skillInfo
	sc := bufio.NewScanner(strings.NewReader(text[i+len("### Available skills\n"):]))
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "- ") {
			break
		}
		m := codexSkillLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		file := m[3]
		if root, rest, ok := strings.Cut(file, "/"); ok && roots[root] != "" {
			file = filepath.Join(roots[root], rest)
		}
		list = append(list, skillInfo{Name: m[1], Description: clip(m[2], skillDescMax), Path: file})
	}
	if len(list) > 0 {
		t.skills = list
	}
	return true
}

// --- Grok -------------------------------------------------------------------

func (grokAdapter) SkillTrigger() string { return "/" }

type grokSkillsCache struct {
	at   time.Time
	list []skillInfo
}

var (
	grokSkillsMu  sync.Mutex
	grokSkillsBy  = map[string]grokSkillsCache{}
	grokSkillsTTL = 2 * time.Minute
)

func (grokAdapter) Skills(_, cwd string) ([]skillInfo, error) {
	if cwd == "" {
		return []skillInfo{}, nil
	}
	grokSkillsMu.Lock()
	c, ok := grokSkillsBy[cwd]
	grokSkillsMu.Unlock()
	if ok && time.Since(c.at) < grokSkillsTTL {
		return c.list, nil
	}
	bin, err := exec.LookPath("grok")
	if err != nil {
		home, _ := os.UserHomeDir()
		bin = filepath.Join(home, ".grok", "bin", "grok")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "--cwd", cwd, "inspect", "--json").Output()
	if err != nil {
		return nil, errors.New("grok inspect failed: " + err.Error())
	}
	list, err := parseGrokInspect(out)
	if err != nil {
		return nil, err
	}
	grokSkillsMu.Lock()
	grokSkillsBy[cwd] = grokSkillsCache{at: time.Now(), list: list}
	grokSkillsMu.Unlock()
	return list, nil
}

func parseGrokInspect(out []byte) ([]skillInfo, error) {
	var d struct {
		Skills []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Source      struct {
				Path string `json:"path"`
			} `json:"source"`
		} `json:"skills"`
	}
	if err := json.Unmarshal(out, &d); err != nil {
		return nil, errors.New("grok inspect: unreadable json")
	}
	list := make([]skillInfo, 0, len(d.Skills))
	for _, s := range d.Skills {
		list = append(list, skillInfo{Name: s.Name, Description: clip(s.Description, skillDescMax), Path: s.Source.Path})
	}
	return list, nil
}

// --- origin -------------------------------------------------------------------

// platformSkills: the platform rows of skills/manifest.tsv (the skills this
// repository exports to every agent).
func platformSkills() map[string]bool {
	set := map[string]bool{}
	root := repoRoot()
	if root == "" {
		return set
	}
	data, err := os.ReadFile(filepath.Join(root, "skills", "manifest.tsv"))
	if err != nil {
		return set
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "#") {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) >= 3 && f[2] == "platform" {
			set[f[0]] = true
		}
	}
	return set
}

func classifySkills(list []skillInfo, cwd string) []skillInfo {
	platform := platformSkills()
	home, _ := os.UserHomeDir()
	exists := func(p string) bool { _, err := os.Stat(p); return err == nil }
	out := make([]skillInfo, 0, len(list))
	for _, s := range list {
		switch {
		case platform[s.Name]:
			s.Origin = "wezdeck"
		case strings.Contains(s.Name, ":"):
			s.Origin = "plugin"
		case s.Path != "" && cwd != "" && strings.HasPrefix(s.Path, cwd+string(filepath.Separator)):
			s.Origin = "project"
		case s.Path == "" && cwd != "" && (exists(filepath.Join(cwd, ".claude", "skills", s.Name)) || exists(filepath.Join(cwd, ".agents", "skills", s.Name))):
			s.Origin = "project"
		case s.Path != "" && home != "" && strings.HasPrefix(s.Path, home+string(filepath.Separator)) && !strings.Contains(s.Path, string(filepath.Separator)+".system"+string(filepath.Separator)):
			s.Origin = "user"
		case s.Path == "" && home != "" && (exists(filepath.Join(home, ".claude", "skills", s.Name)) || exists(filepath.Join(home, ".agents", "skills", s.Name))):
			s.Origin = "user"
		default:
			s.Origin = "builtin"
		}
		out = append(out, s)
	}
	return out
}

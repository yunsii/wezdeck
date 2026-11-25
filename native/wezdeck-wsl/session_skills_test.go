package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func newTestTranscript() *transcript {
	return &transcript{tools: map[string]int{}, agents: map[string]int{}, tasks: map[string]int{}, seenNotes: map[string]bool{}}
}

func skillLine(t *testing.T, content string, names []string, initial bool) []byte {
	t.Helper()
	line, _ := json.Marshal(map[string]any{"type": "attachment", "attachment": map[string]any{
		"type": "skill_listing", "content": content, "names": names, "isInitial": initial,
		"skillCount": len(names)}})
	return line
}

func TestClaudeSkillListingInitialThenDelta(t *testing.T) {
	tr := newTestTranscript()
	// a description running over lines, one starting with "- " that is not
	// an entry, a plugin skill with no description, a name that prefixes another
	content := "- run: Launch the app.\n- run-tests: Run tests.\nTRIGGER — read FIRST\n- not a skill line\n- anthropic-skills:pdf"
	tr.feedLine(skillLine(t, content, []string{"run", "run-tests", "anthropic-skills:pdf"}, true))
	if len(tr.skills) != 3 {
		t.Fatalf("want 3 skills, got %+v", tr.skills)
	}
	if tr.skills[0].Description != "Launch the app." {
		t.Fatalf("run desc: %q", tr.skills[0].Description)
	}
	if got := tr.skills[1].Description; got != "Run tests.\nTRIGGER — read FIRST\n- not a skill line" {
		t.Fatalf("run-tests desc: %q", got)
	}
	if tr.skills[2].Name != "anthropic-skills:pdf" || tr.skills[2].Description != "" {
		t.Fatalf("plugin skill: %+v", tr.skills[2])
	}
	// a skill added mid-session: appended, the rest kept
	tr.feedLine(skillLine(t, "- coco-cms: CMS ops.", []string{"coco-cms"}, false))
	if len(tr.skills) != 4 || tr.skills[3].Name != "coco-cms" || tr.skills[3].Description != "CMS ops." {
		t.Fatalf("delta: %+v", tr.skills)
	}
	// /clear: a new initial listing replaces it
	tr.feedLine(skillLine(t, "- only: x", []string{"only"}, true))
	if len(tr.skills) != 1 || tr.skills[0].Name != "only" {
		t.Fatalf("initial again: %+v", tr.skills)
	}
}

func TestClaudeOtherAttachmentsLeaveSkillsAlone(t *testing.T) {
	tr := newTestTranscript()
	tr.feedLine(skillLine(t, "- a: x", []string{"a"}, true))
	// another attachment type whose content is not a string must not break or reset
	tr.feedLine([]byte(`{"type":"attachment","attachment":{"type":"deferred_tools_delta","content":[{"x":1}],"names":{"k":1}}}`))
	if len(tr.skills) != 1 {
		t.Fatalf("skills changed: %+v", tr.skills)
	}
}

func TestCodexAvailableSkills(t *testing.T) {
	tr := newTestTranscript()
	text := "## Skills\nintro mentions ### Available skills\".\n## Skill roots\n- `r0` = `/home/u/.codex/skills`\n- `r3` = `/repo/.agents/skills`\n### Available skills\n" +
		"- imagegen: Generate images (with parens) here. (file: r0/.system/imagegen/SKILL.md)\n" +
		"- frontend-design: Visual direction. (file: r3/frontend-design/SKILL.md)\n" +
		"\n## Next section\n- not-a-skill: x"
	line, _ := json.Marshal(map[string]any{"type": "response_item", "payload": map[string]any{
		"type": "message", "role": "developer", "content": []map[string]any{{"type": "input_text", "text": "other"}, {"type": "input_text", "text": text}}}})
	tr.feedCodex(line)
	if len(tr.skills) != 2 {
		t.Fatalf("want 2, got %+v", tr.skills)
	}
	if s := tr.skills[0]; s.Name != "imagegen" || s.Description != "Generate images (with parens) here." || s.Path != "/home/u/.codex/skills/.system/imagegen/SKILL.md" {
		t.Fatalf("imagegen: %+v", s)
	}
	if s := tr.skills[1]; s.Path != "/repo/.agents/skills/frontend-design/SKILL.md" {
		t.Fatalf("frontend-design: %+v", s)
	}
}

func TestParseGrokInspect(t *testing.T) {
	list, err := parseGrokInspect([]byte(`{"skills":[{"name":"frontend-design","description":"d","source":{"type":"project","path":"/repo/.agents/skills/frontend-design/SKILL.md"}}]}`))
	if err != nil || len(list) != 1 || list[0].Path == "" {
		t.Fatalf("got %+v %v", list, err)
	}
	if _, err := parseGrokInspect([]byte("not json")); err == nil {
		t.Fatal("want an error for non-json output")
	}
}

func TestClassifySkills(t *testing.T) {
	repo := t.TempDir()
	home := t.TempDir()
	cwd := filepath.Join(repo, "work")
	t.Setenv("WEZDECK_REPO", repo)
	t.Setenv("HOME", home)
	_ = os.MkdirAll(filepath.Join(repo, "skills"), 0o755)
	_ = os.WriteFile(filepath.Join(repo, "skills", "manifest.tsv"),
		[]byte("# name\tsource\tclass\nbrainstorm\tskills/brainstorm\tplatform\tagents,claude\tyes\nrepo-hygiene\tskills/repo-hygiene\trepo-local\tnone\tno\n"), 0o644)
	_ = os.MkdirAll(filepath.Join(cwd, ".claude", "skills", "frontend-design"), 0o755)
	_ = os.MkdirAll(filepath.Join(home, ".claude", "skills", "coco-logs"), 0o755)
	got := classifySkills([]skillInfo{
		{Name: "brainstorm"},
		{Name: "anthropic-skills:pdf"},
		{Name: "frontend-design"},
		{Name: "coco-logs"},
		{Name: "simplify"},
		{Name: "imagegen", Path: filepath.Join(home, ".codex", "skills", ".system", "imagegen", "SKILL.md")},
		{Name: "uxc", Path: filepath.Join(home, ".codex", "skills", "uxc", "SKILL.md")},
		{Name: "web-design-guidelines", Path: filepath.Join(cwd, ".agents", "skills", "web-design-guidelines", "SKILL.md")},
	}, cwd)
	want := []string{"wezdeck", "plugin", "project", "user", "builtin", "builtin", "user", "project"}
	for i, s := range got {
		if s.Origin != want[i] {
			t.Errorf("%s: origin %q, want %q", s.Name, s.Origin, want[i])
		}
	}
}

func TestSkillsRevFollowsNames(t *testing.T) {
	a := skillsRev([]skillInfo{{Name: "a"}, {Name: "b"}})
	b := skillsRev([]skillInfo{{Name: "a"}, {Name: "b", Description: "changed"}})
	c := skillsRev([]skillInfo{{Name: "a"}, {Name: "c"}})
	if a != b || a == c || skillsRev(nil) != "" {
		t.Fatalf("rev: %q %q %q", a, b, c)
	}
}

package main

import "testing"

func TestParseActivity(t *testing.T) {
	cases := []struct {
		agent, screen string
		want          *agentActivity
	}{
		{"claude", "● done\n\n✢ Gesticulating… (4m 39s · ↓ 19.1k tokens · thought for 2s)\n\n────\n❯ \n────\n  ⏵⏵ auto mode on · esc to interrupt",
			&agentActivity{Text: "Gesticulating", Elapsed: "4m 39s", Tokens: "↓ 19.1k"}},
		{"claude", "✻ Compacting conversation… (36s · ↓ 2.0k tokens)\n❯",
			&agentActivity{Text: "Compacting conversation", Elapsed: "36s", Tokens: "↓ 2.0k", Compacting: true}},
		{"claude", "· Orbiting… (6m 44s · ↓ 4.4k tokens)", &agentActivity{Text: "Orbiting", Elapsed: "6m 44s", Tokens: "↓ 4.4k"}},
		{"claude", "✶ Thinking… (esc to interrupt · 1h 2m 3s · ↑ 812 tokens)", &agentActivity{Text: "Thinking", Elapsed: "1h 2m 3s", Tokens: "↑ 812"}},
		// a quoted spinner inside tool output is indented under ⎿: no match
		{"claude", "  ⎿  grep → ✢ Gesticulating… (4m)\n❯", nil},
		{"claude", "❯ hello\n", nil},
		{"codex", "• Working (12s • esc to interrupt)\n›", &agentActivity{Text: "Working", Elapsed: "12s"}},
		{"codex", "• Ran ls (done)\n", nil},
	}
	for _, c := range cases {
		got := parseActivity(c.agent, c.screen)
		if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
			t.Errorf("%s %q:\n got %+v\nwant %+v", c.agent, c.screen, got, c.want)
		}
	}
}

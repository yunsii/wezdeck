package main

import "testing"

func TestDiagGist(t *testing.T) {
	body := []byte(`{"build":"abc","page":"/zh/console/sessions/x","hostRequest":{"deployed":"abd","steps":[
		{"do":"query","selector":"[data-testid=session-tags]","count":1,"items":[{"attrs":{"data-folded":null}}],"frames":{"count":40}},
		{"do":"click","ok":true,"frames":{"count":12}}]}}`)
	g := diagGist(body)
	if g.Build != "abc" || g.Deployed != "abd" || g.Current == nil || *g.Current || g.Page != "/zh/console/sessions/x" {
		t.Fatalf("gist %+v", g)
	}
	if len(g.Steps) != 2 || g.Steps[0]["count"] != float64(1) {
		t.Fatalf("steps %+v", g.Steps)
	}
	for _, s := range g.Steps {
		if _, ok := s["frames"]; ok {
			t.Fatal("frames stay in the file")
		}
	}
	if g := diagGist([]byte(`{"build":"abc","hostRequest":{"deployed":"abc"}}`)); g.Current == nil || !*g.Current {
		t.Fatalf("current %+v", g)
	}
	if g := diagGist([]byte(`not json`)); g.Build != "" {
		t.Fatal("bad body: empty gist")
	}
}

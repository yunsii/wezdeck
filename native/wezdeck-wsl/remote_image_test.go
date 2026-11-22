package main

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func pngB64(t *testing.T, c color.RGBA) (string, []byte) {
	img := image.NewRGBA(image.Rect(0, 0, 40, 20))
	for y := 0; y < 20; y++ {
		for x := 0; x < 40; x++ {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes()), buf.Bytes()
}

func TestTranscriptImageRefsRoundTrip(t *testing.T) {
	red, redRaw := pngB64(t, color.RGBA{255, 0, 0, 255})
	blue, blueRaw := pngB64(t, color.RGBA{0, 0, 255, 255})
	green, greenRaw := pngB64(t, color.RGBA{0, 255, 0, 255})
	img := func(d string) string {
		return `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + d + `"}}`
	}
	lines := []string{
		`{"type":"user","timestamp":"t0","message":{"content":"hello"}}`,
		`{"type":"user","timestamp":"t1","message":{"content":[{"type":"text","text":"[Image #1] 看这个"},` + img(red) + `]}}`,
		`{"type":"assistant","timestamp":"t2","message":{"id":"a1","content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/x.png"}}]}}`,
		// an orphan tool_result first: its image still counts, so the second ref is .1
		`{"type":"user","timestamp":"t3","message":{"content":[{"type":"tool_result","tool_use_id":"gone","content":[` + img(green) + `]},{"type":"tool_result","tool_use_id":"tu1","content":[{"type":"text","text":"ok"},` + img(blue) + `]}]}}`,
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	msgs := parseClaudeTranscript(data, 100)
	var userRef, toolRef string
	for _, m := range msgs {
		if m.Role == "user" && len(m.Images) == 1 {
			userRef = m.Images[0]
		}
		if m.Role == "tool" && len(m.Images) == 1 {
			toolRef = m.Images[0]
		}
	}
	if userRef == "" || toolRef == "" || !strings.HasSuffix(toolRef, ".1") {
		t.Fatalf("refs missing: user=%q tool=%q msgs=%+v", userRef, toolRef, msgs)
	}
	check := func(ref string, want []byte) {
		m := imageRefPattern.FindStringSubmatch(ref)
		off, nth := int64(0), 0
		for _, c := range m[1] {
			off = off*10 + int64(c-'0')
		}
		for _, c := range m[2] {
			nth = nth*10 + int(c-'0')
		}
		got, mime, err := transcriptImage(path, off, nth)
		if err != nil || mime != "image/png" || !bytes.Equal(got, want) {
			t.Fatalf("ref %s: err=%v mime=%s equal=%t", ref, err, mime, bytes.Equal(got, want))
		}
	}
	check(userRef, redRaw)
	check(toolRef, blueRaw)
	_ = greenRaw
	if _, _, err := transcriptImage(path, 0, 0); err == nil {
		t.Fatal("a line without images must not yield one")
	}
}

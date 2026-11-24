package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func chunkArgs(id string, seq, total int, mime string, data []byte) json.RawMessage {
	b, _ := json.Marshal(map[string]any{
		"upload": id, "seq": seq, "total": total, "mime": mime,
		"data": base64.StdEncoding.EncodeToString(data),
	})
	return b
}

func TestUploadChunksAssembleOutOfOrder(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEZDECK_REMOTE_UPLOADS", dir)
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 100)...)
	id := "0123abcd-0000-4000-8000-000000000001"
	if r, err := uploadChunk(chunkArgs(id, 1, 2, "image/png", png[50:])); err != nil || r.(map[string]any)["received"] != 1 {
		t.Fatalf("first chunk: %v %v", r, err)
	}
	r, err := uploadChunk(chunkArgs(id, 0, 2, "image/png", png[:50]))
	if err != nil {
		t.Fatal(err)
	}
	name := r.(map[string]any)["name"].(string)
	if !strings.HasPrefix(name, "img-") || !strings.HasSuffix(name, ".png") {
		t.Fatalf("name %q", name)
	}
	got, _ := os.ReadFile(filepath.Join(dir, name))
	if string(got) != string(png) {
		t.Fatalf("assembled file differs (%d bytes)", len(got))
	}

	note, err := attachmentNote([]string{name})
	if err != nil || !strings.Contains(note, "图片1: "+filepath.Join(dir, name)) {
		t.Fatalf("note %q %v", note, err)
	}
}

func TestUploadRejectsBadInput(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEZDECK_REMOTE_UPLOADS", dir)
	id := "0123abcd-0000-4000-8000-000000000002"
	if _, err := uploadChunk(chunkArgs(id, 0, 1, "image/png", []byte("not a png at all"))); err == nil {
		t.Fatal("content not matching its type must be refused")
	}
	if _, err := uploadChunk(chunkArgs(id, 0, 1, "text/html", []byte("<b>"))); err == nil {
		t.Fatal("unsupported type must be refused")
	}
	if _, err := uploadChunk(chunkArgs("../../etc", 0, 1, "image/png", []byte("x"))); err == nil {
		t.Fatal("bad upload id must be refused")
	}
	if _, err := uploadChunk(chunkArgs(id, 0, 1, "image/png", make([]byte, uploadChunkMax+1))); err == nil {
		t.Fatal("oversized chunk must be refused")
	}
	for _, bad := range []string{"../x.png", "/etc/passwd", "img-missing.png"} {
		if _, err := attachmentNote([]string{bad}); err == nil {
			t.Fatalf("attachment %q must be refused", bad)
		}
	}
}

func TestUploadDiagnosticsAndPrune(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEZDECK_REMOTE_UPLOADS", dir)
	old := filepath.Join(dir, "img-20200101-000000-aaaaaaaa.png")
	_ = os.WriteFile(old, []byte("x"), 0o600)
	past := time.Now().Add(-31 * 24 * time.Hour)
	_ = os.Chtimes(old, past, past)

	r, err := uploadChunk(chunkArgs("0123abcd-0000-4000-8000-000000000003", 0, 1, "application/json", []byte(`{"viewport":{"h":480}}`)))
	if err != nil {
		t.Fatal(err)
	}
	name := r.(map[string]any)["name"].(string)
	note, err := attachmentNote([]string{name})
	if err != nil || !strings.Contains(note, "客户端诊断: ") {
		t.Fatalf("note %q %v", note, err)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("uploads older than 30 days must be pruned")
	}
}

// images are numbered in order ([图片N] in the text refers to them);
// a diagnostics file is not an image and takes no number
func TestAttachmentNoteNumbersImages(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEZDECK_REMOTE_UPLOADS", dir)
	names := []string{"img-1-a.jpg", "diagnostics-1-b.json", "img-2-c.jpg"}
	for _, n := range names {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	note, err := attachmentNote(names)
	if err != nil {
		t.Fatal(err)
	}
	want := "[手机附件]\n- 图片1: " + filepath.Join(dir, names[0]) +
		"\n- 客户端诊断: " + filepath.Join(dir, names[1]) +
		"\n- 图片2: " + filepath.Join(dir, names[2])
	if note != want {
		t.Fatalf("note:\n%s\nwant:\n%s", note, want)
	}
}

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestUploadGetThumbAndChunks(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEZDECK_REMOTE_UPLOADS", dir)
	img := image.NewRGBA(image.Rect(0, 0, 1200, 600))
	for y := 0; y < 600; y++ {
		for x := 0; x < 1200; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 80, 255})
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	name := "img-20261122-000000-abcdef12.png"
	_ = os.WriteFile(filepath.Join(dir, name), buf.Bytes(), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("x"), 0o600)

	res, err := uploadGet(json.RawMessage(`{"name":"` + name + `","thumb":true}`))
	if err != nil {
		t.Fatal(err)
	}
	m := res.(map[string]any)
	raw, _ := base64.StdEncoding.DecodeString(m["data"].(string))
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width != thumbMax || cfg.Height != thumbMax/2 || m["width"] != 1200 {
		t.Fatalf("thumb wrong: %v %+v %v", err, cfg, m["width"])
	}

	var got []byte
	for off := int64(0); ; {
		res, err := uploadGet(json.RawMessage(`{"name":"` + name + `","offset":` + itoa(off) + `}`))
		if err != nil {
			t.Fatal(err)
		}
		m := res.(map[string]any)
		part, _ := base64.StdEncoding.DecodeString(m["data"].(string))
		got = append(got, part...)
		off += int64(len(part))
		if off >= m["size"].(int64) || len(part) == 0 {
			break
		}
	}
	if !bytes.Equal(got, buf.Bytes()) {
		t.Fatalf("chunks reassemble to %d bytes, want %d", len(got), buf.Len())
	}

	for _, bad := range []string{"../" + name, "secret.txt", "/etc/passwd", "img-x/../../a.png", "img-missing.png"} {
		if _, err := uploadGet(json.RawMessage(`{"name":"` + bad + `"}`)); err == nil {
			t.Fatalf("%q must be refused", bad)
		}
	}
}

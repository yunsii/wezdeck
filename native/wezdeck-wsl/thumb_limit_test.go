package main

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/png"
	"strings"
	"testing"
)

// a real 1×1 PNG whose IHDR claims w×h (CRC fixed up): what a decompression
// bomb looks like to the header reader
func pngClaiming(t *testing.T, w, h uint32) []byte {
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	b := buf.Bytes()
	// signature (8) + length (4) + "IHDR" (4) → width at 16, height at 20, CRC at 29
	binary.BigEndian.PutUint32(b[16:], w)
	binary.BigEndian.PutUint32(b[20:], h)
	binary.BigEndian.PutUint32(b[29:], crc32.ChecksumIEEE(b[12:29]))
	return b
}

func TestThumbnailRefusesHugeDeclaredSize(t *testing.T) {
	_, err := thumbnailOf(pngClaiming(t, 30000, 30000), "image/png")
	if err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("want too-large refusal, got %v", err)
	}
}

func TestThumbnailStillWorks(t *testing.T) {
	var buf bytes.Buffer
	_ = png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 800, 600)))
	out, err := thumbnailOf(buf.Bytes(), "image/png")
	if err != nil {
		t.Fatal(err)
	}
	if m := out.(map[string]any); m["mime"] != "image/jpeg" {
		t.Fatalf("thumb %v", m["mime"])
	}
}

func TestThumbnailWebpPassesThroughWhenSmall(t *testing.T) {
	webp := append([]byte("RIFF\x10\x00\x00\x00WEBPVP8 "), make([]byte, 64)...)
	out, err := thumbnailOf(webp, "image/webp")
	if err != nil || out.(map[string]any)["mime"] != "image/webp" {
		t.Fatalf("webp pass-through: %v %v", out, err)
	}
	if _, err := thumbnailOf(make([]byte, thumbPassThrough+1), "image/webp"); err == nil {
		t.Fatal("a large webp should be refused")
	}
	if _, err := thumbnailOf([]byte("not an image"), "image/png"); err == nil {
		t.Fatal("garbage should be refused")
	}
}

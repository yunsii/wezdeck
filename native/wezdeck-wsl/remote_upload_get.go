package main

// Reading phone attachments back (docs/remote-sessions.md "Attachments"):
// `upload.get {name, offset}` answers one relay frame,
//
//	{mime, size, offset, data} — ≤ downloadChunk bytes from offset; the
//	                             phone asks again until offset+len == size
//
// The host only hands out bytes: the phone makes its own thumbnails
// (web/src/lib/upload-image.ts). Decoding here cost a gigabyte for a small
// PNG that declares a huge size, and had no webp decoder. A `thumb` field
// from an older page is ignored: it gets the first chunk.
//
// Only a bare file name inside the uploads dir is accepted (the same rule as
// attachmentNote), never a path, so this cannot read anything else.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const downloadChunk = 48 << 10

var uploadMime = map[string]string{
	".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
}

func uploadGet(args json.RawMessage) (any, error) {
	var a struct {
		Name   string `json:"name"`
		Offset int64  `json:"offset"`
	}
	if json.Unmarshal(args, &a) != nil {
		return nil, errors.New("bad request")
	}
	base := filepath.Base(a.Name)
	mime, ok := uploadMime[strings.ToLower(filepath.Ext(base))]
	if base != a.Name || !strings.HasPrefix(base, "img-") || !ok {
		return nil, errors.New("not a phone image")
	}
	data, err := os.ReadFile(filepath.Join(uploadDir(), base))
	if err != nil {
		return nil, errors.New("image is no longer on the host (kept 30 days)")
	}
	return serveImage(data, mime, a.Offset)
}

// serveImage answers one frame: a chunk of the original.
func serveImage(data []byte, mime string, offset int64) (any, error) {
	size := int64(len(data))
	if offset < 0 || offset > size {
		return nil, errors.New("bad offset")
	}
	end := min(offset+downloadChunk, size)
	return map[string]any{"mime": mime, "size": size, "offset": offset,
		"data": base64.StdEncoding.EncodeToString(data[offset:end])}, nil
}

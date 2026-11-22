package main

// Phone attachments (docs/remote-access.md "Attachments"): a screenshot or the
// client's diagnostics snapshot travels as signed `upload` chunks (a relay
// frame stays small enough for a DataChannel message), lands as one file
// under the uploads dir, and a later `send` names it so the agent gets the
// path appended to the message and can read it. Files older than 30 days are
// pruned on every completed upload.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	uploadChunkMax  = 64 << 10 // decoded bytes per chunk
	uploadFileMax   = 8 << 20
	uploadChunksMax = uploadFileMax / (32 << 10)
	uploadKeep      = 30 * 24 * time.Hour
	uploadStaleAge  = 10 * time.Minute
	attachmentsMax  = 6
)

var (
	uploadIDPattern = regexp.MustCompile(`^[0-9a-f-]{8,64}$`)
	uploadExt       = map[string]string{
		"image/jpeg":       "jpg",
		"image/png":        "png",
		"image/webp":       "webp",
		"image/gif":        "gif",
		"application/json": "json",
	}
)

type pendingUpload struct {
	mime   string
	total  int
	chunks [][]byte
	got    int
	size   int
	seen   time.Time
}

var (
	uploadsMu sync.Mutex
	uploads   = map[string]*pendingUpload{}
)

func uploadDir() string {
	if p := os.Getenv("WEZDECK_REMOTE_UPLOADS"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local/state/wezdeck/remote-uploads")
}

// uploadChunk stores one chunk; the last one writes the file and returns its name.
func uploadChunk(args json.RawMessage) (any, error) {
	var a struct {
		Upload string `json:"upload"`
		Seq    int    `json:"seq"`
		Total  int    `json:"total"`
		Mime   string `json:"mime"`
		Data   string `json:"data"`
	}
	if json.Unmarshal(args, &a) != nil || !uploadIDPattern.MatchString(a.Upload) {
		return nil, errors.New("bad upload id")
	}
	ext, ok := uploadExt[a.Mime]
	if !ok {
		return nil, fmt.Errorf("unsupported file type %q", a.Mime)
	}
	if a.Total < 1 || a.Total > uploadChunksMax || a.Seq < 0 || a.Seq >= a.Total {
		return nil, errors.New("bad chunk index")
	}
	data, err := base64.StdEncoding.DecodeString(a.Data)
	if err != nil || len(data) == 0 || len(data) > uploadChunkMax {
		return nil, errors.New("bad chunk data")
	}

	uploadsMu.Lock()
	for id, p := range uploads {
		if time.Since(p.seen) > uploadStaleAge {
			delete(uploads, id)
		}
	}
	p := uploads[a.Upload]
	if p == nil {
		p = &pendingUpload{mime: a.Mime, total: a.Total, chunks: make([][]byte, a.Total)}
		uploads[a.Upload] = p
	}
	if p.mime != a.Mime || p.total != a.Total {
		uploadsMu.Unlock()
		return nil, errors.New("chunk does not match its upload")
	}
	if p.chunks[a.Seq] == nil {
		p.got++
	}
	// a resent chunk replaces the old one: count the difference, or 1-byte
	// chunks resent at 64 KB would slip past uploadFileMax
	p.size += len(data) - len(p.chunks[a.Seq])
	p.chunks[a.Seq] = data
	p.seen = time.Now()
	if p.size > uploadFileMax {
		delete(uploads, a.Upload)
		uploadsMu.Unlock()
		return nil, fmt.Errorf("file is over %d MB", uploadFileMax>>20)
	}
	if p.got < p.total {
		got := p.got
		uploadsMu.Unlock()
		return map[string]any{"received": got, "total": a.Total}, nil
	}
	delete(uploads, a.Upload)
	uploadsMu.Unlock()

	body := bytes.Join(p.chunks, nil)
	if !contentMatches(a.Mime, body) {
		return nil, errors.New("file content does not match its type")
	}
	dir := uploadDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	pruneUploads(dir)
	prefix := "img"
	if ext == "json" {
		prefix = "diagnostics"
		var pretty bytes.Buffer
		if json.Indent(&pretty, body, "", "  ") == nil {
			body = pretty.Bytes()
		}
	}
	name := fmt.Sprintf("%s-%s-%s.%s", prefix, time.Now().Format("20060102-150405"), a.Upload[:8], ext)
	if err := os.WriteFile(filepath.Join(dir, name), body, 0o600); err != nil {
		return nil, err
	}
	return map[string]any{"name": name, "bytes": len(body)}, nil
}

// contentMatches checks magic bytes so a renamed file cannot pose as an image.
func contentMatches(mime string, b []byte) bool {
	switch mime {
	case "image/jpeg":
		return bytes.HasPrefix(b, []byte{0xff, 0xd8, 0xff})
	case "image/png":
		return bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n"))
	case "image/gif":
		return bytes.HasPrefix(b, []byte("GIF8"))
	case "image/webp":
		return len(b) > 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP"
	case "application/json":
		return json.Valid(b)
	}
	return false
}

func pruneUploads(dir string) {
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > uploadKeep {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

// attachmentNote resolves uploaded file names (never paths from the phone) and
// renders the lines appended to the message so the agent can open them.
func attachmentNote(names []string) (string, error) {
	if len(names) == 0 {
		return "", nil
	}
	if len(names) > attachmentsMax {
		return "", fmt.Errorf("at most %d attachments", attachmentsMax)
	}
	lines := []string{"[手机附件]"}
	for _, n := range names {
		base := filepath.Base(n)
		path := filepath.Join(uploadDir(), base)
		if base != n || base == "." || !strings.Contains(base, "-") {
			return "", fmt.Errorf("bad attachment %q", n)
		}
		if _, err := os.Stat(path); err != nil {
			return "", fmt.Errorf("attachment %q is not on the host (upload it again)", n)
		}
		label := "图片"
		if strings.HasPrefix(base, "diagnostics-") {
			label = "客户端诊断"
		}
		lines = append(lines, fmt.Sprintf("- %s: %s", label, path))
	}
	return strings.Join(lines, "\n"), nil
}

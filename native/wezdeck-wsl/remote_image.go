package main

// Images embedded in a Claude transcript (base64 blocks: a screenshot pasted
// at the desk, or an image a tool returned — Read of a .png, a browser
// screenshot) shown on the phone. The parser leaves a ref on the message
// (chatMessage.Images, "<line byte offset>.<nth image in that line>");
// `session.image {id, ref, thumb, offset}` re-reads that one line and answers
// like upload.get (serveImage): a ≤360 px thumbnail, or 48 KB chunks.

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
)

var imageRefPattern = regexp.MustCompile(`^(\d{1,15})\.(\d{1,4})$`)

func sessionImage(args json.RawMessage) (any, error) {
	var a struct {
		ID     string `json:"id"`
		Ref    string `json:"ref"`
		Thumb  bool   `json:"thumb"`
		Offset int64  `json:"offset"`
	}
	if json.Unmarshal(args, &a) != nil || !sessionIDPattern.MatchString(a.ID) {
		return nil, errors.New("bad request")
	}
	m := imageRefPattern.FindStringSubmatch(a.Ref)
	if m == nil {
		return nil, errors.New("bad image ref")
	}
	// only sessions the phone can see (live or recent), like `session`: an id
	// alone must not open any past transcript's pasted screenshots
	listed, err := liveSessions()
	if err != nil {
		return nil, err
	}
	if _, ok := listed[a.ID]; !ok {
		return nil, errors.New("session not found (ended or not tracked)")
	}
	path, agent := findTranscript(a.ID)
	if path == "" || agent != "claude" {
		return nil, errors.New("transcript not found")
	}
	lineOff, _ := strconv.ParseInt(m[1], 10, 64)
	nth, _ := strconv.Atoi(m[2])
	data, mime, err := transcriptImage(path, lineOff, nth)
	if err != nil {
		return nil, err
	}
	return serveImage(data, mime, a.Thumb, a.Offset)
}

// transcriptImage decodes the nth image of the line starting at lineOff,
// walking blocks in the parser's order: direct image blocks and tool_result
// image parts share one count.
func transcriptImage(path string, lineOff int64, nth int) ([]byte, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, "", err
	}
	defer f.Close()
	if _, err := f.Seek(lineOff, io.SeekStart); err != nil {
		return nil, "", err
	}
	line, err := bufio.NewReaderSize(f, 1<<20).ReadBytes('\n')
	if err != nil && err != io.EOF {
		return nil, "", err
	}
	type source struct {
		Type      string `json:"type"`
		MediaType string `json:"media_type"`
		Data      string `json:"data"`
	}
	type part struct {
		Type    string          `json:"type"`
		Source  source          `json:"source"`
		Content json.RawMessage `json:"content"`
	}
	var row struct {
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	var blocks []part
	if json.Unmarshal(line, &row) != nil || json.Unmarshal(row.Message.Content, &blocks) != nil {
		return nil, "", errors.New("image line not found (transcript changed?)")
	}
	n := 0
	pick := func(p part) ([]byte, string, bool) {
		if p.Type != "image" {
			return nil, "", false
		}
		n++
		if n-1 != nth || p.Source.Type != "base64" || !strings.HasPrefix(p.Source.MediaType, "image/") {
			return nil, "", false
		}
		b, err := base64.StdEncoding.DecodeString(p.Source.Data)
		return b, p.Source.MediaType, err == nil
	}
	for _, b := range blocks {
		if data, mime, ok := pick(b); ok {
			return data, mime, nil
		}
		if b.Type == "tool_result" {
			var parts []part
			if json.Unmarshal(b.Content, &parts) == nil {
				for _, p := range parts {
					if data, mime, ok := pick(p); ok {
						return data, mime, nil
					}
				}
			}
		}
	}
	return nil, "", errors.New("image not found in that line")
}

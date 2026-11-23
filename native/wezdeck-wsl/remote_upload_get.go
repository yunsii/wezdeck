package main

// Reading phone attachments back (docs/remote-sessions.md "Attachments"): the
// conversation shows an image the phone sent as a thumbnail, and opens the
// original on tap. `upload.get {name, thumb}` answers one relay frame:
//
//	thumb:true  → {mime:"image/jpeg", data, width, height} — the image scaled
//	              to thumbMax on its long edge (stdlib decode + box filter)
//	thumb:false → {mime, size, offset, data} — ≤ downloadChunk bytes from
//	              offset; the phone asks again until offset+len == size
//
// Only a bare file name inside the uploads dir is accepted (the same rule as
// attachmentNote), never a path, so this cannot read anything else.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	_ "image/gif" // decoders for image.Decode
	"image/jpeg"
	_ "image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	thumbMax      = 360
	downloadChunk = 48 << 10
)

var uploadMime = map[string]string{
	".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
}

func uploadGet(args json.RawMessage) (any, error) {
	var a struct {
		Name   string `json:"name"`
		Thumb  bool   `json:"thumb"`
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
	return serveImage(data, mime, a.Thumb, a.Offset)
}

// serveImage answers one frame: a thumbnail, or a chunk of the original.
func serveImage(data []byte, mime string, thumb bool, offset int64) (any, error) {
	if thumb {
		return thumbnailOf(data, mime)
	}
	size := int64(len(data))
	if offset < 0 || offset > size {
		return nil, errors.New("bad offset")
	}
	end := min(offset+downloadChunk, size)
	return map[string]any{"mime": mime, "size": size, "offset": offset,
		"data": base64.StdEncoding.EncodeToString(data[offset:end])}, nil
}

// thumbMaxPixels: a header is read before anything is decoded — a small
// PNG can declare 30000×30000, and decoding it took gigabytes (guest OOM).
const thumbMaxPixels = 40_000_000

// thumbPassThrough: formats the browser shows but Go has no decoder for
// here (webp: transcript screenshots) go back as they are when small.
const thumbPassThrough = 1_500_000

func thumbnailOf(data []byte, mime string) (any, error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		if mime == "image/webp" && len(data) <= thumbPassThrough {
			return map[string]any{"mime": mime, "data": base64.StdEncoding.EncodeToString(data)}, nil
		}
		return nil, errors.New("cannot make a thumbnail of this image")
	}
	if int64(cfg.Width)*int64(cfg.Height) > thumbMaxPixels {
		return nil, errors.New("image too large for a thumbnail")
	}
	return thumbnail(bytes.NewReader(data))
}

func thumbnail(r io.Reader) (any, error) {
	src, _, err := image.Decode(r)
	if err != nil {
		return nil, errors.New("cannot make a thumbnail of this image")
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	scale := float64(thumbMax) / float64(max(w, h))
	if scale > 1 {
		scale = 1
	}
	tw, th := max(1, int(float64(w)*scale)), max(1, int(float64(h)*scale))
	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	// box filter: average every source pixel that falls into a target pixel
	for y := 0; y < th; y++ {
		y0, y1 := b.Min.Y+y*h/th, b.Min.Y+max((y+1)*h/th, y*h/th+1)
		for x := 0; x < tw; x++ {
			x0, x1 := b.Min.X+x*w/tw, b.Min.X+max((x+1)*w/tw, x*w/tw+1)
			var rs, gs, bs, n uint64
			for sy := y0; sy < y1; sy++ {
				for sx := x0; sx < x1; sx++ {
					cr, cg, cb, _ := src.At(sx, sy).RGBA()
					rs, gs, bs, n = rs+uint64(cr), gs+uint64(cg), bs+uint64(cb), n+1
				}
			}
			i := dst.PixOffset(x, y)
			dst.Pix[i], dst.Pix[i+1], dst.Pix[i+2], dst.Pix[i+3] =
				uint8(rs/n>>8), uint8(gs/n>>8), uint8(bs/n>>8), 255
		}
	}
	var out bytes.Buffer
	if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: 72}); err != nil {
		return nil, err
	}
	return map[string]any{"mime": "image/jpeg", "width": w, "height": h,
		"data": base64.StdEncoding.EncodeToString(out.Bytes())}, nil
}

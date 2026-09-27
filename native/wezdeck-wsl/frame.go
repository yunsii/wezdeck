package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

const maxFrame = 8 << 20

type request struct {
	Version int             `json:"version"`
	TraceID string          `json:"trace_id"`
	Domain  string          `json:"domain"`
	Action  string          `json:"action"`
	Payload json.RawMessage `json:"payload"`
}

type response struct {
	Version      int    `json:"version"`
	TraceID      string `json:"trace_id"`
	Domain       string `json:"domain"`
	Action       string `json:"action"`
	OK           bool   `json:"ok"`
	Status       string `json:"status"`
	DecisionPath string `json:"decision_path"`
	Result       any    `json:"result,omitempty"`
	Error        string `json:"error,omitempty"`
}

func writeFrame(w io.Writer, payload []byte) error {
	if len(payload) > maxFrame {
		return fmt.Errorf("frame is %d bytes", len(payload))
	}
	var head [4]byte
	binary.LittleEndian.PutUint32(head[:], uint32(len(payload)))
	if _, err := w.Write(head[:]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

func readFrame(r io.Reader) ([]byte, error) {
	var head [4]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return nil, err
	}
	size := binary.LittleEndian.Uint32(head[:])
	if size > maxFrame {
		return nil, fmt.Errorf("frame is %d bytes", size)
	}
	body := make([]byte, size)
	_, err := io.ReadFull(r, body)
	return body, err
}

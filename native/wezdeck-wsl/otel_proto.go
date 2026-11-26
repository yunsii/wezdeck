package main

// Minimal zero-dependency OpenTelemetry OTLP/HTTP log decoder.
//
// Supports both OTLP JSON (`application/json`) and OTLP Protobuf
// (`application/x-protobuf`) for ExportLogsServiceRequest
// (opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest).
//
// Keeping the protobuf wire parser self-contained avoids pulling google.golang.org
// protobuf / otel SDK trees into the small static `wezdeck-wsl` binary.

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
)

type otelLogRecord struct {
	Resource     map[string]any
	ScopeName    string
	TimeUnixNano uint64
	EventName    string
	Body         any
	Attributes   map[string]any
}

const maxOTLPBodyBytes = 4 << 20 // 4 MiB

func readHTTPBody(r io.Reader, contentEncoding string) ([]byte, error) {
	limited := io.LimitReader(r, maxOTLPBodyBytes+1)
	raw, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if len(raw) > maxOTLPBodyBytes {
		return nil, errors.New("otlp payload exceeds 4 MiB limit")
	}
	if strings.EqualFold(strings.TrimSpace(contentEncoding), "gzip") {
		gz, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, fmt.Errorf("gzip open: %w", err)
		}
		defer gz.Close()
		out, err := io.ReadAll(io.LimitReader(gz, maxOTLPBodyBytes+1))
		if err != nil {
			return nil, fmt.Errorf("gzip read: %w", err)
		}
		if len(out) > maxOTLPBodyBytes {
			return nil, errors.New("decompressed otlp payload exceeds 4 MiB limit")
		}
		return out, nil
	}
	return raw, nil
}

func decodeOTLPLogs(data []byte, contentType string) ([]otelLogRecord, error) {
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, nil
	}
	ct := strings.ToLower(contentType)
	if strings.Contains(ct, "protobuf") || strings.Contains(ct, "octet-stream") {
		return decodeOTLPProtoLogs(data)
	}
	if strings.Contains(ct, "json") {
		return decodeOTLPJSONLogs(data)
	}
	// Sniff when Content-Type is omitted or generic.
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 && trimmed[0] == '{' {
		return decodeOTLPJSONLogs(trimmed)
	}
	return decodeOTLPProtoLogs(data)
}

// --- OTLP JSON ---

type otlpJSONAnyValue struct {
	StringValue *string           `json:"stringValue,omitempty"`
	BoolValue   *bool             `json:"boolValue,omitempty"`
	IntValue    json.RawMessage   `json:"intValue,omitempty"`
	DoubleValue *float64          `json:"doubleValue,omitempty"`
	ArrayValue  *otlpJSONArray    `json:"arrayValue,omitempty"`
	KvlistValue *otlpJSONKvlist   `json:"kvlistValue,omitempty"`
}

type otlpJSONArray struct {
	Values []otlpJSONAnyValue `json:"values"`
}

type otlpJSONKvlist struct {
	Values []otlpJSONKeyValue `json:"values"`
}

type otlpJSONKeyValue struct {
	Key   string           `json:"key"`
	Value otlpJSONAnyValue `json:"value"`
}

func (v otlpJSONAnyValue) toGo() any {
	if v.StringValue != nil {
		return *v.StringValue
	}
	if v.BoolValue != nil {
		return *v.BoolValue
	}
	if len(v.IntValue) > 0 {
		var s string
		if json.Unmarshal(v.IntValue, &s) == nil {
			if n, err := strconv.ParseInt(s, 10, 64); err == nil {
				return n
			}
			return s
		}
		var n int64
		if json.Unmarshal(v.IntValue, &n) == nil {
			return n
		}
		var f float64
		if json.Unmarshal(v.IntValue, &f) == nil {
			return int64(f)
		}
	}
	if v.DoubleValue != nil {
		return *v.DoubleValue
	}
	if v.KvlistValue != nil {
		m := make(map[string]any, len(v.KvlistValue.Values))
		for _, kv := range v.KvlistValue.Values {
			if kv.Key != "" {
				m[kv.Key] = kv.Value.toGo()
			}
		}
		return m
	}
	if v.ArrayValue != nil {
		out := make([]any, 0, len(v.ArrayValue.Values))
		for _, item := range v.ArrayValue.Values {
			out = append(out, item.toGo())
		}
		return out
	}
	return nil
}

func jsonAttrsToMap(kvs []otlpJSONKeyValue) map[string]any {
	m := make(map[string]any, len(kvs))
	for _, kv := range kvs {
		if kv.Key != "" {
			m[kv.Key] = kv.Value.toGo()
		}
	}
	return m
}

func parseUnixNanoJSON(raw json.RawMessage) uint64 {
	if len(raw) == 0 {
		return 0
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if n, err := strconv.ParseUint(strings.TrimSpace(s), 10, 64); err == nil {
			return n
		}
	}
	var n uint64
	if json.Unmarshal(raw, &n) == nil {
		return n
	}
	return 0
}

func decodeOTLPJSONLogs(data []byte) ([]otelLogRecord, error) {
	var req struct {
		ResourceLogs []struct {
			Resource struct {
				Attributes []otlpJSONKeyValue `json:"attributes"`
			} `json:"resource"`
			ScopeLogs []struct {
				Scope struct {
					Name string `json:"name"`
				} `json:"scope"`
				LogRecords []struct {
					TimeUnixNano         json.RawMessage    `json:"timeUnixNano"`
					ObservedTimeUnixNano json.RawMessage    `json:"observedTimeUnixNano"`
					EventName            string             `json:"eventName"`
					Body                 *otlpJSONAnyValue  `json:"body"`
					Attributes           []otlpJSONKeyValue `json:"attributes"`
				} `json:"logRecords"`
			} `json:"scopeLogs"`
		} `json:"resourceLogs"`
	}
	if err := json.Unmarshal(data, &req); err != nil {
		return nil, fmt.Errorf("otlp json decode: %w", err)
	}
	var records []otelLogRecord
	for _, rl := range req.ResourceLogs {
		resAttrs := jsonAttrsToMap(rl.Resource.Attributes)
		for _, sl := range rl.ScopeLogs {
			for _, lr := range sl.LogRecords {
				ts := parseUnixNanoJSON(lr.TimeUnixNano)
				if ts == 0 {
					ts = parseUnixNanoJSON(lr.ObservedTimeUnixNano)
				}
				var body any
				if lr.Body != nil {
					body = lr.Body.toGo()
				}
				records = append(records, otelLogRecord{
					Resource:     resAttrs,
					ScopeName:    sl.Scope.Name,
					TimeUnixNano: ts,
					EventName:    lr.EventName,
					Body:         body,
					Attributes:   jsonAttrsToMap(lr.Attributes),
				})
			}
		}
	}
	return records, nil
}

// --- OTLP Protobuf Wire Decoder ---

func consumeVarint(b []byte) (uint64, int, error) {
	v, n := binary.Uvarint(b)
	if n == 0 {
		return 0, 0, errors.New("truncated varint")
	}
	if n < 0 {
		return 0, 0, errors.New("varint overflow")
	}
	return v, n, nil
}

func consumeField(b []byte) (fieldNum uint64, wireType uint64, val []byte, u64 uint64, consumed int, err error) {
	tag, n, err := consumeVarint(b)
	if err != nil {
		return 0, 0, nil, 0, 0, err
	}
	fieldNum = tag >> 3
	wireType = tag & 0x7
	pos := n
	switch wireType {
	case 0: // varint
		v, vn, verr := consumeVarint(b[pos:])
		if verr != nil {
			return 0, 0, nil, 0, 0, verr
		}
		return fieldNum, wireType, nil, v, pos + vn, nil
	case 1: // 64-bit
		if len(b)-pos < 8 {
			return 0, 0, nil, 0, 0, errors.New("truncated 64-bit field")
		}
		v := binary.LittleEndian.Uint64(b[pos : pos+8])
		return fieldNum, wireType, b[pos : pos+8], v, pos + 8, nil
	case 2: // length-delimited
		ln, lnn, lerr := consumeVarint(b[pos:])
		if lerr != nil {
			return 0, 0, nil, 0, 0, lerr
		}
		pos += lnn
		if ln > uint64(len(b)-pos) {
			return 0, 0, nil, 0, 0, errors.New("truncated length-delimited field")
		}
		end := pos + int(ln)
		return fieldNum, wireType, b[pos:end], ln, end, nil
	case 5: // 32-bit
		if len(b)-pos < 4 {
			return 0, 0, nil, 0, 0, errors.New("truncated 32-bit field")
		}
		v := uint64(binary.LittleEndian.Uint32(b[pos : pos+4]))
		return fieldNum, wireType, b[pos : pos+4], v, pos + 4, nil
	default:
		return 0, 0, nil, 0, 0, fmt.Errorf("unsupported protobuf wire type %d", wireType)
	}
}

func decodeProtoAnyValue(b []byte, depth int) (any, error) {
	if depth > 8 {
		return nil, nil
	}
	for pos := 0; pos < len(b); {
		num, wt, val, u64, n, err := consumeField(b[pos:])
		if err != nil {
			return nil, err
		}
		pos += n
		switch {
		case num == 1 && wt == 2: // string_value
			return string(val), nil
		case num == 2 && wt == 0: // bool_value
			return u64 != 0, nil
		case num == 3 && wt == 0: // int_value (int64)
			return int64(u64), nil
		case num == 4 && wt == 1: // double_value
			return math.Float64frombits(u64), nil
		case num == 5 && wt == 2: // array_value
			var items []any
			for ap := 0; ap < len(val); {
				anum, awt, aval, _, an, aerr := consumeField(val[ap:])
				if aerr != nil {
					return nil, aerr
				}
				ap += an
				if anum == 1 && awt == 2 {
					elem, eerr := decodeProtoAnyValue(aval, depth+1)
					if eerr != nil {
						return nil, eerr
					}
					items = append(items, elem)
				}
			}
			return items, nil
		case num == 6 && wt == 2: // kvlist_value
			m := map[string]any{}
			for kp := 0; kp < len(val); {
				knum, kwt, kval, _, kn, kerr := consumeField(val[kp:])
				if kerr != nil {
					return nil, kerr
				}
				kp += kn
				if knum == 1 && kwt == 2 {
					k, v, kverr := decodeProtoKeyValue(kval, depth+1)
					if kverr != nil {
						return nil, kverr
					}
					if k != "" {
						m[k] = v
					}
				}
			}
			return m, nil
		}
	}
	return nil, nil
}

func decodeProtoKeyValue(b []byte, depth int) (string, any, error) {
	var key string
	var value any
	for pos := 0; pos < len(b); {
		num, wt, val, _, n, err := consumeField(b[pos:])
		if err != nil {
			return "", nil, err
		}
		pos += n
		switch {
		case num == 1 && wt == 2:
			key = string(val)
		case num == 2 && wt == 2:
			v, verr := decodeProtoAnyValue(val, depth)
			if verr != nil {
				return "", nil, verr
			}
			value = v
		}
	}
	return key, value, nil
}

func decodeProtoResource(b []byte) (map[string]any, error) {
	attrs := map[string]any{}
	for pos := 0; pos < len(b); {
		num, wt, val, _, n, err := consumeField(b[pos:])
		if err != nil {
			return nil, err
		}
		pos += n
		if num == 1 && wt == 2 { // attributes
			k, v, kerr := decodeProtoKeyValue(val, 0)
			if kerr != nil {
				return nil, kerr
			}
			if k != "" {
				attrs[k] = v
			}
		}
	}
	return attrs, nil
}

func decodeProtoScopeName(b []byte) (string, error) {
	for pos := 0; pos < len(b); {
		num, wt, val, _, n, err := consumeField(b[pos:])
		if err != nil {
			return "", err
		}
		pos += n
		if num == 1 && wt == 2 {
			return string(val), nil
		}
	}
	return "", nil
}

func decodeProtoLogRecord(b []byte, resource map[string]any, scopeName string) (otelLogRecord, error) {
	rec := otelLogRecord{
		Resource:   resource,
		ScopeName:  scopeName,
		Attributes: map[string]any{},
	}
	var observed uint64
	for pos := 0; pos < len(b); {
		num, wt, val, u64, n, err := consumeField(b[pos:])
		if err != nil {
			return rec, err
		}
		pos += n
		switch {
		case num == 1 && wt == 1: // time_unix_nano (fixed64)
			rec.TimeUnixNano = u64
		case num == 5 && wt == 2: // body (AnyValue)
			v, verr := decodeProtoAnyValue(val, 0)
			if verr != nil {
				return rec, verr
			}
			rec.Body = v
		case num == 6 && wt == 2: // attributes (KeyValue)
			k, v, kerr := decodeProtoKeyValue(val, 0)
			if kerr != nil {
				return rec, kerr
			}
			if k != "" {
				rec.Attributes[k] = v
			}
		case num == 11 && wt == 1: // observed_time_unix_nano (fixed64)
			observed = u64
		case num == 12 && wt == 2: // event_name (string)
			rec.EventName = string(val)
		}
	}
	if rec.TimeUnixNano == 0 {
		rec.TimeUnixNano = observed
	}
	return rec, nil
}

func decodeOTLPProtoLogs(data []byte) ([]otelLogRecord, error) {
	var records []otelLogRecord
	for pos := 0; pos < len(data); {
		num, wt, rlBytes, _, n, err := consumeField(data[pos:])
		if err != nil {
			return nil, fmt.Errorf("otlp proto top: %w", err)
		}
		pos += n
		if num != 1 || wt != 2 { // ExportLogsServiceRequest.resource_logs = 1
			continue
		}
		var resource map[string]any
		var scopeBlobs [][]byte
		for rpos := 0; rpos < len(rlBytes); {
			rnum, rwt, rval, _, rn, rerr := consumeField(rlBytes[rpos:])
			if rerr != nil {
				return nil, fmt.Errorf("otlp proto resource_logs: %w", rerr)
			}
			rpos += rn
			switch {
			case rnum == 1 && rwt == 2: // resource
				resource, err = decodeProtoResource(rval)
				if err != nil {
					return nil, err
				}
			case rnum == 2 && rwt == 2: // scope_logs
				scopeBlobs = append(scopeBlobs, rval)
			}
		}
		if resource == nil {
			resource = map[string]any{}
		}
		for _, slBytes := range scopeBlobs {
			var scopeName string
			var logBlobs [][]byte
			for spos := 0; spos < len(slBytes); {
				snum, swt, sval, _, sn, serr := consumeField(slBytes[spos:])
				if serr != nil {
					return nil, fmt.Errorf("otlp proto scope_logs: %w", serr)
				}
				spos += sn
				switch {
				case snum == 1 && swt == 2:
					scopeName, err = decodeProtoScopeName(sval)
					if err != nil {
						return nil, err
					}
				case snum == 2 && swt == 2:
					logBlobs = append(logBlobs, sval)
				}
			}
			for _, lb := range logBlobs {
				rec, lerr := decodeProtoLogRecord(lb, resource, scopeName)
				if lerr != nil {
					return nil, fmt.Errorf("otlp proto log_record: %w", lerr)
				}
				records = append(records, rec)
			}
		}
	}
	return records, nil
}

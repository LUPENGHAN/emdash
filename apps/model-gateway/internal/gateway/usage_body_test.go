package gateway

import (
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestUsageObservationDistinguishesCompleteAndTruncatedStreams(t *testing.T) {
	for _, test := range []struct {
		name, alt, data string
		failed          bool
	}{
		{"responses truncated", "", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n", true},
		{"responses complete", "", "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1}}}\n\n", false},
		{"chat truncated", "chat/completions", "data: {\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2}}\n\n", true},
		{"chat complete", "chat/completions", "data: {\"usage\":{\"prompt_tokens\":7}}\n\ndata: [DONE]\n\n", false},
		{"messages truncated", "messages", "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":7}}}\n\n", true},
		{"messages complete", "messages", "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":7}}}\n\ndata: {\"type\":\"message_stop\"}\n\n", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			body := observeBody(io.NopCloser(strings.NewReader(test.data)), nil, nil, true, test.alt, func(payload []byte, failed bool) {
				calls++
				if failed != test.failed {
					t.Errorf("failed=%v want=%v", failed, test.failed)
				}
				if test.alt != "" && !bytes.Contains(payload, []byte(`"input_tokens":7`)) {
					t.Errorf("partial token evidence lost: %s", payload)
				}
			})
			actual, err := io.ReadAll(body)
			body.Close()
			if err != nil || string(actual) != test.data || calls != 1 {
				t.Fatalf("wire bytes or record count changed: calls=%d err=%v", calls, err)
			}
		})
	}
}

func TestUsageCodecFailuresNeverRewriteResponseBytes(t *testing.T) {
	valid, err := encodeRequestPayload([]byte("data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1}}}\n\n"), "gzip")
	if err != nil {
		t.Fatal(err)
	}
	corrupt := append([]byte(nil), valid...)
	corrupt[len(corrupt)-1] ^= 0xff
	for _, test := range []struct {
		name, encoding string
		data           []byte
		failed         bool
	}{
		{"unknown encoding", "br", []byte("opaque bytes"), false},
		{"invalid gzip", "gzip", []byte("invalid gzip bytes"), true},
		{"corrupt gzip checksum", "gzip", corrupt, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := observeBody(io.NopCloser(bytes.NewReader(test.data)), http.Header{"Content-Encoding": {test.encoding}}, nil, true, "", func(_ []byte, failed bool) {
				if failed != test.failed {
					t.Errorf("failed=%v want=%v", failed, test.failed)
				}
			})
			actual, err := io.ReadAll(body)
			body.Close()
			if err != nil || !bytes.Equal(actual, test.data) {
				t.Fatalf("observer altered wire response: err=%v", err)
			}
		})
	}
}

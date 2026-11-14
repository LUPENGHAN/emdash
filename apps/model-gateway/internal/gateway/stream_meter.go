package gateway

import (
	"bytes"
	"encoding/json"
)

type streamMeter struct {
	input, output, cached, created int64
	messages                       bool
	known, complete, failed        bool
	response                       []byte
}

func (m *streamMeter) observe(data []byte, protocol string) {
	m.messages = protocol == "messages"
	if string(bytes.TrimSpace(data)) == "[DONE]" {
		m.complete = true
		return
	}
	var event struct {
		Type string `json:"type"`
	}
	// Usage contains nested objects on some providers; inspect individual fields below.
	var object map[string]json.RawMessage
	if json.Unmarshal(data, &object) != nil {
		return
	}
	_ = json.Unmarshal(object["type"], &event.Type)
	if protocol == "" || protocol == "responses/compact" {
		if event.Type == "response.completed" || event.Type == "response.incomplete" || event.Type == "response.failed" {
			m.complete = true
			m.failed = event.Type != "response.completed"
			m.response = append([]byte(nil), data...)
		}
		return
	}
	usage := object["usage"]
	if event.Type == "message_start" {
		var message map[string]json.RawMessage
		_ = json.Unmarshal(object["message"], &message)
		usage = message["usage"]
	}
	if len(usage) > 0 && string(usage) != "null" {
		var counts map[string]json.RawMessage
		if json.Unmarshal(usage, &counts) == nil {
			m.known = true
			read := func(key string, value *int64) {
				if counts[key] != nil {
					_ = json.Unmarshal(counts[key], value)
				}
			}
			read("prompt_tokens", &m.input)
			read("input_tokens", &m.input)
			read("completion_tokens", &m.output)
			read("output_tokens", &m.output)
			read("cache_read_input_tokens", &m.cached)
			read("cache_creation_input_tokens", &m.created)
			var details struct {
				Cached int64 `json:"cached_tokens"`
			}
			if json.Unmarshal(counts["prompt_tokens_details"], &details) == nil {
				m.cached = details.Cached
			}
		}
	}
	if event.Type == "message_stop" {
		m.complete = true
	}
	if event.Type == "error" {
		m.failed = true
	}
}

func (m *streamMeter) payload() []byte {
	if m.response != nil {
		return m.response
	}
	if !m.known {
		return nil
	}
	cached := m.cached
	if cached == 0 {
		cached = m.created
	}
	total := m.input + m.output
	if m.messages {
		total += m.cached + m.created
	}
	data, _ := json.Marshal(map[string]any{"response": map[string]any{"usage": map[string]any{
		"input_tokens": m.input, "output_tokens": m.output, "total_tokens": total,
		"input_tokens_details": map[string]int64{"cached_tokens": cached},
	}}})
	return data
}

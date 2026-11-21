package gateway

import (
	"bytes"
	"encoding/json"
)

type streamMeter struct {
	input, output           int64
	cache                   cacheTokenCounts
	messages                bool
	known, complete, failed bool
	response                []byte
}

type cacheTokenCounts struct {
	Read  *int64 `json:"cached_tokens,omitempty"`
	Write *int64 `json:"cache_write_tokens,omitempty"`
}

func tokenCount(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
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
			readCacheCount(counts["cache_read_input_tokens"], &m.cache.Read)
			readCacheCount(counts["cache_creation_input_tokens"], &m.cache.Write)
			var details map[string]json.RawMessage
			if json.Unmarshal(counts["prompt_tokens_details"], &details) == nil {
				readCacheCount(details["cached_tokens"], &m.cache.Read)
				readCacheCount(details["cache_write_tokens"], &m.cache.Write)
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

func readCacheCount(raw json.RawMessage, dest **int64) {
	var count *int64
	if json.Unmarshal(raw, &count) == nil && count != nil {
		*dest = count
	}
}

func (m *streamMeter) payload() []byte {
	if m.response != nil {
		return m.response
	}
	if !m.known {
		return nil
	}
	total := m.input + m.output
	if m.messages {
		total += tokenCount(m.cache.Read) + tokenCount(m.cache.Write)
	}
	data, _ := json.Marshal(map[string]any{"response": map[string]any{"usage": map[string]any{
		"input_tokens": m.input, "output_tokens": m.output, "total_tokens": total,
		"input_tokens_details": m.cache,
	}}})
	return data
}

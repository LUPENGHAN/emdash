package gateway

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	a "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	e "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	t "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/translator/builtin"
)

func wireFormat(protocol string) t.Format {
	switch protocol {
	case "anthropic":
		return t.FormatClaude
	case "openai-chat":
		return t.FormatOpenAI
	default:
		return t.FormatOpenAIResponse
	}
}

func canConvert(from, to string) bool {
	r := builtin.Registry()
	f, target := wireFormat(from), wireFormat(to)
	return r.HasRequestTransformer(f, target) && r.HasStreamResponseTransformer(f, target) && r.HasNonStreamResponseTransformer(f, target)
}

func selectProtocol(route ModelRoute, model, inbound string) (string, error) {
	mapping := route.ProtocolModels[model]
	if route.Policy.Mode == "fixed" {
		target := route.Policy.Protocol
		if mapping[target] != "" && (target == inbound || canConvert(inbound, target)) {
			return target, nil
		}
		return "", routeError("The fixed upstream protocol is incompatible with this agent.")
	}
	if mapping[inbound] != "" {
		return inbound, nil
	}
	targets := map[string][]string{"anthropic": {"openai-chat"}, "openai-responses": {"anthropic", "openai-chat"}, "openai-chat": {"anthropic"}}[inbound]
	if explicit := route.Policy.ConversionTargets[inbound]; explicit != "" {
		targets = []string{explicit}
	}
	for _, target := range targets {
		if mapping[target] != "" && canConvert(inbound, target) {
			return target, nil
		}
	}
	return "", routeError("No supported SDK conversion exists for this model and agent protocol.")
}

// Refuse features whose state or semantics cannot be carried by the conversion path.
func validateConversion(payload []byte, inbound string) error {
	var body map[string]json.RawMessage
	if err := json.Unmarshal(payload, &body); err != nil {
		return routeError("Invalid JSON request.")
	}
	allowed := map[string]string{
		"anthropic":        "model messages system tools tool_choice max_tokens stream temperature top_p top_k stop_sequences metadata thinking output_config",
		"openai-chat":      "model messages tools tool_choice max_tokens max_completion_tokens stream stream_options temperature top_p stop n presence_penalty frequency_penalty parallel_tool_calls reasoning_effort user",
		"openai-responses": "model input instructions tools tool_choice max_output_tokens stream temperature top_p parallel_tool_calls reasoning store metadata user",
	}[inbound]
	fields := " " + allowed + " "
	for key := range body {
		if !strings.Contains(fields, " "+key+" ") {
			return routeError(fmt.Sprintf("Field %q is not supported across these protocols; use a native protocol endpoint.", key))
		}
	}
	var tools []map[string]json.RawMessage
	if len(body["tools"]) > 0 && json.Unmarshal(body["tools"], &tools) != nil {
		return routeError("Invalid tool definitions.")
	}
	for _, tool := range tools {
		keys := " name description input_schema "
		if inbound == "openai-chat" {
			keys = " type function "
		}
		if inbound == "openai-responses" {
			keys = " type name description parameters "
		}
		for key := range tool {
			if !strings.Contains(keys, " "+key+" ") {
				return routeError(fmt.Sprintf("Tool field %q requires a native protocol endpoint.", key))
			}
		}
		if inbound == "openai-chat" {
			var function map[string]json.RawMessage
			if json.Unmarshal(tool["function"], &function) != nil {
				return routeError("Invalid function tool.")
			}
			for key := range function {
				if !strings.Contains(" name description parameters ", " "+key+" ") {
					return routeError(fmt.Sprintf("Function field %q requires a native protocol endpoint.", key))
				}
			}
		}
	}
	if raw := body["store"]; len(raw) > 0 && string(raw) != "false" {
		return routeError("Server-stored response state requires a native protocol endpoint.")
	}
	if raw := body["output_config"]; len(raw) > 0 {
		var output map[string]json.RawMessage
		if json.Unmarshal(raw, &output) != nil {
			return routeError("Invalid output configuration.")
		}
		for key := range output {
			if key != "effort" {
				return routeError("Structured output and task budgets require a native protocol endpoint.")
			}
		}
	}
	// These blocks carry provider-bound state or functionality beyond portable tools/text.
	var check func(any) error
	check = func(value any) error {
		switch v := value.(type) {
		case map[string]any:
			for _, key := range []string{"signature", "encrypted_content", "cache_control"} {
				if _, found := v[key]; found {
					return routeError("Signed reasoning, encrypted state and cache directives require a native protocol endpoint.")
				}
			}
			if kind, _ := v["type"].(string); kind != "" {
				switch kind {
				case "text", "input_text", "output_text", "message", "tool_use", "tool_result", "function", "function_call", "function_call_output", "enabled", "disabled", "auto", "any", "tool":
				default:
					return routeError(fmt.Sprintf("Content or tool type %q is not supported by this conversion path.", kind))
				}
			}
			for key, item := range v {
				// JSON schemas and function arguments are user data, not protocol blocks.
				if key != "input_schema" && key != "parameters" && key != "arguments" && key != "input" {
					if err := check(item); err != nil {
						return err
					}
				}
			}
		case []any:
			for _, item := range v {
				if err := check(item); err != nil {
					return err
				}
			}
		}
		return nil
	}
	for _, key := range []string{"messages", "input", "tools", "system"} {
		var value any
		if len(body[key]) > 0 {
			_ = json.Unmarshal(body[key], &value)
			if err := check(value); err != nil {
				return err
			}
		}
	}
	if err := validateMessageFields(body, inbound); err != nil {
		return err
	}
	return nil
}

func portableFields(object map[string]json.RawMessage, allowed, path string) error {
	for key := range object {
		if !strings.Contains(" "+allowed+" ", " "+key+" ") {
			return routeError(fmt.Sprintf("Field %s.%s requires a native protocol endpoint.", path, key))
		}
	}
	return nil
}

func validateMessageFields(body map[string]json.RawMessage, inbound string) error {
	var blocks func(json.RawMessage) error
	blocks = func(raw json.RawMessage) error {
		raw = bytes.TrimSpace(raw)
		if len(raw) == 0 || string(raw) == "null" || raw[0] == '"' {
			return nil
		}
		var entries []map[string]json.RawMessage
		if json.Unmarshal(raw, &entries) != nil {
			return routeError("Unsupported structured message content.")
		}
		for _, block := range entries {
			var kind string
			_ = json.Unmarshal(block["type"], &kind)
			allowed := "type text annotations"
			if kind == "tool_use" {
				allowed = "type id name input"
			}
			if kind == "tool_result" {
				allowed = "type tool_use_id content is_error"
			}
			if err := portableFields(block, allowed, "content"); err != nil {
				return err
			}
			if annotations := block["annotations"]; len(annotations) > 0 {
				var values []json.RawMessage
				if json.Unmarshal(annotations, &values) != nil || len(values) != 0 {
					return routeError("Citations require a native protocol endpoint.")
				}
			}
			if kind == "tool_result" {
				if err := blocks(block["content"]); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := blocks(body["system"]); err != nil {
		return err
	}
	field := "messages"
	if inbound == "openai-responses" {
		field = "input"
	}
	raw := bytes.TrimSpace(body[field])
	if len(raw) == 0 || raw[0] == '"' {
		return nil
	}
	var messages []map[string]json.RawMessage
	if json.Unmarshal(raw, &messages) != nil {
		return routeError("Unsupported structured messages.")
	}
	for _, message := range messages {
		allowed := "role content"
		if inbound == "openai-chat" {
			allowed = "role content name tool_calls tool_call_id reasoning_content"
		}
		if inbound == "openai-responses" {
			allowed = "type role content id status call_id name arguments output"
		}
		if err := portableFields(message, allowed, field); err != nil {
			return err
		}
		if err := blocks(message["content"]); err != nil {
			return err
		}
		var calls []map[string]json.RawMessage
		if raw := message["tool_calls"]; len(raw) > 0 {
			if json.Unmarshal(raw, &calls) != nil {
				return routeError("Invalid tool calls.")
			}
			for _, call := range calls {
				if err := portableFields(call, "id type function", "tool_calls"); err != nil {
					return err
				}
				var function map[string]json.RawMessage
				if json.Unmarshal(call["function"], &function) != nil {
					return routeError("Invalid tool call function.")
				}
				if err := portableFields(function, "name arguments", "tool_calls.function"); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func protocolPath(protocol string) string {
	switch protocol {
	case "anthropic":
		return "messages"
	case "openai-chat":
		return "chat/completions"
	default:
		return "responses"
	}
}

func (x ResponsesExecutor) serveConverted(c *gin.Context, auth *a.Auth, req e.Request, decoded []byte, stream bool, inbound, target string) {
	fail := func(code int, err error) {
		c.JSON(code, gin.H{"error": gin.H{"type": "gateway_conversion_error", "message": err.Error()}})
	}
	if hasRequestIntegrity(c.Request.Header) || hasRequestIntegrity(c.Request.Trailer) {
		fail(400, integrityRewriteError{})
		return
	}
	var configured map[string]string
	_ = json.Unmarshal([]byte(auth.Attributes["emdash_headers"]), &configured)
	for key := range configured {
		if hasRequestIntegrity(http.Header{key: nil}) {
			fail(400, integrityRewriteError{})
			return
		}
	}
	if err := validateConversion(decoded, inbound); err != nil {
		fail(400, err)
		return
	}
	from, to := wireFormat(inbound), wireFormat(target)
	var mapping map[string]string
	_ = json.Unmarshal([]byte(auth.Attributes["emdash_models"]), &mapping)
	translated := builtin.Registry().TranslateRequestEnvelope(c.Request.Context(), from, to, t.RequestEnvelope{Format: from, Model: mapping[req.Model], Body: decoded, Stream: stream})
	if translated.Err != nil {
		fail(400, translated.Err)
		return
	}
	// Keep the conversion payload separate from the raw passthrough branch.
	copy := c.Copy()
	copy.Request = c.Request.Clone(c.Request.Context())
	copy.Request.Header = c.Request.Header.Clone()
	for _, key := range []string{"Content-Encoding", "Content-Length", "Accept-Encoding", "anthropic-version", "anthropic-beta"} {
		copy.Request.Header.Del(key)
	}
	copy.Request.Header.Set("Accept-Encoding", "identity")
	copy.Request.Trailer = nil
	copy.Request.URL.RawQuery = ""
	ctx := context.WithValue(c.Request.Context(), "gin", copy)
	prepared, err := upstreamRequest(ctx, auth, e.Request{Model: req.Model, Payload: translated.Body}, protocolPath(target))
	if err != nil {
		fail(400, err)
		return
	}
	started := time.Now()
	ctx = snapshotSession(prepared.Context())
	res, err := x.HttpRequest(ctx, auth, prepared)
	if err != nil {
		usageRecord(ctx, auth, req, started, nil, true)
		fail(502, routeError("The upstream connection failed; the request was not replayed."))
		return
	}
	defer res.Body.Close()
	res.Body = observeBody(res.Body, res.Header, res.Trailer, stream && res.StatusCode < 300, protocolPath(target), func(payload []byte, failed bool) {
		usageRecord(ctx, auth, req, started, payload, failed || res.StatusCode >= 300)
	})
	defer res.Body.Close()
	for key, values := range forwardHeaders(res.Header, false) {
		switch strings.ToLower(key) {
		case "content-length", "content-type", "content-encoding", "content-md5", "digest", "content-digest", "repr-digest", "etag":
			continue
		}
		c.Writer.Header()[key] = values
	}
	c.Header("Cache-Control", "no-store")
	if res.StatusCode >= 300 {
		c.Header("Content-Type", res.Header.Get("Content-Type"))
		c.Header("Content-Encoding", res.Header.Get("Content-Encoding"))
		c.Status(res.StatusCode)
		_, _ = io.Copy(c.Writer, res.Body)
		return
	}
	if encoding := res.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		fail(502, routeError("Encoded upstream responses are not supported across protocols."))
		return
	}
	var state any
	if !stream {
		body, err := io.ReadAll(io.LimitReader(res.Body, maxRequestBody+1))
		if err != nil || len(body) > maxRequestBody {
			fail(502, routeError("Upstream response is incomplete or too large."))
			return
		}
		out := builtin.Registry().TranslateNonStream(ctx, to, from, req.Model, decoded, translated.Body, body, &state)
		if !json.Valid(out) {
			fail(502, routeError("The SDK could not translate the upstream response."))
			return
		}
		c.Data(res.StatusCode, "application/json", out)
		return
	}
	c.Header("Content-Type", "text/event-stream")
	c.Status(res.StatusCode)
	reader := bufio.NewReaderSize(res.Body, 32*1024)
	meter := streamMeter{}
	var data []byte
	upstreamFailed := false
	dispatch := func() bool {
		if len(data) == 0 {
			return true
		}
		alt := protocolPath(target)
		if alt == "responses" {
			alt = ""
		}
		meter.observe(data, alt)
		var problem map[string]json.RawMessage
		if json.Unmarshal(data, &problem) == nil && problem["error"] != nil {
			upstreamFailed = true
			problem["type"] = json.RawMessage(`"error"`)
			encoded, _ := json.Marshal(problem)
			prefix := "data: "
			if inbound != "openai-chat" {
				prefix = "event: error\ndata: "
			}
			_, _ = c.Writer.Write(append(append([]byte(prefix), encoded...), []byte("\n\n")...))
			c.Writer.Flush()
			data = nil
			return true
		}
		input := append([]byte("data: "), data...)
		for _, out := range builtin.Registry().TranslateStream(ctx, to, from, req.Model, decoded, translated.Body, input, &state) {
			if json.Valid(out) {
				prefix := "data: "
				if inbound != "openai-chat" {
					var event struct {
						Type string `json:"type"`
					}
					_ = json.Unmarshal(out, &event)
					if event.Type != "" {
						prefix = "event: " + event.Type + "\ndata: "
					}
				}
				out = append(append([]byte(prefix), out...), []byte("\n\n")...)
			}
			if _, err := c.Writer.Write(out); err != nil {
				return false
			}
			c.Writer.Flush()
		}
		data = nil
		return true
	}
	for {
		line, err := readSSELine(reader)
		if err != nil && err != io.EOF {
			c.Writer.Flush()
			panic(http.ErrAbortHandler)
		}
		if len(bytes.TrimSpace(line)) == 0 {
			if !dispatch() {
				return
			}
			if upstreamFailed {
				return
			}
		} else if bytes.HasPrefix(line, []byte("data:")) {
			part := bytes.TrimPrefix(bytes.TrimRight(line[5:], "\r\n"), []byte(" "))
			if len(data)+len(part)+1 > maxRequestBody {
				panic(http.ErrAbortHandler)
			}
			if len(data) > 0 {
				data = append(data, '\n')
			}
			data = append(data, part...)
		} else if bytes.HasPrefix(line, []byte(":")) || strings.HasPrefix(string(line), "event: ping") {
			_, _ = c.Writer.Write([]byte(": ping\n\n"))
			c.Writer.Flush()
		}
		if err == io.EOF {
			if !dispatch() {
				return
			}
			if !meter.complete || meter.failed {
				panic(http.ErrAbortHandler)
			}
			if inbound == "openai-chat" {
				_, _ = c.Writer.Write([]byte("data: [DONE]\n\n"))
				c.Writer.Flush()
			}
			return
		}
	}
}

func readSSELine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		part, err := reader.ReadSlice('\n')
		if len(line)+len(part) > maxRequestBody {
			return nil, routeError("Upstream SSE event exceeds its size limit.")
		}
		line = append(line, part...)
		if err != bufio.ErrBufferFull {
			return line, err
		}
	}
}

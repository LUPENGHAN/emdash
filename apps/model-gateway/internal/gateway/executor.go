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
	u "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

const ResponsesProvider = "emdash-responses"

// Selector reads the authenticated Gin request retained by the SDK execution context.
// The SDK Responses handler does not inherit arbitrary request-context values.
type Selector struct{}

func (Selector) Pick(ctx context.Context, _ string, _ string, opts e.Options, candidates []*a.Auth) (*a.Auth, error) {
	id, _ := opts.Metadata[e.PinnedAuthMetadataKey].(string)
	if c, ok := ctx.Value("gin").(*gin.Context); ok {
		id = c.GetString("emdash.account")
	}
	if id == "" {
		return nil, fmt.Errorf("a session account is required")
	}
	for _, candidate := range candidates {
		if candidate.ID == id && !candidate.Disabled {
			return candidate, nil
		}
	}
	return nil, fmt.Errorf("the session account is unavailable")
}

// ResponsesExecutor preserves compatible Responses payloads. Provider-native OAuth
// accounts use the SDK's own executors instead.
type ResponsesExecutor struct{ Client *http.Client }

func (ResponsesExecutor) Identifier() string { return ResponsesProvider }
func (x ResponsesExecutor) Refresh(_ context.Context, auth *a.Auth) (*a.Auth, error) {
	return auth, nil
}
func (x ResponsesExecutor) HttpRequest(ctx context.Context, auth *a.Auth, req *http.Request) (*http.Response, error) {
	req = req.Clone(ctx)
	var headers map[string]string
	_ = json.Unmarshal([]byte(auth.Attributes["emdash_headers"]), &headers)
	for k, v := range headers {
		if !strings.EqualFold(k, "Host") && !strings.EqualFold(k, "Content-Length") {
			req.Header.Set(k, v)
		}
	}
	key := auth.Attributes["api_key"]
	protocol, _ := req.Context().Value(protocolKey{}).(string)
	var keys map[string]string
	_ = json.Unmarshal([]byte(auth.Attributes["emdash_protocol_keys"]), &keys)
	if keys[protocol] != "" {
		key = keys[protocol]
	}
	if key == "" {
		return nil, statusError{401}
	}
	if strings.Contains(req.URL.Path, "/messages") && auth.Attributes["anthropic_auth"] == "api-key" {
		req.Header.Set("x-api-key", key)
	} else {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	if strings.Contains(req.URL.Path, "/messages") && req.Header.Get("anthropic-version") == "" {
		req.Header.Set("anthropic-version", "2023-06-01")
	}
	return x.Client.Do(req)
}

type protocolKey struct{}

func (x ResponsesExecutor) request(ctx context.Context, auth *a.Auth, req e.Request, alt string) (*http.Response, error) {
	protocol := "openai-responses"
	if alt == "chat/completions" {
		protocol = "openai-chat"
	}
	if strings.HasPrefix(alt, "messages") {
		protocol = "anthropic"
	}
	ctx = context.WithValue(ctx, protocolKey{}, protocol)
	base := strings.TrimRight(auth.Attributes["base_url"], "/")
	var mapping map[string]string
	_ = json.Unmarshal([]byte(auth.Attributes["emdash_models"]), &mapping)
	if model := mapping[req.Model]; model != "" && model != req.Model {
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(req.Payload, &payload); err != nil {
			return nil, err
		}
		payload["model"], _ = json.Marshal(model)
		req.Payload, _ = json.Marshal(payload)
	}
	endpoint := "/responses"
	switch alt {
	case "responses/compact", "chat/completions", "messages", "messages/count_tokens":
		endpoint = "/" + alt
	}
	if strings.HasPrefix(alt, "messages") && auth.Attributes["anthropic_base_url"] != "" {
		base = strings.TrimRight(auth.Attributes["anthropic_base_url"], "/")
	}
	var endpoints map[string]string
	_ = json.Unmarshal([]byte(auth.Attributes["emdash_endpoints"]), &endpoints)
	if len(endpoints) > 0 {
		protocol := "openai-responses"
		if alt == "chat/completions" {
			protocol = "openai-chat"
		}
		if strings.HasPrefix(alt, "messages") {
			protocol = "anthropic"
		}
		if endpoints[protocol] == "" {
			return nil, statusError{400}
		}
		base = strings.TrimRight(endpoints[protocol], "/")
	}
	r, err := http.NewRequestWithContext(ctx, "POST", base+endpoint, bytes.NewReader(req.Payload))
	if err != nil {
		return nil, err
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "text/event-stream")
	if c, ok := ctx.Value("gin").(*gin.Context); ok {
		for _, key := range []string{"anthropic-version", "anthropic-beta"} {
			if value := c.GetHeader(key); value != "" {
				r.Header.Set(key, value)
			}
		}
	}
	return x.HttpRequest(ctx, auth, r)
}

type sessionContextKey struct{}

func snapshotSession(ctx context.Context) context.Context {
	sessionID := ""
	if c, ok := ctx.Value("gin").(*gin.Context); ok && c.Request != nil {
		sessionID = c.GetHeader("session_id")
	}
	return context.WithValue(ctx, sessionContextKey{}, sessionID)
}

type statusError struct{ status int }

func (s statusError) Error() string   { return fmt.Sprintf("upstream returned HTTP %d", s.status) }
func (s statusError) StatusCode() int { return s.status }

func usageRecord(ctx context.Context, auth *a.Auth, req e.Request, started time.Time, payload []byte, failed bool) {
	var event struct {
		Response struct {
			Usage *struct {
				Input  int64 `json:"input_tokens"`
				Output int64 `json:"output_tokens"`
				Total  int64 `json:"total_tokens"`
				Cached struct {
					Tokens int64 `json:"cached_tokens"`
				} `json:"input_tokens_details"`
			} `json:"usage"`
		} `json:"response"`
	}
	_ = json.Unmarshal(payload, &event)
	var root map[string]json.RawMessage
	if json.Unmarshal(payload, &root) == nil && root["response"] == nil {
		wrapped, _ := json.Marshal(map[string]json.RawMessage{"response": payload})
		_ = json.Unmarshal(wrapped, &event)
	}
	v := event.Response.Usage
	source := ""
	detail := u.Detail{}
	if v != nil {
		source = "emdash:usage-known"
		detail = u.Detail{InputTokens: v.Input, OutputTokens: v.Output, TotalTokens: v.Total, CachedTokens: v.Cached.Tokens}
	}
	sessionID, _ := ctx.Value(sessionContextKey{}).(string)
	u.PublishRecord(ctx, u.Record{Provider: ResponsesProvider, Source: source, Model: req.Model, AuthID: auth.ID, SessionID: sessionID,
		RequestedAt: started, Latency: time.Since(started), Failed: failed, Detail: detail})
}

func (x ResponsesExecutor) ExecuteStream(ctx context.Context, auth *a.Auth, req e.Request, opts e.Options) (*e.StreamResult, error) {
	ctx = snapshotSession(ctx)
	started := time.Now()
	res, err := x.request(ctx, auth, req, opts.Alt)
	if err != nil {
		usageRecord(ctx, auth, req, started, nil, true)
		return nil, err
	}
	if res.StatusCode >= 300 {
		res.Body.Close()
		usageRecord(ctx, auth, req, started, nil, true)
		return nil, statusError{res.StatusCode}
	}
	ch := make(chan e.StreamChunk)
	go func() {
		defer close(ch)
		defer res.Body.Close()
		scanner := bufio.NewScanner(res.Body)
		scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
		var data []byte
		meter := streamMeter{}
		defer func() { usageRecord(ctx, auth, req, started, meter.payload(), meter.failed || !meter.complete) }()
		dispatch := func() { meter.observe(data, opts.Alt); data = nil }

		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				dispatch()
			} else if strings.HasPrefix(line, "data:") {
				if len(data) > 0 {
					data = append(data, '\n')
				}
				data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " ")...)
			}
			payload := append([]byte(line), '\n')
			select {
			case ch <- e.StreamChunk{Payload: payload}:
			case <-ctx.Done():
				meter.failed = true
				return
			}
		}
		if len(data) > 0 {
			dispatch()
		}
		if err := scanner.Err(); err != nil && ctx.Err() == nil {
			select {
			case ch <- e.StreamChunk{Err: err}:
			case <-ctx.Done():
			}
		}
	}()
	return &e.StreamResult{Headers: res.Header, Chunks: ch}, nil
}
func (x ResponsesExecutor) Execute(ctx context.Context, auth *a.Auth, req e.Request, opts e.Options) (e.Response, error) {
	ctx = snapshotSession(ctx)
	started := time.Now()
	res, err := x.request(ctx, auth, req, opts.Alt)
	if err != nil {
		usageRecord(ctx, auth, req, started, nil, true)
		return e.Response{}, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		usageRecord(ctx, auth, req, started, nil, true)
		return e.Response{}, statusError{res.StatusCode}
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 32*1024*1024+1))
	if len(b) > 32*1024*1024 {
		err = fmt.Errorf("upstream response is too large")
		b = nil
	}
	if opts.Alt == "chat/completions" || opts.Alt == "messages" {
		meter := streamMeter{}
		meter.observe(b, opts.Alt)
		usageRecord(ctx, auth, req, started, meter.payload(), err != nil)
	} else {
		usageRecord(ctx, auth, req, started, b, err != nil)
	}
	return e.Response{Payload: b, Headers: res.Header}, err
}
func (x ResponsesExecutor) CountTokens(ctx context.Context, auth *a.Auth, req e.Request, _ e.Options) (e.Response, error) {
	res, err := x.request(ctx, auth, req, "messages/count_tokens")
	if err != nil {
		return e.Response{}, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return e.Response{}, statusError{res.StatusCode}
	}
	payload, err := io.ReadAll(io.LimitReader(res.Body, 1024*1024))
	return e.Response{Payload: payload, Headers: res.Header}, err
}

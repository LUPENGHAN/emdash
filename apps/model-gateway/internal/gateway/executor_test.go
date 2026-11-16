package gateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	a "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	e "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestOpenCodeGoRetainsCodingClientAndConversationIdentity(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("User-Agent") != "claude-code/test" || r.Header.Get("x-opencode-session") != "conversation-one" {
			return &http.Response{StatusCode: 400, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session"}}`))}, nil
		}
		if r.Header.Get("Authorization") != "Bearer fake-key" {
			t.Error("upstream did not receive its own credential")
		}
		if r.Header.Get("session_id") != "conversation-one" {
			t.Error("native conversation identity was lost")
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("X-Emdash-Account") != "" {
			t.Error("internal headers leaked upstream")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"usage":{"input_tokens":1,"output_tokens":1}}`))}, nil
	})}
	incoming := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	incoming.Header.Set("User-Agent", "claude-code/test")
	incoming.Header.Set("session_id", "conversation-one")
	incoming.Header.Set("Cookie", "local-cookie")
	incoming.Header.Set("X-Emdash-Account", "local-account")
	c := &gin.Context{Request: incoming}
	ctx := context.WithValue(context.Background(), "gin", c)
	auth := &a.Auth{ID: "account", Attributes: map[string]string{
		"base_url": "https://opencode.ai/inference/go/anthropic/v1",
		"api_key":  "fake-key",
	}}
	_, err := (ResponsesExecutor{Client: client}).Execute(ctx, auth, e.Request{
		Model: "test-model", Payload: []byte(`{"model":"test-model","messages":[]}`),
	}, e.Options{Alt: "messages"})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSelectorRequiresAuthenticatedAccount(t *testing.T) {
	ctx := context.WithValue(context.Background(), "gin", &gin.Context{Keys: map[string]any{"emdash.account": "a"}})
	candidates := []*a.Auth{{ID: "a"}, {ID: "b"}}
	selected, err := (Selector{}).Pick(ctx, "", "", e.Options{Metadata: map[string]any{e.PinnedAuthMetadataKey: "b"}}, candidates)
	if err != nil || selected.ID != "a" {
		t.Fatalf("selected=%v err=%v", selected, err)
	}
	if _, err = (Selector{}).Pick(context.Background(), "", "", e.Options{}, candidates); err == nil {
		t.Fatal("missing session was accepted")
	}
	if _, err = (Selector{}).Pick(ctx, "", "", e.Options{}, candidates[1:]); err == nil {
		t.Fatal("unavailable selected account fell back")
	}
}

func TestResponsesStreamPreservesSplitUTF8AndPayload(t *testing.T) {
	data := ": heartbeat\r\nevent: response.completed\r\ndata: {\"type\":\"response.completed\",\r\n" + "data: \"response\":{\"output\":\"你好\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0,\"total_tokens\":0}}}\r\n\r\n: no final newline"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if json.NewDecoder(r.Body).Decode(&payload) != nil {
			t.Error("invalid upstream JSON")
		}
		if payload["model"] != "upstream" || payload["instructions"] != "preserve" {
			t.Errorf("changed payload: %v", payload)
		}
		if r.Header.Get("Authorization") != "Bearer fake-key" {
			t.Error("incorrect upstream authorization")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, b := range []byte(data) {
			_, _ = w.Write([]byte{b})
			w.(http.Flusher).Flush()
		}
	}))
	defer server.Close()
	x := ResponsesExecutor{Client: server.Client()}
	auth := &a.Auth{ID: "a", Attributes: map[string]string{"base_url": server.URL, "api_key": "fake-key", "emdash_models": `{"public":"upstream"}`}}
	result, err := x.ExecuteStream(context.Background(), auth, e.Request{Model: "public", Payload: []byte(`{"model":"public","instructions":"preserve","stream":true}`)}, e.Options{})
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	for chunk := range result.Chunks {
		if chunk.Err != nil {
			t.Fatal(chunk.Err)
		}
		output.Write(chunk.Payload)
	}
	if output.String() != data {
		t.Fatal("stream framing or UTF-8 was corrupted")
	}
}

func TestCompactUsesCompactEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/responses/compact" {
			t.Errorf("wrong path: %s", r.URL.Path)
		}
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = w.Write([]byte(`{"output":[],"usage":{"input_tokens":1,"output_tokens":1}}`))
	}))
	defer server.Close()
	x := ResponsesExecutor{Client: server.Client()}
	_, err := x.Execute(context.Background(), &a.Auth{Attributes: map[string]string{"api_key": "fake-test-key", "base_url": server.URL}}, e.Request{Model: "m", Payload: []byte(`{"model":"m"}`)}, e.Options{Alt: "responses/compact"})
	if err != nil {
		t.Fatal(err)
	}
}

func TestCancellationStopsUpstreamWithoutReplay(t *testing.T) {
	cancelled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(cancelled)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	result, err := (ResponsesExecutor{Client: server.Client()}).ExecuteStream(ctx, &a.Auth{Attributes: map[string]string{"api_key": "fake-test-key", "base_url": server.URL}}, e.Request{Payload: []byte(`{"model":"test","input":[{"type":"function_call_output","call_id":"tool-1","output":"result"}],"tools":[{"type":"function","name":"test"}]}`)}, e.Options{})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	for range result.Chunks {
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("upstream remained active after cancellation")
	}
}

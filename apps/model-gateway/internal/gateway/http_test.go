package gateway

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	a "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

func proxyTestServer(t *testing.T, upstream http.HandlerFunc, overrides ...map[string]string) (*httptest.Server, *http.Client) {
	t.Helper()
	backend := httptest.NewServer(upstream)
	t.Cleanup(backend.Close)
	client := backend.Client()
	transport := client.Transport.(*http.Transport).Clone()
	transport.DisableCompression = true
	client.Transport = transport
	t.Cleanup(transport.CloseIdleConnections)
	auth := &a.Auth{ID: "account", Attributes: map[string]string{
		"api_key": "upstream-key", "base_url": backend.URL, "emdash_protocol": "all", "emdash_models": `{"m":"m"}`,
	}}
	for _, fields := range overrides {
		for name, value := range fields {
			auth.Attributes[name] = value
		}
	}
	router := gin.New()
	router.Any("/v1/*path", func(c *gin.Context) { (ResponsesExecutor{Client: client}).ServeAPI(c, auth) })
	proxy := httptest.NewServer(router)
	t.Cleanup(proxy.Close)
	return proxy, client
}

func TestAPIPreservesApplicationHeadersQueryBodyStatusAndTrailers(t *testing.T) {
	payload := "{ \"model\": \"m\", \"input\": \"你好\", \"future_field\": {\"x\":1} }\n"
	query := "beta=true&repeat=1&repeat=2&encoded=%2F%2B"
	proxy, client := proxyTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if string(body) != payload || r.URL.RawQuery != query || r.URL.Path != "/responses" {
			t.Errorf("request changed: path=%s query=%s body=%q", r.URL.Path, r.URL.RawQuery, body)
		}
		if !reflect.DeepEqual(r.Header.Values("X-Custom-Feature"), []string{"one", "two"}) || r.Header.Get("OpenAI-Project") != "project" || r.Header.Get("Accept") != "application/json" {
			t.Errorf("application request headers changed: %v", r.Header)
		}
		if r.Header.Get("Authorization") != "Bearer upstream-key" || r.Header.Get("X-Api-Key") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Emdash-Account") != "" || r.Header.Get("X-Hop") != "" {
			t.Errorf("request boundary was bypassed: %v", r.Header)
		}
		if r.Trailer.Get("X-Request-Checksum") != "checksum" {
			t.Errorf("request trailer lost: %v", r.Trailer)
		}
		w.Header().Add("X-Custom-Feature", "one")
		w.Header().Add("X-Custom-Feature", "two")
		w.Header().Set("Retry-After", "12")
		w.Header().Set("X-Ratelimit-Remaining", "3")
		w.Header().Set("Content-Type", "application/vnd.example+json")
		w.Header().Set("Set-Cookie", "provider-login=secret")
		w.Header().Set("Connection", "X-Hop-Response")
		w.Header().Set("X-Hop-Response", "private-hop")
		w.Header().Set("Trailer", "X-Response-Checksum")
		w.WriteHeader(201)
		_, _ = w.Write([]byte("{\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}\n"))
		w.Header().Set("X-Response-Checksum", "response-checksum")
	})
	req, _ := http.NewRequest(http.MethodPost, proxy.URL+"/v1/responses?"+query, strings.NewReader(payload))
	req.ContentLength = -1
	req.Trailer = http.Header{"X-Request-Checksum": {"checksum"}}
	req.Header = http.Header{
		"Content-Type": {"application/json"}, "Accept": {"application/json"},
		"X-Custom-Feature": {"one", "two"}, "Openai-Project": {"project"},
		"Authorization": {"Bearer local-capability"}, "X-Api-Key": {"local-capability"},
		"Cookie": {"local-login=secret"}, "X-Emdash-Account": {"internal"},
		"Connection": {"X-Hop"}, "X-Hop": {"private-hop"},
	}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 201 || string(body) != "{\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}\n" {
		t.Fatalf("response changed: %d %q", res.StatusCode, body)
	}
	if res.Header.Get("Content-Type") != "application/vnd.example+json" || res.Header.Get("Retry-After") != "12" || res.Header.Get("X-Ratelimit-Remaining") != "3" || !reflect.DeepEqual(res.Header.Values("X-Custom-Feature"), []string{"one", "two"}) {
		t.Errorf("response headers changed: %v", res.Header)
	}
	if res.Header.Get("Set-Cookie") != "" || res.Header.Get("X-Hop-Response") != "" || res.Trailer.Get("X-Response-Checksum") != "response-checksum" {
		t.Errorf("response boundary or trailer mismatch: %v %v", res.Header, res.Trailer)
	}
}

func TestAPIForwardsErrorBodiesAndRedirectsWithoutReplay(t *testing.T) {
	for _, status := range []int{400, 429, 307} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			calls := 0
			body := `{"type":"error","error":{"type":"MissingSessionID","message":"send a session header"}}`
			proxy, client := proxyTestServer(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.Header().Set("Content-Type", "application/problem+json")
				w.Header().Set("Retry-After", "15")
				w.Header().Set("Location", "/must-not-replay")
				w.WriteHeader(status)
				_, _ = w.Write([]byte(body))
			})
			client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
			res, err := client.Post(proxy.URL+"/v1/messages", "application/json", strings.NewReader(`{"model":"m","messages":[]}`))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			data, err := io.ReadAll(res.Body)
			if err != nil || res.StatusCode != status || string(data) != body || res.Header.Get("Retry-After") != "15" || res.Header.Get("Location") != "/must-not-replay" || calls != 1 {
				t.Fatalf("error/redirect changed or replayed: status=%d body=%s headers=%v calls=%d err=%v", res.StatusCode, data, res.Header, calls, err)
			}
		})
	}
}

func TestAPIPreservesGzipRequestsAndStreamingBytes(t *testing.T) {
	stream := []byte(": heartbeat\r\nid: 7\r\nretry: 200\r\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}}\r\n\r\n: final without newline")
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, _ = writer.Write(stream)
	_ = writer.Close()
	requestBody, err := encodeRequestPayload([]byte(`{"model":"m","stream":true,"input":"hello"}`), "gzip")
	if err != nil {
		t.Fatal(err)
	}
	proxy, client := proxyTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if !bytes.Equal(body, requestBody) || r.Header.Get("Content-Encoding") != "gzip" || r.Header.Get("Accept-Encoding") != "gzip" {
			t.Error("compressed request changed")
		}
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Content-Encoding", "gzip")
		for _, part := range compressed.Bytes() {
			_, _ = w.Write([]byte{part})
			w.(http.Flusher).Flush()
		}
	})
	req, _ := http.NewRequest(http.MethodPost, proxy.URL+"/v1/responses", bytes.NewReader(requestBody))
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Accept-Encoding", "gzip")
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil || !bytes.Equal(body, compressed.Bytes()) || res.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("compressed streaming response changed: err=%v", err)
	}
}

func TestUsageObservationCannotTruncateLargeSSEEvents(t *testing.T) {
	payload := []byte("data: " + strings.Repeat("x", 17*1024*1024) + "\r\n\r\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":7}}}\r\n\r\n")
	var recorded []byte
	body := observeBody(io.NopCloser(bytes.NewReader(payload)), http.Header{}, nil, true, "", func(data []byte, failed bool) {
		recorded = data
		if failed {
			t.Error("an oversized observer event marked a complete response as failed")
		}
	})
	actual, err := io.ReadAll(body)
	_ = body.Close()
	if err != nil || !bytes.Equal(actual, payload) || !bytes.Contains(recorded, []byte(`"input_tokens":7`)) {
		t.Fatalf("observer changed bytes or lost final usage: err=%v usage=%s", err, recorded)
	}
}

func TestAPIFlushesBeforeCompletionAndCancelsWithoutReplay(t *testing.T) {
	cancelled := make(chan struct{})
	proxy, client := proxyTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(": heartbeat\r\n\r\n"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(cancelled)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, proxy.URL+"/v1/responses", strings.NewReader(`{"model":"m","stream":true}`))
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	first := make([]byte, len(": heartbeat\r\n\r\n"))
	_, err = io.ReadFull(res.Body, first)
	_ = res.Body.Close()
	if err != nil || string(first) != ": heartbeat\r\n\r\n" {
		t.Fatalf("stream was buffered or rewritten: %q err=%v", first, err)
	}
	select {
	case <-cancelled:
	case <-ctx.Done():
		t.Fatal("client cancellation did not stop the upstream request")
	}
}

func TestAPIPreservesPartialOutputButAbortsOnUpstreamDisconnect(t *testing.T) {
	first := ": heartbeat\r\n\r\n"
	proxy, client := proxyTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(first))
		w.(http.Flusher).Flush()
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		conn.Close()
	})
	res, err := client.Post(proxy.URL+"/v1/responses", "application/json", strings.NewReader(`{"model":"m","stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err == nil || string(body) != first {
		t.Fatalf("truncation was hidden or partial output changed: body=%q err=%v", body, err)
	}
}

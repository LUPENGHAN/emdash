package gateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func routeAttributes(protocols ...string) map[string]string {
	mapping := map[string]string{}
	for _, protocol := range protocols {
		mapping[protocol] = "physical-model"
	}
	raw, _ := json.Marshal(ModelRoute{ProviderID: "provider", Revision: 3, ProtocolModels: map[string]map[string]string{"m": mapping}, Policy: RoutePolicy{Mode: "auto"}})
	return map[string]string{"emdash_route": string(raw)}
}

func conversionInput(protocol string, stream, result bool) string {
	body := map[string]any{"model": "m", "stream": stream}
	var raw string
	switch protocol {
	case "anthropic":
		body["max_tokens"] = 128
		raw = `{"tools":[{"name":"echo","input_schema":{"type":"object","properties":{"text":{"type":"string"}}}}],"messages":[{"role":"user","content":"hello"}]}`
		if result {
			raw = `{"messages":[{"role":"user","content":"hello"},{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"echo","input":{"text":"hi"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"hi"}]}]}`
		}
	case "openai-chat":
		raw = `{"tools":[{"type":"function","function":{"name":"echo","parameters":{"type":"object","properties":{"text":{"type":"string"}}}}}],"messages":[{"role":"user","content":"hello"}]}`
		if result {
			raw = `{"messages":[{"role":"user","content":"hello"},{"role":"assistant","tool_calls":[{"id":"call_1","type":"function","function":{"name":"echo","arguments":"{\"text\":\"hi\"}"}}]},{"role":"tool","tool_call_id":"call_1","content":"hi"}]}`
		}
	default:
		body["store"] = false
		raw = `{"tools":[{"type":"function","name":"echo","parameters":{"type":"object","properties":{"text":{"type":"string"}}}}],"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]}`
		if result {
			raw = `{"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]},{"type":"function_call","call_id":"call_1","name":"echo","arguments":"{\"text\":\"hi\"}"},{"type":"function_call_output","call_id":"call_1","output":"hi"}]}`
		}
	}
	var fields map[string]any
	_ = json.Unmarshal([]byte(raw), &fields)
	for k, v := range fields {
		body[k] = v
	}
	out, _ := json.Marshal(body)
	return string(out)
}

func toolResponse(protocol string) string {
	switch protocol {
	case "anthropic":
		return `{"id":"msg_1","type":"message","role":"assistant","model":"physical-model","content":[{"type":"tool_use","id":"call_1","name":"echo","input":{"text":"hi"}}],"stop_reason":"tool_use","usage":{"input_tokens":4,"output_tokens":3}}`
	case "openai-chat":
		return `{"id":"chat_1","object":"chat.completion","created":1,"model":"physical-model","choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"echo","arguments":"{\"text\":\"hi\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}`
	default:
		return `{"id":"resp_1","object":"response","status":"completed","model":"physical-model","output":[{"type":"function_call","id":"fc_1","call_id":"call_1","name":"echo","arguments":"{\"text\":\"hi\"}","status":"completed"}],"usage":{"input_tokens":4,"output_tokens":3,"total_tokens":7}}`
	}
}

func toolStream(protocol string) string {
	if protocol == "openai-chat" {
		return "data: " + `{"id":"chat_1","object":"chat.completion.chunk","created":1,"model":"physical-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"echo","arguments":"{\"text\":\"hi\"}"}}]},"finish_reason":null}]}` + "\n\ndata: " + `{"id":"chat_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}` + "\n\ndata: [DONE]\n\n"
	}
	events := []string{
		`{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"physical-model","content":[],"usage":{"input_tokens":4,"output_tokens":0}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"echo","input":{}}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"text\":\"hi\"}"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}`,
		`{"type":"message_stop"}`,
	}
	var result strings.Builder
	for _, event := range events {
		result.WriteString("data: " + event + "\n\n")
	}
	return result.String()
}

func TestCatalogPrefersNativeProtocol(t *testing.T) {
	for _, inbound := range []string{"anthropic", "openai-responses", "openai-chat"} {
		t.Run(inbound, func(t *testing.T) {
			proxy, client := proxyTestServer(t, func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				if r.URL.Path != "/"+protocolPath(inbound) || !strings.Contains(string(body), `"model":"physical-model"`) {
					t.Errorf("wrong native route %s %s", r.URL, body)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, toolResponse(inbound))
			}, routeAttributes("anthropic", "openai-chat", "openai-responses"))
			res, err := client.Post(proxy.URL+"/v1/"+protocolPath(inbound), "application/json", strings.NewReader(conversionInput(inbound, false, false)))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			out, _ := io.ReadAll(res.Body)
			if res.StatusCode != 200 || string(out) != toolResponse(inbound) {
				t.Fatalf("native response changed: %d %s", res.StatusCode, out)
			}
		})
	}
}

func TestSDKConversionToolLoop(t *testing.T) {
	pairs := [][2]string{{"anthropic", "openai-chat"}, {"openai-responses", "anthropic"}, {"openai-responses", "openai-chat"}, {"openai-chat", "anthropic"}}
	for _, pair := range pairs {
		for _, stream := range []bool{false, true} {
			name := pair[0] + "-to-" + pair[1]
			if stream {
				name += "-stream"
			}
			t.Run(name, func(t *testing.T) {
				calls := 0
				proxy, client := proxyTestServer(t, func(w http.ResponseWriter, r *http.Request) {
					body, _ := io.ReadAll(r.Body)
					calls++
					if r.URL.Path != "/"+protocolPath(pair[1]) || !strings.Contains(string(body), `"model":"physical-model"`) {
						t.Errorf("wrong converted route %s %s", r.URL, body)
					}
					if !strings.Contains(string(body), "echo") || (calls == 2 && !strings.Contains(string(body), "call_1")) {
						t.Errorf("tool information lost: %s", body)
					}
					if stream {
						w.Header().Set("Content-Type", "text/event-stream")
						_, _ = io.WriteString(w, toolStream(pair[1]))
					} else {
						w.Header().Set("Content-Type", "application/json")
						_, _ = io.WriteString(w, toolResponse(pair[1]))
					}
				}, routeAttributes(pair[1]))
				for _, result := range []bool{false, true} {
					res, err := client.Post(proxy.URL+"/v1/"+protocolPath(pair[0]), "application/json", strings.NewReader(conversionInput(pair[0], stream, result)))
					if err != nil {
						t.Fatal(err)
					}
					out, err := io.ReadAll(res.Body)
					res.Body.Close()
					if err != nil || res.StatusCode != 200 || !strings.Contains(string(out), "echo") || !strings.Contains(string(out), "call_1") {
						t.Fatalf("tool conversion failed: %d err=%v %s", res.StatusCode, err, out)
					}
					if !stream && !json.Valid(out) {
						t.Errorf("invalid JSON: %s", out)
					}
					if stream {
						marker := map[string]string{"anthropic": "message_stop", "openai-chat": "[DONE]", "openai-responses": "response.completed"}[pair[0]]
						if !strings.Contains(string(out), marker) {
							t.Errorf("missing terminal event %s: %s", marker, out)
						}
					}
					for _, line := range strings.Split(string(out), "\n") {
						if strings.HasPrefix(line, "data:") {
							data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
							if data != "[DONE]" && !json.Valid([]byte(data)) {
								t.Errorf("invalid SSE framing: %q", line)
							}
						}
					}
				}
				if calls != 2 {
					t.Fatalf("unexpected replay count: %d", calls)
				}
			})
		}
	}
}

func TestConvertedErrorsArePreservedWithoutReplay(t *testing.T) {
	calls := 0
	body := `{"error":{"type":"MissingSessionID","message":"send session header"}}`
	proxy, client := proxyTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/problem+json")
		w.Header().Set("Retry-After", "15")
		w.WriteHeader(400)
		_, _ = io.WriteString(w, body)
	}, routeAttributes("openai-chat"))
	res, err := client.Post(proxy.URL+"/v1/messages", "application/json", strings.NewReader(conversionInput("anthropic", false, false)))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	if res.StatusCode != 400 || string(out) != body || res.Header.Get("Retry-After") != "15" || calls != 1 {
		t.Fatalf("upstream error changed: %d %s calls=%d", res.StatusCode, out, calls)
	}
}

func TestConvertedStreamCancellationAndTruncation(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		t.Run(map[bool]string{true: "cancel", false: "truncated"}[cancel], func(t *testing.T) {
			stopped := make(chan struct{})
			proxy, client := proxyTestServer(t, func(w http.ResponseWriter, r *http.Request) {
				defer close(stopped)
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, "data: "+`{"id":"c","object":"chat.completion.chunk","model":"physical-model","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}`+"\n\n")
				w.(http.Flusher).Flush()
				if cancel {
					<-r.Context().Done()
				}
			}, routeAttributes("openai-chat"))
			ctx, stop := context.WithCancel(context.Background())
			defer stop()
			req, _ := http.NewRequestWithContext(ctx, "POST", proxy.URL+"/v1/messages", strings.NewReader(conversionInput("anthropic", true, false)))
			req.Header.Set("Content-Type", "application/json")
			res, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			if cancel {
				stop()
			}
			out, readErr := io.ReadAll(res.Body)
			res.Body.Close()
			if readErr == nil || strings.Contains(string(out), "message_stop") {
				t.Fatalf("unfinished response reported success: err=%v %s", readErr, out)
			}
			select {
			case <-stopped:
			case <-time.After(3 * time.Second):
				t.Fatal("upstream was not cancelled")
			}
		})
	}
}

func TestConversionRejectsUnsupportedFeaturesBeforeSending(t *testing.T) {
	for _, field := range []string{`"unknown_extension":true`, `"context_management":{}`, `"previous_response_id":"upstream-id"`, `"response_format":{}`} {
		t.Run(field, func(t *testing.T) {
			calls := 0
			proxy, client := proxyTestServer(t, func(http.ResponseWriter, *http.Request) { calls++ }, routeAttributes("openai-chat"))
			res, err := client.Post(proxy.URL+"/v1/messages", "application/json", strings.NewReader(`{"model":"m","max_tokens":32,"messages":[],`+field+`}`))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			_, _ = io.Copy(io.Discard, res.Body)
			if res.StatusCode != 400 || calls != 0 {
				t.Fatalf("unsupported request sent: %d calls=%d", res.StatusCode, calls)
			}
		})
	}
}

func TestMissingConversionDoesNotPassRawPayload(t *testing.T) {
	calls := 0
	proxy, client := proxyTestServer(t, func(http.ResponseWriter, *http.Request) { calls++ }, routeAttributes("openai-responses"))
	res, err := client.Post(proxy.URL+"/v1/messages", "application/json", strings.NewReader(conversionInput("anthropic", false, false)))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	if res.StatusCode != 400 || calls != 0 || !strings.Contains(string(out), "conversion") {
		t.Fatalf("missing converter bypassed: %d %s calls=%d", res.StatusCode, out, calls)
	}
}

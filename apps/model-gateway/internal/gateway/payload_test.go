package gateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	a "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	e "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

func TestAliasRejectsCallerIntegrityWithoutSendingUpstream(t *testing.T) {
	for _, field := range []string{"Content-MD5", "Digest", "Content-Digest", "Repr-Digest", "Signature", "Signature-Input"} {
		for _, location := range []string{"header", "trailer", "provider"} {
			t.Run(field+"/"+location, func(t *testing.T) {
				metadata := map[string]string{"emdash_models": `{"m":"upstream-model"}`}
				if location == "provider" {
					encoded, _ := json.Marshal(map[string]string{field: "caller-integrity"})
					metadata["emdash_headers"] = string(encoded)
				}
				proxy, client := proxyTestServer(t, func(w http.ResponseWriter, r *http.Request) {
					t.Error("integrity-protected body was rewritten and sent upstream")
				}, metadata)
				req, _ := http.NewRequest(http.MethodPost, proxy.URL+"/v1/responses", strings.NewReader(`{"model":"m","input":"hello"}`))
				if location == "header" {
					req.Header.Set(field, "caller-integrity")
				} else if location == "trailer" {
					req.ContentLength = -1
					req.Trailer = http.Header{field: {"caller-integrity"}}
				}
				res, err := client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer res.Body.Close()
				body, _ := io.ReadAll(res.Body)
				if res.StatusCode != 400 || !bytes.Contains(body, []byte("Model aliases cannot rewrite")) {
					t.Fatalf("expected actionable rejection, got %d %s", res.StatusCode, body)
				}
			})
		}
	}
}

func TestConfiguredRequestModelAndOptionsAreNotOverridden(t *testing.T) {
	payload := []byte(`{ "model":"alternate", "input":"hello", "temperature":0.2, "max_output_tokens":64, "tools":[{"type":"function","name":"read","parameters":{"type":"object"}}], "future_option":{"large":9007199254740993} }`)
	sum := sha256.Sum256(payload)
	digest := "sha-256=:" + base64.StdEncoding.EncodeToString(sum[:]) + ":"
	proxy, client := proxyTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if !bytes.Equal(body, payload) || r.Header.Get("Content-Digest") != digest {
			t.Error("requested model, options, or intact body digest changed")
		}
		w.WriteHeader(204)
	}, map[string]string{"emdash_models": `{"m":"m","alternate":"alternate"}`})
	req, _ := http.NewRequest(http.MethodPost, proxy.URL+"/v1/responses", bytes.NewReader(payload))
	req.Header.Set("Content-Digest", digest)
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 204 {
		t.Fatalf("configured alternate model rejected: %d", res.StatusCode)
	}
}

func TestCompressedAliasesRetainOtherRequestFields(t *testing.T) {
	for _, encoding := range []string{"gzip", "deflate"} {
		t.Run(encoding, func(t *testing.T) {
			payload, err := encodeRequestPayload([]byte(`{"model":"public","temperature":0.2,"tools":[{"name":"read"}],"future":9007199254740993}`), encoding)
			if err != nil {
				t.Fatal(err)
			}
			incoming := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
			incoming.Header.Set("Content-Encoding", encoding)
			ctx := context.WithValue(context.Background(), "gin", &gin.Context{Request: incoming})
			auth := &a.Auth{Attributes: map[string]string{"base_url": "https://example.test/v1", "emdash_models": `{"public":"upstream"}`}}
			prepared, err := upstreamRequest(ctx, auth, e.Request{Model: "public", Payload: payload}, "")
			if err != nil {
				t.Fatal(err)
			}
			encoded, _ := io.ReadAll(prepared.Body)
			prepared.Body.Close()
			decoded, err := decodeRequestPayload(encoded, prepared.Header.Get("Content-Encoding"))
			var body map[string]json.RawMessage
			if err != nil || json.Unmarshal(decoded, &body) != nil || string(body["model"]) != `"upstream"` || string(body["temperature"]) != "0.2" || string(body["tools"]) != `[{"name":"read"}]` || string(body["future"]) != "9007199254740993" {
				t.Fatalf("alias corrupted compressed body fields: %s err=%v", decoded, err)
			}
		})
	}
}

func TestEncodedRequestFailuresDoNotReachUpstream(t *testing.T) {
	oversized, err := encodeRequestPayload([]byte(`{"model":"m","input":"`+strings.Repeat("x", maxRequestBody)+`"}`), "gzip")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, encoding string
		body           []byte
		status         int
	}{
		{"invalid gzip", "gzip", []byte("not-gzip"), 400},
		{"invalid deflate", "deflate", []byte("not-deflate"), 400},
		{"unsupported", "br", []byte("unknown"), 415},
		{"decompressed limit", "gzip", oversized, 413},
	} {
		t.Run(test.name, func(t *testing.T) {
			proxy, client := proxyTestServer(t, func(w http.ResponseWriter, r *http.Request) { t.Error("invalid body reached upstream") })
			req, _ := http.NewRequest(http.MethodPost, proxy.URL+"/v1/responses", bytes.NewReader(test.body))
			req.Header.Set("Content-Encoding", test.encoding)
			res, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			if res.StatusCode != test.status {
				t.Fatalf("status=%d want=%d", res.StatusCode, test.status)
			}
		})
	}
}

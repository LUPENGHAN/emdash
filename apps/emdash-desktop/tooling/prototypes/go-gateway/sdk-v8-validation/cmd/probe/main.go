package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	a "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	u "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

type recorder struct {
	mu   sync.Mutex
	path string
}

func (r *recorder) write(v any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, err := os.OpenFile(r.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		panic(err)
	}
	defer f.Close()
	if err = json.NewEncoder(f).Encode(v); err != nil {
		panic(err)
	}
}

type sink struct{ r *recorder }

func (s sink) HandleUsage(_ context.Context, v u.Record) {
	s.r.write(map[string]any{"kind": "usage", "request": v.RequestID, "session": v.SessionID, "auth": v.AuthID, "input": v.Detail.InputTokens, "output": v.Detail.OutputTokens, "failed": v.Failed})
}
func main() {
	dir, err := os.MkdirTemp("", "emdash-v8-runtime-")
	if err != nil {
		panic(err)
	}
	r := &recorder{path: filepath.Join(dir, "events.jsonl")}
	backend := func(id string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
			raw, _ := io.ReadAll(q.Body)
			var payload map[string]any
			_ = json.Unmarshal(raw, &payload)
			r.write(map[string]any{"kind": "upstream", "provider": id, "payload": payload, "path": q.URL.Path, "authOK": q.Header.Get("Authorization") == "Bearer mock-"+id})
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(200)
			fmt.Fprint(w, "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_mock\",\"object\":\"response\",\"status\":\"in_progress\",\"output\":[]}}\n\n")
			w.(http.Flusher).Flush()
			if strings.Contains(string(raw), "WAIT_FOR_CANCEL") {
				<-q.Context().Done()
				r.write(map[string]any{"kind": "cancelled", "provider": id})
				return
			}
			msg := map[string]any{"id": "msg_mock", "type": "message", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": "hello " + id, "annotations": []any{}}}}
			response := map[string]any{"id": "resp_mock", "object": "response", "status": "completed", "model": "test", "output": []any{msg}, "usage": map[string]any{"input_tokens": 7, "output_tokens": 3, "total_tokens": 10, "input_tokens_details": map[string]any{"cached_tokens": 0}}}
			for _, event := range []map[string]any{{"type": "response.output_item.done", "output_index": 0, "item": msg}, {"type": "response.completed", "response": response}} {
				b, _ := json.Marshal(event)
				fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event["type"], b)
			}
			w.(http.Flusher).Flush()
		}))
	}
	one, two := backend("a"), backend("b")
	defer one.Close()
	defer two.Close()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	cfgPath := filepath.Join(dir, "config.yaml")
	yaml := fmt.Sprintf(`host: 127.0.0.1
port: %d
auth-dir: %s
api-keys: [probe-client]
remote-management:
  secret-key: probe-management
  disable-control-panel: true
  disable-auto-update-panel: true
usage-statistics-enabled: true
request-retry: 0
models:
  catalog: %s
  codex-catalog: %s
  devin-catalog: %s
codex-api-key:
  - api-key: mock-a
    base-url: %s
    headers: {X-Probe-Wait: "false"}
    disable-codex-cloaking: true
    models: [{name: test, alias: test}]
  - api-key: mock-b
    base-url: %s
    disable-codex-cloaking: true
    models: [{name: test, alias: test}]
`, port, filepath.Join(dir, "auth"), filepath.Join(dir, "missing.json"), filepath.Join(dir, "missing.json"), filepath.Join(dir, "missing.json"), one.URL, two.URL)
	if err = os.WriteFile(cfgPath, []byte(yaml), 0600); err != nil {
		panic(err)
	}
	cfg, err := config.LoadConfig(cfgPath)
	if err != nil {
		panic(err)
	}
	m := a.NewManager(nil, nil, nil)
	var mu sync.RWMutex
	routes := map[string]string{"one": one.URL, "two": one.URL}
	middleware := func(c *gin.Context) {
		if c.Request.URL.Path != "/v1/responses" {
			c.Next()
			return
		}
		mu.RLock()
		target := routes[c.GetHeader("X-Probe-Session")]
		mu.RUnlock()
		if target == "" {
			c.AbortWithStatusJSON(400, gin.H{"error": "unknown session"})
			return
		}
		id := ""
		for _, v := range m.List() {
			if v.Attributes["base_url"] == target {
				id = v.ID
				break
			}
		}
		if id == "" {
			c.AbortWithStatusJSON(503, gin.H{"error": "route unavailable"})
			return
		}
		ctx := handlers.WithPinnedAuthID(c.Request.Context(), id)
		ctx = handlers.WithExecutionSessionID(ctx, c.GetHeader("X-Probe-Session"))
		c.Request = c.Request.WithContext(ctx)
		if c.GetHeader("X-Probe-Default") == "true" {
			c.Next()
			return
		}
		c.Abort()
		if c.GetHeader("Authorization") != "Bearer probe-client" {
			c.Status(401)
			return
		}
		raw, err := io.ReadAll(c.Request.Body)
		if err != nil {
			c.Status(400)
			return
		}
		var payload struct {
			Model string `json:"model"`
		}
		if json.Unmarshal(raw, &payload) != nil {
			c.Status(400)
			return
		}
		ctx = context.WithValue(ctx, "gin", c)
		base := handlers.NewBaseAPIHandlers(&cfg.SDKConfig, m)
		stream, _, failures := base.ExecuteStreamWithAuthManager(ctx, "openai-response", payload.Model, raw, "")
		committed := false
		for stream != nil || failures != nil {
			select {
			case <-ctx.Done():
				return
			case part, ok := <-stream:
				if !ok {
					stream = nil
					continue
				}
				if !committed {
					c.Header("Content-Type", "text/event-stream")
					c.Status(200)
					committed = true
				}
				if _, err = c.Writer.Write(append(part, func() []byte {
					if strings.HasPrefix(string(part), "data:") {
						return []byte("\n\n")
					}
					return []byte("\n")
				}()...)); err != nil {
					return
				}
				c.Writer.Flush()
			case failure, ok := <-failures:
				if !ok {
					failures = nil
					continue
				}
				if failure != nil {
					if !committed {
						c.JSON(failure.StatusCode, gin.H{"error": failure.Error.Error()})
					}
					return
				}
			}
		}
	}
	svc, err := cliproxy.NewBuilder().WithConfig(cfg).WithConfigPath(cfgPath).WithCoreAuthManager(m).WithLocalManagementPassword("probe-management").WithServerOptions(api.WithMiddleware(middleware), api.WithRouterConfigurator(func(e *gin.Engine, _ *handlers.BaseAPIHandler, _ *config.Config) {
		e.GET("/probe/ui", func(c *gin.Context) { c.File(os.Getenv("PROBE_UI_HTML")) })
		e.PUT("/probe/routes/:session/:provider", func(c *gin.Context) {
			if c.GetHeader("Authorization") != "Bearer probe-management" {
				c.AbortWithStatus(401)
				return
			}
			target := map[string]string{"a": one.URL, "b": two.URL}[c.Param("provider")]
			if target == "" {
				c.AbortWithStatus(400)
				return
			}
			mu.Lock()
			routes[c.Param("session")] = target
			mu.Unlock()
			c.Status(204)
		})
	})).WithHooks(cliproxy.Hooks{OnAfterStart: func(_ *cliproxy.Service) {
		b, _ := json.Marshal(map[string]any{"url": fmt.Sprintf("http://127.0.0.1:%d", port), "dir": dir, "config": cfgPath, "events": r.path})
		if err := os.WriteFile(os.Getenv("PROBE_BOOT_FILE"), b, 0600); err != nil {
			panic(err)
		}
	}}).Build()
	if err != nil {
		panic(err)
	}
	u.RegisterPlugin(sink{r})
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err = svc.Run(ctx); err != nil && ctx.Err() == nil {
		panic(err)
	}
	time.Sleep(100 * time.Millisecond)
}

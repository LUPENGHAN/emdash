package main

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"emdash.local/model-gateway/internal/gateway"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
	sdkauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	a "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	u "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	bolt "go.etcd.io/bbolt"
)

const protocol = 1

type boot struct {
	Token    string    `json:"token"`
	DataDir  string    `json:"dataDir"`
	Accounts []*a.Auth `json:"accounts"`
}
type message struct {
	ID    string          `json:"id,omitempty"`
	Type  string          `json:"type,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error string          `json:"error,omitempty"`
}
type bridge struct {
	mu    sync.Mutex
	enc   *json.Encoder
	waits map[string]chan message
	seq   atomic.Uint64
}

func (b *bridge) emit(kind string, data any) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.enc.Encode(message{Type: kind, Data: raw})
}
func (b *bridge) call(ctx context.Context, kind string, data any) error {
	id := fmt.Sprint(b.seq.Add(1))
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	ch := make(chan message, 1)
	b.mu.Lock()
	b.waits[id] = ch
	err = b.enc.Encode(message{ID: id, Type: kind, Data: raw})
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.waits, id); b.mu.Unlock() }()
	if err != nil {
		return err
	}
	select {
	case r := <-ch:
		if r.Error != "" {
			return errors.New("host credential persistence failed")
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(20 * time.Second):
		return errors.New("host persistence timed out")
	}
}

type tokenStore struct {
	initial []*a.Auth
	bridge  *bridge
}

func (s *tokenStore) List(context.Context) ([]*a.Auth, error) { return s.initial, nil }
func (s *tokenStore) Save(ctx context.Context, v *a.Auth) (string, error) {
	if v.Provider == gateway.ResponsesProvider {
		return "", nil
	}
	// OAuth token storage implementations carry the initial credentials before the
	// runtime has projected them into Metadata. Persist those through the host too.
	if v.Storage != nil {
		v.Metadata = maps.Clone(v.Metadata)
		raw, err := json.Marshal(v.Storage)
		if err != nil {
			return "", err
		}
		var m map[string]any
		if json.Unmarshal(raw, &m) == nil {
			if v.Metadata == nil {
				v.Metadata = map[string]any{}
			}
			for k, x := range m {
				if _, exists := v.Metadata[k]; !exists {
					v.Metadata[k] = x
				}
			}
		}
	}
	return v.ID, s.bridge.call(ctx, "auth.save", v)
}
func (s *tokenStore) Delete(ctx context.Context, id string) error {
	return s.bridge.call(ctx, "auth.delete", map[string]string{"id": id})
}

type usageSink struct {
	db     *bolt.DB
	bridge *bridge
}

func (s *usageSink) HandleUsage(ctx context.Context, v u.Record) {
	if v.Source == "emdash-drain" {
		_ = s.bridge.emit("drained", nil)
		return
	}
	id := v.RequestID
	if id == "" {
		id = uuid.NewString()
	}
	status := "complete"
	if v.Source != "emdash:usage-known" && v.Detail.TotalTokens == 0 && v.Detail.InputTokens == 0 &&
		v.Detail.OutputTokens == 0 && v.Detail.CacheReadTokens == 0 && v.Detail.CacheCreationTokens == 0 {
		status = "missing"
	}
	entry := map[string]any{"id": id, "accountId": v.AuthID, "model": v.Model, "sessionId": v.SessionID, "at": v.RequestedAt.UnixMilli(), "inputTokens": v.Detail.InputTokens, "outputTokens": v.Detail.OutputTokens, "cachedTokens": v.Detail.CachedTokens, "failed": v.Failed, "status": status}
	entry["cacheReadTokens"] = nil
	entry["cacheWriteTokens"] = nil
	// SDK executors expose counts as integers without field presence.
	if v.Detail.CacheReadTokens > 0 {
		entry["cacheReadTokens"] = v.Detail.CacheReadTokens
	}
	if v.Detail.CacheCreationTokens > 0 {
		entry["cacheWriteTokens"] = v.Detail.CacheCreationTokens
	}
	for key, value := range gateway.UsageAttribution(ctx) {
		entry[key] = value
	}
	raw, err := json.Marshal(entry)
	if err == nil {
		err = s.db.Update(func(tx *bolt.Tx) error {
			b, e := tx.CreateBucketIfNotExists([]byte("usage"))
			if e != nil {
				return e
			}
			return b.Put([]byte(id), raw)
		})
	}
	if err != nil {
		_ = s.bridge.emit("usage.error", map[string]string{"message": "Could not persist model usage"})
		return
	}
	_ = s.bridge.emit("usage", json.RawMessage(raw))
}

type provider struct {
	Route            *gateway.ModelRoute `json:"route,omitempty"`
	ProtocolKeys     map[string]string   `json:"protocolKeys"`
	Endpoints        map[string]string   `json:"endpoints"`
	Protocol         string              `json:"protocol"`
	AnthropicBaseURL string              `json:"anthropicBaseUrl"`
	AnthropicAuth    string              `json:"anthropicAuth"`
	ContextWindows   map[string]int      `json:"contextWindows"`
	ID               string              `json:"id"`
	Name             string              `json:"name"`
	BaseURL          string              `json:"baseUrl"`
	APIKey           string              `json:"apiKey"`
	Models           []string            `json:"models"`
	ModelMap         map[string]string   `json:"modelMap"`
	Headers          map[string]string   `json:"headers"`
}

func run() error {
	dec := json.NewDecoder(bufio.NewReaderSize(os.Stdin, 64*1024))
	var input boot
	if err := dec.Decode(&input); err != nil {
		return err
	}
	if len(input.Token) < 32 || !filepath.IsAbs(input.DataDir) {
		return errors.New("invalid gateway bootstrap")
	}
	if err := os.MkdirAll(input.DataDir, 0700); err != nil {
		return err
	}
	control := os.Stdout
	// Keep a dedicated protocol writer while redirecting SDK and Gin diagnostics.
	// Standard stdin/stdout pipes also work on Windows without inherited Unix FDs.
	os.Stdout = os.Stderr
	gin.DefaultWriter = os.Stderr
	gin.DefaultErrorWriter = os.Stderr
	b := &bridge{enc: json.NewEncoder(control), waits: map[string]chan message{}}
	db, err := bolt.Open(filepath.Join(input.DataDir, "usage-outbox.db"), 0600, &bolt.Options{Timeout: time.Second})
	if err != nil {
		return err
	}
	defer db.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		for {
			var m message
			if dec.Decode(&m) != nil {
				cancel()
				return
			}
			if m.Type == "usage.drain" {
				u.PublishRecord(context.Background(), u.Record{Source: "emdash-drain"})
				continue
			}
			if m.Type == "usage.ack" {
				var id string
				_ = json.Unmarshal(m.Data, &id)
				_ = db.Update(func(tx *bolt.Tx) error {
					if bucket := tx.Bucket([]byte("usage")); bucket != nil {
						return bucket.Delete([]byte(id))
					}
					return nil
				})
				continue
			}
			b.mu.Lock()
			ch := b.waits[m.ID]
			b.mu.Unlock()
			if ch != nil {
				ch <- m
			}
		}
	}()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	temp, err := os.MkdirTemp("", "emdash-gateway-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temp)
	configPath := filepath.Join(temp, "config.yaml")
	if err = os.WriteFile(configPath, []byte("{}\n"), 0600); err != nil {
		return err
	}
	cfg := &config.Config{Host: "127.0.0.1", Port: port, AuthDir: filepath.Join(temp, "oauth")}
	cfg.APIKeys = []string{input.Token}
	cfg.RemoteManagement.SecretKey = input.Token
	cfg.RemoteManagement.DisableControlPanel = true
	cfg.RemoteManagement.DisableAutoUpdatePanel = true
	cfg.Models.Catalog = filepath.Join(temp, "catalog.json")
	cfg.Models.CodexCatalog = filepath.Join(temp, "codex.json")
	cfg.Models.DevinCatalog = filepath.Join(temp, "devin.json")
	store := &tokenStore{initial: input.Accounts, bridge: b}
	sdkauth.RegisterTokenStore(store)
	manager := a.NewManager(store, gateway.Selector{}, nil)
	apiExecutor := gateway.ResponsesExecutor{Client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 60 * time.Second, DisableCompression: true}}}
	var providersMu sync.Mutex
	modelRoutes := &gateway.ModelRoutes{}
	var managed []string
	middleware := func(c *gin.Context) {
		path := c.Request.URL.Path
		if strings.HasPrefix(path, "/v1/") {
			if subtle.ConstantTimeCompare([]byte(c.GetHeader("Authorization")), []byte("Bearer "+input.Token)) != 1 {
				c.AbortWithStatus(401)
				return
			}
			id := c.GetHeader("X-Emdash-Account")
			if strings.HasPrefix(id, "catalog:") {
				var handled bool
				id, handled = modelRoutes.Resolve(c, strings.TrimPrefix(id, "catalog:"))
				if handled {
					return
				}
			}
			if id == "" {
				c.AbortWithStatusJSON(400, gin.H{"error": "session account required"})
				return
			}
			c.Set("emdash.account", id)
			if _, ok := manager.GetByID(id); !ok {
				c.AbortWithStatusJSON(409, gin.H{"error": "The saved provider binding is unavailable. Restore its configuration or restart the agent."})
				return
			}
			if auth, ok := manager.GetByID(id); ok && auth.Provider == gateway.ResponsesProvider {
				if auth.Disabled {
					c.AbortWithStatus(403)
					return
				}
				c.Abort()
				apiExecutor.ServeAPI(c, auth)
				return
			}
			c.Next()
			return
		}
		if subtle.ConstantTimeCompare([]byte(c.GetHeader("Authorization")), []byte("Bearer "+input.Token)) != 1 && !strings.HasSuffix(path, "/oauth/callback") {
			c.AbortWithStatus(401)
			return
		}
		if strings.HasPrefix(path, "/emdash/") || strings.HasPrefix(path, "/v8/management/oauth/") || path == "/v8/management/credentials/refresh" {
			c.Next()
			return
		}
		c.AbortWithStatus(404)
	}
	started := make(chan struct{})
	svc, err := cliproxy.NewBuilder().WithHooks(cliproxy.Hooks{OnAfterStart: func(*cliproxy.Service) { close(started) }}).WithWatcherFactory(func(string, string, func(*config.Config)) (*cliproxy.WatcherWrapper, error) {
		return &cliproxy.WatcherWrapper{}, nil
	}).WithConfig(cfg).WithConfigPath(configPath).WithCoreAuthManager(manager).WithLocalManagementPassword(input.Token).WithServerOptions(api.WithMiddleware(middleware), api.WithRouterConfigurator(func(e *gin.Engine, _ *handlers.BaseAPIHandler, _ *config.Config) {
		e.GET("/emdash/health", func(c *gin.Context) { c.JSON(200, gin.H{"protocol": protocol}) })
		e.PUT("/emdash/model-routes", func(c *gin.Context) {
			var entries []gateway.SessionModels
			if err := c.ShouldBindJSON(&entries); err != nil {
				c.JSON(400, gin.H{"error": "Invalid model catalogs"})
				return
			}
			if err := modelRoutes.Replace(entries); err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			c.Status(204)
		})
		e.PUT("/emdash/providers", func(c *gin.Context) {
			var entries []provider
			if err := c.ShouldBindJSON(&entries); err != nil {
				c.JSON(400, gin.H{"error": "invalid providers"})
				return
			}
			providersMu.Lock()
			defer providersMu.Unlock()
			seen := map[string]bool{}
			for _, p := range entries {
				if p.ID == "" || seen[p.ID] || (p.APIKey == "" && len(p.ProtocolKeys) == 0) || len(p.Models) == 0 {
					c.JSON(400, gin.H{"error": "invalid or duplicate provider"})
					return
				}
				seen[p.ID] = true
			}
			for _, id := range managed {
				if !seen[id] {
					manager.Remove(c.Request.Context(), id)
					cliproxy.GlobalModelRegistry().UnregisterClient(id)
				}
			}
			managed = nil
			for _, p := range entries {
				if p.Protocol == "" {
					p.Protocol = "openai-responses"
				}
				modelMap, _ := json.Marshal(p.ModelMap)
				headers, _ := json.Marshal(p.Headers)
				contexts, _ := json.Marshal(p.ContextWindows)
				endpoints, _ := json.Marshal(p.Endpoints)
				protocolKeys, _ := json.Marshal(p.ProtocolKeys)
				route, _ := json.Marshal(p.Route)
				auth := &a.Auth{ID: p.ID, Provider: gateway.ResponsesProvider, Label: p.Name, Status: a.StatusActive, Attributes: map[string]string{"api_key": p.APIKey, "base_url": p.BaseURL, "emdash_models": string(modelMap), "emdash_headers": string(headers), "emdash_protocol_keys": string(protocolKeys), "emdash_endpoints": string(endpoints), "emdash_contexts": string(contexts), "emdash_protocol": p.Protocol, "anthropic_base_url": p.AnthropicBaseURL, "anthropic_auth": p.AnthropicAuth}}
				auth.Attributes["emdash_route"] = string(route)
				if _, err := manager.Register(c.Request.Context(), auth); err != nil {
					c.JSON(500, gin.H{"error": "provider registration failed"})
					return
				}
				models := make([]*cliproxy.ModelInfo, 0, len(p.Models))
				for _, id := range p.Models {
					models = append(models, &cliproxy.ModelInfo{ID: id, Object: "model", OwnedBy: gateway.ResponsesProvider, ContextLength: p.ContextWindows[id], MaxContextLength: p.ContextWindows[id]})
				}
				cliproxy.GlobalModelRegistry().RegisterClient(p.ID, gateway.ResponsesProvider, models)
				manager.RefreshSchedulerEntry(p.ID)
				managed = append(managed, p.ID)
			}
			c.Status(204)
		})
		e.GET("/emdash/catalog", func(c *gin.Context) {
			rows := make([]gin.H, 0)
			for _, auth := range manager.List() {
				if auth.Disabled {
					continue
				}
				models := []string{}
				contexts := map[string]int{}
				for _, m := range cliproxy.GlobalModelRegistry().GetModelsForClient(auth.ID) {
					models = append(models, m.ID)
					context := m.MaxContextLength
					if context <= 0 {
						context = m.ContextLength
					}
					if context > 0 {
						contexts[m.ID] = context
					}
				}
				if auth.Provider == gateway.ResponsesProvider {
					var mapping map[string]string
					_ = json.Unmarshal([]byte(auth.Attributes["emdash_models"]), &mapping)
					models = nil
					for id := range mapping {
						models = append(models, id)
					}
					sort.Strings(models)
					_ = json.Unmarshal([]byte(auth.Attributes["emdash_contexts"]), &contexts)
				}
				name := auth.Label
				if name == "" {
					name = auth.FileName
				}
				if name == "" {
					name = auth.ID
				}
				rows = append(rows, gin.H{"id": auth.ID, "name": name, "provider": auth.Provider, "models": models, "contextWindows": contexts, "disabled": auth.Disabled, "protocol": auth.Attributes["emdash_protocol"]})
			}
			c.JSON(200, rows)
		})
		e.GET("/emdash/credentials", func(c *gin.Context) {
			rows := make([]gin.H, 0)
			for _, auth := range manager.List() {
				if auth.Provider == gateway.ResponsesProvider {
					continue
				}
				rows = append(rows, gin.H{"id": auth.ID, "name": auth.ID, "provider": auth.Provider, "type": auth.Provider, "label": auth.Label, "disabled": auth.Disabled, "status": auth.Status})
			}
			c.JSON(200, gin.H{"files": rows})
		})
		e.DELETE("/emdash/credentials", func(c *gin.Context) {
			var input struct {
				Names []string `json:"names"`
			}
			_ = c.ShouldBindJSON(&input)
			if name := c.Query("name"); name != "" {
				input.Names = append(input.Names, name)
			}
			if c.Query("all") == "true" {
				for _, auth := range manager.List() {
					if auth.Provider != gateway.ResponsesProvider {
						input.Names = append(input.Names, auth.ID)
					}
				}
			}
			if len(input.Names) == 0 {
				c.JSON(400, gin.H{"error": "credential required"})
				return
			}
			deleted := []string{}
			for _, id := range input.Names {
				auth, exists := manager.GetByID(id)
				if !exists || auth.Provider == gateway.ResponsesProvider {
					continue
				}
				if err := store.Delete(c.Request.Context(), id); err != nil {
					c.JSON(500, gin.H{"error": "credential deletion failed"})
					return
				}
				manager.Remove(c.Request.Context(), id)
				cliproxy.GlobalModelRegistry().UnregisterClient(id)
				deleted = append(deleted, id)
			}
			c.JSON(200, gin.H{"status": "ok", "deleted": len(deleted), "files": deleted})
		})
		e.PATCH("/emdash/credentials/status", func(c *gin.Context) {
			var input struct {
				Name     string `json:"name"`
				Disabled bool   `json:"disabled"`
			}
			if c.ShouldBindJSON(&input) != nil {
				c.Status(400)
				return
			}
			auth, ok := manager.GetByID(input.Name)
			if !ok || auth.Provider == gateway.ResponsesProvider {
				c.Status(404)
				return
			}
			auth = auth.Clone()
			auth.Disabled = input.Disabled
			if _, err := manager.Update(c.Request.Context(), auth); err != nil {
				c.JSON(500, gin.H{"error": "credential update failed"})
				return
			}
			manager.RefreshSchedulerEntry(auth.ID)
			c.JSON(200, gin.H{"status": "ok", "disabled": input.Disabled})
		})
		e.GET("/emdash/credentials/models", func(c *gin.Context) {
			models := cliproxy.GlobalModelRegistry().GetModelsForClient(c.Query("name"))
			c.JSON(200, gin.H{"models": models})
		})

		e.GET("/emdash/outbox", func(c *gin.Context) {
			events := []json.RawMessage{}
			err := db.View(func(tx *bolt.Tx) error {
				bucket := tx.Bucket([]byte("usage"))
				if bucket == nil {
					return nil
				}
				cursor := bucket.Cursor()
				for _, v := cursor.First(); v != nil && len(events) < 200; _, v = cursor.Next() {
					events = append(events, append(json.RawMessage(nil), v...))
				}
				return nil
			})
			if err != nil {
				c.Status(500)
				return
			}
			c.JSON(200, events)
		})
	})).Build()
	if err != nil {
		return err
	}
	manager.RegisterExecutor(apiExecutor)
	svc.RegisterUsagePlugin(&usageSink{db: db, bridge: b})
	// Ready is sent only after the authenticated listener accepts requests.
	readyCtx, readyCancel := context.WithCancel(ctx)
	defer readyCancel()
	go func() {
		select {
		case <-started:
		case <-readyCtx.Done():
			return
		}
		client := &http.Client{Timeout: time.Second}
		for attempts := 0; attempts < 150; attempts++ {
			select {
			case <-readyCtx.Done():
				return
			case <-time.After(100 * time.Millisecond):
			}
			req, _ := http.NewRequestWithContext(readyCtx, "GET", fmt.Sprintf("http://127.0.0.1:%d/emdash/health", port), nil)
			req.Header.Set("Authorization", "Bearer "+input.Token)
			res, err := client.Do(req)
			if err == nil {
				res.Body.Close()
				if res.StatusCode == 200 {
					_ = b.emit("ready", map[string]any{"protocol": protocol, "address": fmt.Sprintf("http://127.0.0.1:%d", port)})
					return
				}
			}
		}
		_ = b.emit("fatal", map[string]string{"message": "Gateway listener did not become ready"})
		cancel()
	}()
	err = svc.Run(ctx)
	if ctx.Err() != nil && errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "model gateway failed:", err)
		os.Exit(1)
	}
}

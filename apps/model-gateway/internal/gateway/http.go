package gateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	a "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	e "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

// ServeAPI keeps the three configured wire protocols unchanged. Native OAuth
// accounts continue through the SDK handlers and provider-native executors.
func (x ResponsesExecutor) ServeAPI(c *gin.Context, auth *a.Auth) {
	path := strings.TrimPrefix(c.Request.URL.Path, "/v1/")
	var models map[string]string
	_ = json.Unmarshal([]byte(auth.Attributes["emdash_models"]), &models)
	if path == "models" && c.Request.Method == "GET" {
		rows := []gin.H{}
		for id := range models {
			rows = append(rows, gin.H{"id": id, "object": "model"})
		}
		c.JSON(200, gin.H{"object": "list", "data": rows})
		return
	}
	protocol := auth.Attributes["emdash_protocol"]
	if protocol == "" {
		protocol = "openai-responses"
	}
	allowed := (protocol == "all") || (protocol == "anthropic" && strings.HasPrefix(path, "messages")) ||
		(protocol == "openai-chat" && path == "chat/completions") || (protocol == "openai-responses" && strings.HasPrefix(path, "responses"))
	var endpoints map[string]string
	_ = json.Unmarshal([]byte(auth.Attributes["emdash_endpoints"]), &endpoints)
	if len(endpoints) > 0 {
		selected := "openai-responses"
		if path == "chat/completions" {
			selected = "openai-chat"
		}
		if strings.HasPrefix(path, "messages") {
			selected = "anthropic"
		}
		allowed = endpoints[selected] != ""
	}
	if !allowed || c.Request.Method != "POST" || (path != "responses" && path != "responses/compact" && path != "messages" && path != "messages/count_tokens" && path != "chat/completions") {
		c.JSON(400, gin.H{"error": "The selected provider does not support this protocol."})
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, 32*1024*1024))
	var body struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	if err != nil || json.Unmarshal(raw, &body) != nil || models[body.Model] == "" {
		c.JSON(400, gin.H{"error": "Select a model configured on this provider."})
		return
	}
	ctx := context.WithValue(c.Request.Context(), "gin", c)
	req := e.Request{Model: body.Model, Payload: raw}
	alt := path
	if alt == "responses" {
		alt = ""
	}
	opts := e.Options{Alt: alt}
	fail := func(err error) {
		code := 502
		if status, ok := err.(interface{ StatusCode() int }); ok {
			code = status.StatusCode()
		}
		c.JSON(code, gin.H{"error": err.Error()})
	}
	copyHeaders := func(headers http.Header) {
		for _, key := range []string{"Content-Type", "Request-Id", "X-Request-Id"} {
			if value := headers.Get(key); value != "" {
				c.Header(key, value)
			}
		}
		c.Header("Cache-Control", "no-store")
	}
	if path == "messages/count_tokens" {
		response, err := x.CountTokens(ctx, auth, req, opts)
		if err != nil {
			fail(err)
			return
		}
		copyHeaders(response.Headers)
		c.Data(200, "application/json", response.Payload)
		return
	}
	if !body.Stream {
		response, err := x.Execute(ctx, auth, req, opts)
		if err != nil {
			fail(err)
			return
		}
		copyHeaders(response.Headers)
		c.Data(200, "application/json", response.Payload)
		return
	}
	response, err := x.ExecuteStream(ctx, auth, req, opts)
	if err != nil {
		fail(err)
		return
	}
	copyHeaders(response.Headers)
	c.Header("Content-Type", "text/event-stream")
	for chunk := range response.Chunks {
		if chunk.Err != nil {
			return
		}
		if _, err := c.Writer.Write(chunk.Payload); err != nil {
			return
		}
		c.Writer.Flush()
	}
}

package gateway

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
)

type RoutePolicy struct {
	Mode              string            `json:"mode"`
	Protocol          string            `json:"protocol,omitempty"`
	ConversionTargets map[string]string `json:"conversionTargets,omitempty"`
}

type ModelRoute struct {
	ProviderID     string                       `json:"providerId"`
	Revision       int                          `json:"revision"`
	ProtocolModels map[string]map[string]string `json:"protocolModels"`
	Policy         RoutePolicy                  `json:"policy"`
}

type SessionModels struct {
	ID     string            `json:"id"`
	Models map[string]string `json:"models"`
}

// ModelRoutes contains only catalogs published on the authenticated control channel.
type ModelRoutes struct {
	mu       sync.RWMutex
	sessions map[string]map[string]string
}

func (r *ModelRoutes) Replace(entries []SessionModels) error {
	next := make(map[string]map[string]string, len(entries))
	for _, entry := range entries {
		if entry.ID == "" || next[entry.ID] != nil {
			return routeError("Invalid or duplicate session catalog.")
		}
		next[entry.ID] = entry.Models
	}
	r.mu.Lock()
	r.sessions = next
	r.mu.Unlock()
	return nil
}

// Resolve preserves the request bytes while selecting by its public model alias.
func (r *ModelRoutes) Resolve(c *gin.Context, id string) (string, bool) {
	r.mu.RLock()
	models, found := r.sessions[id]
	r.mu.RUnlock()
	if !found {
		c.AbortWithStatusJSON(409, gin.H{"error": "Gateway session catalog is unavailable. Restart the agent."})
		return "", true
	}
	if c.Request.Method == "GET" && c.Request.URL.Path == "/v1/models" {
		ids := make([]string, 0, len(models))
		for model := range models {
			ids = append(ids, model)
		}
		sort.Strings(ids)
		data := make([]gin.H, 0, len(ids))
		for _, model := range ids {
			data = append(data, gin.H{"id": model, "object": "model"})
		}
		c.AbortWithStatusJSON(200, gin.H{"object": "list", "data": data})
		return "", true
	}
	raw, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, maxRequestBody))
	if err != nil {
		c.AbortWithStatusJSON(413, gin.H{"error": "Gateway request is incomplete or too large."})
		return "", true
	}
	decoded, err := decodeRequestPayload(raw, c.GetHeader("Content-Encoding"))
	if err != nil {
		code := 400
		if status, ok := err.(interface{ StatusCode() int }); ok {
			code = status.StatusCode()
		}
		c.AbortWithStatusJSON(code, gin.H{"error": "Unsupported or invalid encoded request."})
		return "", true
	}
	var body struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(decoded, &body) != nil || models[body.Model] == "" {
		c.AbortWithStatusJSON(400, gin.H{"error": "Unknown or unavailable gateway model alias. Check its enabled state and provider credentials, or restart after a route change."})
		return "", true
	}
	c.Request.Body = io.NopCloser(bytes.NewReader(raw))
	return models[body.Model], false
}

func inboundProtocol(path string) string {
	if strings.HasPrefix(path, "messages") {
		return "anthropic"
	}
	if path == "chat/completions" {
		return "openai-chat"
	}
	return "openai-responses"
}

type routeError string

func (e routeError) Error() string { return string(e) }
func (routeError) StatusCode() int { return 400 }

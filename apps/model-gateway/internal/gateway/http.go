package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/http/httputil"
	"strings"
	"time"

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
	var route *ModelRoute
	_ = json.Unmarshal([]byte(auth.Attributes["emdash_route"]), &route)
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
	if route != nil {
		allowed = true
	}
	if !allowed || c.Request.Method != "POST" || (path != "responses" && path != "responses/compact" && path != "messages" && path != "messages/count_tokens" && path != "chat/completions") {
		c.JSON(400, gin.H{"error": "The selected provider does not support this protocol."})
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, maxRequestBody))
	if err != nil {
		code := 400
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			code = 413
		}
		c.JSON(code, gin.H{"error": "Gateway request body is incomplete or exceeds its size limit."})
		return
	}
	decoded, err := decodeRequestPayload(raw, c.GetHeader("Content-Encoding"))
	if err != nil {
		code := 400
		if status, ok := err.(interface{ StatusCode() int }); ok {
			code = status.StatusCode()
		}
		c.JSON(code, gin.H{"error": "Unsupported, invalid, or oversized encoded request body."})
		return
	}
	var body struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	if json.Unmarshal(decoded, &body) != nil || models[body.Model] == "" {
		c.JSON(400, gin.H{"error": "Select a model configured on this provider."})
		return
	}
	if route != nil {
		inbound := inboundProtocol(path)
		target, err := selectProtocol(*route, body.Model, inbound)
		if err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		auth = auth.Clone()
		models[body.Model] = route.ProtocolModels[body.Model][target]
		mapping, _ := json.Marshal(models)
		auth.Attributes["emdash_models"] = string(mapping)
		auth.Attributes["emdash_inbound_protocol"] = inbound
		auth.Attributes["emdash_upstream_protocol"] = target
		if target != inbound {
			if path == "responses/compact" || path == "messages/count_tokens" {
				c.JSON(400, gin.H{"error": "This operation requires a native protocol endpoint."})
				return
			}
			x.serveConverted(c, auth, e.Request{Model: body.Model, Payload: raw}, decoded, body.Stream, inbound, target)
			return
		}
	}
	ctx := context.WithValue(c.Request.Context(), "gin", c)
	req := e.Request{Model: body.Model, Payload: raw}
	alt := path
	if alt == "responses" {
		alt = ""
	}
	fail := func(err error) {
		code := 502
		if status, ok := err.(interface{ StatusCode() int }); ok {
			code = status.StatusCode()
		}
		c.JSON(code, gin.H{"error": err.Error()})
	}
	prepared, err := upstreamRequest(ctx, auth, req, alt)
	if err != nil {
		fail(err)
		return
	}
	ctx = snapshotSession(prepared.Context())
	started := time.Now()
	countTokens := path == "messages/count_tokens"
	proxy := httputil.ReverseProxy{
		Rewrite:       func(p *httputil.ProxyRequest) { p.Out = prepared.Clone(p.Out.Context()) },
		Transport:     providerTransport{executor: x, auth: auth},
		FlushInterval: -1,
		ModifyResponse: func(response *http.Response) error {
			response.Header = forwardHeaders(response.Header, false)
			response.Header.Set("Cache-Control", "no-store")
			stripHeaders(response.Trailer, false)
			mediaType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
			response.Body = observeBody(response.Body, response.Header, response.Trailer,
				strings.EqualFold(mediaType, "text/event-stream"), alt,
				func(payload []byte, failed bool) {
					stripHeaders(response.Trailer, false)
					if !countTokens {
						usageRecord(ctx, auth, req, started, payload, failed || response.StatusCode >= 300)
					}
				})
			return nil
		},
		ErrorHandler: func(_ http.ResponseWriter, _ *http.Request, err error) {
			if !countTokens {
				usageRecord(ctx, auth, req, started, nil, true)
			}
			fail(err)
		},
	}
	proxy.ServeHTTP(c.Writer, c.Request.WithContext(ctx))
}

type providerTransport struct {
	executor ResponsesExecutor
	auth     *a.Auth
}

func (t providerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return t.executor.HttpRequest(req.Context(), t.auth, req)
}

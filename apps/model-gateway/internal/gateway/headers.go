package gateway

import (
	"net/http"
	"strings"
)

// Connection-scoped fields describe one transport hop, not the model request.
func forwardHeaders(source http.Header, request bool) http.Header {
	headers := source.Clone()
	stripHeaders(headers, request)
	return headers
}

func stripHeaders(headers http.Header, request bool) {
	for _, value := range headers.Values("Connection") {
		for _, name := range strings.Split(value, ",") {
			headers.Del(strings.TrimSpace(name))
		}
	}
	for name := range headers {
		lower := strings.ToLower(name)
		switch lower {
		case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade":
			headers.Del(name)
			continue
		}
		if strings.HasPrefix(lower, "x-emdash-") {
			headers.Del(name)
		}
		if request {
			switch lower {
			case "authorization", "x-api-key", "host", "content-length", "cookie", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto":
				headers.Del(name)
			}
		} else if lower == "set-cookie" {
			// Provider cookies must not become credentials on the local gateway.
			headers.Del(name)
		}
	}
}

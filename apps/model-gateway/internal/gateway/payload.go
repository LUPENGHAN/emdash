package gateway

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"io"
	"net/http"
	"strings"
)

const maxRequestBody = 32 * 1024 * 1024

// We do not own the caller's digest or signing keys. Reject a body rewrite
// rather than stripping integrity protection or forwarding a stale signature.
func hasRequestIntegrity(headers http.Header) bool {
	for name := range headers {
		switch strings.ToLower(name) {
		case "content-md5", "digest", "content-digest", "repr-digest", "signature", "signature-input":
			return true
		}
	}
	return false
}

type integrityRewriteError struct{}

func (integrityRewriteError) Error() string {
	return "Model aliases cannot rewrite requests with digest or signature fields. Configure and request the upstream model ID without an alias."
}

func (integrityRewriteError) StatusCode() int { return http.StatusBadRequest }

func decodeRequestPayload(payload []byte, encoding string) ([]byte, error) {
	var reader io.ReadCloser
	var err error
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "", "identity":
		return payload, nil
	case "gzip":
		reader, err = gzip.NewReader(bytes.NewReader(payload))
	case "deflate":
		reader, err = zlib.NewReader(bytes.NewReader(payload))
	default:
		return nil, statusError{415}
	}
	if err != nil {
		return nil, statusError{400}
	}
	defer reader.Close()
	decoded, err := io.ReadAll(io.LimitReader(reader, maxRequestBody+1))
	if err != nil {
		return nil, statusError{400}
	}
	if len(decoded) > maxRequestBody {
		return nil, statusError{413}
	}
	return decoded, nil
}

func encodeRequestPayload(payload []byte, encoding string) ([]byte, error) {
	var buffer bytes.Buffer
	var writer io.WriteCloser
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "", "identity":
		return payload, nil
	case "gzip":
		writer = gzip.NewWriter(&buffer)
	case "deflate":
		writer = zlib.NewWriter(&buffer)
	default:
		return nil, statusError{415}
	}
	if _, err := writer.Write(payload); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

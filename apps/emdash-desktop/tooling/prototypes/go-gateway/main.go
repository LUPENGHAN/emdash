// This executable is a local-only experiment. It only accepts loopback upstreams.
package main

import (
	"bufio"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type gateway struct {
	mu        sync.RWMutex
	routes    map[string]*url.URL
	token     string
	usagePath string
	usageMu   sync.Mutex
}
type usageRecord struct {
	Session  string    `json:"session"`
	Provider string    `json:"provider"`
	At       time.Time `json:"at"`
	Input    int64     `json:"input_tokens"`
	Output   int64     `json:"output_tokens"`
}

func newGateway(token, usagePath string) *gateway {
	return &gateway{routes: map[string]*url.URL{}, token: token, usagePath: usagePath}
}
func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")), []byte(g.token)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
	if len(parts) < 2 || parts[1] == "" || strings.ContainsAny(parts[1], ".\\") {
		http.NotFound(w, r)
		return
	}
	id := parts[1]
	if parts[0] == "routes" && len(parts) == 2 && r.Method == http.MethodPut {
		var body struct {
			Upstream string `json:"upstream"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body) != nil {
			http.Error(w, "invalid JSON", 400)
			return
		}
		u, err := url.Parse(body.Upstream)
		if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || net.ParseIP(u.Hostname()) == nil || !net.ParseIP(u.Hostname()).IsLoopback() {
			http.Error(w, "only loopback HTTP upstreams are allowed", 400)
			return
		}
		g.mu.Lock()
		g.routes[id] = u
		g.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if parts[0] != "sessions" || len(parts) < 4 || r.Method != http.MethodPost || strings.Join(parts[2:], "/") != "v1/responses" {
		http.NotFound(w, r)
		return
	}
	g.mu.RLock()
	upstream := g.routes[id]
	g.mu.RUnlock()
	if upstream == nil {
		http.Error(w, "unknown session", 404)
		return
	}
	target := *upstream
	proxy := httputil.NewSingleHostReverseProxy(&target)
	proxy.Transport = &http.Transport{Proxy: nil}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, "upstream unavailable", http.StatusBadGateway)
	}
	proxy.Director = func(req *http.Request) {
		req.URL.Scheme = target.Scheme
		req.URL.Host = target.Host
		req.URL.Path = strings.TrimSuffix(target.Path, "/") + "/v1/responses"
		req.URL.RawQuery = ""
		req.Host = target.Host
		req.Header.Del("Authorization")
	}
	proxy.ModifyResponse = func(resp *http.Response) error {
		if resp.StatusCode < 200 || resp.StatusCode >= 300 || !strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
			return nil
		}
		resp.Body = &usageReader{ReadCloser: resp.Body, reader: bufio.NewReader(resp.Body), done: func(input, output int64) {
			if err := g.record(usageRecord{Session: id, Provider: target.String(), At: time.Now().UTC(), Input: input, Output: output}); err != nil {
				log.Printf("usage write failed: %v", err)
			}
		}}
		return nil
	}
	proxy.FlushInterval = -1
	proxy.ServeHTTP(w, r)
}

type usageReader struct {
	io.ReadCloser
	reader   *bufio.Reader
	done     func(int64, int64)
	line     []byte
	recorded bool
}

func (u *usageReader) Read(p []byte) (int, error) {
	n, err := u.reader.Read(p)
	for _, b := range p[:n] {
		if b == '\n' {
			u.parseLine()
			u.line = u.line[:0]
		} else if len(u.line) < 1024*1024 {
			u.line = append(u.line, b)
		}
	}
	return n, err
}
func (u *usageReader) parseLine() {
	if u.recorded || !strings.HasPrefix(string(u.line), "data: ") {
		return
	}
	var event struct {
		Type     string `json:"type"`
		Response struct {
			Usage *struct {
				Input  int64 `json:"input_tokens"`
				Output int64 `json:"output_tokens"`
			} `json:"usage"`
		} `json:"response"`
	}
	if json.Unmarshal(u.line[6:], &event) == nil && event.Type == "response.completed" && event.Response.Usage != nil {
		u.recorded = true
		u.done(event.Response.Usage.Input, event.Response.Usage.Output)
	}
}
func (g *gateway) record(row usageRecord) error {
	g.usageMu.Lock()
	defer g.usageMu.Unlock()
	f, err := os.OpenFile(g.usagePath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	return json.NewEncoder(f).Encode(row)
}
func main() {
	if len(os.Args) != 2 {
		log.Fatal("usage: go-gateway <usage-directory>")
	}
	dir, err := filepath.Abs(os.Args[1])
	if err != nil {
		log.Fatal(err)
	}
	if err = os.MkdirAll(dir, 0700); err != nil {
		log.Fatal(err)
	}
	tokenBytes := make([]byte, 32)
	if _, err = rand.Read(tokenBytes); err != nil {
		log.Fatal(err)
	}
	token := hex.EncodeToString(tokenBytes)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	// Bootstrap is sent over the private stdout pipe, never process arguments.
	fmt.Printf("%s\n", mustJSON(map[string]string{"address": "http://" + l.Addr().String(), "token": token}))
	server := &http.Server{Handler: newGateway(token, filepath.Join(dir, "usage.jsonl")), ReadHeaderTimeout: 5 * time.Second}
	if err = server.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

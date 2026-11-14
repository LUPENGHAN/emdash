package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type requestLog struct {
	mu     sync.Mutex
	bodies [][]byte
}

func (l *requestLog) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	l.mu.Lock()
	l.bodies = append(l.bodies, body)
	l.mu.Unlock()
	w.Header().Set("Content-Type", "text/event-stream")
	fmt.Fprint(w, "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_test\",\"object\":\"response\",\"created_at\":1,\"status\":\"in_progress\",\"model\":\"test-model\",\"output\":[]}}\n\n")
	fmt.Fprint(w, "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"msg_test\",\"type\":\"message\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"PROBE_REPLY\",\"annotations\":[]}]}}\n\n")
	fmt.Fprint(w, "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_test\",\"object\":\"response\",\"created_at\":1,\"status\":\"completed\",\"model\":\"test-model\",\"output\":[{\"id\":\"msg_test\",\"type\":\"message\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"PROBE_REPLY\",\"annotations\":[]}]}],\"usage\":{\"input_tokens\":12,\"output_tokens\":3,\"total_tokens\":15}}}\n\n")
}
func (l *requestLog) contains(text string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, b := range l.bodies {
		if bytes.Contains(b, []byte(text)) {
			return true
		}
	}
	return false
}
func TestSidecarCodexResumeAndUsage(t *testing.T) {
	if _, err := exec.LookPath("codex"); err != nil {
		t.Skip("codex not installed")
	}
	dir := t.TempDir()
	binary := filepath.Join(dir, "gateway")
	build := exec.Command("go", "build", "-o", binary, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v: %s", err, out)
	}
	sidecar := exec.Command(binary, dir)
	stdout, err := sidecar.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	sidecar.Stderr = os.Stderr
	if err = sidecar.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sidecar.Process.Kill(); _ = sidecar.Wait() }()
	var boot struct {
		Address string `json:"address"`
		Token   string `json:"token"`
	}
	if err = json.NewDecoder(bufio.NewReader(stdout)).Decode(&boot); err != nil {
		t.Fatal(err)
	}
	a, b := &requestLog{}, &requestLog{}
	sa := httptest.NewServer(http.HandlerFunc(a.handler))
	defer sa.Close()
	sb := httptest.NewServer(http.HandlerFunc(b.handler))
	defer sb.Close()
	setRoute := func(session, upstream string) {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"upstream": upstream})
		req, _ := http.NewRequest("PUT", boot.Address+"/routes/"+session, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+boot.Token)
		resp, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 204 {
			t.Fatalf("route: %s", resp.Status)
		}
	}
	setRoute("one", sa.URL)
	setRoute("two", sa.URL)
	home := filepath.Join(dir, "codex-home")
	if err = os.Mkdir(home, 0700); err != nil {
		t.Fatal(err)
	}
	cfg := fmt.Sprintf("model = \"test-model\"\nmodel_provider = \"emdash-prototype\"\n[model_providers.emdash-prototype]\nname = \"prototype\"\nbase_url = %q\nwire_api = \"responses\"\nenv_key = \"EMDASH_PROTOTYPE_TOKEN\"\n", boot.Address+"/sessions/one/v1")
	if err = os.WriteFile(filepath.Join(home, "config.toml"), []byte(cfg), 0600); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("codex", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "CODEX_HOME="+home, "EMDASH_PROTOTYPE_TOKEN="+boot.Token, "OTEL_SDK_DISABLED=true")
		out, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("codex: %v: %s", e, out)
		}
		return string(out)
	}
	first := run("exec", "--skip-git-repo-check", "--json", "remember the token bluecar")
	var id string
	for _, line := range strings.Split(first, "\n") {
		var v struct {
			Type string `json:"type"`
			ID   string `json:"thread_id"`
		}
		if json.Unmarshal([]byte(line), &v) == nil && v.Type == "thread.started" {
			id = v.ID
		}
	}
	if id == "" {
		t.Fatalf("no session: %s", first)
	}
	setRoute("one", sb.URL)
	second := run("exec", "--skip-git-repo-check", "--json", "resume", id, "what was the token?")
	if !strings.Contains(second, id) || !b.contains("bluecar") {
		t.Fatalf("same session and history not sent to B: %s", second)
	}
	req, _ := http.NewRequest("POST", boot.Address+"/sessions/two/v1/responses", strings.NewReader(`{"input":[]}`))
	req.Header.Set("Authorization", "Bearer "+boot.Token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, res.Body)
	_ = res.Body.Close()
	if !a.contains(`"input":[]`) {
		t.Fatal("switch changed the other session route")
	}
	if err = os.RemoveAll(filepath.Join(home, "sessions")); err != nil {
		t.Fatal(err)
	}
	var data []byte
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); {
		data, _ = os.ReadFile(filepath.Join(dir, "usage.jsonl"))
		if bytes.Count(data, []byte("\n")) >= 3 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if bytes.Count(data, []byte("\n")) < 3 || !bytes.Contains(data, []byte(`"input_tokens":12`)) {
		t.Fatalf("usage not persisted: %s", data)
	}
	if bytes.Contains(data, []byte("bluecar")) || bytes.Contains(data, []byte(boot.Token)) {
		t.Fatal("ledger contains request content or secret")
	}
}
func TestRejectNonLoopback(t *testing.T) {
	g := newGateway("secret", filepath.Join(t.TempDir(), "usage"))
	req := httptest.NewRequest("PUT", "/routes/test", strings.NewReader(`{"upstream":"http://example.com"}`))
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	g.ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
}

package embed_test

import (
	"context"
	"errors"
	"github.com/router-for-me/CLIProxyAPI/v6/sdk/cliproxy"
	a "github.com/router-for-me/CLIProxyAPI/v6/sdk/cliproxy/auth"
	e "github.com/router-for-me/CLIProxyAPI/v6/sdk/cliproxy/executor"
	u "github.com/router-for-me/CLIProxyAPI/v6/sdk/cliproxy/usage"
	"github.com/router-for-me/CLIProxyAPI/v6/sdk/config"
	"net/http"
	"path/filepath"
	"testing"
	"time"
)

func TestExternalBuilder(t *testing.T) {
	dir := t.TempDir()
	_, err := cliproxy.NewBuilder().WithConfig(&config.Config{AuthDir: dir}).WithConfigPath(filepath.Join(dir, "config.yaml")).Build()
	if err != nil {
		t.Fatal(err)
	}
}

type receiver struct{ ch chan u.Record }

func (r receiver) HandleUsage(_ context.Context, v u.Record) { r.ch <- v }
func TestUsageCallback(t *testing.T) {
	m := u.NewManager(4)
	defer m.Stop()
	ch := make(chan u.Record, 1)
	m.Register(receiver{ch})
	m.Publish(context.Background(), u.Record{Provider: "mock", Model: "model", Detail: u.Detail{InputTokens: 7, OutputTokens: 3}})
	select {
	case r := <-ch:
		if r.Detail.InputTokens != 7 || r.Detail.OutputTokens != 3 {
			t.Fatal(r)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("usage callback timeout")
	}
}

type mock struct{}

func (mock) Identifier() string { return "mock" }
func (mock) Execute(_ context.Context, a *a.Auth, _ e.Request, _ e.Options) (e.Response, error) {
	return e.Response{Payload: []byte(a.ID)}, nil
}
func (mock) ExecuteStream(context.Context, *a.Auth, e.Request, e.Options) (*e.StreamResult, error) {
	return nil, errors.New("unused")
}
func (mock) Refresh(_ context.Context, v *a.Auth) (*a.Auth, error) { return v, nil }
func (mock) CountTokens(context.Context, *a.Auth, e.Request, e.Options) (e.Response, error) {
	return e.Response{}, errors.New("unused")
}
func (mock) HttpRequest(context.Context, *a.Auth, *http.Request) (*http.Response, error) {
	return nil, errors.New("unused")
}
func TestPinnedAccount(t *testing.T) {
	ctx := context.Background()
	m := a.NewManager(nil, nil, nil)
	m.RegisterExecutor(mock{})
	for _, id := range []string{"a", "b"} {
		if _, err := m.Register(ctx, &a.Auth{ID: id, Provider: "mock", Status: a.StatusActive}); err != nil {
			t.Fatal(err)
		}
		cliproxy.GlobalModelRegistry().RegisterClient(id, "mock", []*cliproxy.ModelInfo{{ID: "test"}})
		defer cliproxy.GlobalModelRegistry().UnregisterClient(id)
		m.RefreshSchedulerEntry(id)
	}
	for _, id := range []string{"a", "b", "a"} {
		r, err := m.Execute(ctx, []string{"mock"}, e.Request{Model: "test"}, e.Options{Metadata: map[string]any{e.PinnedAuthMetadataKey: id}})
		if err != nil || string(r.Payload) != id {
			t.Fatalf("pin=%s result=%s err=%v", id, r.Payload, err)
		}
	}
	_, err := m.Execute(ctx, []string{"mock"}, e.Request{Model: "test"}, e.Options{Metadata: map[string]any{e.PinnedAuthMetadataKey: "missing"}})
	if err == nil {
		t.Fatal("missing pinned credential fell back")
	}
}

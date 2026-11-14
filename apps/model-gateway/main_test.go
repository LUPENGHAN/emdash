package main

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	u "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
	bolt "go.etcd.io/bbolt"
)

func TestUsageOutboxKeepsRecordsUntilAcknowledged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "outbox.db")
	db, err := bolt.Open(path, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	sink := usageSink{db: db, bridge: &bridge{enc: json.NewEncoder(&output)}}
	for _, source := range []string{"emdash:usage-known", ""} {
		sink.HandleUsage(context.Background(), u.Record{RequestID: "request-" + source, Source: source, AuthID: "account", RequestedAt: time.Now()})
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = bolt.Open(path, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	err = db.View(func(tx *bolt.Tx) error {
		for _, source := range []string{"emdash:usage-known", ""} {
			var event map[string]any
			if err := json.Unmarshal(tx.Bucket([]byte("usage")).Get([]byte("request-"+source)), &event); err != nil {
				return err
			}
			want := "complete"
			if source == "" {
				want = "missing"
			}
			if event["status"] != want {
				t.Errorf("zero token usage status=%v, want=%s", event["status"], want)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

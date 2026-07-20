// Package buffer is the offline disk queue: batches that fail to ship are
// persisted and retried until the network comes back (HPC networks flake).
package buffer

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

type Queue struct {
	Dir string
}

type remainderError interface {
	Remaining() []byte
}

func New(dir string) (*Queue, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Queue{Dir: dir}, nil
}

// Push persists one batch (any JSON-serializable value).
func (q *Queue) Push(batch any) error {
	data, err := json.Marshal(batch)
	if err != nil {
		return err
	}
	name := fmt.Sprintf("%d.json", time.Now().UnixNano())
	tmp := filepath.Join(q.Dir, name+".tmp")
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(q.Dir, name))
}

// Flush sends queued batches oldest-first, deleting each on success and
// stopping at the first failure (order-preserving). Returns sent count.
func (q *Queue) Flush(send func(raw []byte) error) (int, error) {
	entries, err := os.ReadDir(q.Dir)
	if err != nil {
		return 0, err
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".json" {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	sent := 0
	for _, name := range names {
		path := filepath.Join(q.Dir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			return sent, err
		}
		if err := send(data); err != nil {
			var partial remainderError
			if errors.As(err, &partial) && len(partial.Remaining()) > 0 {
				if err := q.replace(path, partial.Remaining()); err != nil {
					return sent, err
				}
			}
			return sent, err
		}
		if err := os.Remove(path); err != nil {
			return sent, err
		}
		sent++
	}
	return sent, nil
}

func (q *Queue) replace(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Len reports how many batches are queued.
func (q *Queue) Len() int {
	entries, err := os.ReadDir(q.Dir)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".json" {
			n++
		}
	}
	return n
}

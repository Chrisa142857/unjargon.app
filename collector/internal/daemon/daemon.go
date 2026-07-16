// Package daemon is unjargond's long-running mode: it discovers agent
// transcript files (SessionStart-hook notifications on localhost, plus a
// polling directory scan as fallback), tails them all, and ships new
// assistant messages — buffering to disk when the network is down.
//
// Everything is polling-based (~2s mtime) by design: inotify is unreliable
// on the NFS/Lustre filesystems HPC home dirs live on, and 2s polling of a
// handful of JSONL files costs nothing.
package daemon

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/chrisa142857/unjargon.app/collector/internal/buffer"
	"github.com/chrisa142857/unjargon.app/collector/internal/parse"
	"github.com/chrisa142857/unjargon.app/collector/internal/ship"
	"github.com/chrisa142857/unjargon.app/collector/internal/tail"
)

type Config struct {
	Shipper    *ship.Shipper
	Parser     parse.Parser
	WatchRoots []string      // directories scanned for **/*.jsonl
	Listen     string        // hook-notification address, e.g. 127.0.0.1:4577
	StateDir   string        // offsets, offline queue, pid file
	Interval   time.Duration // poll interval
}

type Daemon struct {
	cfg     Config
	queue   *buffer.Queue
	mu      sync.Mutex
	tailers map[string]*tail.Tailer
	offsets *offsetStore
	started time.Time
}

func New(cfg Config) (*Daemon, error) {
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		return nil, err
	}
	q, err := buffer.New(filepath.Join(cfg.StateDir, "queue"))
	if err != nil {
		return nil, err
	}
	offsets, err := loadOffsets(filepath.Join(cfg.StateDir, "offsets.json"))
	if err != nil {
		return nil, err
	}
	return &Daemon{
		cfg:     cfg,
		queue:   q,
		tailers: map[string]*tail.Tailer{},
		offsets: offsets,
		started: time.Now(),
	}, nil
}

// Run blocks forever. PID-file handling is the caller's job.
func (d *Daemon) Run() error {
	if d.cfg.Listen != "" {
		ln, err := net.Listen("tcp", d.cfg.Listen)
		if err != nil {
			// Another daemon instance probably owns the port; the PID check
			// should have caught that, so surface it.
			return fmt.Errorf("hook listener: %w", err)
		}
		go func() {
			mux := http.NewServeMux()
			mux.HandleFunc("/notify", d.handleNotify)
			mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
				fmt.Fprintln(w, "ok")
			})
			if err := http.Serve(ln, mux); err != nil {
				log.Printf("hook listener stopped: %v", err)
			}
		}()
		log.Printf("hook listener on http://%s/notify", d.cfg.Listen)
	}

	flushTick := time.NewTicker(15 * time.Second)
	defer flushTick.Stop()
	pollTick := time.NewTicker(d.cfg.Interval)
	defer pollTick.Stop()

	d.scan()
	d.poll()
	for {
		select {
		case <-pollTick.C:
			d.scan()
			d.poll()
		case <-flushTick.C:
			if n, err := d.queue.Flush(d.cfg.Shipper.SendRaw); n > 0 || err != nil {
				log.Printf("offline queue: flushed %d, %d left (err=%v)", n, d.queue.Len(), err)
			}
		}
	}
}

// handleNotify is the SessionStart-hook path: `unjargond hook` posts
// {"transcript_path": "..."} the moment a session starts, so we tail the
// exact file from byte 0 — no path guessing, robust to relocation.
func (d *Daemon) handleNotify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		TranscriptPath string `json:"transcript_path"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil ||
		strings.TrimSpace(body.TranscriptPath) == "" {
		http.Error(w, "want {\"transcript_path\": ...}", http.StatusBadRequest)
		return
	}
	path := body.TranscriptPath
	if !strings.HasSuffix(path, ".jsonl") {
		http.Error(w, "not a .jsonl path", http.StatusBadRequest)
		return
	}
	d.track(path, true)
	fmt.Fprintln(w, "ok")
}

// scan walks the watch roots for *.jsonl files (fallback discovery for
// sessions started before the collector, or without the hook installed).
func (d *Daemon) scan() {
	for _, root := range d.cfg.WatchRoots {
		_ = filepath.WalkDir(root, func(path string, e fs.DirEntry, err error) error {
			if err != nil {
				return nil // unreadable subtree — skip, keep walking
			}
			if !e.IsDir() && strings.HasSuffix(path, ".jsonl") {
				d.track(path, false)
			}
			return nil
		})
	}
}

// track registers a transcript for tailing (idempotent).
//
// Start position: a persisted offset always wins (daemon restart → resume,
// no duplicates). Otherwise hook-announced files and files newer than the
// daemon start are read from 0 (catch the session's first messages), while
// pre-existing files discovered by scan start at their current end so we
// don't flood the stream with old history.
func (d *Daemon) track(path string, fromHook bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.tailers[path]; ok {
		return
	}
	var offset int64
	if saved, ok := d.offsets.get(path); ok {
		offset = saved
	} else if !fromHook {
		if st, err := os.Stat(path); err == nil && st.ModTime().Before(d.started) {
			offset = st.Size()
		}
	}
	d.tailers[path] = tail.NewAt(path, offset)
	src := "scan"
	if fromHook {
		src = "hook"
	}
	log.Printf("tracking %s (via %s, from byte %d)", path, src, offset)
}

// poll drains every tracked file and ships one batch per file (a transcript
// file is one session). Failed sends go to the offline queue — offsets still
// advance because the batch is safely on disk.
func (d *Daemon) poll() {
	d.mu.Lock()
	paths := make([]string, 0, len(d.tailers))
	for p := range d.tailers {
		paths = append(paths, p)
	}
	d.mu.Unlock()

	dirty := false
	for _, path := range paths {
		d.mu.Lock()
		t := d.tailers[path]
		d.mu.Unlock()

		lines, err := t.Poll()
		if err != nil {
			log.Printf("poll %s: %v", path, err)
			continue
		}
		var msgs []parse.AgentMessage
		for _, line := range lines {
			if m, ok := d.cfg.Parser.ParseLine(line); ok {
				msgs = append(msgs, m)
			}
		}
		if len(msgs) > 0 {
			batch := d.cfg.Shipper.FromMessages(msgs)
			if err := d.cfg.Shipper.SendBatch(batch); err != nil {
				log.Printf("ship failed, buffering %d message(s): %v", len(batch.Messages), err)
				if qerr := d.queue.Push(batch); qerr != nil {
					log.Printf("buffer failed, %d message(s) LOST: %v", len(batch.Messages), qerr)
				}
			} else {
				log.Printf("shipped %d message(s) from %s", len(msgs), filepath.Base(path))
			}
		}
		if len(lines) > 0 {
			d.offsets.set(path, t.Offset())
			dirty = true
		}
	}
	if dirty {
		if err := d.offsets.save(); err != nil {
			log.Printf("offsets save: %v", err)
		}
	}
}

// --- offset persistence ----------------------------------------------------

type offsetStore struct {
	path string
	mu   sync.Mutex
	m    map[string]int64
}

func loadOffsets(path string) (*offsetStore, error) {
	s := &offsetStore{path: path, m: map[string]int64{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &s.m); err != nil {
		// Corrupt state file: start fresh rather than dying.
		log.Printf("offsets file unreadable, resetting: %v", err)
		s.m = map[string]int64{}
	}
	return s, nil
}

func (s *offsetStore) get(path string) (int64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.m[path]
	return v, ok
}

func (s *offsetStore) set(path string, offset int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[path] = offset
}

func (s *offsetStore) save() error {
	s.mu.Lock()
	data, err := json.MarshalIndent(s.m, "", " ")
	s.mu.Unlock()
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

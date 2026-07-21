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
	"bytes"
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
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/chrisa142857/unjargon.app/collector/internal/aicli"
	"github.com/chrisa142857/unjargon.app/collector/internal/buffer"
	"github.com/chrisa142857/unjargon.app/collector/internal/parse"
	"github.com/chrisa142857/unjargon.app/collector/internal/ship"
	"github.com/chrisa142857/unjargon.app/collector/internal/tail"
)

type Config struct {
	Shipper          *ship.Shipper
	Expander         *aicli.Translator // nil → server-side explicit explanation
	WatchRoots       []string          // directories scanned for **/*.jsonl
	Listen           string            // hook-notification address, e.g. 127.0.0.1:4577
	StateDir         string            // offsets, offline queue, pid file
	Interval         time.Duration     // poll interval
	BackfillExisting bool              // import transcripts already present at install time
}

// tracked pairs a tailer with its per-file parser (formats like Codex carry
// session metadata only on the first line, so parsers hold per-file state).
type tracked struct {
	tailer *tail.Tailer
	parser parse.Parser
}

type Daemon struct {
	cfg        Config
	queue      *buffer.Queue
	mu         sync.Mutex
	tailers    map[string]*tracked
	offsets    *offsetStore
	started    time.Time
	retryUntil time.Time
	workBusy   atomic.Bool
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
	if cfg.BackfillExisting {
		marker := filepath.Join(cfg.StateDir, "backfill-v1.done")
		if _, err := os.Stat(marker); errors.Is(err, os.ErrNotExist) {
			offsets.reset()
			if err := os.WriteFile(marker, []byte("done\n"), 0o600); err != nil {
				return nil, err
			}
			log.Print("backfill: importing existing transcripts")
		}
	}
	return &Daemon{
		cfg:     cfg,
		queue:   q,
		tailers: map[string]*tracked{},
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
	scanTick := time.NewTicker(30 * time.Second)
	defer scanTick.Stop()

	// History scans can take longer than a status interval on machines with
	// thousands of old transcripts. Keep the optional explanation heartbeat
	// independent so a healthy collector remains reachable while scanning.
	go d.backgroundWork()
	d.scan()
	d.poll()
	for {
		select {
		case <-pollTick.C:
			d.poll()
		case <-scanTick.C:
			d.scan()
		case <-flushTick.C:
			if !time.Now().Before(d.retryUntil) {
				if n, err := d.queue.Flush(d.cfg.Shipper.SendRaw); n > 0 || err != nil {
					d.deferRetry(err)
					log.Printf("offline queue: flushed %d, %d left (err=%v)", n, d.queue.Len(), err)
				}
			}
		}
	}
}

func (d *Daemon) backgroundWork() {
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	for {
		d.reportStatus()
		// Explicit explanation work runs separately so AI calls never stall
		// transcript tailing or collector heartbeats.
		if d.cfg.Expander != nil && d.workBusy.CompareAndSwap(false, true) {
			go func() {
				defer d.workBusy.Store(false)
				d.expandWork()
				d.reportStatus()
			}()
		}
		<-tick.C
	}
}

// expandWork serves queued term-expansion requests (a user tapped "explain"
// on a no-key server) with the user's own AI CLI. Runs before the history
// backlog because someone is looking at the card right now.
func (d *Daemon) expandWork() {
	client := &http.Client{Timeout: 60 * time.Second}
	for range 5 { // bounded per cycle
		req, err := http.NewRequest(http.MethodGet, d.cfg.Shipper.ServerURL+"/api/work/expand", nil)
		if err != nil {
			return
		}
		req.Header.Set("Authorization", "Bearer "+d.cfg.Shipper.Token)
		resp, err := client.Do(req)
		if err != nil {
			return
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return
		}
		var work struct {
			ID     int    `json:"id"`
			Prompt string `json:"prompt"`
		}
		err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&work)
		resp.Body.Close()
		if err != nil || work.ID == 0 || work.Prompt == "" {
			return
		}

		out, err := d.cfg.Expander.Complete(work.Prompt)
		if err != nil {
			var wait *aicli.ErrBudgetWait
			if errors.As(err, &wait) {
				log.Printf("expand work: budget spent, resumes %s", wait.Until.Format(time.RFC3339))
			} else {
				log.Printf("expand work %d: AI call failed: %v", work.ID, err)
			}
			return // unposted claims expire server-side and are re-served
		}
		text, err := aicli.ExtractText(out)
		if err != nil {
			log.Printf("expand work %d: %v", work.ID, err)
			return
		}
		body, _ := json.Marshal(map[string]string{"text": text})
		post, err := http.NewRequest(http.MethodPost,
			fmt.Sprintf("%s/api/work/expand/%d", d.cfg.Shipper.ServerURL, work.ID),
			bytes.NewReader(body))
		if err != nil {
			return
		}
		post.Header.Set("Content-Type", "application/json")
		post.Header.Set("Authorization", "Bearer "+d.cfg.Shipper.Token)
		postResp, err := client.Do(post)
		if err != nil {
			log.Printf("expand work %d: deliver failed: %v", work.ID, err)
			return
		}
		postResp.Body.Close()
		log.Printf("expand work %d: explained and delivered", work.ID)
	}
}

// reportStatus records whether this collector can serve an explicit
// explanation. Detection progress is wholly server-side and never waits.
func (d *Daemon) reportStatus() {
	body := map[string]any{"budget_used": 0, "budget_limit": 0}
	if d.cfg.Expander != nil {
		used, limit, resetAt := d.cfg.Expander.BudgetStatus()
		body["budget_used"] = used
		body["budget_limit"] = limit
		if used >= limit && !resetAt.IsZero() {
			body["paused_until"] = resetAt.UTC().Format(time.RFC3339)
		}
	}
	data, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, d.cfg.Shipper.ServerURL+"/api/status", bytes.NewReader(data))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+d.cfg.Shipper.Token)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("status heartbeat failed: %v", err)
		return
	}
	resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		log.Printf("status heartbeat failed: server returned %s", resp.Status)
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
	// Never tail our own explanation child sessions (local-explain mode
	// spawns headless AI sessions that write transcripts too) — tailing them
	// would recurse forever.
	if aicli.RecursionGuard(path) {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.tailers[path]; ok {
		return
	}
	var offset int64
	var existingSize int64
	if st, err := os.Stat(path); err == nil {
		existingSize = st.Size()
	}
	if saved, ok := d.offsets.get(path); ok {
		offset = saved
	} else if !fromHook && !d.cfg.BackfillExisting {
		offset = existingSize
	}
	d.tailers[path] = &tracked{
		tailer: tail.NewAt(path, offset),
		parser: parse.ForPath(path),
	}
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
	if time.Now().Before(d.retryUntil) {
		return // the server told us to preserve this history until its reset
	}
	d.mu.Lock()
	paths := make([]string, 0, len(d.tailers))
	for p := range d.tailers {
		paths = append(paths, p)
	}
	d.mu.Unlock()
	sort.Slice(paths, func(i, j int) bool {
		a, _ := os.Stat(paths[i])
		b, _ := os.Stat(paths[j])
		if a == nil || b == nil {
			return paths[i] < paths[j]
		}
		return a.ModTime().Before(b.ModTime())
	})

	dirty := false
	for _, path := range paths {
		d.mu.Lock()
		tr := d.tailers[path]
		d.mu.Unlock()

		lines, err := tr.tailer.Poll()
		if err != nil {
			log.Printf("poll %s: %v", path, err)
			continue
		}
		var msgs []parse.AgentMessage
		for _, line := range lines {
			if m, ok := tr.parser.ParseLine(line); ok {
				msgs = append(msgs, m)
			}
		}
		if len(msgs) > 0 {
			batch := d.cfg.Shipper.FromMessages(tr.parser.Tool(), msgs)
			if err := d.cfg.Shipper.SendBatch(batch); err != nil {
				d.deferRetry(err)
				log.Printf("ship failed, buffering %d message(s): %v", len(batch.Messages), err)
				queued := any(batch)
				var partial interface{ Remaining() []byte }
				if errors.As(err, &partial) {
					queued = json.RawMessage(partial.Remaining())
				}
				if qerr := d.queue.Push(queued); qerr != nil {
					log.Printf("buffer failed, %d message(s) LOST: %v", len(batch.Messages), qerr)
				}
			} else {
				log.Printf("shipped %d message(s) from %s", len(msgs), filepath.Base(path))
			}
		}
		if len(lines) > 0 {
			d.offsets.set(path, tr.tailer.Offset())
			dirty = true
		}
	}
	if dirty {
		if err := d.offsets.save(); err != nil {
			log.Printf("offsets save: %v", err)
		}
	}
}

func (d *Daemon) deferRetry(err error) {
	if until, ok := ship.RetryUntil(err); ok && until.After(d.retryUntil) {
		d.retryUntil = until
		log.Printf("history import paused until %s", until.UTC().Format(time.RFC3339))
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

func (s *offsetStore) reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m = map[string]int64{}
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

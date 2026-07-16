// Package tail reads complete new lines from an append-only file.
//
// It tracks a byte offset per file and keeps a remainder buffer so that a
// partially written line (agents stream, so appends land mid-line) is never
// consumed until its trailing newline arrives. Polling-based by design: it
// works everywhere, including NFS/Lustre where inotify is unreliable.
package tail

import (
	"bytes"
	"io"
	"os"
)

type Tailer struct {
	Path      string
	offset    int64
	remainder []byte
}

// New starts tailing at the beginning of the file (offset 0), so existing
// content is delivered on the first poll — wanted for both the walking
// skeleton and replaying sessions that started before the collector.
func New(path string) *Tailer {
	return &Tailer{Path: path}
}

// Poll returns all complete lines appended since the last call. A missing
// file is not an error (the session may not have started); truncation or
// rotation resets the offset.
func (t *Tailer) Poll() ([][]byte, error) {
	f, err := os.Open(t.Path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if st.Size() < t.offset {
		t.offset = 0
		t.remainder = nil
	}
	if st.Size() == t.offset {
		return nil, nil
	}

	if _, err := f.Seek(t.offset, io.SeekStart); err != nil {
		return nil, err
	}
	buf, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}
	t.offset += int64(len(buf))

	data := append(t.remainder, buf...)
	var lines [][]byte
	for {
		i := bytes.IndexByte(data, '\n')
		if i < 0 {
			break
		}
		line := bytes.TrimSuffix(data[:i], []byte("\r"))
		if len(bytes.TrimSpace(line)) > 0 {
			lines = append(lines, append([]byte(nil), line...))
		}
		data = data[i+1:]
	}
	t.remainder = append([]byte(nil), data...)
	return lines, nil
}

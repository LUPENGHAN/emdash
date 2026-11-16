package gateway

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
)

// The observer reads its own copy. Framing, compression, and parse failures never
// change the bytes delivered to the client or truncate the upstream response.
type usageBody struct {
	io.ReadCloser
	pipe     *io.PipeWriter
	done     chan struct{}
	finish   sync.Once
	complete func(bool)
	eof      bool
	trailers http.Header
}

func observeBody(body io.ReadCloser, headers, trailers http.Header, stream bool, alt string, record func([]byte, bool)) *usageBody {
	input, output := io.Pipe()
	b := &usageBody{ReadCloser: body, pipe: output, done: make(chan struct{}), trailers: trailers}
	var payload []byte
	var failed bool
	go func() {
		defer close(b.done)
		defer input.Close()
		var reader io.Reader = input
		switch strings.ToLower(strings.TrimSpace(headers.Get("Content-Encoding"))) {
		case "", "identity":
		case "gzip":
			decoded, err := gzip.NewReader(input)
			if err != nil {
				failed = true
				return
			}
			defer decoded.Close()
			reader = decoded
		case "deflate":
			decoded, err := zlib.NewReader(input)
			if err != nil {
				failed = true
				return
			}
			defer decoded.Close()
			reader = decoded
		default:
			return // Unknown encodings still pass through; usage remains unknown.
		}
		if stream {
			meter := streamMeter{}
			err := observeEvents(reader, &meter, alt)
			payload = meter.payload()
			failed = meter.failed || !meter.complete || err != nil
			return
		}
		data, err := io.ReadAll(io.LimitReader(reader, 32*1024*1024+1))
		if err != nil {
			failed = true
			return
		}
		if len(data) > 32*1024*1024 {
			return
		}
		payload = data
		if alt == "chat/completions" || alt == "messages" {
			meter := streamMeter{}
			meter.observe(data, alt)
			payload = meter.payload()
		}
	}()
	b.complete = func(interrupted bool) {
		b.finish.Do(func() {
			_ = output.Close()
			<-b.done
			record(payload, failed || interrupted)
		})
	}
	return b
}

func (b *usageBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if n > 0 {
		_, _ = b.pipe.Write(p[:n])
	}
	if err != nil {
		b.eof = errors.Is(err, io.EOF)
		b.complete(!b.eof)
	}
	return n, err
}

func (b *usageBody) Close() error {
	err := b.ReadCloser.Close()
	stripHeaders(b.trailers, false)
	b.complete(!b.eof)
	return err
}

func observeEvents(input io.Reader, meter *streamMeter, alt string) error {
	reader := bufio.NewReader(input)
	var line, data []byte
	var oversized, fragmented bool
	const maxEvent = 16 * 1024 * 1024
	dispatch := func() {
		if !oversized {
			meter.observe(data, alt)
		}
		data = nil
		oversized = false
	}
	for {
		fragment, err := reader.ReadSlice('\n')
		if len(line)+len(fragment) > maxEvent {
			oversized = true
			line = nil
		} else if !oversized {
			line = append(line, fragment...)
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			fragmented = true
			continue
		}
		// A blank line ends an event, even after an oversized data line.
		blank := !fragmented && len(bytes.TrimRight(fragment, "\r\n")) == 0 && len(line) <= 2
		fragmented = false
		if blank {
			dispatch()
		} else if !oversized && bytes.HasPrefix(line, []byte("data:")) {
			value := bytes.TrimRight(line[5:], "\r\n")
			value = bytes.TrimPrefix(value, []byte(" "))
			if len(data)+len(value)+1 > maxEvent {
				oversized = true
				data = nil
			} else {
				if len(data) > 0 {
					data = append(data, '\n')
				}
				data = append(data, value...)
			}
		}
		line = nil
		if err != nil {
			if len(data) > 0 {
				dispatch()
			}
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

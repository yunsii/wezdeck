package main

import (
	"errors"
	"io"
	"net"
	"os"
	"time"
)

func attach() error {
	path := socketPath()
	if path == "" {
		return errors.New("socket path is empty")
	}
	if err := ensureServe(); err != nil {
		note("ensure-failed", err)
		return err
	}
	note("dial", nil)
	conn, err := dial(path)
	if err != nil {
		return err
	}
	defer conn.Close()
	errCh := make(chan error, 2)
	go func() {
		_, err := io.Copy(conn, os.Stdin)
		errCh <- err
	}()
	go func() {
		_, err := io.Copy(os.Stdout, conn)
		errCh <- err
	}()
	return <-errCh
}

func dial(path string) (net.Conn, error) {
	var last error
	for attempt := 0; attempt < 20; attempt++ {
		conn, err := net.Dial("unix", path)
		if err == nil {
			return conn, nil
		}
		last = err
		time.Sleep(50 * time.Millisecond)
	}
	return nil, last
}

func copyFrames(dst io.Writer, src io.Reader) {
	for {
		body, err := readFrame(src)
		if err != nil {
			return
		}
		if err := writeFrame(dst, body); err != nil {
			return
		}
	}
}

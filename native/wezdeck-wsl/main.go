// wezdeck-wsl is the per-user Linux side of the Windows Runtime.
//
// `serve` listens on the Unix socket and answers framed JSON requests.
// `attach` dials that socket and copies length-prefixed frames between it
// and stdio, so one long-lived wsl.exe is enough for every later call.
package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"
)

func note(step string, err error) {
	path := socketPath()
	if path == "" {
		return
	}
	logPath := filepath.Join(filepath.Dir(path), "logs", "wsl-bridge.log")
	_ = os.MkdirAll(filepath.Dir(logPath), 0o755)
	file, openErr := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if openErr != nil {
		return
	}
	defer file.Close()
	fmt.Fprintf(file, "%s pid=%d err=%v\n", step, os.Getpid(), err)
}

func ensureServe() error {
	path := socketPath()
	note("ensure", nil)
	if path == "" {
		return nil
	}
	conn, dialErr := net.Dial("unix", path)
	note("probe", dialErr)
	if dialErr == nil {
		conn.Close()
		return nil
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		note("remove", err)
	}
	if os.Getenv("WEZDECK_WSL_FOREGROUND") == "1" {
		return nil
	}
	logPath := filepath.Join(filepath.Dir(path), "logs", "wsl-bridge.log")
	_ = os.MkdirAll(filepath.Dir(logPath), 0o755)
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	devNull, err := os.Open("/dev/null")
	if err != nil {
		return err
	}
	proc, err := os.StartProcess(os.Args[0], []string{os.Args[0], "serve"}, &os.ProcAttr{
		Dir:   "/",
		Env:   append(os.Environ(), "WEZDECK_WSL_FOREGROUND=1"),
		Files: []*os.File{devNull, logFile, logFile},
		Sys:   &syscall.SysProcAttr{Setsid: true},
	})
	if err != nil {
		return err
	}
	_ = proc.Release()
	return nil
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: wezdeck-wsl serve|attach")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = serve()
	case "attach":
		err = attach()
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "wezdeck-wsl:", err)
		os.Exit(1)
	}
}

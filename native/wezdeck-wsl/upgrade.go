package main

import (
	"errors"
	"net"
	"os"
	"strings"
	"time"
)

// binaryStamp identifies the on-disk executable this process was started from.
type binaryStamp struct {
	size    int64
	modTime time.Time
}

func stampOf(path string) (binaryStamp, error) {
	info, err := os.Stat(path)
	if err != nil {
		return binaryStamp{}, err
	}
	return binaryStamp{size: info.Size(), modTime: info.ModTime()}, nil
}

// replaced reports whether the executable at path differs from the stamp taken
// at start (sync's build.sh rewrites native/wezdeck-wsl/bin/wezdeck-wsl), or
// /proc/self/exe now points at a deleted inode.
func replaced(path string, start binaryStamp, selfExe string) bool {
	if strings.HasSuffix(selfExe, " (deleted)") {
		return true
	}
	now, err := stampOf(path)
	if err != nil {
		return false // transient (mid-write); check again next tick
	}
	return now != start
}

// exitWhenReplaced closes the listener once a newer binary is on disk so the
// next `attach` (ensureServe) starts the new build. Without this a long-lived
// serve keeps answering with old dispatch tables after every sync — new
// bridge actions then look like unknown_action. The live attach connection
// drops once; WslBridge reconnects on the following call.
func exitWhenReplaced(listener net.Listener) {
	path, err := os.Executable()
	if err != nil {
		return
	}
	start, err := stampOf(path)
	if err != nil {
		return
	}
	for range time.Tick(30 * time.Second) {
		self, _ := os.Readlink("/proc/self/exe")
		if replaced(path, start, self) {
			note("exit: binary replaced", errors.New(path))
			_ = listener.Close()
			return
		}
	}
}

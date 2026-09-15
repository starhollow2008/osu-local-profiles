//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// hideConsole has nothing to hide on macOS and Linux: the app is started with no terminal.
func hideConsole(*exec.Cmd) {}

// startDetached starts the new launcher after an update in a session of its own, so it outlives
// this one.
func startDetached(exe, dir string) error {
	cmd := exec.Command(exe)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// instanceLock is an flock on data/launcher.lock, which the system releases when the process
// ends, however it ends. data/ is never touched by an update, so the lock outlives a swap.
type instanceLock struct{ file *os.File }

func acquireLock(root string) (*instanceLock, bool) {
	dir := filepath.Join(root, "data")
	_ = os.MkdirAll(dir, 0o755)
	file, err := os.OpenFile(filepath.Join(dir, "launcher.lock"), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		// Cannot tell; carry on as the only one, and the port settles any collision.
		return &instanceLock{}, true
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		return nil, false
	}
	return &instanceLock{file: file}, true
}

func (l *instanceLock) release() {
	if l != nil && l.file != nil {
		_ = l.file.Close()
		l.file = nil
	}
}

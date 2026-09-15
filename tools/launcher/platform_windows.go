//go:build windows

package main

import (
	"hash/fnv"
	"os/exec"
	"strconv"
	"strings"
	"syscall"

	"fyne.io/systray"
	"golang.org/x/sys/windows"
)

// hideConsole starts the app with a console that has no window. Its own children -- the pp
// helper, the browser opener -- share that console, so none of them opens a window either.
func hideConsole(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}

// startDetached starts the new launcher after an update, owing nothing to this process.
func startDetached(exe, dir string) error {
	cmd := exec.Command(exe)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func processAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	var code uint32
	if windows.GetExitCodeProcess(h, &code) != nil {
		return false
	}
	const stillActive = 259
	return code == stillActive
}

// openPath opens a page or a file with whatever the user set to open it. ShellExecute rather than
// `cmd /c start`, so no command line is parsed and there is nothing to quote.
func openPath(target string) error {
	verb, _ := windows.UTF16PtrFromString("open")
	file, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	return windows.ShellExecute(0, verb, file, nil, nil, windows.SW_SHOWNORMAL)
}

func messageBox(title, message string, icon uint32) {
	t, _ := windows.UTF16PtrFromString(title)
	m, _ := windows.UTF16PtrFromString(message)
	_, _ = windows.MessageBox(0, m, t, windows.MB_OK|icon|windows.MB_SETFOREGROUND)
}

func alert(title, message string)  { messageBox(title, message, windows.MB_ICONERROR) }
func notice(title, message string) { messageBox(title, message, windows.MB_ICONINFORMATION) }

func trayAvailable() bool { return true }
func setTrayIcon()        { systray.SetIcon(trayICO) }
func trayReadyPlatform()  {}

func releaseQuarantine(string)       {}
func leaveTranslocation(string) bool { return false }

// instanceLock is a named mutex per install folder: the system drops it when the process ends,
// however it ends, so a crash never leaves a stale lock behind.
type instanceLock struct{ handle windows.Handle }

func acquireLock(root string) (*instanceLock, bool) {
	h := fnv.New64a()
	_, _ = h.Write([]byte(strings.ToLower(root)))
	name, _ := windows.UTF16PtrFromString(`Local\osu-local-profiles-` + strconv.FormatUint(h.Sum64(), 16))
	handle, err := windows.CreateMutex(nil, false, name)
	if err == windows.ERROR_ALREADY_EXISTS {
		_ = windows.CloseHandle(handle)
		return nil, false
	}
	if err != nil {
		// Cannot tell; carry on as the only one, and the port settles any collision.
		return &instanceLock{}, true
	}
	return &instanceLock{handle: handle}, true
}

func (l *instanceLock) release() {
	if l != nil && l.handle != 0 {
		_ = windows.CloseHandle(l.handle)
		l.handle = 0
	}
}

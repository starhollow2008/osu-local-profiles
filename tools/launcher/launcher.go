package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// launcher runs the app and follows it: up, tracking, stopping, updating, or failed.
type launcher struct {
	exe, root string
	port      int
	lock      *instanceLock
	// No dialogs. Set by OSU_LOCAL_PROFILES_NO_TRAY, which is also how the tests run it.
	quiet bool

	mu       sync.Mutex
	state    appState
	tracking bool
	stdin    io.WriteCloser
	proc     *os.Process
	// Which start this is, so a poller or a waiter left over from the last one does nothing.
	run      int
	quitting bool
	exitCode int

	// The tray's redraw; nil with no tray.
	changed func(appState, bool)
	// How the launcher goes away: systray.Quit, or ending runWithoutTray.
	finished func()
	once     sync.Once
}

func pageURL(port int) string { return "http://localhost:" + strconv.Itoa(port) }

var client = &http.Client{Timeout: 2 * time.Second}

// probe asks /api/app whether this app is answering on the port. 127.0.0.1 rather than
// localhost: the app listens on both families, and it skips resolving a name on every poll.
func probe(port int) (appInfo, bool) {
	r, err := client.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/api/app")
	if err != nil {
		return appInfo{}, false
	}
	defer r.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil || r.StatusCode != http.StatusOK {
		return appInfo{}, false
	}
	return parseAppInfo(raw)
}

func (l *launcher) say(title, message string) {
	if l.quiet {
		fmt.Fprintf(os.Stderr, "%s: %s\n", title, message)
		return
	}
	alert(title, message)
}

// start runs the app: the runtime beside the launcher, from the app's own folder, with its output
// in data/logs/app.log and the write end of its stdin held here. Closing that is how Quit asks it
// to stop, and the system closes it if the launcher dies, so the app never outlives its icon.
func (l *launcher) start() error {
	l.mu.Lock()
	if l.proc != nil {
		l.mu.Unlock()
		return nil
	}
	l.mu.Unlock()

	current, previous := logFiles(l.root)
	if err := os.MkdirAll(filepath.Dir(current), 0o755); err != nil {
		return err
	}
	_ = os.Rename(current, previous)
	logFile, err := os.Create(current)
	if err != nil {
		return err
	}

	cmd := exec.Command(filepath.Join(l.root, runtimeName(runtime.GOOS)), filepath.Join("src", "main.ts"))
	cmd.Dir = l.root
	cmd.Env = append(os.Environ(), launcherEnv+"="+launcherValue)
	cmd.Stdout, cmd.Stderr = logFile, logFile
	stdin, err := cmd.StdinPipe()
	if err != nil {
		logFile.Close()
		return err
	}
	hideConsole(cmd)
	if err := cmd.Start(); err != nil {
		logFile.Close()
		return err
	}

	l.mu.Lock()
	l.run++
	run := l.run
	l.stdin, l.proc, l.quitting = stdin, cmd.Process, false
	l.state = stateStarting
	redraw := l.changed
	l.mu.Unlock()
	if redraw != nil {
		redraw(stateStarting, false)
	}

	go l.poll(run)
	go func() {
		err := cmd.Wait()
		logFile.Close()
		code := 0
		if err != nil {
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				code = exit.ExitCode()
			} else {
				code = -1
			}
		}
		l.exited(run, code)
	}()
	return nil
}

// move changes state only while this is still the current start and the state is one `from`
// allows, so a late poll can never undo a stop or a failure.
func (l *launcher) move(run int, from func(appState) bool, to appState, tracking bool) {
	l.mu.Lock()
	if l.run != run || !from(l.state) || (l.state == to && l.tracking == tracking) {
		l.mu.Unlock()
		return
	}
	l.state, l.tracking = to, tracking
	redraw := l.changed
	l.mu.Unlock()
	if redraw != nil {
		redraw(to, tracking)
	}
}

func (l *launcher) set(to appState) {
	l.mu.Lock()
	run := l.run
	l.mu.Unlock()
	l.move(run, func(appState) bool { return true }, to, false)
}

func live(s appState) bool { return s == stateStarting || s == stateRunning }

// poll follows the app while it is up: every second until it answers, then every few seconds
// for whether tracking is paused, which the page can change.
func (l *launcher) poll(run int) {
	for {
		l.mu.Lock()
		current := l.run == run && live(l.state)
		l.mu.Unlock()
		if !current {
			return
		}
		wait := time.Second
		if info, ok := probe(l.port); ok {
			l.move(run, live, stateRunning, info.Tracking)
			wait = 5 * time.Second
		}
		time.Sleep(wait)
	}
}

func (l *launcher) exited(run, code int) {
	l.mu.Lock()
	if run != l.run {
		l.mu.Unlock()
		return
	}
	quitting := l.quitting
	l.stdin, l.proc, l.exitCode = nil, nil, code
	l.mu.Unlock()

	switch {
	case afterExit(code) == actionUpdate:
		l.set(stateUpdating)
		l.relaunchAfterSwap()
	case quitting || afterExit(code) == actionQuit:
		l.finish()
	default:
		l.set(stateFailed)
		current, _ := logFiles(l.root)
		raw, _ := os.ReadFile(current)
		why := lastLines(string(raw), 12)
		if l.changed == nil {
			// Nothing stays on screen without a tray, so say why and go.
			fmt.Fprintf(os.Stderr, "osu! local profiles stopped (exit %d):\n%s\n", code, why)
			if !l.quiet {
				alert("osu! local profiles stopped", why+"\n\nThe whole log is in "+current)
			}
			l.finish()
			return
		}
		// The icon stays, offering Start again and the log.
		go alert("osu! local profiles stopped", why+"\n\nThe whole log is in "+current+
			"\n\nStart it again from its icon once that is fixed.")
	}
}

// relaunchAfterSwap is the launcher's half of an update. The app has handed the swap to a
// detached process and exited 75; that process's pid is in data/update/swapper.pid, and data/
// is the one place the swap does not move. Once it is done, the launcher now at this path -- the
// new release's -- is started, and this one goes. On Windows the running launcher can be renamed
// aside by the swap but not replaced, which is why it is a new process and not this one.
func (l *launcher) relaunchAfterSwap() {
	raw, _ := os.ReadFile(filepath.Join(l.root, "data", "update", swapperPidFile))
	pid, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
	for waited := 0; pid > 0 && processAlive(pid) && waited < 600; waited++ {
		time.Sleep(time.Second)
	}
	// Released first: the new launcher takes it, and would otherwise think this one still runs.
	l.lock.release()
	if err := startDetached(l.exe, l.root); err != nil {
		l.say("osu! local profiles was updated",
			"It could not start again by itself ("+err.Error()+"). Start it again from its folder.")
	}
	l.finish()
}

// quit asks the app to stop by closing its stdin, and stops it outright if it has not in 15s.
func (l *launcher) quit() {
	l.mu.Lock()
	stdin, proc, run := l.stdin, l.proc, l.run
	if proc == nil {
		l.mu.Unlock()
		l.finish()
		return
	}
	l.quitting = true
	l.mu.Unlock()
	l.move(run, func(appState) bool { return true }, stateStopping, false)
	if stdin != nil {
		_ = stdin.Close()
	}
	go func() {
		time.Sleep(15 * time.Second)
		l.mu.Lock()
		still := l.run == run && l.proc != nil
		l.mu.Unlock()
		if still {
			_ = proc.Kill()
		}
	}()
}

func (l *launcher) finish() {
	l.once.Do(func() {
		l.lock.release()
		if l.finished != nil {
			l.finished()
		}
	})
}

// runWithoutTray supervises the app with no icon: a desktop with no tray, or the tests. Ctrl+C
// or a signal stops it as Quit would.
func (l *launcher) runWithoutTray() int {
	done := make(chan struct{})
	l.finished = func() { close(done) }
	if err := l.start(); err != nil {
		l.say("osu! local profiles cannot start", err.Error())
		return 1
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-signals
		l.quit()
	}()
	<-done

	l.mu.Lock()
	defer l.mu.Unlock()
	if l.state == stateFailed {
		if l.exitCode > 0 {
			return l.exitCode
		}
		return 1
	}
	return 0
}

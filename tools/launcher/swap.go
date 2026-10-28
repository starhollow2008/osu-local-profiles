package main

// The swap: installing a staged update over the app's own folder. scripts/apply-update.mjs does
// this with the new release's Node runtime; a release without Node (roadmap 5.82) is swapped in
// by its own launcher instead, started from the staged folder with --apply-update. Both keep
// the same rules, log and messages (docs/architecture.md, "Updater: rewrites the app's own
// folder"):
//
//   - data/ is never touched.
//   - Nothing is deleted until the replacement is in place: the outgoing files are moved into
//     .rollback-<stamp>/, which goes once the new build is on disk and its package.json reads
//     back.
//   - The app comes back somewhere it can be stopped from, or not at all (relaunchPlan).

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// errAppStillRunning ends a swap that never started: the app did not exit, so nothing was moved.
var errAppStillRunning = errors.New("the app did not exit")

// swapper runs one swap. Everything that touches the clock or other processes is a field, so
// the tests can run a real swap in a temporary folder without waiting or starting anything.
type swapper struct {
	opts   swapOptions
	goos   string
	alive  func(pid int) bool
	poll   time.Duration
	settle time.Duration
	start  func(command string, args []string, dir string) error
	getenv func(string) string
	now    func() time.Time
	lines  []string
}

func newSwapper(opts swapOptions) *swapper {
	return &swapper{
		opts:  opts,
		goos:  runtime.GOOS,
		alive: processAlive,
		poll:  500 * time.Millisecond,
		// Windows can hold a handle open for a moment after the process is reported gone.
		settle: 1500 * time.Millisecond,
		start:  startDetachedCommand,
		getenv: os.Getenv,
		now:    time.Now,
	}
}

// say records a line for data/update.log, the only account of what happened: this process has
// no console anyone sees.
func (s *swapper) say(line string) {
	s.lines = append(s.lines, logStamp(s.now())+"  "+line)
	fmt.Println(line)
}

func (s *swapper) writeLog(outcome string) {
	data := filepath.Join(s.opts.install, "data")
	if err := os.MkdirAll(data, 0o755); err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(data, "update.log"), []byte(outcome+"\n\n"+strings.Join(s.lines, "\n")+"\n"), 0o644)
}

// run swaps, and answers with the process's exit status.
func (s *swapper) run() int {
	err := s.swap()
	if err == nil {
		return 0
	}
	if errors.Is(err, errAppStillRunning) {
		return 1
	}
	s.say("FAILED: " + err.Error())
	s.say("The previous version is in the .rollback- folder beside the app; move its contents")
	s.say("back into place to undo this. data/ was not touched.")
	s.writeLog("FAILED: " + err.Error())
	return 1
}

func (s *swapper) swap() error {
	install, staged := s.opts.install, s.opts.staged

	s.say(fmt.Sprintf("waiting for the app (pid %d) to exit", s.opts.pid))
	for i := 0; i < 120 && s.alive(s.opts.pid); i++ {
		time.Sleep(s.poll)
	}
	if s.alive(s.opts.pid) {
		s.say("it is still running after 60s; not touching anything")
		s.writeLog("ABORTED: the app did not exit")
		return errAppStillRunning
	}
	time.Sleep(s.settle)

	rollback := filepath.Join(install, ".rollback-"+rollbackStamp(s.now()))
	if err := os.MkdirAll(rollback, 0o755); err != nil {
		return err
	}
	s.say("rollback copy: " + rollback)

	present, err := names(install)
	if err != nil {
		return err
	}
	outgoing := replaceable(present)
	s.say(fmt.Sprintf("moving %d entries aside", len(outgoing)))
	for _, name := range outgoing {
		if err := moveEntry(filepath.Join(install, name), filepath.Join(rollback, name)); err != nil {
			return err
		}
	}

	arriving, err := names(staged)
	if err != nil {
		return err
	}
	// A release never carries data/; were one to, it would still not be copied over the user's.
	native := exists(filepath.Join(staged, nativeApp(s.goos)))
	entries := incoming(arriving, native, s.goos)
	s.say(fmt.Sprintf("copying %d entries in", len(entries)))
	for _, name := range entries {
		// Copied, not moved: the staged folder is under data/update, and this process is running
		// from it.
		if err := copyTree(filepath.Join(staged, name), filepath.Join(install, name)); err != nil {
			return err
		}
	}

	version, err := installedVersion(install)
	if err != nil {
		return err
	}
	s.say("installed " + version)

	// The rollback has done its job: the new build is on disk and reads back. A failure to delete
	// is not a failure of the update; the app sweeps it at its next start (pruneUpdateLeftovers).
	if err := os.RemoveAll(rollback); err != nil {
		s.say("could not remove the rollback copy (" + err.Error() + "); it will go on next start")
	} else {
		s.say("removed the rollback copy; the update is complete")
	}

	if s.opts.archive != "" {
		_ = os.Remove(s.opts.archive)
	}

	s.relaunch()
	s.writeLog("OK: updated to " + version)
	return nil
}

func (s *swapper) relaunch() {
	step := relaunchPlan(s.goos, s.opts.install, s.opts.launcherRestarts, s.opts.noRelaunch, exists, s.getenv)
	if step.skip != "" {
		s.say("not relaunching: " + step.skip)
		return
	}
	s.say("relaunching: " + step.command + " " + strings.Join(step.args, " "))
	if err := s.start(step.command, step.args, s.opts.install); err != nil {
		s.say("the relaunch failed (" + err.Error() + "); start the app yourself")
	}
}

func names(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out, nil
}

func installedVersion(install string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(install, "package.json"))
	if err != nil {
		return "", err
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		return "", fmt.Errorf("the installed package.json is unreadable: %w", err)
	}
	if pkg.Version == "" {
		return "", errors.New("the installed package.json names no version")
	}
	return pkg.Version, nil
}

// moveEntry renames, falling back to copy and remove. Rename is instant within a volume, but
// fails across one, and can fail on Windows while a file is still held for a moment.
func moveEntry(from, to string) error {
	if err := os.Rename(from, to); err == nil {
		return nil
	}
	if err := copyTree(from, to); err != nil {
		return err
	}
	return os.RemoveAll(from)
}

// copyTree copies a file, a folder or a link, keeping permission bits so the launcher and the
// app stay executable on macOS and Linux.
func copyTree(from, to string) error {
	info, err := os.Lstat(from)
	if err != nil {
		return err
	}
	switch {
	case info.Mode()&os.ModeSymlink != 0:
		target, err := os.Readlink(from)
		if err != nil {
			return err
		}
		return os.Symlink(target, to)
	case info.IsDir():
		if err := os.MkdirAll(to, info.Mode().Perm()|0o700); err != nil {
			return err
		}
		entries, err := os.ReadDir(from)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := copyTree(filepath.Join(from, e.Name()), filepath.Join(to, e.Name())); err != nil {
				return err
			}
		}
		return nil
	default:
		src, err := os.Open(from)
		if err != nil {
			return err
		}
		defer src.Close()
		dst, err := os.OpenFile(to, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode().Perm())
		if err != nil {
			return err
		}
		if _, err := io.Copy(dst, src); err != nil {
			dst.Close()
			return err
		}
		return dst.Close()
	}
}

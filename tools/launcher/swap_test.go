package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestSwapArgumentsInEitherForm(t *testing.T) {
	want := swapOptions{install: "/opt/olp", staged: "/opt/olp/data/update/2.0.0", pid: 42, archive: "a.zip", launcherRestarts: true, noRelaunch: true}
	rest := []string{"--install", "/opt/olp", "--staged", "/opt/olp/data/update/2.0.0", "--pid", "42", "--archive", "a.zip", "--launcher-restarts", "--no-relaunch"}
	for _, first := range []string{swapArg, "scripts/apply-update.mjs", `C:\olp\data\update\2.0.0\scripts\apply-update.mjs`} {
		got, isSwap, err := parseSwapArgs(append([]string{first}, rest...))
		if !isSwap || err != nil || got != want {
			t.Errorf("%s: got %+v %v %v", first, got, isSwap, err)
		}
	}
}

func TestOnlyASwapRequestIsTakenForOne(t *testing.T) {
	for _, args := range [][]string{nil, {"--version"}, {"--startup"}, {"apply-update.mjs.bak", "--install", "x"}} {
		if _, isSwap, _ := parseSwapArgs(args); isSwap {
			t.Errorf("%v taken for a swap", args)
		}
	}
	for _, args := range [][]string{{swapArg}, {swapArg, "--install", "/x", "--staged", "/y"}, {swapArg, "--install", "/x", "--staged", "/y", "--pid", "nope"}} {
		if _, isSwap, err := parseSwapArgs(args); !isSwap || err == nil {
			t.Errorf("%v: incomplete request not refused", args)
		}
	}
}

// relaunchPlan's cases are test/relaunch.test.ts's, so the two swappers decide alike.
func TestRelaunchPlan(t *testing.T) {
	all := func(string) bool { return true }
	none := func(string) bool { return false }
	env := func(vars map[string]string) func(string) string { return func(k string) string { return vars[k] } }
	desktop := env(map[string]string{"DISPLAY": ":0"})

	for _, goos := range []string{"windows", "darwin", "linux"} {
		if s := relaunchPlan(goos, "/opt/olp", true, false, all, desktop); s.skip == "" {
			t.Errorf("%s: a second copy would race the launcher's for the port", goos)
		}
		for _, restarts := range []bool{true, false} {
			if s := relaunchPlan(goos, "/opt/olp", restarts, true, all, desktop); s.skip == "" {
				t.Errorf("%s: relaunched after a quit", goos)
			}
		}
		if s := relaunchPlan(goos, "/opt/olp", false, false, none, desktop); !strings.Contains(s.skip, "start the app yourself") {
			t.Errorf("%s: with no launcher the runtime must never be started directly: %+v", goos, s)
		}
	}

	exe := `C:\Program Files (x86)\olp\osu! local profiles.exe`
	if s := relaunchPlan("windows", `C:\Program Files (x86)\olp`, false, false, func(p string) bool { return p == exe }, env(nil)); s.command != exe || len(s.args) != 0 {
		t.Errorf("windows: %+v", s)
	}
	bundle := "/Applications/olp/osu! local profiles.app"
	if s := relaunchPlan("darwin", "/Applications/olp", false, false, func(p string) bool { return p == bundle }, env(nil)); s.command != "open" || strings.Join(s.args, "|") != "-n|"+bundle {
		t.Errorf("darwin: %+v", s)
	}
	linux := "/home/me/olp/osu-local-profiles"
	has := func(p string) bool { return p == linux }
	if s := relaunchPlan("linux", "/home/me/olp", false, false, has, env(map[string]string{"WAYLAND_DISPLAY": "wayland-0"})); s.command != linux {
		t.Errorf("linux with a desktop: %+v", s)
	}
	if s := relaunchPlan("linux", "/home/me/olp", false, false, has, env(nil)); !strings.Contains(s.skip, "./start.sh") {
		t.Errorf("linux with no desktop started an invisible copy: %+v", s)
	}
}

func TestStampsAreJavaScriptsISOTime(t *testing.T) {
	at := time.Date(2026, 10, 28, 9, 5, 7, 123_000_000, time.UTC)
	if got := logStamp(at); got != "2026-10-28T09:05:07.123Z" {
		t.Errorf("log stamp %q", got)
	}
	if got := rollbackStamp(at); got != "2026-10-28T09-05-07" {
		t.Errorf("rollback stamp %q", got)
	}
}

/* ------------------------------------------------------------------- a real swap */

func write(t *testing.T, file, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(file string) string {
	raw, err := os.ReadFile(file)
	if err != nil {
		return "(missing)"
	}
	return string(raw)
}

// installed lays out a Node release with a waiting C# one staged in data/update, as the app
// leaves them before handing over.
func installed(t *testing.T) (install, staged string) {
	install = t.TempDir()
	write(t, filepath.Join(install, "package.json"), `{"version":"1.40.0"}`)
	write(t, filepath.Join(install, runtimeName(runtime.GOOS)), "node")
	write(t, filepath.Join(install, "src", "main.ts"), "old app")
	write(t, filepath.Join(install, "web", "index.html"), "old page")
	write(t, filepath.Join(install, launcherName(runtime.GOOS)), "old launcher")
	write(t, filepath.Join(install, "data", "profiles.db"), "the player's scores")
	write(t, filepath.Join(install, "data", "config.json"), `{"port":7272}`)

	staged = filepath.Join(install, "data", "update", "2.0.0")
	write(t, filepath.Join(staged, "package.json"), `{"version":"2.0.0"}`)
	write(t, filepath.Join(staged, nativeApp(runtime.GOOS)), "new app")
	write(t, filepath.Join(staged, "web", "index.html"), "new page")
	write(t, filepath.Join(staged, launcherName(runtime.GOOS)), "new launcher")
	return install, staged
}

type started struct {
	command string
	args    []string
}

func testSwapper(opts swapOptions, alive bool) (*swapper, *[]started) {
	var starts []started
	s := newSwapper(opts)
	s.alive = func(int) bool { return alive }
	s.poll, s.settle = 0, 0
	s.getenv = func(string) string { return ":0" }
	s.start = func(command string, args []string, dir string) error {
		starts = append(starts, started{command, args})
		return nil
	}
	return s, &starts
}

func TestASwapReplacesEverythingButData(t *testing.T) {
	install, staged := installed(t)
	s, starts := testSwapper(swapOptions{install: install, staged: staged, pid: 1}, false)
	if code := s.run(); code != 0 {
		t.Fatalf("exit %d\n%s", code, strings.Join(s.lines, "\n"))
	}

	// The old build is gone, the new one is in place, and the player's data is as it was.
	for _, gone := range []string{runtimeName(runtime.GOOS), "src"} {
		if _, err := os.Stat(filepath.Join(install, gone)); err == nil {
			t.Errorf("%s is still there", gone)
		}
	}
	if got := read(filepath.Join(install, "web", "index.html")); got != "new page" {
		t.Errorf("web: %q", got)
	}
	if got := read(filepath.Join(install, nativeApp(runtime.GOOS))); got != "new app" {
		t.Errorf("app: %q", got)
	}
	if got := read(filepath.Join(install, "data", "profiles.db")); got != "the player's scores" {
		t.Errorf("data was touched: %q", got)
	}
	matches, _ := filepath.Glob(filepath.Join(install, ".rollback-*"))
	if len(matches) != 0 {
		t.Errorf("rollback left behind: %v", matches)
	}

	// The log starts as updatedToFromLog in src/update/notes.ts reads it.
	log := read(filepath.Join(install, "data", "update.log"))
	if !strings.HasPrefix(log, "OK: updated to 2.0.0\n\n") || !strings.Contains(log, "removed the rollback copy; the update is complete") {
		t.Errorf("log:\n%s", log)
	}
	if len(*starts) != 1 {
		t.Errorf("relaunched %d times: %+v", len(*starts), *starts)
	}
}

func TestASwapAtQuitStartsNothing(t *testing.T) {
	install, staged := installed(t)
	s, starts := testSwapper(swapOptions{install: install, staged: staged, pid: 1, noRelaunch: true}, false)
	if code := s.run(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if len(*starts) != 0 {
		t.Errorf("relaunched after a quit: %+v", *starts)
	}
	if !strings.Contains(read(filepath.Join(install, "data", "update.log")), "not relaunching: installed as the app was quit") {
		t.Error("the log does not say why nothing was started")
	}
}

func TestAnAppThatNeverExitsIsLeftAlone(t *testing.T) {
	install, staged := installed(t)
	s, _ := testSwapper(swapOptions{install: install, staged: staged, pid: 1}, true)
	if code := s.run(); code != 1 {
		t.Fatalf("exit %d", code)
	}
	if got := read(filepath.Join(install, "src", "main.ts")); got != "old app" {
		t.Errorf("touched while the app ran: %q", got)
	}
	if log := read(filepath.Join(install, "data", "update.log")); !strings.HasPrefix(log, "ABORTED: the app did not exit") {
		t.Errorf("log:\n%s", log)
	}
}

func TestAFailedSwapKeepsTheOldBuildAndSaysWhere(t *testing.T) {
	install, staged := installed(t)
	if err := os.Remove(filepath.Join(staged, "package.json")); err != nil {
		t.Fatal(err)
	}
	s, starts := testSwapper(swapOptions{install: install, staged: staged, pid: 1}, false)
	if code := s.run(); code != 1 {
		t.Fatalf("exit %d", code)
	}
	matches, _ := filepath.Glob(filepath.Join(install, ".rollback-*", "src", "main.ts"))
	if len(matches) != 1 || read(matches[0]) != "old app" {
		t.Errorf("the old build is not in the rollback: %v", matches)
	}
	if log := read(filepath.Join(install, "data", "update.log")); !strings.HasPrefix(log, "FAILED: ") || !strings.Contains(log, "data/ was not touched") {
		t.Errorf("log:\n%s", log)
	}
	if len(*starts) != 0 {
		t.Error("a failed swap relaunched the app")
	}
}

func TestDataInAReleaseIsNeverCopiedOverThePlayers(t *testing.T) {
	install, staged := installed(t)
	write(t, filepath.Join(staged, "data", "profiles.db"), "not the player's")
	s, _ := testSwapper(swapOptions{install: install, staged: staged, pid: 1}, false)
	if code := s.run(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if got := read(filepath.Join(install, "data", "profiles.db")); got != "the player's scores" {
		t.Errorf("data overwritten: %q", got)
	}
}

func TestCopiesKeepTheExecuteBit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no execute bit")
	}
	dir := t.TempDir()
	write(t, filepath.Join(dir, "from", "tool"), "#!/bin/sh\n")
	if err := os.Chmod(filepath.Join(dir, "from", "tool"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := copyTree(filepath.Join(dir, "from"), filepath.Join(dir, "to")); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, "to", "tool"))
	if err != nil || info.Mode().Perm()&0o111 == 0 {
		t.Errorf("execute bit lost: %v %v", info, err)
	}
}

func TestTheStandInsOfAReleaseWithoutNodeStayOutOfTheInstall(t *testing.T) {
	names := []string{"app", "web", "package.json", "node.exe", "node", "src", "scripts", "data", ".rollback-x", launcherName("windows")}
	if got := strings.Join(incoming(names, true, "windows"), ","); got != "app,web,package.json,node,osu! local profiles.exe" {
		t.Errorf("windows: %s", got)
	}
	if got := strings.Join(incoming(names, true, "linux"), ","); got != "app,web,package.json,node.exe,osu! local profiles.exe" {
		t.Errorf("linux: %s", got)
	}
	// A Node release keeps all of them: they are the app.
	if got := strings.Join(incoming(names, false, "windows"), ","); got != "app,web,package.json,node.exe,node,src,scripts,osu! local profiles.exe" {
		t.Errorf("node release: %s", got)
	}

	install, staged := installed(t)
	write(t, filepath.Join(staged, runtimeName(runtime.GOOS)), "the launcher, standing in for the runtime")
	write(t, filepath.Join(staged, "scripts", "apply-update.mjs"), "placeholder")
	write(t, filepath.Join(staged, "src", "main.ts"), "placeholder")
	s, _ := testSwapper(swapOptions{install: install, staged: staged, pid: 1}, false)
	if code := s.run(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	for _, gone := range []string{runtimeName(runtime.GOOS), "src", "scripts"} {
		if _, err := os.Stat(filepath.Join(install, gone)); err == nil {
			t.Errorf("stand-in %s was installed", gone)
		}
	}
}

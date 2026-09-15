package main

import (
	"strings"
	"testing"
)

// The app is the folder the launcher sits in, and on macOS the folder its .app bundle sits in.
// Wrong, and the app finds no data/ and starts from nothing -- the failure the old launchers'
// `cd` existed to prevent.
func TestAppRoot(t *testing.T) {
	cases := []struct{ goos, exe, want string }{
		{"windows", `C:\Program Files (x86)\olp\osu! local profiles.exe`, `C:\Program Files (x86)\olp`},
		{"linux", "/home/me/olp/osu-local-profiles", "/home/me/olp"},
		{"darwin", "/Users/me/olp/osu! local profiles.app/Contents/MacOS/osu-local-profiles", "/Users/me/olp"},
		// Not inside a bundle (a development build): its own folder, as elsewhere.
		{"darwin", "/Users/me/olp/tools/launcher/bin/osu-local-profiles", "/Users/me/olp/tools/launcher/bin"},
	}
	for _, c := range cases {
		if got := appRoot(c.exe, c.goos); got != c.want {
			t.Errorf("%s %q: got %q, want %q", c.goos, c.exe, got, c.want)
		}
	}
}

func TestMissingFilesNamesTheRuntimeFirst(t *testing.T) {
	none := func(string) bool { return false }
	if got := missingFiles(`C:\olp`, "windows", none); strings.Join(got, ",") != `node.exe,src\main.ts` {
		t.Errorf("windows: %v", got)
	}
	onlySrc := func(p string) bool { return p == "/opt/olp/src/main.ts" }
	if got := missingFiles("/opt/olp", "linux", onlySrc); strings.Join(got, ",") != "node" {
		t.Errorf("linux: %v", got)
	}
	all := func(string) bool { return true }
	if got := missingFiles("/opt/olp", "darwin", all); len(got) != 0 {
		t.Errorf("complete folder reported %v", got)
	}
}

func TestConfigPortFallsBackToTheAppsDefault(t *testing.T) {
	cases := map[string]int{
		`{"port": 8080}`: 8080,
		`{"port": 0}`:    defaultPort,
		`{"port": 70000}`: defaultPort,
		`{}`:             defaultPort,
		`not json`:       defaultPort,
		``:               defaultPort,
	}
	for raw, want := range cases {
		if got := configPort([]byte(raw)); got != want {
			t.Errorf("%q: got %d, want %d", raw, got, want)
		}
	}
}

// Another program on the port must never be taken for the app: its page would be opened, and
// a second start would give up on starting at all.
func TestParseAppInfoOnlyRecognisesTheApp(t *testing.T) {
	info, ok := parseAppInfo([]byte(`{"app":"osu-local-profiles","version":"1.17.0","tracking":true}`))
	if !ok || info.Version != "1.17.0" || !info.Tracking {
		t.Errorf("the app itself: %+v %v", info, ok)
	}
	for _, raw := range []string{`{"app":"something-else"}`, `<html>`, ``} {
		if _, ok := parseAppInfo([]byte(raw)); ok {
			t.Errorf("%q taken for the app", raw)
		}
	}
}

// The codes the app exits with are its half of the contract: RESTART_EXIT_CODE in
// src/update/index.ts, and 0 for every deliberate stop.
func TestAfterExit(t *testing.T) {
	if afterExit(0) != actionQuit || afterExit(restartExitCode) != actionUpdate || afterExit(1) != actionFailed {
		t.Error("exit codes mapped wrongly")
	}
	if restartExitCode != 75 {
		t.Error("RESTART_EXIT_CODE is 75 in src/update/index.ts")
	}
}

func TestStatusText(t *testing.T) {
	if got := statusText(stateRunning, true, 7272); got != "Tracking at localhost:7272" {
		t.Errorf("tracking: %q", got)
	}
	if got := statusText(stateRunning, false, 7272); !strings.HasPrefix(got, "Paused") {
		t.Errorf("paused: %q", got)
	}
	if got := statusText(stateUpdating, false, 7272); !strings.Contains(got, "update") {
		t.Errorf("updating: %q", got)
	}
}

func TestLastLinesKeepsTheEndOfTheLog(t *testing.T) {
	log := "\r\n  osu! local profiles\r\n  -------------------\r\n\r\n  No osu! installation found.\r\n  Set installRoots\r\n"
	if got := lastLines(log, 2); got != "No osu! installation found.\nSet installRoots" {
		t.Errorf("got %q", got)
	}
}

func TestTranslocated(t *testing.T) {
	if !translocated("/private/var/folders/x/T/AppTranslocation/ABC/d/osu! local profiles.app/Contents/MacOS/osu-local-profiles") {
		t.Error("a translocated path was not recognised")
	}
	if translocated("/Users/me/olp/osu! local profiles.app/Contents/MacOS/osu-local-profiles") {
		t.Error("an ordinary path was taken for a translocated one")
	}
}

package main

import (
	"encoding/json"
	"fmt"
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
		`{"port": 8080}`:  8080,
		`{"port": 0}`:     defaultPort,
		`{"port": 70000}`: defaultPort,
		`{}`:              defaultPort,
		`not json`:        defaultPort,
		``:                defaultPort,
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

// The daily check's result reaches the icon through /api/app; an older app sends no update.
func TestParseAppInfoReadsTheOfferedUpdate(t *testing.T) {
	info, _ := parseAppInfo([]byte(`{"app":"osu-local-profiles","version":"1.26.0","tracking":true,"update":"1.27.0"}`))
	if info.Update != "1.27.0" {
		t.Errorf("update: %q", info.Update)
	}
	for _, raw := range []string{
		`{"app":"osu-local-profiles","version":"1.26.0","update":null}`,
		`{"app":"osu-local-profiles","version":"1.23.0"}`,
	} {
		if info, _ := parseAppInfo([]byte(raw)); info.Update != "" {
			t.Errorf("%s offered %q", raw, info.Update)
		}
	}
}

// Offered only while the app is up to install it: not while starting, stopping, updating or
// failed, not while it is already being installed, and not with nothing to offer.
func TestUpdateOfferedOnlyWhileRunning(t *testing.T) {
	running := trayView{state: stateRunning, tracking: true, update: "1.27.0"}
	install, notes, shown := updateItems(running)
	if !shown || !strings.Contains(install, "1.27.0") || !strings.Contains(install, "restart") || !strings.Contains(notes, "1.27.0") {
		t.Errorf("running: %q %q %v", install, notes, shown)
	}
	for _, state := range []appState{stateStarting, stateStopping, stateUpdating, stateFailed} {
		if _, _, shown := updateItems(trayView{state: state, update: "1.27.0"}); shown {
			t.Errorf("offered in state %d", state)
		}
	}
	if _, _, shown := updateItems(trayView{state: stateRunning}); shown {
		t.Error("offered with no version")
	}
	if _, _, shown := updateItems(trayView{state: stateRunning, update: "1.27.0", updating: true}); shown {
		t.Error("offered while it is already being installed")
	}
	if got := tooltipText(running, 7272); !strings.Contains(got, "1.27.0") {
		t.Errorf("tooltip: %q", got)
	}
	if got := tooltipText(trayView{state: stateRunning, tracking: true}, 7272); got != "osu! local profiles - Tracking at localhost:7272" {
		t.Errorf("tooltip with no update: %q", got)
	}
	if got := statusLine(trayView{state: stateRunning, update: "1.27.0", updating: true}, 7272); !strings.Contains(got, "Downloading update 1.27.0") {
		t.Errorf("status while updating: %q", got)
	}
}

// The app reads these (stopWhenLauncherCloses in src/instance.ts): one JSON object a line.
func TestLinesForTheApp(t *testing.T) {
	for line, want := range map[string]map[string]any{
		quitLine:                  {"quit": true},
		meteredLine(true, true):   {"metered": true},
		meteredLine(false, true):  {"metered": false},
		meteredLine(false, false): {"metered": nil},
	} {
		if !strings.HasSuffix(line, "\n") || strings.Count(line, "\n") != 1 {
			t.Errorf("%q is not one line", line)
		}
		var got map[string]any
		if err := json.Unmarshal([]byte(line), &got); err != nil || fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("%q read as %v, want %v", line, got, want)
		}
	}
}

// Windows' and NetworkManager's answers, read as Windows Update reads them: near, over or
// roaming is metered whatever the cost; unknown is unknown, not "not metered".
func TestMeteredReadings(t *testing.T) {
	cases := []struct {
		cost                       int32
		approaching, over, roaming bool
		metered, known             bool
	}{
		{1, false, false, false, false, true},
		{2, false, false, false, true, true},
		{3, false, false, false, true, true},
		{0, false, false, false, false, false},
		{1, false, true, false, true, true},
		{1, false, false, true, true, true},
		{0, true, false, false, true, true},
	}
	for _, c := range cases {
		m, k := meteredFromHint(c.cost, c.approaching, c.over, c.roaming)
		if m != c.metered || k != c.known {
			t.Errorf("%+v: got %v %v", c, m, k)
		}
	}
	for value, want := range map[uint32][2]bool{0: {false, false}, 1: {true, true}, 2: {false, true}, 3: {true, true}, 4: {false, true}} {
		if m, k := meteredFromNM(value); m != want[0] || k != want[1] {
			t.Errorf("NMMetered %d: got %v %v", value, m, k)
		}
	}
}

func TestApplyErrorSaysWhy(t *testing.T) {
	if got := applyError(400, []byte(`{"error":"already on 1.27.0"}`)); got != "already on 1.27.0" {
		t.Errorf("with a reason: %q", got)
	}
	if got := applyError(502, []byte(`<html>`)); !strings.Contains(got, "502") {
		t.Errorf("without one: %q", got)
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

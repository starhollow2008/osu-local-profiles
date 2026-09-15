package main

// The launcher's decisions, apart from the tray and the processes it starts, so `go test` can
// check every platform's answer from any one machine -- the same reason the Node side keeps
// platform behaviour behind pure functions (docs/architecture.md, "Windows: only verified
// platform").

import (
	"encoding/json"
	"path"
	"path/filepath"
	"strings"
)

const (
	// The id /api/app answers with (APP_ID in src/instance.ts).
	appID = "osu-local-profiles"
	// What the app is told started it (LAUNCHER_ENV in src/update/index.ts). "tray" also means
	// "restarts": the app exits with restartExitCode for an update and leaves the rest to us.
	launcherEnv   = "OSU_LOCAL_PROFILES_LAUNCHER"
	launcherValue = "tray"
	// RESTART_EXIT_CODE and SWAPPER_PID_FILE in src/update/index.ts.
	restartExitCode = 75
	swapperPidFile  = "swapper.pid"
	// Run with no tray icon: a desktop with no tray, or the tests.
	noTrayEnv   = "OSU_LOCAL_PROFILES_NO_TRAY"
	defaultPort = 7272
)

// dirOf is filepath.Dir for the named platform rather than this one, so a macOS path can be
// taken apart in a test on Windows and the other way round.
func dirOf(p, goos string) string {
	if goos == "windows" {
		i := strings.LastIndexAny(p, `\/`)
		if i <= 0 {
			return p
		}
		return p[:i]
	}
	return path.Dir(p)
}

func baseOf(p, goos string) string {
	if goos == "windows" {
		return p[strings.LastIndexAny(p, `\/`)+1:]
	}
	return path.Base(p)
}

// appRoot is the folder holding the runtime, src/ and data/, given this executable's path.
//
// On macOS the launcher is inside `osu! local profiles.app/Contents/MacOS/`, and the app is the
// folder the bundle sits in. Everywhere else it is the executable's own folder. Resolved from
// the executable and never the working directory, which is whatever the file manager chose --
// the app would otherwise find no data/ and start from nothing.
func appRoot(exe, goos string) string {
	dir := dirOf(exe, goos)
	if goos == "darwin" {
		contents := dirOf(dir, goos)
		bundle := dirOf(contents, goos)
		if baseOf(dir, goos) == "MacOS" && baseOf(contents, goos) == "Contents" && strings.HasSuffix(bundle, ".app") {
			return dirOf(bundle, goos)
		}
	}
	return dir
}

func join(goos string, parts ...string) string {
	if goos == "windows" {
		return strings.Join(parts, `\`)
	}
	return path.Join(parts...)
}

// runtimeName is the Node binary each package ships beside the app.
func runtimeName(goos string) string {
	if goos == "windows" {
		return "node.exe"
	}
	return "node"
}

// missingFiles names what an incomplete folder lacks, runtime first: it is the file antivirus
// is likeliest to have taken, and nothing here needs installing, so saying which file is gone
// is the whole message.
func missingFiles(root, goos string, exists func(string) bool) []string {
	var missing []string
	for _, rel := range []string{runtimeName(goos), join(goos, "src", "main.ts")} {
		if !exists(join(goos, root, rel)) {
			missing = append(missing, rel)
		}
	}
	return missing
}

// configPort reads the port from data/config.json, which the app writes on every start.
// Anything unreadable is the app's own default, which is what the app would use too.
func configPort(raw []byte) int {
	var c struct {
		Port int `json:"port"`
	}
	if json.Unmarshal(raw, &c) != nil || c.Port <= 0 || c.Port > 65535 {
		return defaultPort
	}
	return c.Port
}

// appInfo is what /api/app says, when the thing answering is this app.
type appInfo struct {
	App      string `json:"app"`
	Version  string `json:"version"`
	Tracking bool   `json:"tracking"`
}

func parseAppInfo(raw []byte) (appInfo, bool) {
	var info appInfo
	if json.Unmarshal(raw, &info) != nil || info.App != appID {
		return appInfo{}, false
	}
	return info, true
}

// exitAction is what the launcher does once the app's process ends.
type exitAction int

const (
	// Quit from the page, the tray, or a second start that found the first: go away.
	actionQuit exitAction = iota
	// The app handed an update to the swapper: wait for it, then start the new launcher.
	actionUpdate
	// Anything else is a failure worth showing, with the log, rather than vanishing.
	actionFailed
)

func afterExit(code int) exitAction {
	switch code {
	case 0:
		return actionQuit
	case restartExitCode:
		return actionUpdate
	default:
		return actionFailed
	}
}

type appState int

const (
	stateStarting appState = iota
	stateRunning
	stateStopping
	stateUpdating
	stateFailed
)

// statusText is the tray's first line: whether it is tracking, in the tray's own words.
func statusText(state appState, tracking bool, port int) string {
	switch state {
	case stateStarting:
		return "Starting..."
	case stateRunning:
		if tracking {
			return "Tracking at localhost:" + itoa(port)
		}
		return "Paused - open the page to resume"
	case stateStopping:
		return "Stopping..."
	case stateUpdating:
		return "Installing an update..."
	default:
		return "Stopped with an error"
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}

// lastLines is the end of the app's log, for the message shown when it stops with an error:
// the app says why on its last lines, as it did in the console.
func lastLines(text string, n int) string {
	var kept []string
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(line) != "" {
			kept = append(kept, strings.TrimSpace(line))
		}
	}
	if len(kept) > n {
		kept = kept[len(kept)-n:]
	}
	return strings.Join(kept, "\n")
}

// translocated reports a macOS app run from App Translocation's randomised read-only mount: what
// macOS does to a quarantined app the first time it is opened where it was unpacked. From there
// the folder beside the bundle is not the app's folder, and data/ would not be found.
func translocated(exe string) bool {
	return strings.Contains(exe, "/AppTranslocation/")
}

// logFiles is where the app's output goes: it has no console to print to.
func logFiles(root string) (current, previous string) {
	dir := filepath.Join(root, "data", "logs")
	return filepath.Join(dir, "app.log"), filepath.Join(dir, "app.previous.log")
}

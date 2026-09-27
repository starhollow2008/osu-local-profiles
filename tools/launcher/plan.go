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
	// The newer release the app's daily check found, or empty (offeredVersion in
	// src/update/index.ts). An app from before 1.27 never sends it.
	Update string `json:"update"`
	// Downloading and installing it now: Update to ... and restart, from here or the page.
	Updating bool `json:"updating"`
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

// trayView is everything the icon and its menu show.
type trayView struct {
	state    appState
	tracking bool
	// The update the app offers, or empty.
	update string
	// The app is downloading and installing it now.
	updating bool
}

// statusLine is the menu's first line: statusText, or the update being installed.
func statusLine(v trayView, port int) string {
	if v.state == stateRunning && v.updating {
		if v.update != "" {
			return "Downloading update " + v.update + "..."
		}
		return "Downloading an update..."
	}
	return statusText(v.state, v.tracking, port)
}

// updateItems are the two menu items offering an update -- install it now, or read what is new
// on the page first -- and whether to show them: only while the app is up to install it, and
// not while it already is.
func updateItems(v trayView) (install, notes string, shown bool) {
	if v.update == "" || v.state != stateRunning || v.updating {
		return "", "", false
	}
	return "Update to " + v.update + " and restart", "What's new in " + v.update, true
}

// tooltipText is what hovering the icon says. An update is mentioned there too, because the
// menu is only seen by someone who opens it.
func tooltipText(v trayView, port int) string {
	text := "osu! local profiles - " + statusLine(v, port)
	if _, _, shown := updateItems(v); shown {
		text += " - update " + v.update + " available"
	}
	return text
}

// The lines the launcher writes down the app's stdin, as stopWhenLauncherCloses in
// src/instance.ts reads them: one JSON object a line.
const quitLine = "{\"quit\":true}\n"

func meteredLine(metered, known bool) string {
	switch {
	case !known:
		return "{\"metered\":null}\n"
	case metered:
		return "{\"metered\":true}\n"
	default:
		return "{\"metered\":false}\n"
	}
}

// meteredFromHint reads Windows' NL_NETWORK_CONNECTIVITY_HINT: a cost of 1 is unrestricted, 2
// fixed and 3 variable (both metered), 0 unknown. Near, over or roaming counts as metered
// whatever the cost says -- Windows Update's own reading.
func meteredFromHint(cost int32, approaching, over, roaming bool) (metered, known bool) {
	if approaching || over || roaming {
		return true, true
	}
	switch cost {
	case 1:
		return false, true
	case 2, 3:
		return true, true
	}
	return false, false
}

// meteredFromNM reads NetworkManager's NMMetered: 1 yes and 3 guessed yes, 2 no and 4 guessed
// no, 0 unknown.
func meteredFromNM(value uint32) (metered, known bool) {
	switch value {
	case 1, 3:
		return true, true
	case 2, 4:
		return false, true
	}
	return false, false
}

// applyError is why /api/update/apply said no, from its JSON, or its status when it gave none.
func applyError(status int, raw []byte) string {
	var body struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &body) == nil && body.Error != "" {
		return body.Error
	}
	return "the app answered " + itoa(status)
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

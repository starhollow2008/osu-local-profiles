package main

// The launcher's decisions, apart from the tray and the processes it starts, so `go test` can
// check every platform's answer from any one machine -- the same reason the Node side keeps
// platform behaviour behind pure functions (docs/architecture.md, "Windows: only verified
// platform").

import (
	"encoding/json"
	"errors"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// errSwapUsage is the answer to a swap request missing what it needs.
var errSwapUsage = errors.New("usage: --apply-update --install <dir> --staged <dir> --pid <n> [--archive <zip>] [--launcher-restarts] [--no-relaunch]")

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
	// What the computer's startup entry passes (STARTUP_ARG in src/startup.ts), and what the app
	// is told when it started that way (STARTUP_ENV), so it opens no page.
	startupArg = "--startup"
	startupEnv = "OSU_LOCAL_PROFILES_STARTUP"
)

// atStartup reports whether the computer started the launcher as the user signed in, rather
// than a person opening it: then nothing is opened, the page included.
func atStartup(args []string) bool {
	for _, arg := range args[min(1, len(args)):] {
		if arg == startupArg {
			return true
		}
	}
	return false
}

// runtimeEnv is what the app is started with: told the tray started it, and, on the first start
// of a launcher the computer started, that too. A restart for an update is not a startup.
func runtimeEnv(base []string, startup bool) []string {
	env := append(append([]string{}, base...), launcherEnv+"="+launcherValue)
	if startup {
		env = append(env, startupEnv+"=1")
	}
	return env
}

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

// nativeRelease reports whether the folder holds a release without Node, whose app is in app/
// (docs/csharp-port.md, phase 7). The stand-ins such a release carries for installs too old to
// know it (a runtime-named copy of this launcher, a placeholder src/) are never what runs.
func nativeRelease(root, goos string, exists func(string) bool) bool {
	return exists(join(goos, root, "app"))
}

// appCommand is what starts the app, by absolute path and never from PATH: a release's own app,
// or the Node runtime beside it on src/main.ts.
func appCommand(root, goos string, native bool) (string, []string) {
	if native {
		return join(goos, root, nativeApp(goos)), nil
	}
	return join(goos, root, runtimeName(goos)), []string{join(goos, "src", "main.ts")}
}

// missingFiles names what an incomplete folder lacks, runtime first: it is the file antivirus
// is likeliest to have taken, and nothing here needs installing, so saying which file is gone
// is the whole message.
func missingFiles(root, goos string, exists func(string) bool) []string {
	if nativeRelease(root, goos, exists) {
		if !exists(join(goos, root, nativeApp(goos))) {
			return []string{nativeApp(goos)}
		}
		return nil
	}
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

/* ------------------------------------------------------------------------- the swap */

// swapArg asks the launcher to install a staged update instead of starting the app: the job
// scripts/apply-update.mjs does with Node, done here for a build that has no Node (roadmap 5.82,
// docs/csharp-port.md phase 6).
const swapArg = "--apply-update"

// swapOptions are apply-update.mjs's arguments, which every swapper keeps understanding: an
// older app hands the swap to the newer release's swapper (docs/architecture.md, "Updater").
type swapOptions struct {
	install, staged, archive     string
	pid                          int
	launcherRestarts, noRelaunch bool
}

// parseSwapArgs reads a swap request from the arguments after the program name, or reports
// that there is none. Asked either as `--apply-update ...`, or the way every Node release asks
// its successor's swapper -- `<runtime> scripts/apply-update.mjs --install ...` -- so a build
// without Node can carry the launcher under the runtime's name for installs that never learnt
// to ask for --apply-update.
func parseSwapArgs(args []string) (opts swapOptions, isSwap bool, err error) {
	if len(args) == 0 {
		return opts, false, nil
	}
	first := strings.ReplaceAll(args[0], `\`, "/")
	if args[0] != swapArg && path.Base(first) != "apply-update.mjs" {
		return opts, false, nil
	}
	rest := args[1:]
	for i := 0; i < len(rest); i++ {
		value := func() string {
			if i+1 < len(rest) {
				i++
				return rest[i]
			}
			return ""
		}
		switch rest[i] {
		case "--install":
			opts.install = value()
		case "--staged":
			opts.staged = value()
		case "--archive":
			opts.archive = value()
		case "--pid":
			n, convErr := strconv.Atoi(value())
			if convErr != nil {
				return opts, true, convErr
			}
			opts.pid = n
		case "--launcher-restarts":
			opts.launcherRestarts = true
		case "--no-relaunch":
			opts.noRelaunch = true
		}
	}
	if opts.install == "" || opts.staged == "" || opts.pid <= 0 {
		return opts, true, errSwapUsage
	}
	return opts, true, nil
}

// launcherName is what each platform's package opens, as scripts/package-files.mjs names it.
// On macOS it is the bundle, which is what `open` is handed.
func launcherName(goos string) string {
	switch goos {
	case "windows":
		return "osu! local profiles.exe"
	case "darwin":
		return "osu! local profiles.app"
	}
	return "osu-local-profiles"
}

// relaunchStep is how to start the app again once the swap is done, or why not to.
type relaunchStep struct {
	skip    string
	command string
	args    []string
}

// relaunchPlan is relaunchPlan in scripts/apply-update.mjs: the app comes back somewhere it can
// be stopped from, or not at all. Never the runtime directly.
func relaunchPlan(goos, installDir string, launcherRestarts, noRelaunch bool, exists func(string) bool, getenv func(string) string) relaunchStep {
	if noRelaunch {
		return relaunchStep{skip: "installed as the app was quit, so it stays closed until it is started"}
	}
	if launcherRestarts {
		return relaunchStep{skip: "the launcher that started the app is waiting to start it again"}
	}
	name := launcherName(goos)
	launcher := join(goos, installDir, name)
	if !exists(launcher) {
		return relaunchStep{skip: "there is no " + name + " to start it with; start the app yourself"}
	}
	switch goos {
	case "windows":
		return relaunchStep{command: launcher}
	case "darwin":
		// -n: the launcher that ran the app may not have finished exiting, and open would only
		// bring it forward.
		return relaunchStep{command: "open", args: []string{"-n", launcher}}
	}
	if getenv("DISPLAY") == "" && getenv("WAYLAND_DISPLAY") == "" {
		return relaunchStep{skip: "there is no desktop to show its icon on; run ./start.sh again"}
	}
	return relaunchStep{command: launcher}
}

// replaceable is everything at the top of the install an update replaces: not data/, the
// user's, and not a previous update's .rollback-*, which moving would bury.
func replaceable(names []string) []string {
	var out []string
	for _, name := range names {
		if name != "data" && !strings.HasPrefix(name, ".rollback-") {
			out = append(out, name)
		}
	}
	return out
}

// rollbackStamp names a rollback folder as apply-update.mjs does: the ISO time to the second,
// with ':' and '.' made '-' so it is a valid file name everywhere.
func rollbackStamp(t time.Time) string {
	return strings.NewReplacer(":", "-", ".", "-").Replace(t.UTC().Format("2006-01-02T15:04:05.000Z"))[:19]
}

// logStamp is JavaScript's toISOString, which every line of data/update.log starts with.
func logStamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// nativeApp is the app a release without Node carries, relative to the release's folder
// (nativeAppFor in src/update/index.ts). Its presence is what marks such a release.
func nativeApp(goos string) string {
	if goos == "windows" {
		return join(goos, "app", "osu-local-profiles-app.exe")
	}
	return join(goos, "app", "osu-local-profiles-app")
}

// incoming is what of a staged release is copied into the install. Never data/ or a rollback.
// And from a release without Node, never the stand-ins it carries only so that installs too old
// to ask for --apply-update can still update to it -- a runtime-named copy of this launcher, a
// placeholder src/ and scripts/ -- or they would be left behind in the install for good.
func incoming(names []string, native bool, goos string) []string {
	var out []string
	for _, name := range replaceable(names) {
		if native && (name == runtimeName(goos) || name == "src" || name == "scripts") {
			continue
		}
		out = append(out, name)
	}
	return out
}

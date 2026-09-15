// Command osu-local-profiles is the app's launcher.
//
// It starts the app with no console window and keeps an icon in the system tray -- the menu bar
// on macOS -- for as long as the app runs. The icon is how the app is found and stopped; the
// page's Quit is the other way, and starting the launcher again while the app runs opens that
// page. It is a separate program, not part of the Node process, which loads no native modules.
//
// Built by scripts/build-launcher.mjs. See docs/architecture.md, "Launcher: a tray icon".
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// version is set at build time to the app's own version.
var version = "dev"

const releasesURL = "https://github.com/jonathant09/osu-local-profiles/releases"

func main() {
	os.Exit(run())
}

func run() int {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println(version)
		return 0
	}

	// With no tray there is also nobody to click a dialog away, so messages go to stderr.
	quiet := os.Getenv(noTrayEnv) != ""
	say := func(title, message string) {
		if quiet {
			fmt.Fprintf(os.Stderr, "%s: %s\n", title, message)
			return
		}
		alert(title, message)
	}

	exe, err := os.Executable()
	if err != nil {
		say("osu! local profiles cannot start", err.Error())
		return 1
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}

	if runtime.GOOS == "darwin" && translocated(exe) {
		if leaveTranslocation(exe) {
			return 0
		}
		say("osu! local profiles cannot start",
			"macOS is running it from a temporary copy, away from its own folder and your data. "+
				"Move the whole osu! local profiles folder somewhere else with Finder, such as your "+
				"Documents folder, then open it again.")
		return 1
	}

	root := appRoot(exe, runtime.GOOS)
	if missing := missingFiles(root, runtime.GOOS, exists); len(missing) > 0 {
		say("osu! local profiles cannot start", fmt.Sprintf(
			"%s is missing from this folder.\n\n"+
				"Nothing needs installing - the runtime ships inside this folder - so this means the "+
				"download or the extraction did not finish, or antivirus has removed part of it.\n\n"+
				"Download the archive again and extract all of it:\n%s", missing[0], releasesURL))
		return 1
	}
	releaseQuarantine(root)

	port := defaultPort
	if raw, err := os.ReadFile(filepath.Join(root, "data", "config.json")); err == nil {
		port = configPort(raw)
	}

	// Started twice, from one folder or from two: the second start opens the first's page.
	lock, only := acquireLock(root)
	if !only {
		openWhenRunning(port, 30*time.Second)
		return 0
	}
	if _, ok := probe(port); ok {
		lock.release()
		_ = openPath(pageURL(port))
		return 0
	}

	l := &launcher{exe: exe, root: root, port: port, lock: lock, quiet: quiet}
	if quiet {
		return l.runWithoutTray()
	}
	if !trayAvailable() {
		notice("osu! local profiles is running",
			"Your desktop has no system tray, so it has no icon. Start it again to open its page, where Quit is.")
		return l.runWithoutTray()
	}
	l.runWithTray()
	return 0
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// openWhenRunning opens the page once the app answers, for a start that found another launcher
// already starting it.
func openWhenRunning(port int, patience time.Duration) {
	for deadline := time.Now().Add(patience); time.Now().Before(deadline); time.Sleep(500 * time.Millisecond) {
		if _, ok := probe(port); ok {
			_ = openPath(pageURL(port))
			return
		}
	}
}

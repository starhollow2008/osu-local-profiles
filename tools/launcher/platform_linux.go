//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"

	"fyne.io/systray"
	"github.com/godbus/dbus/v5"
)

func openPath(target string) error {
	return exec.Command("xdg-open", target).Start()
}

// alert uses whichever dialog program the desktop has. Neither is guaranteed, so a
// notification comes next, and the terminal last.
func alert(title, message string) {
	if path, err := exec.LookPath("zenity"); err == nil {
		_ = exec.Command(path, "--error", "--no-markup", "--title", title, "--text", message).Run()
		return
	}
	if path, err := exec.LookPath("kdialog"); err == nil {
		_ = exec.Command(path, "--title", title, "--error", message).Run()
		return
	}
	if path, err := exec.LookPath("notify-send"); err == nil {
		_ = exec.Command(path, "-u", "critical", title, message).Run()
		return
	}
	fmt.Fprintf(os.Stderr, "%s: %s\n", title, message)
}

func notice(title, message string) {
	if path, err := exec.LookPath("notify-send"); err == nil {
		_ = exec.Command(path, title, message).Run()
		return
	}
	fmt.Fprintf(os.Stderr, "%s: %s\n", title, message)
}

// trayAvailable reports whether anything on the desktop shows tray icons: a
// StatusNotifierWatcher on the session bus. KDE, Cinnamon, XFCE, MATE and Budgie have one, and
// so does GNOME on Ubuntu; plain GNOME needs the AppIndicator extension. Without one the icon
// would exist and never be seen.
func trayAvailable() bool {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return false
	}
	defer conn.Close()
	var has bool
	err = conn.BusObject().Call("org.freedesktop.DBus.NameHasOwner", 0, "org.kde.StatusNotifierWatcher").Store(&has)
	return err == nil && has
}

func setTrayIcon()       { systray.SetIcon(trayPNG) }
func trayReadyPlatform() {}

func releaseQuarantine(string)       {}
func leaveTranslocation(string) bool { return false }

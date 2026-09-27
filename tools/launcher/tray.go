package main

import (
	_ "embed"
	"runtime"

	"fyne.io/systray"
)

// The icon, from web/favicon.svg, made by scripts/build-icons.mjs. A pink disc on Windows and
// Linux; on macOS a template image, which the menu bar tints to suit a light or dark bar.
var (
	//go:embed icon/tray.ico
	trayICO []byte
	//go:embed icon/tray.png
	trayPNG []byte
	//go:embed icon/template.png
	templatePNG []byte

	// The same with a dot, while an update is waiting (roadmap 5.66).
	//go:embed icon/tray-update.ico
	trayUpdateICO []byte
	//go:embed icon/tray-update.png
	trayUpdatePNG []byte
	//go:embed icon/template-update.png
	templateUpdatePNG []byte
)

// runWithTray shows the icon and runs the app under it until Quit.
//
// Clicking the icon opens the page on Windows and Linux, as a tray icon's click usually does
// there, and the menu is on right-click. On macOS the menu opens on click, as every menu bar
// item's does.
func (l *launcher) runWithTray() {
	systray.Run(l.trayReady, func() {})
}

func (l *launcher) trayReady() {
	setTrayIcon(false)
	trayReadyPlatform()
	systray.SetTooltip("osu! local profiles")

	status := systray.AddMenuItem(statusText(stateStarting, false, l.port), "")
	status.Disable()
	open := systray.AddMenuItem("Open profile", "Open the profile page in your browser")
	openLog := systray.AddMenuItem("Open log", "What the app has printed since it started")
	again := systray.AddMenuItem("Start again", "Start the app again")
	again.Hide()
	// Found by the app's daily check: install it from here, or read what is new on the page first.
	install := systray.AddMenuItem("", "Download what changed, install it and start again")
	install.Hide()
	notes := systray.AddMenuItem("", "Open the page at what the new version changes")
	notes.Hide()
	systray.AddSeparator()
	quit := systray.AddMenuItem("Quit osu! local profiles", "Stop tracking and close the app")

	openPage := func() { _ = openPath(pageURL(l.port)) }
	if runtime.GOOS != "darwin" {
		systray.SetOnTapped(openPage)
	}

	l.mu.Lock()
	l.changed = func(v trayView) {
		state := v.state
		status.SetTitle(statusLine(v, l.port))
		systray.SetTooltip(tooltipText(v, l.port))
		if installText, notesText, shown := updateItems(v); shown {
			install.SetTitle(installText)
			notes.SetTitle(notesText)
			install.Show()
			notes.Show()
		} else {
			install.Hide()
			notes.Hide()
		}
		// Seen without opening the menu, which is the point: the menu is only read by someone
		// who already went looking. Redraws come only with a change, so this is not repeated.
		setTrayIcon(v.update != "")
		if state == stateFailed {
			again.Show()
		} else {
			again.Hide()
		}
	}
	l.finished = systray.Quit
	l.mu.Unlock()

	go func() {
		for {
			select {
			case <-open.ClickedCh:
				openPage()
			case <-install.ClickedCh:
				go l.installUpdate()
			case <-notes.ClickedCh:
				_ = openPath(pageURL(l.port) + "/?update=1")
			case <-openLog.ClickedCh:
				current, _ := logFiles(l.root)
				_ = openPath(current)
			case <-again.ClickedCh:
				if err := l.start(); err != nil {
					go l.say("osu! local profiles cannot start", err.Error())
				}
			case <-quit.ClickedCh:
				l.quit()
			}
		}
	}()

	if err := l.start(); err != nil {
		l.say("osu! local profiles cannot start", err.Error())
		l.finish()
	}
}

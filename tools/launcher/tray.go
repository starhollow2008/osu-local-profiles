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
	setTrayIcon()
	trayReadyPlatform()
	systray.SetTooltip("osu! local profiles")

	status := systray.AddMenuItem(statusText(stateStarting, false, l.port), "")
	status.Disable()
	open := systray.AddMenuItem("Open profile", "Open the profile page in your browser")
	openLog := systray.AddMenuItem("Open log", "What the app has printed since it started")
	again := systray.AddMenuItem("Start again", "Start the app again")
	again.Hide()
	systray.AddSeparator()
	quit := systray.AddMenuItem("Quit osu! local profiles", "Stop tracking and close the app")

	openPage := func() { _ = openPath(pageURL(l.port)) }
	if runtime.GOOS != "darwin" {
		systray.SetOnTapped(openPage)
	}

	l.mu.Lock()
	l.changed = func(state appState, tracking bool) {
		text := statusText(state, tracking, l.port)
		status.SetTitle(text)
		systray.SetTooltip("osu! local profiles - " + text)
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

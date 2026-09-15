//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework Security
#import <Cocoa/Cocoa.h>
#include <stdlib.h>

// Security.framework's App Translocation calls, which the SDK does not declare.
extern Boolean SecTranslocateIsTranslocatedURL(CFURLRef path, bool *isTranslocated, CFErrorRef *error);
extern CFURLRef SecTranslocateCreateOriginalPathForURL(CFURLRef translocatedPath, CFErrorRef *error);

// A menu bar item and nothing else: no Dock icon, no app menu. Info.plist's LSUIElement says the
// same for the bundle; this covers the launcher run from outside one.
static void hideFromDock(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
	});
}

// Where a translocated bundle really is, or NULL. The caller frees it.
static char *originalPath(const char *translocated) {
	CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)translocated, strlen(translocated), true);
	if (url == NULL) return NULL;
	char *out = NULL;
	bool is = false;
	if (SecTranslocateIsTranslocatedURL(url, &is, NULL) && is) {
		CFURLRef original = SecTranslocateCreateOriginalPathForURL(url, NULL);
		if (original != NULL) {
			char buf[PATH_MAX];
			if (CFURLGetFileSystemRepresentation(original, true, (UInt8 *)buf, sizeof buf)) out = strdup(buf);
			CFRelease(original);
		}
	}
	CFRelease(url);
	return out;
}
*/
import "C"

import (
	"os/exec"
	"path/filepath"
	"unsafe"

	"fyne.io/systray"
)

func openPath(target string) error {
	return exec.Command("/usr/bin/open", target).Start()
}

// alert and notice go through AppleScript, with the text as arguments so nothing in it is ever
// read as script.
func alert(title, message string) {
	_ = exec.Command("/usr/bin/osascript",
		"-e", "on run argv",
		"-e", "display alert (item 1 of argv) message (item 2 of argv) as critical",
		"-e", "end run", title, message).Run()
}

func notice(title, message string) {
	_ = exec.Command("/usr/bin/osascript",
		"-e", "on run argv",
		"-e", "display notification (item 2 of argv) with title (item 1 of argv)",
		"-e", "end run", title, message).Run()
}

func trayAvailable() bool { return true }

func setTrayIcon() { systray.SetTemplateIcon(templatePNG, trayPNG) }

func trayReadyPlatform() { C.hideFromDock() }

// releaseQuarantine lifts macOS's quarantine from the app's folder when the download still
// carries it, as the .command launcher did before this. Gatekeeper otherwise refuses the pp
// helper and each of its libraries one at a time. The user approved this launcher, which is the
// decision to trust the folder; removing the attribute from their own files needs no password.
func releaseQuarantine(root string) {
	for _, rel := range []string{"node", filepath.Join("tools", "pp", "osu-pp")} {
		if exec.Command("/usr/bin/xattr", "-p", "com.apple.quarantine", filepath.Join(root, rel)).Run() == nil {
			_ = exec.Command("/usr/bin/xattr", "-dr", "com.apple.quarantine", root).Run()
			return
		}
	}
}

// leaveTranslocation handles the first open of a quarantined download. macOS runs it from a
// random read-only copy of the bundle, where the folder beside it holds no runtime and no data/.
// Find where the bundle really is, lift the quarantine from that folder -- after which macOS
// stops translocating it -- and open it from there. Reports whether that copy was started.
func leaveTranslocation(exe string) bool {
	bundle := filepath.Dir(filepath.Dir(filepath.Dir(exe)))
	path := C.CString(bundle)
	defer C.free(unsafe.Pointer(path))
	original := C.originalPath(path)
	if original == nil {
		return false
	}
	defer C.free(unsafe.Pointer(original))
	real := C.GoString(original)

	_ = exec.Command("/usr/bin/xattr", "-dr", "com.apple.quarantine", filepath.Dir(real)).Run()
	return exec.Command("/usr/bin/open", "-n", real).Start() == nil
}

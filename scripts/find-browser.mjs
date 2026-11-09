/**
 * The Chromium-based browser installed here, for the scripts that drive one over the DevTools
 * protocol (scripts/ui-check.mjs, scripts/build-icons.mjs). The app's own search, for Share's
 * picture, is `dotnet/App/Http/Screenshot.cs`; this one looks in the same places.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where a Chromium-based browser usually lives, most preferred first -- only the ones that
 * exist, and lazily, so the search stops at the first.
 */
function* browserCandidates() {
  const candidates = [];

  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean);
    for (const root of roots) {
      candidates.push(path.join(root, 'Google/Chrome/Application/chrome.exe'));
      candidates.push(path.join(root, 'Microsoft/Edge/Application/msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/brave-browser',
      '/snap/bin/chromium',
      '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
      path.join(os.homedir(), '.local/share/flatpak/exports/bin/org.chromium.Chromium'),
    );
  }

  for (const candidate of candidates) if (fs.existsSync(candidate)) yield candidate;

  // Then whatever is on PATH: on Linux the same browser is packaged a dozen ways.
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    const found = onPath(name);
    if (found) yield found;
  }
}

/** Resolve a command through PATH, the way a shell would. Windows needs the extensions. */
function onPath(name) {
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE').split(';') : [''];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* not here, or not executable */
      }
    }
  }
  return null;
}

/** The browser to drive, or null when none is installed. */
export function findBrowser() {
  return browserCandidates().next().value ?? null;
}

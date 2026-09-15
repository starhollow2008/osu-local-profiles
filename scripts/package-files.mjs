/**
 * The launchers and README that go into a packaged build, as pure functions of the platform.
 *
 * Separate from `scripts/package.mjs` because that script packages the app the moment it is
 * imported, and these need to be callable without doing that -- the macOS and Linux
 * versions can otherwise only be checked by building on macOS and Linux, which is the exact
 * situation this project is trying not to be in. `test/package-files.test.ts` pins all
 * three.
 */

/** `win` | `osx` | `linux`, the first half of a .NET runtime identifier. */

/**
 * Where to get the archive again, which is the answer to every case the launcher's guard
 * catches. Written once here rather than in each launcher and each README.
 */
const RELEASES_URL = 'https://github.com/jonathant09/osu-local-profiles/releases';

/**
 * The tray launcher each package carries (tools/launcher, built by scripts/build-launcher.mjs):
 * what the user opens, and where its executable is inside that.
 *
 * `scripts/apply-update.mjs` names the same files in `launcherName`, because it is copied into
 * packages alone and cannot import this; `test/relaunch.test.ts` pins that the two agree.
 */
export function trayLauncherFor(hostOs) {
  if (hostOs === 'win') return { name: 'osu! local profiles.exe', executable: 'osu! local profiles.exe' };
  if (hostOs === 'osx') {
    return {
      name: 'osu! local profiles.app',
      executable: 'osu! local profiles.app/Contents/MacOS/osu-local-profiles',
    };
  }
  return { name: 'osu-local-profiles', executable: 'osu-local-profiles' };
}

/**
 * The script beside the tray launcher on macOS and Linux, under the name earlier releases gave
 * their launcher; null on Windows, which needs none.
 *
 * It has to exist, with that name. Releases 1.14 to 1.16 restart the app after an update by
 * running `./<their own name>` again (roadmap 5.46), so the first update to a tray build ends
 * by running this file, from the old launcher's terminal -- and it must start the tray launcher.
 * It is also a second way in: a `.command` Finder runs, and on Linux the terminal, which is
 * still where the app runs when there is no desktop to show an icon on.
 *
 * All of them move to their own folder first. A script started by double-clicking begins in
 * whatever directory the file manager felt like, and the app would look for its `data/`
 * somewhere else entirely and silently start from scratch.
 */
export function launcherFor(hostOs, nodeBinary) {
  if (hostOs === 'win') return null;

  const tray = trayLauncherFor(hostOs);
  const quote = (p) => `"./${p}"`;

  return {
    name: hostOs === 'osx' ? 'Start osu! local profiles.command' : 'start.sh',
    content: [
      '#!/bin/sh',
      '# Run from this folder however it was launched, so data/ is always found beside it.',
      'cd "$(dirname "$0")" || exit 1',
      '',
      /*
       * Nothing needs installing, so a missing file is never a missing prerequisite: it is an
       * incomplete download, a half-finished extraction, or antivirus having quarantined the
       * runtime. A zip extracted by a tool that drops permissions is the other case, leaving
       * the runtime present and unrunnable, which `sh` reports only as "Permission denied".
       */
      `if [ ! -f ./${nodeBinary} ] || [ ! -f src/main.ts ] || [ ! -e ${quote(tray.name)} ]; then`,
      '  echo ""',
      '  echo "  osu! local profiles cannot start: this folder is incomplete."',
      '  echo ""',
      '  echo "  Nothing needs installing - the runtime ships inside this folder - so this"',
      '  echo "  means the download or the extraction did not finish."',
      '  echo ""',
      '  echo "  Download the archive again and extract all of it:"',
      `  echo "  ${RELEASES_URL}"`,
      '  echo ""',
      '  exit 1',
      'fi',
      '',
      `if [ ! -x ./${nodeBinary} ] || [ ! -x ${quote(tray.executable)} ]; then`,
      '  echo ""',
      '  echo "  The bundled programs are not executable. Some unzip tools drop that."',
      '  echo ""',
      `  echo "  Restore them from this folder with:  chmod +x ./${nodeBinary} tools/pp/osu-pp '${tray.executable}'"`,
      '  echo ""',
      '  exit 1',
      'fi',
      '',
      ...(hostOs === 'osx' ? macStart(nodeBinary, tray) : linuxStart(nodeBinary, tray)),
    ].join('\n'),
    // Without this the archive carries a launcher nobody can run, and `chmod +x` is not an
    // obvious fix for someone who has just downloaded a zip.
    mode: 0o755,
  };
}

function macStart(nodeBinary, tray) {
  return [
    /*
     * macOS quarantines everything unpacked from a browser download, and refuses each unsigned
     * file separately as it loads: the pp helper, then its native libraries one by one. The
     * tray launcher lifts the quarantine itself once it runs; doing it here first also spares
     * the bundle App Translocation, which runs a quarantined app from a random read-only copy.
     * Approving this script is the user deciding to trust this folder, and removing the
     * attribute from files the user owns needs no password.
     */
    `if xattr -p com.apple.quarantine ./${nodeBinary} >/dev/null 2>&1 || xattr -p com.apple.quarantine tools/pp/osu-pp >/dev/null 2>&1; then`,
    '  xattr -dr com.apple.quarantine . 2>/dev/null',
    '  echo "  Allowed the rest of this folder to run: macOS had quarantined the download."',
    'fi',
    '',
    // The app lives in the menu bar from here; this Terminal window can be closed.
    `open "./${tray.name}"`,
    'echo "  osu! local profiles is starting. It has an icon in the menu bar while it runs."',
    '',
  ];
}

function linuxStart(nodeBinary, tray) {
  return [
    // With a desktop, the tray launcher runs the app, and this terminal can be closed.
    'if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; then',
    '  if command -v setsid >/dev/null 2>&1; then',
    `    setsid ./${tray.executable} </dev/null >/dev/null 2>&1 &`,
    '  else',
    `    nohup ./${tray.executable} </dev/null >/dev/null 2>&1 &`,
    '  fi',
    '  echo "  osu! local profiles is starting. It has an icon in your system tray while it runs."',
    '  exit 0',
    'fi',
    '',
    /*
     * No desktop, so no tray: the app runs in this terminal, where Ctrl+C stops it.
     *
     * Run, not `exec`ed, so this shell is still here when the app exits for an update. It
     * then waits for the swap and runs the new launcher, and the app comes back in this
     * terminal. The variable, the code and the pid file are src/update/index.ts's
     * LAUNCHER_ENV, RESTART_EXIT_CODE and SWAPPER_PID_FILE.
     *
     * The swap replaces this file while it runs. The shell reads on from the file it
     * opened, which the swap has moved aside, not from the new one.
     */
    `OSU_LOCAL_PROFILES_LAUNCHER=restarts ./${nodeBinary} src/main.ts`,
    'status=$?',
    '[ "$status" -eq 75 ] || exit "$status"',
    '',
    'echo ""',
    'echo "  Installing the update. The app starts again here when it is done."',
    'echo ""',
    'pid=$(cat data/update/swapper.pid 2>/dev/null)',
    'waited=0',
    'while [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 600 ]; do',
    '  sleep 1',
    '  waited=$((waited + 1))',
    'done',
    'exec sh "./$(basename "$0")"',
    '',
  ];
}

/**
 * How to start it, which is genuinely different on each platform -- and on macOS and Windows is
 * not merely different but questioned by default.
 *
 * Neither system knows a program not signed by a paid developer account, so a first-time user is
 * met with a warning rather than an app. Saying so here, with the way round it, is the honest
 * option; leaving it out would have them assume the build is broken.
 */
function howToStart(hostOs) {
  if (hostOs === 'win') {
    return [
      'Double-click "osu! local profiles.exe".',
      '',
      'The first time, Windows may say it protected your PC from an unrecognised app. This app',
      'is not signed by a paid certificate, which Windows asks about. Press More info, then Run',
      'anyway. It asks once.',
      '',
      'It runs in the system tray, beside the clock, with no window of its own. Windows 11 puts a',
      'new icon behind the ^ arrow at first; drag it onto the taskbar to keep it in view. Click',
      'the icon to open the page, or right-click it for Quit.',
    ];
  }

  if (hostOs === 'osx') {
    return [
      'Double-click "osu! local profiles".',
      '',
      'The first time, macOS will refuse to open it. This app is not signed by a paid Apple',
      'developer account, and macOS blocks downloaded programs that are not. It takes one',
      'approval:',
      '',
      '  1. Double-click "osu! local profiles" and close the message.',
      '  2. Open System Settings -> Privacy & Security, scroll down, press Open Anyway',
      '     beside it, and confirm with your password or Touch ID.',
      '',
      'On macOS 14 or earlier you can instead right-click it and choose Open.',
      '',
      'It then allows the rest of this folder itself, so nothing else is refused. There is no',
      'need to allow apps from anywhere, and it is safer not to.',
      '',
      'Or run this once in Terminal, from this folder, and skip the approval entirely:',
      '',
      '    xattr -dr com.apple.quarantine .',
      '',
      'It runs in the menu bar, at the top right of the screen, with no Dock icon and no window.',
      'Click the icon for Open profile and Quit.',
      '"Start osu! local profiles.command" starts it too.',
    ];
  }

  return [
    'Run ./osu-local-profiles from this folder, or ./start.sh, or double-click either if your',
    'desktop allows that.',
    '',
    'It runs in the system tray, with no window of its own. Click the icon to open the page, or',
    'right-click it for Quit. KDE, Cinnamon, XFCE, MATE, Budgie and Ubuntu show tray icons;',
    'other GNOME desktops need the AppIndicator extension. Without a tray it still runs, with',
    'no icon: start it again to open the page, where Quit is. With no desktop at all, ./start.sh',
    'runs it in the terminal instead.',
    '',
    'If it will not run, the executable bit was lost in transit. Restore it with:',
    '',
    '    chmod +x start.sh node osu-local-profiles tools/pp/osu-pp',
  ];
}

export function readmeFor(hostOs) {
  return [
    'osu! local profiles',
    '===================',
    '',
    ...howToStart(hostOs),
    '',
    'Your browser opens at http://localhost:7272 and tracking begins.',
    '',
    'Play osu! -- lazer or stable, online or offline -- and scores appear as you set them.',
    '',
    'To stop it, press Quit on its icon, or Quit at the top of the page. Starting it again while',
    'it runs opens the page, so that is also how to find the page again.',
    '',
    "Nothing needs installing. Node and osu!'s pp calculator are both included.",
    '',
    'Everything this app records lives in the "data" folder next to this file, so you can',
    'move or copy the whole folder and your profiles come with it. Deleting "data" resets',
    'the app to a clean slate. What the app prints as it runs is in data/logs/app.log.',
    '',
    'The first run reads your local beatmaps once, in the background: the page opens at',
    'once and shows how far it has got. Later runs only look for new beatmaps.',
    '',
    'Settings are in data/config.json (profile name, port, country, tagline).',
    '',
    // The escape hatch when detection misses, which is likeliest on macOS and Linux: there
    // is no official osu!stable build there, only Wine wrappers.
    'If it cannot find osu!, add the folder to installRoots in data/config.json:',
    '    "installRoots": ["/path/to/osu!"]',
    '',
    // CRLF on Windows so Notepad does not run the whole file together on one line.
  ].join(hostOs === 'win' ? '\r\n' : '\n');
}

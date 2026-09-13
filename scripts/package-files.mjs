/**
 * The launcher and README that go into a packaged build, as pure functions of the platform.
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
 * The launcher, named the way each platform's file manager will actually run it.
 *
 * All three do the same two things: move to the folder they are in, then run the app with
 * the Node runtime sitting beside them. Moving first is the part that matters -- a launcher
 * started by double-clicking begins in whatever directory the file manager felt like, and
 * without it the app would look for its `data/` somewhere else entirely and silently start
 * from scratch.
 *
 * macOS gets `.command` because that is the extension Finder runs on a double-click; a
 * `.sh` would open in a text editor. Linux desktops run an executable `.sh` directly.
 */
export function launcherFor(hostOs, nodeBinary) {
  if (hostOs === 'win') {
    return {
      name: 'Start osu! local profiles.bat',
      // CRLF: a .bat with bare newlines is not reliably parsed by cmd.
      content: [
        '@echo off',
        'cd /d "%~dp0"',
        'title osu! local profiles',
        /*
         * Nothing needs installing, so a missing file here is never a missing prerequisite --
         * it is an incomplete download, a half-finished extraction, or antivirus having
         * quarantined the runtime. Without this the user gets cmd's own "is not recognized as
         * an internal or external command", which reads exactly like a missing prerequisite
         * and sends them off installing Node they do not need.
         *
         * Checked in this order so that the runtime is the one named when both are gone: it
         * is the file something else is most likely to have taken.
         */
        'set "missing="',
        'if not exist "src\\main.ts" set "missing=src\\main.ts"',
        `if not exist ".\\${nodeBinary}" set "missing=${nodeBinary}"`,
        'if defined missing goto incomplete',
        /*
         * `.\` and never the bare name, as `./` on the other two. A bare `node.exe` is found
         * in the current folder only while Windows' NoDefaultCurrentDirectoryInExePath is
         * unset; with it set -- a documented hardening switch -- cmd searches PATH instead,
         * and the app starts on whatever Node happens to be installed, or on none.
         */
        `.\\${nodeBinary} src\\main.ts`,
        'if errorlevel 1 (',
        '  echo.',
        '  echo The app stopped with an error. The message above says why.',
        '  pause',
        ')',
        'exit /b',
        '',
        ':incomplete',
        'echo.',
        'echo  osu! local profiles cannot start: %missing% is missing from this folder.',
        'echo.',
        'echo  Nothing needs installing - the runtime ships inside this folder - so this',
        'echo  means the download or the extraction did not finish, or antivirus has',
        `echo  removed part of it - ${nodeBinary} is the usual casualty.`,
        'echo.',
        'echo  Download the archive again and extract all of it:',
        `echo  ${RELEASES_URL}`,
        'echo.',
        'pause',
        'exit /b 1',
        '',
      ].join('\r\n'),
      // Windows has no executable bit; the extension is what makes it runnable.
      mode: null,
    };
  }

  return {
    name: hostOs === 'osx' ? 'Start osu! local profiles.command' : 'start.sh',
    content: [
      '#!/bin/sh',
      '# Run from this folder however it was launched, so data/ is always found beside it.',
      'cd "$(dirname "$0")" || exit 1',
      '',
      // The same reasoning as the Windows guard above, plus a case Windows does not have:
      // a zip extracted by a tool that drops permissions leaves the runtime present and
      // unrunnable, which `sh` reports only as "Permission denied".
      `if [ ! -f ./${nodeBinary} ] || [ ! -f src/main.ts ]; then`,
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
      `if [ ! -x ./${nodeBinary} ]; then`,
      '  echo ""',
      '  echo "  The bundled runtime is not executable. Some unzip tools drop that."',
      '  echo ""',
      `  echo "  Restore it from this folder with:  chmod +x ./${nodeBinary} tools/pp/osu-pp"`,
      '  echo ""',
      '  exit 1',
      'fi',
      '',
      /*
       * Run, not `exec`ed, so this shell is still here when the app exits for an update. It
       * then waits for the swap and runs the new launcher, and the app comes back in this
       * terminal. Anything else -- including a swapper starting the app itself -- brings it
       * back with no terminal, which is what 1.13.2 and earlier did: running, invisible,
       * and impossible to stop. The variable, the code and the pid file are
       * src/update/index.ts's LAUNCHER_ENV, RESTART_EXIT_CODE and SWAPPER_PID_FILE.
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
    ].join('\n'),
    // Without this the archive carries a launcher nobody can run, and `chmod +x` is not an
    // obvious fix for someone who has just downloaded a zip.
    mode: 0o755,
  };
}

/**
 * How to start it, which is genuinely different on each platform -- and on macOS is not
 * merely different but blocked by default.
 *
 * Gatekeeper quarantines any downloaded program not signed by a paid Apple developer
 * account, so a first-time macOS user is met with a refusal rather than an app. Saying so
 * here, with both ways round it, is the honest option; leaving it out would have them
 * assume the build is broken.
 */
function howToStart(hostOs) {
  if (hostOs === 'win') return ['Double-click "Start osu! local profiles.bat".'];

  if (hostOs === 'osx') {
    return [
      'Double-click "Start osu! local profiles.command".',
      '',
      'The first time, macOS will refuse to open it. This app is not signed by an Apple',
      'developer account, and macOS quarantines downloaded programs that are not. To allow',
      'it, either right-click the file and choose Open (then Open again in the dialog), or',
      'run this once in Terminal, from this folder:',
      '',
      '    xattr -dr com.apple.quarantine .',
      '',
      'That is a real limitation rather than a bug -- signing needs a paid Apple account.',
    ];
  }

  return [
    'Run ./start.sh from this folder, or double-click it if your desktop allows that.',
    '',
    'If it will not run, the executable bit was lost in transit. Restore it with:',
    '',
    '    chmod +x start.sh node tools/pp/osu-pp',
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
    'Closing the console window stops tracking.',
    '',
    "Nothing needs installing. Node and osu!'s pp calculator are both included.",
    '',
    'Everything this app records lives in the "data" folder next to this file, so you can',
    'move or copy the whole folder and your profiles come with it. Deleting "data" resets',
    'the app to a clean slate.',
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

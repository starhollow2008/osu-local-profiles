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
      name: 'Start osu! fresh profile.bat',
      // CRLF: a .bat with bare newlines is not reliably parsed by cmd.
      content: [
        '@echo off',
        'cd /d "%~dp0"',
        'title osu! fresh profile',
        `${nodeBinary} src\\main.ts`,
        'if errorlevel 1 (',
        '  echo.',
        '  echo The app stopped with an error. The message above says why.',
        '  pause',
        ')',
        '',
      ].join('\r\n'),
      // Windows has no executable bit; the extension is what makes it runnable.
      mode: null,
    };
  }

  return {
    name: hostOs === 'osx' ? 'Start osu! fresh profile.command' : 'start.sh',
    content: [
      '#!/bin/sh',
      '# Run from this folder however it was launched, so data/ is always found beside it.',
      'cd "$(dirname "$0")" || exit 1',
      `exec ./${nodeBinary} src/main.ts`,
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
  if (hostOs === 'win') return ['Double-click "Start osu! fresh profile.bat".'];

  if (hostOs === 'osx') {
    return [
      'Double-click "Start osu! fresh profile.command".',
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
    '    chmod +x start.sh node',
  ];
}

export function readmeFor(hostOs) {
  return [
    'osu! fresh profile',
    '==================',
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
    'The first run takes about a minute while it indexes your local beatmaps.',
    'Later runs start immediately.',
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

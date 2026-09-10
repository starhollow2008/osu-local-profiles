import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaultRid, shouldPrune } from '../scripts/build-pp-helper.mjs';

/*
 * Which files the shipped pp helper drops.
 *
 * Worth testing rather than eyeballing because getting it wrong is quiet in both
 * directions. Prune too much and the helper dies at startup -- and `official.ts` falls back
 * to the plain build output, so that failure once hid behind passing pp tests. Prune too
 * little and a macOS or Linux build silently ships 160MB of natives it cannot use, BASS
 * among them, which is not ours to redistribute.
 */

/** The list that was verified by hand on Windows, one file at a time. */
const WINDOWS_NATIVES = [
  'osu.Game.Resources.dll',
  'bass.dll',
  'bass_fx.dll',
  'bassmix.dll',
  'basswasapi.dll',
  'avcodec-58.dll',
  'avformat-58.dll',
  'avutil-56.dll',
  'swscale-5.dll',
  'swresample-3.dll',
  'SDL2.dll',
  'SDL3.dll',
  'libveldrid-spirv.dll',
  'stbi.dll',
  'Microsoft.DiaSymReader.Native.amd64.dll',
  'Microsoft.DiaSymReader.Native.x86.dll',
];

test('every file the verified Windows list named is still pruned', () => {
  for (const file of WINDOWS_NATIVES) {
    assert.equal(shouldPrune(file), true, `${file} should be pruned`);
  }
});

/*
 * The point of matching by pattern. The same library is spelled three ways, and ffmpeg puts
 * its version in a different place on each platform. None of these could be verified by
 * running the build here, which is exactly why they are pinned.
 */
test('the macOS and Linux spellings of the same libraries are pruned too', () => {
  const elsewhere = [
    'libbass.dylib',
    'libbass.so',
    'libbass_fx.dylib',
    'libbassmix.so',
    'libbasswasapi.so',
    'libavcodec.58.dylib',
    'libavcodec.so.58',
    'libavformat.so.58',
    'libavutil.so.56',
    'libswscale.so.5',
    'libswresample.so.3',
    'libSDL2.dylib',
    'libSDL2-2.0.so.0',
    'libSDL3.so.0',
    'libveldrid-spirv.dylib',
    'libveldrid-spirv.so',
    'libstbi.dylib',
    'libstbi.so',
  ];
  for (const file of elsewhere) {
    assert.equal(shouldPrune(file), true, `${file} should be pruned`);
  }
});

/*
 * The dangerous direction. osu.Framework's Logger initialiser pulls in nearly the whole
 * managed graph before any of this project's code runs, so removing a managed assembly
 * kills the helper at startup no matter how irrelevant it looks to pp. `ppy.ManagedBass` is
 * the trap: it is the *wrapper* around the native library being dropped, and a substring
 * match would take it.
 */
test('the managed assemblies the helper cannot start without are kept', () => {
  const required = [
    'ppy.ManagedBass.dll',
    'ppy.ManagedBass.Fx.dll',
    'ppy.ManagedBass.Mix.dll',
    'ppy.ManagedBass.Wasapi.dll',
    'osu.Framework.dll',
    'osu.Game.dll',
    'osu.Game.Rulesets.Osu.dll',
    'osu-pp.dll',
    'Realm.dll',
    'SixLabors.ImageSharp.dll',
    'nunit.framework.dll',
    'Sentry.dll',
    'OpenTabletDriver.dll',
    'System.Private.Xml.dll',
    'System.Private.DataContractSerialization.dll',
  ];
  for (const file of required) {
    assert.equal(shouldPrune(file), false, `${file} must be kept`);
  }
});

/*
 * The strongest check available without publishing again: run the patterns over a helper
 * that was actually built and pruned. Nothing left in it may match, or the next build on
 * any platform would remove a file this one needed.
 */
test('nothing in an already-pruned helper is matched', (t) => {
  const dir = path.join(process.cwd(), 'tools', 'pp');
  if (!fs.existsSync(dir)) return t.skip('no built helper -- run npm run build:pp:local');

  const files = fs.readdirSync(dir).filter((f) => !fs.statSync(path.join(dir, f)).isDirectory());
  assert.ok(files.length > 50, 'expected a real published helper');

  const matched = files.filter(shouldPrune);
  assert.deepEqual(matched, [], 'these would be removed from a working helper');
});

test('the runtime identifier follows the machine, not Windows', () => {
  const rid = defaultRid();
  assert.match(rid, /^(win|osx|linux)-(x64|arm64)$/);
  const expected =
    process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'osx' : 'linux';
  assert.equal(rid.split('-')[0], expected);
});

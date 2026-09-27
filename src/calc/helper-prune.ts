/**
 * What a published pp helper carries that a pp calculator never uses, and can go.
 *
 * One definition for both helpers built here: the one every release ships
 * (scripts/build-pp-helper.mjs) and the one built from a player's own osu! source
 * (src/calc/source-helper.ts). Both reference the whole game -- fonts, textures and audio
 * samples, ffmpeg, SDL, a shader compiler -- and both start without it; each entry below was
 * verified by removing it and watching the helper start and price, with no fallback available.
 *
 * Only the *full* helper's list. The slim helper removes more, and only past the parity check
 * (roadmap 5.60) -- see `SLIM_PRUNE_NATIVES` in scripts/build-pp-helper.mjs.
 */

/** Managed assemblies safe to drop. Named exactly: a managed assembly is called the same thing everywhere. */
export const PRUNE_ASSEMBLIES: readonly string[] = [
  // Fonts, textures and audio samples: 125MB, and the single biggest win.
  'osu.Game.Resources.dll',
];

/**
 * Native libraries the calculator never calls, by *base* name.
 *
 * Matched by pattern rather than by filename because the same library is called three
 * different things: `bass.dll`, `libbass.dylib`, `libbass.so`, and ffmpeg carries its
 * version in a different place on each (`avcodec-58.dll` against `libavcodec.so.58`).
 * Listing every spelling would mean guessing at names on platforms this was written on
 * none of -- and a guess that missed would silently ship a 273MB helper instead of a 114MB
 * one, and ship BASS with it.
 *
 * BASS is the reason this is not merely a size question. It is un4seen's commercial
 * library, free for non-commercial use but *not* freely redistributable, and this app never
 * plays a sound. The pattern has to catch it on every platform, not just the one that was
 * tested.
 *
 * The *managed* wrapper `ppy.ManagedBass.dll` must stay -- osu.Framework references it
 * directly and the helper will not start without it -- which is why these match a whole
 * filename and never a substring.
 */
export const PRUNE_NATIVES: readonly string[] = [
  // Audio.
  'bass', 'bass_fx', 'bassmix', 'basswasapi',
  // Video decoding: nothing here ever plays a beatmap background.
  'avcodec', 'avformat', 'avutil', 'swscale', 'swresample',
  // Windowing, image loading and shader compilation: no window is ever opened.
  'SDL2', 'SDL3', 'veldrid-spirv', 'stbi',
  // Debug symbol reader.
  'Microsoft.DiaSymReader.Native.amd64', 'Microsoft.DiaSymReader.Native.x86',
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/*
 * `[lib]<name>[-1.2][.dll|.dylib|.so][.3]`, anchored at both ends.
 *
 * Anchoring is what keeps `ppy.ManagedBass.dll` and `osu.Framework.dll` safe: a substring
 * test would take both. The two version slots cover where each platform puts it --
 * `avcodec-58.dll`, `libavcodec.58.dylib`, `libavcodec.so.58`, `libSDL2-2.0.so.0`.
 */
export const nativePattern = (name: string): RegExp =>
  new RegExp(`^(lib)?${escape(name)}([-.][0-9][0-9.]*)?\\.(dll|dylib|so)(\\.[0-9][0-9.]*)?$`, 'i');

const NATIVE_PATTERNS = PRUNE_NATIVES.map(nativePattern);

/** Whether the full helper can do without this published file. */
export function prunedFromFullHelper(filename: string): boolean {
  return PRUNE_ASSEMBLIES.includes(filename) || NATIVE_PATTERNS.some((pattern) => pattern.test(filename));
}

/** The .NET runtime identifier for the machine this is running on. */
export function helperRid(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return `win-${arch}`;
  if (process.platform === 'darwin') return `osx-${arch}`;
  return `linux-${arch}`;
}

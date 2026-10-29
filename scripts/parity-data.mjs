/**
 * A data folder for `scripts/api-parity.mjs` that needs no osu! installation, so two builds of
 * the C# app can be compared on any machine, a CI runner included (docs/csharp-port.md, phase 7).
 *
 *   node scripts/parity-data.mjs <out dir> <app dir>
 *
 * Writes a stand-in osu!stable install into `<out dir>/osu!` from the pp check's generated
 * beatmaps (scripts/pp-parity-corpus.mjs): `osu!.exe`, the beatmaps in `Songs/`, and osu!stable
 * replays on them in `Data/r/`, every ruleset under a spread of mods. Then the app in `<app dir>`
 * starts on `<out dir>/root`, indexes those beatmaps, imports every replay and stops, which leaves
 * `<out dir>/root/data` holding scores, pp, beatmaps and whatever it turned away, made by the
 * app's own code. Prints that folder last.
 *
 * Nothing private and nothing downloaded: the same on every machine.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateCorpus, stableReplay } from './pp-parity-corpus.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** osu!stable mod bitmasks the replays are written with: none, HD, HR, DT, HD+DT, HT, FL, EZ, NC. */
const STABLE_MODS = [0, 8, 16, 64, 8 | 64, 256, 1024, 2, 64 | 512];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** The stand-in install: what `stableInstall` (src/clients/detect.ts) takes for osu!stable. */
export function writeStableInstall(dir) {
  const corpus = path.join(dir, 'corpus');
  const { replays, maps } = generateCorpus(corpus);
  const songs = path.join(dir, 'Songs', '1 parity - generated');
  const replayDir = path.join(dir, 'Data', 'r');
  fs.mkdirSync(songs, { recursive: true });
  fs.mkdirSync(replayDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'osu!.exe'), '');
  let written = 0;
  for (const [mode, list] of Object.entries(maps)) {
    for (const map of list) {
      fs.copyFileSync(map.file, path.join(songs, path.basename(map.file)));
      for (const mods of STABLE_MODS) {
        fs.writeFileSync(path.join(replayDir, `${map.md5}-${mode}-${mods}.osr`), stableReplay(Number(mode), map.md5, mods));
        written++;
      }
    }
  }
  // McOsu's plays are built as osu!stable replays, so they stand in for whole ones, with counts.
  for (const replay of replays.filter((r) => path.basename(r.file).startsWith('mcosu-'))) {
    fs.copyFileSync(replay.file, path.join(replayDir, path.basename(replay.file)));
    written++;
  }
  fs.rmSync(corpus, { recursive: true, force: true });
  return { root: dir, replays: written };
}

async function ask(port, pathname, init) {
  const r = await fetch(`http://localhost:${port}${pathname}`, { ...init, signal: AbortSignal.timeout(60_000) });
  return r.json();
}

/** Until the app answers, and then until its index and any import have finished. */
async function settled(port, child, timeoutMs = 600_000) {
  const until = Date.now() + timeoutMs;
  let answered = false;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`the app exited (${child.exitCode})`);
    try {
      const state = await ask(port, '/api/state');
      answered = true;
      if (!state.indexing.active && !state.importing.active && !state.ppCalculator.recalculating) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(answered ? 'the app was still busy after ten minutes' : 'the app never answered');
}

/** The install, then a data folder made by the app in `appDir` importing it. Returns that folder. */
export async function generateParityData(outDir, appDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  const install = writeStableInstall(path.join(outDir, 'osu!'));
  const root = path.join(outDir, 'root');
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(root, 'package.json'));
  const port = await freePort();
  fs.writeFileSync(
    path.join(data, 'config.json'),
    `${JSON.stringify({ port, openBrowser: false, checkForUpdates: false, installRoots: [install.root], searchedForInstalls: true }, null, 2)}\n`,
  );

  const exe = path.join(appDir, `osu-local-profiles-app${process.platform === 'win32' ? '.exe' : ''}`);
  const log = fs.openSync(path.join(outDir, 'app.log'), 'w');
  const child = spawn(exe, ['--root', root], { stdio: ['pipe', log, log] });
  try {
    await settled(port, child);
    const imported = await ask(port, '/api/backfill', {
      method: 'POST',
      body: JSON.stringify({ since: 0, confirm: true, sources: ['replays'] }),
    });
    if (imported.error) throw new Error(`the import was refused: ${imported.error}`);
    await settled(port, child);
    await fetch(`http://localhost:${port}/api/quit`, { method: 'POST' });
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 15_000).unref();
    });
  } finally {
    if (child.exitCode === null) child.kill();
    fs.closeSync(log);
  }
  if (!fs.existsSync(path.join(data, 'profiles.db'))) throw new Error(`the app made no database; see ${path.join(outDir, 'app.log')}`);
  console.log(`  ${install.replays} generated replays imported by ${appDir}`);
  return data;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [out, app] = process.argv.slice(2);
  if (!out || !app) {
    console.error('usage: node scripts/parity-data.mjs <out dir> <app dir>');
    process.exit(2);
  }
  generateParityData(path.resolve(out), path.resolve(app)).then(
    (data) => console.log(data),
    (e) => {
      console.error(`  ${e.message}`);
      process.exitCode = 1;
    },
  );
}

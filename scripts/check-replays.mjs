// Sanity-check the replay parser against the real .osr corpus in the lazer file store.
import fs from 'node:fs';
import path from 'node:path';
import { parseReplay, looksLikeReplay } from '../src/osr.ts';

const root = path.join(process.env.APPDATA, 'osu', 'files');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p) : files.push(p);
  }
})(root);

const head = Buffer.alloc(8);
const replays = [];
for (const f of files) {
  let fd;
  try { fd = fs.openSync(f, 'r'); } catch { continue; }
  const n = fs.readSync(fd, head, 0, 8, 0);
  fs.closeSync(fd);
  if (looksLikeReplay(head.subarray(0, n))) replays.push({ f, mtime: fs.statSync(f).mtimeMs });
}
replays.sort((a, b) => b.mtime - a.mtime);
console.log('replays found:', replays.length);

const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
let ok = 0, failed = 0, withExt = 0;
const limit = Number(process.argv[2] ?? 40);

for (const { f } of replays.slice(0, limit)) {
  try {
    const s = await parseReplay(fs.readFileSync(f));
    ok++;
    if (s.extras) withExt++;
    const st = sum(s.extras?.statistics);
    const mx = sum(s.extras?.maximum_statistics);
    console.log(
      `${s.client} m${s.mode} rank=${String(s.extras?.rank ?? '?').padEnd(2)} ` +
      `mods=${(s.extras?.mods ?? []).map((m) => m.acronym).join('') || '-'} `.padEnd(12) +
      `judged=${String(st).padStart(4)}/${String(mx).padEnd(4)} ` +
      `${st >= mx && mx > 0 ? 'COMPLETE' : 'PARTIAL '} ` +
      `combo=${String(s.maxCombo).padEnd(4)} ${s.playedAt.toISOString().slice(0, 16)}`,
    );
  } catch (e) {
    failed++;
    console.log('PARSE FAIL', path.basename(f).slice(0, 12), e.message);
  }
}
console.log(`\nparsed ok=${ok} failed=${failed} withExtendedBlock=${withExt}`);

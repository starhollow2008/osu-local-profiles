/**
 * Build the pp -> global rank curve that `src/calc/rank.ts` interpolates.
 *
 * osu!'s rankings API only exposes the top 10,000, which is useless for a fresh profile
 * sitting near the bottom of the ladder. data.ppy.sh instead publishes
 * `performance_<mode>_random_10000`: a random sample of users from across the whole
 * distribution, each carrying both their pp and their actual global rank. Those pairs are
 * the curve -- no modelling, no assumption that the sample is representative, because
 * every point states its own rank.
 *
 *   node scripts/build-rank-table.mjs osu
 *   node scripts/build-rank-table.mjs osu --dump 2026_09_01
 *   node scripts/build-rank-table.mjs osu --from path/to/osu_user_stats.sql
 *
 * Without `--from` the archive is streamed straight through `bzip2` and `tar`, so the
 * ~1 GB never lands on disk: only the one table inside it is kept, and only for as long
 * as it takes to reduce it to a few KB of curve. Needs curl, bzip2 and tar on PATH (all
 * three ship with Git for Windows).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODES = ['osu', 'taiko', 'catch', 'mania'];

/**
 * The user-stats table for each mode. osu! names catch's after its old name, and mania's
 * dump also carries `_mania_4k` / `_mania_7k` tables -- separate ladders with their own
 * ranks, which must not be mixed into the main one.
 */
const STATS_TABLE = {
  osu: 'osu_user_stats',
  taiko: 'osu_user_stats_taiko',
  catch: 'osu_user_stats_fruits',
  mania: 'osu_user_stats_mania',
};
const DEFAULT_DUMP = '2026_09_01';
/** How many points to keep. The curve is smooth; this is far more than it needs. */
const SAMPLES = 300;

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'src', 'calc', 'rank-tables');

function usage(message) {
  console.error(`${message}\n\n  node scripts/build-rank-table.mjs <${MODES.join('|')}> [--dump YYYY_MM_DD] [--from file.sql]`);
  process.exit(1);
}

const args = process.argv.slice(2);
const mode = args[0];
if (!MODES.includes(mode)) usage(`unknown mode ${JSON.stringify(mode ?? '')}`);

const dumpDate = args.includes('--dump') ? args[args.indexOf('--dump') + 1] : DEFAULT_DUMP;
const fromFile = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;

/* ------------------------------------------------------------------ fetch */

function streamTable(url, dir) {
  // One pipeline: download, decompress, and extract only the member we need. tar reads to
  // the end of the stream, so this pays the whole archive once and keeps nothing else.
  const pipeline = `curl -sL --fail "${url}" | bzip2 -dc | tar -x --wildcards --strip-components=1 -C "${dir}" "*user_stats*"`;
  console.log(`  streaming ${url}`);
  console.log('  (this reads the whole archive; nothing large is written to disk)');

  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', pipeline], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => {
      const found = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')) : [];
      if (found.length === 0) {
        reject(new Error(`extraction produced no user_stats table (exit ${code}). ` +
          'Check that curl, bzip2 and tar are on PATH and that the dump date exists.'));
        return;
      }
      resolve(found.map((f) => path.join(dir, f)));
    });
  });
}

/* ------------------------------------------------------------------ parse */

/** Column names, in order, from the dump's CREATE TABLE block. */
function columnsOf(sql) {
  const create = /CREATE TABLE [^(]*\(([\s\S]*?)\n\) ENGINE/i.exec(sql);
  if (!create) throw new Error('no CREATE TABLE block found in the dump');
  const names = [];
  for (const line of create[1].split('\n')) {
    const m = /^\s*`([^`]+)`\s+/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * Split one `(...),(...)` VALUES list into rows of raw field strings.
 *
 * Written by hand rather than with a regex because values contain commas, brackets and
 * escaped quotes; a state machine is the only thing that survives real usernames.
 */
function* rows(values) {
  let field = '';
  let row = [];
  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let i = 0; i < values.length; i++) {
    const c = values[i];

    if (inString) {
      if (escaped) { field += c; escaped = false; continue; }
      if (c === '\\') { field += c; escaped = true; continue; }
      if (c === "'") { inString = false; continue; }
      field += c;
      continue;
    }

    if (c === "'") { inString = true; continue; }
    if (c === '(') { if (depth++ === 0) { row = []; field = ''; } continue; }
    if (c === ')') {
      if (--depth === 0) { row.push(field); field = ''; yield row; }
      continue;
    }
    if (c === ',' && depth === 1) { row.push(field); field = ''; continue; }
    if (depth === 1) field += c;
  }
}

function pairsFrom(sql) {
  const columns = columnsOf(sql);
  const ppAt = columns.indexOf('rank_score');
  const rankAt = columns.indexOf('rank_score_index');
  if (ppAt < 0 || rankAt < 0) {
    throw new Error(
      `expected rank_score and rank_score_index columns; the dump has: ${columns.join(', ')}`,
    );
  }

  const out = [];
  for (const match of sql.matchAll(/INSERT INTO [^)]*?VALUES\s*([\s\S]*?);\r?\n/g)) {
    for (const row of rows(match[1])) {
      const pp = Number(row[ppAt]);
      const rank = Number(row[rankAt]);
      // Inactive users carry a zero rank and no pp; they are not on the ladder at all.
      if (Number.isFinite(pp) && Number.isFinite(rank) && pp > 0 && rank > 0) out.push([pp, rank]);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ curve */

/**
 * Reduce the raw pairs to a monotonic curve.
 *
 * The sample is noisy at the level of individual users, so it is sorted by pp, forced
 * monotonic (more pp can never mean a worse rank), and then thinned to evenly spaced
 * points in log-rank -- which is where the resolution is actually needed, since rank spans
 * six orders of magnitude while pp spans three.
 */
function buildCurve(pairs) {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);

  // Walking up the pp axis, a rank may never get worse. This is a running minimum, so it
  // is the identity on clean data and only nudges genuine inversions.
  let best = Infinity;
  const monotonic = sorted.map(([pp, rank]) => {
    best = Math.min(best, rank);
    return [pp, best];
  });

  const lo = Math.log(monotonic[0][1]);
  const hi = Math.log(monotonic[monotonic.length - 1][1]);
  const picked = new Map();
  for (let i = 0; i < monotonic.length; i++) {
    const t = (Math.log(monotonic[i][1]) - lo) / (hi - lo || 1);
    picked.set(Math.round(t * (SAMPLES - 1)), monotonic[i]);
  }
  // Always keep the extremes, whatever the bucketing did.
  picked.set(-1, monotonic[0]);
  picked.set(SAMPLES, monotonic[monotonic.length - 1]);

  // Pinning the extremes can re-add a point the bucketing already picked, so drop any
  // repeat: the lookup needs strictly ascending pp to binary-search over.
  const out = [];
  for (const [, point] of [...picked.entries()].sort((a, b) => a[0] - b[0])) {
    const entry = [Number(point[0].toFixed(2)), point[1]];
    const previous = out[out.length - 1];
    if (previous && entry[0] <= previous[0]) continue;
    out.push(entry);
  }
  return out;
}

/* ------------------------------------------------------------------- main */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `rank-${mode}-`));
try {
  let files;
  if (fromFile) {
    files = [fromFile];
  } else {
    const url = `https://data.ppy.sh/${dumpDate}_performance_${mode}_random_10000.tar.bz2`;
    files = await streamTable(url, tmp);
  }

  // Take only this mode's own ladder, never a key-count variant that happened to match.
  const wanted = `${STATS_TABLE[mode]}.sql`;
  const exact = files.filter((f) => path.basename(f) === wanted);
  if (exact.length === 0) {
    throw new Error(
      `expected ${wanted}; the archive yielded: ${files.map((f) => path.basename(f)).join(', ')}`,
    );
  }

  const pairs = exact.flatMap((f) => pairsFrom(fs.readFileSync(f, 'utf8')));
  if (pairs.length < 100) throw new Error(`only ${pairs.length} usable rows; refusing to build a curve`);

  const points = buildCurve(pairs);
  const table = {
    mode,
    dump: dumpDate,
    source: `https://data.ppy.sh/${dumpDate}_performance_${mode}_random_10000.tar.bz2`,
    sampled: pairs.length,
    generatedAt: new Date().toISOString().slice(0, 10),
    // [pp, global rank], ascending by pp.
    points,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${mode}.json`);
  fs.writeFileSync(out, `${JSON.stringify(table, null, 0)}\n`);

  console.log(`\n  ${pairs.length} sampled users -> ${points.length} curve points`);
  // Print the shape of the curve: a silently inverted or collapsed one is otherwise very
  // easy to ship, since the JSON looks perfectly well formed either way.
  for (const at of [0, 0.25, 0.5, 0.75, 0.9, 0.99, 1]) {
    const [pp, rank] = points[Math.round(at * (points.length - 1))];
    console.log(`    ${String(Math.round(at * 100)).padStart(3)}%  ${String(pp).padStart(9)}pp  ~  #${rank.toLocaleString()}`);
  }
  console.log(`  wrote ${path.relative(process.cwd(), out)} (${fs.statSync(out).size} bytes)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

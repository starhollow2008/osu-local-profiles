/**
 * Build the pp -> global rank curve that `dotnet/App/Calc/Rank.cs` interpolates.
 *
 * osu!'s rankings API only exposes the top 10,000, which is useless for a new profile
 * sitting near the bottom of the ladder. data.ppy.sh instead publishes, per mode,
 * `performance_<mode>_random_10000`, a random sample of users from across the whole
 * distribution, and `performance_<mode>_top_10000`, the top of the ladder. Every user in
 * them carries both their pp and their actual global rank, and those pairs are the curve --
 * no modelling, because every point states its own rank.
 *
 * The random sample alone stopped at its best user (#376 in osu!standard, issue #23), so the
 * top dump supplies everything above that. Its best 1,000 are kept one point each and read
 * as exact ranks; the rest of the curve is thinned (`buildCurve`).
 *
 *   npm run rank:refresh                                all four modes, newest dump
 *   node scripts/build-rank-table.mjs osu --latest      one mode, newest dump
 *   node scripts/build-rank-table.mjs osu --dump 2026_09_01
 *   node scripts/build-rank-table.mjs osu --from random/osu_user_stats.sql [--from-top top/osu_user_stats.sql]
 *
 * Without `--from` each archive is streamed straight through `bzip2` and `tar`, so nothing
 * large lands on disk: only the one table inside it is kept, and only for as long as it
 * takes to reduce it to a few KB of curve, after which it is deleted. The download stops once
 * the table is out, ahead of the scores most of an archive is. Needs curl, bzip2 and GNU tar
 * on PATH (all three ship with Git for Windows).
 *
 * Nothing in the app ever triggers it: refreshing means a multi-gigabyte download. The
 * owner's weekly maintenance job runs it when data.ppy.sh publishes a newer dump
 * (docs/automated-maintenance.md).
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
const DEFAULT_DUMP = '2026_11_05';
/** How many points to thin the curve below the exact top to. It is smooth; this is far more than it needs. */
const SAMPLES = 300;
/** The best ranks kept one point each, so a pp among them gets its exact rank in the dump. */
const EXACT = 1000;

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'dotnet', 'App', 'Calc', 'rank-tables');

function usage(message) {
  console.error(
    `${message}\n\n` +
      `  node scripts/build-rank-table.mjs <${MODES.join('|')}|all> ` +
      '[--latest | --dump YYYY_MM_DD] [--from file.sql]\n' +
      '  npm run rank:refresh        all four modes, newest published dump',
  );
  process.exit(1);
}

/** The newest dump date data.ppy.sh is currently publishing. */
async function latestDump() {
  const index = await fetch('https://data.ppy.sh/').then((r) => {
    if (!r.ok) throw new Error(`data.ppy.sh returned ${r.status}`);
    return r.text();
  });
  const pattern = /(\d{4}_\d{2}_\d{2})_performance_osu_random_10000\.tar\.bz2/g;
  const dates = [...new Set([...index.matchAll(pattern)].map((m) => m[1]))].sort();
  if (dates.length === 0) throw new Error('no performance dumps found on data.ppy.sh');
  return dates[dates.length - 1];
}

const args = process.argv.slice(2);
const requested = args[0];
if (requested !== 'all' && !MODES.includes(requested)) {
  usage(`unknown mode ${JSON.stringify(requested ?? '')}`);
}

const modes = requested === 'all' ? MODES : [requested];
const fromFile = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;
const fromTop = args.includes('--from-top') ? args[args.indexOf('--from-top') + 1] : null;
if (fromFile && modes.length > 1) usage('--from builds one mode, not "all"');
if (fromTop && !fromFile) usage('--from-top goes with --from');

const dumpDate = args.includes('--dump')
  ? args[args.indexOf('--dump') + 1]
  : args.includes('--latest')
    ? await latestDump()
    : DEFAULT_DUMP;

/* ------------------------------------------------------------------ fetch */

/** `C:\dir` -> `/c/dir`, which is what the tar bundled with Git for Windows understands. */
function toPosixPath(p) {
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!win) return p.replace(/\\/g, '/');
  return `/${win[1].toLowerCase()}/${win[2].replace(/\\/g, '/')}`;
}

function streamTable(url, dir, member) {
  /*
   * One pipeline: download, decompress, and extract only the member we need. The member is
   * named exactly and `--occurrence` makes tar stop once it has it, which closes the pipe and
   * ends the download there: the stats table comes before the lazer `scores.sql`, which is
   * most of a top-10,000 archive. Nothing else is kept.
   *
   * The URL, the output directory and the member are passed as *arguments* to bash rather
   * than pasted into the command string, because the shell strips the backslashes out of a
   * Windows path. The directory is also rewritten to the /c/... form the bundled tar
   * expects. Using it as the child's cwd instead would work, but then Windows refuses to
   * delete it afterwards -- it is a running process's working directory.
   */
  // bzip2's complaint when tar closes the pipe early is the plan working, so it is silenced;
  // a real failure still shows as no table, which the caller checks.
  const pipeline =
    'curl -sL --fail "$0" | bzip2 -dc 2>/dev/null | tar -x --occurrence=1 --strip-components=1 -C "$1" "$2"';
  console.log(`  streaming ${url}`);
  console.log('  (read up to the stats table only; nothing large is written to disk)');

  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', pipeline, url, toPosixPath(dir), member], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
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
 * Ascending pp, forced monotonic: walking up the pp axis a rank may never get worse. A
 * running minimum, so it is the identity on clean data and only nudges genuine inversions.
 * Among equal pp the best rank comes last, so it is the one kept.
 */
function monotonic(pairs) {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let best = Infinity;
  return sorted.map(([pp, rank]) => {
    best = Math.min(best, rank);
    return [pp, best];
  });
}

/**
 * Thin to evenly spaced points in log-rank, which is where the resolution is needed, since
 * rank spans six orders of magnitude while pp spans three. The extremes are always kept.
 */
function thin(points) {
  if (points.length === 0) return [];
  const lo = Math.log(points[0][1]);
  const hi = Math.log(points[points.length - 1][1]);
  const picked = new Map();
  for (let i = 0; i < points.length; i++) {
    const t = (Math.log(points[i][1]) - lo) / (hi - lo || 1);
    picked.set(Math.round(t * (SAMPLES - 1)), points[i]);
  }
  picked.set(-1, points[0]);
  picked.set(SAMPLES, points[points.length - 1]);
  return [...picked.entries()].sort((a, b) => a[0] - b[0]).map(([, point]) => point);
}

/**
 * The curve, from the random sample and the top players.
 *
 * The top players' own ranks are exact, so the best `EXACT` are kept one point each, and
 * `dotnet/App/Calc/Rank.cs` reads that stretch as a step rather than interpolating it. The
 * rest of the top dump, and the random sample below where the top dump ends, are thinned:
 * the random sample is noisy at the level of individual users, and the top dump says
 * everything about the ranks it covers.
 */
function buildCurve(randomPairs, topPairs = []) {
  const topWorst = topPairs.reduce((worst, [, rank]) => Math.max(worst, rank), 0);
  const exact = topPairs.filter(([, rank]) => rank <= EXACT);
  const rest = [
    ...topPairs.filter(([, rank]) => rank > EXACT),
    ...randomPairs.filter(([, rank]) => rank > topWorst),
  ];

  // Rounding can make two players' pp equal; the lookup needs strictly ascending pp, and
  // an equal pp keeps the better rank, as a tie on osu! does.
  const out = [];
  for (const [pp, rank] of monotonic([...thin(monotonic(rest)), ...exact])) {
    const entry = [Number(pp.toFixed(2)), rank];
    const previous = out[out.length - 1];
    if (previous && entry[0] <= previous[0]) {
      previous[1] = Math.min(previous[1], rank);
      continue;
    }
    out.push(entry);
  }
  return out;
}

/* ------------------------------------------------------------------- main */

const archiveUrl = (mode, dump) => `https://data.ppy.sh/${dumpDate}_performance_${mode}_${dump}.tar.bz2`;

/** One archive's [pp, rank] pairs: its stats table streamed out, or read from `--from`/`--from-top`. */
async function pairsOf(mode, dump, tmp) {
  // Only this mode's own ladder, never a key-count variant.
  const wanted = `${STATS_TABLE[mode]}.sql`;
  const local = dump === 'top_10000' ? fromTop : fromFile;
  let file = local;
  if (!fromFile) {
    const dir = fs.mkdtempSync(path.join(tmp, `${dump}-`));
    const files = await streamTable(archiveUrl(mode, dump), dir, `${dumpDate}_performance_${mode}_${dump}/${wanted}`);
    file = files.find((f) => path.basename(f) === wanted);
    if (!file) throw new Error(`expected ${wanted}; the archive yielded: ${files.map((f) => path.basename(f)).join(', ')}`);
  }
  if (!file) return [];
  const pairs = pairsFrom(fs.readFileSync(file, 'utf8'));
  if (pairs.length < 100) throw new Error(`only ${pairs.length} usable rows in ${dump}; refusing to build a curve`);
  return pairs;
}

async function buildMode(mode) {
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `rank-${mode}-`));
try {
  const randomPairs = await pairsOf(mode, 'random_10000', tmp);
  const topPairs = await pairsOf(mode, 'top_10000', tmp);
  const exactRanks = new Set(topPairs.filter(([, rank]) => rank <= EXACT).map(([, rank]) => rank)).size;
  // The exact stretch is only exact if the top dump has every one of those ranks.
  if (topPairs.length > 0 && exactRanks < EXACT * 0.95) {
    throw new Error(`the top dump has only ${exactRanks} of the best ${EXACT} ranks; refusing to call them exact`);
  }

  const points = buildCurve(randomPairs, topPairs);
  const table = {
    mode,
    dump: dumpDate,
    source: archiveUrl(mode, 'random_10000'),
    topSource: topPairs.length > 0 ? archiveUrl(mode, 'top_10000') : null,
    sampled: randomPairs.length + topPairs.length,
    // Ranks this good or better are one point per player, read as a step (dotnet/App/Calc/Rank.cs).
    exact: topPairs.length > 0 ? EXACT : 0,
    generatedAt: new Date().toISOString().slice(0, 10),
    // [pp, global rank], ascending by pp.
    points,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${mode}.json`);
  fs.writeFileSync(out, `${JSON.stringify(table, null, 0)}\n`);

  console.log(`\n  ${randomPairs.length} sampled + ${topPairs.length} top users -> ${points.length} curve points (${exactRanks} exact)`);
  // Print the shape of the curve: a silently inverted or collapsed one is otherwise very
  // easy to ship, since the JSON looks perfectly well formed either way.
  for (const at of [0, 0.25, 0.5, 0.75, 0.9, 0.99, 1]) {
    const [pp, rank] = points[Math.round(at * (points.length - 1))];
    console.log(`    ${String(Math.round(at * 100)).padStart(3)}%  ${String(pp).padStart(9)}pp  ~  #${rank.toLocaleString()}`);
  }
  console.log(`  wrote ${path.relative(process.cwd(), out)} (${fs.statSync(out).size} bytes)`);
} finally {
  // The extracted table is the only part of the dump that ever touched disk, and it is
  // of no further use once the curve exists. Say so, rather than leaving the user to
  // wonder whether a gigabyte is sitting in their temp directory.
  fs.rmSync(tmp, { recursive: true, force: true });
  if (fs.existsSync(tmp)) {
    console.warn(`  WARNING: could not delete ${tmp} -- remove it by hand`);
  } else if (!fromFile) {
    console.log('  extracted dump data deleted');
  }
}
}

let failed = 0;
for (const mode of modes) {
  if (modes.length > 1) console.log(`\n===== ${mode} =====`);
  try {
    await buildMode(mode);
  } catch (e) {
    failed++;
    console.error(`  FAILED (${mode}): ${e.message}`);
  }
}

if (modes.length > 1) {
  console.log(`\n  ${modes.length - failed}/${modes.length} curves built from the ${dumpDate} dump`);
}
process.exit(failed === 0 ? 0 : 1);

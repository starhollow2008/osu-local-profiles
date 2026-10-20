/**
 * Whether the weekly maintenance job has anything to do (docs/automated-maintenance.md).
 *
 *   node tools/maintenance/check.mjs [--state path/to/state.json]
 *
 * Asks the two sources the app follows and compares them with this checkout, with no agent
 * involved, so a week with nothing new costs two HTTP requests and nothing else:
 *
 * - **rank**: the newest data.ppy.sh dump that has all four modes' random samples, against
 *   the `dump` each of `src/calc/rank-tables/*.json` was built from.
 * - **pp**: the newest stable `ppy.osu.Game` on NuGet, with all four ruleset packages at the
 *   same version, against `tools/PpCalculator/PpCalculator.csproj`. A version the job already
 *   priced and found to change no pp is listed in the state file's `ppNotRework` and isn't due
 *   again; the next one that does change pp is.
 *
 * - **release**: `package.json`'s version on main with no `v<version>` tag, when its release
 *   commit came through one of this job's `bot/maintenance-*` pull requests. An earlier run
 *   merged it and stopped before tagging (a reboot, say), and the tag is all that's left. A
 *   release commit of the owner's own is theirs to tag, and never due here.
 *
 * Prints one JSON object and exits 0 whether or not anything is due, 1 when a source can't be
 * read or this checkout isn't what the check expects.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODES = ['osu', 'taiko', 'catch', 'mania'];
const PACKAGES = [
  'ppy.osu.Game',
  'ppy.osu.Game.Rulesets.Osu',
  'ppy.osu.Game.Rulesets.Taiko',
  'ppy.osu.Game.Rulesets.Catch',
  'ppy.osu.Game.Rulesets.Mania',
];

/** Compares osu!'s `YYYY.MDD.N` versions part by part, as numbers. */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function text(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'osu-local-profiles maintenance check' } });
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  return r.text();
}

function currentDumps() {
  return Object.fromEntries(
    MODES.map((mode) => {
      const file = path.join(root, 'src', 'calc', 'rank-tables', `${mode}.json`);
      return [mode, JSON.parse(fs.readFileSync(file, 'utf8')).dump];
    }),
  );
}

/** The newest dump date with a random sample for every mode, or null. */
async function latestCompleteDump() {
  const index = await text('https://data.ppy.sh/');
  const modesByDate = new Map();
  for (const m of index.matchAll(/(\d{4}_\d{2}_\d{2})_performance_(osu|taiko|catch|mania)_random_10000\.tar\.bz2/g)) {
    const date = m[1];
    if (!modesByDate.has(date)) modesByDate.set(date, new Set());
    modesByDate.get(date).add(m[2]);
  }
  const complete = [...modesByDate].filter(([, modes]) => modes.size === MODES.length).map(([date]) => date);
  return complete.sort().at(-1) ?? null;
}

function currentPpVersion() {
  const csproj = fs.readFileSync(path.join(root, 'tools', 'PpCalculator', 'PpCalculator.csproj'), 'utf8');
  const versions = PACKAGES.map((name) => {
    const m = csproj.match(new RegExp(`Include="${name.replaceAll('.', '\\.')}" Version="([^"]+)"`));
    if (!m) throw new Error(`${name} is not referenced in PpCalculator.csproj`);
    return m[1];
  });
  if (new Set(versions).size !== 1) throw new Error(`PpCalculator.csproj mixes osu! versions: ${versions.join(', ')}`);
  return versions[0];
}

/** The newest stable version every one of osu!'s packages has been published at, or null. */
async function latestPpVersion() {
  const lists = await Promise.all(
    PACKAGES.map(async (name) => {
      const json = await text(`https://api.nuget.org/v3-flatcontainer/${name.toLowerCase()}/index.json`);
      return new Set(JSON.parse(json).versions.filter((v) => !v.includes('-')));
    }),
  );
  const [first, ...rest] = lists;
  const common = [...first].filter((v) => rest.every((list) => list.has(v)));
  return common.sort(compareVersions).at(-1) ?? null;
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/** The version on main, and whether this job merged it without tagging it. */
async function unfinishedRelease() {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const tagged = git('tag', '--list', `v${version}`) !== '';
  if (tagged) return { version, due: false };
  const commit = git('log', '-1', '--format=%H', '--fixed-strings', `--grep=chore: release v${version}`);
  if (!commit) return { version, due: false };
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'osu-local-profiles maintenance check' };
  if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  const r = await fetch(`https://api.github.com/repos/jonathant09/osu-local-profiles/commits/${commit}/pulls`, { headers });
  if (!r.ok) throw new Error(`GitHub returned ${r.status} for the pull requests of ${commit}`);
  const byJob = (await r.json()).some((pr) => pr.merged_at && pr.head.ref.startsWith('bot/maintenance-'));
  return { version, commit, due: byJob };
}

function readState(file) {
  if (!file || !fs.existsSync(file)) return { ppNotRework: [] };
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ppNotRework: Array.isArray(state.ppNotRework) ? state.ppNotRework : [] };
}

async function main() {
  const args = process.argv.slice(2);
  const stateFile = args.includes('--state') ? args[args.indexOf('--state') + 1] : null;
  const state = readState(stateFile);

  const dumps = currentDumps();
  const oldestDump = Object.values(dumps).sort()[0];
  const latestDump = await latestCompleteDump();

  const ppCurrent = currentPpVersion();
  const ppLatest = await latestPpVersion();
  const ppNewer = ppLatest !== null && compareVersions(ppLatest, ppCurrent) > 0;
  const ppSkipped = ppNewer && state.ppNotRework.includes(ppLatest);

  const rank = { current: dumps, latest: latestDump, due: latestDump !== null && latestDump > oldestDump };
  const pp = { current: ppCurrent, latest: ppLatest, due: ppNewer && !ppSkipped, knownNotRework: ppSkipped };
  const release = await unfinishedRelease();
  console.log(JSON.stringify({ release, rank, pp, due: release.due || rank.due || pp.due }, null, 2));
}

main().catch((error) => {
  console.error(`maintenance check failed: ${error.message}`);
  process.exit(1);
});

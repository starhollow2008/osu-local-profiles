/**
 * The app's own code, for the scripts that check things with it: `--dev` commands of the C# app
 * (dotnet/App/DevCommands.cs), built from this checkout the first time a script asks.
 *
 *   const answers = devApp('pp-requests', listFile); // one parsed JSON answer per line
 *
 * Built with `dotnet build` and run through `dotnet`, so it needs the .NET SDK and nothing
 * published. The build's own output goes to stderr, never into the answers.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = path.join(root, 'dotnet', 'App', 'App.csproj');
const ASSEMBLY = 'osu-local-profiles-app.dll';

let built = null;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run `work` holding a lock other processes share: the test runner runs test files side by side,
 * and two builds of one project at once collide on its output. The lock is a folder (made
 * atomically) naming its holder, taken over when that process is gone.
 */
function exclusively(work) {
  const lock = path.join(root, 'dotnet', 'App', 'obj', 'dev-app.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try {
        holder = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
      } catch {
        /* being written, or being removed */
      }
      let alive = true;
      if (holder) {
        try {
          process.kill(holder, 0);
        } catch (err) {
          alive = err.code === 'EPERM';
        }
      }
      if (!alive) fs.rmSync(lock, { recursive: true, force: true });
      else sleep(250);
    }
  }
  try {
    return work();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** The app's assembly, built once per process. */
function assembly() {
  if (built) return built;
  const build = exclusively(() =>
    spawnSync('dotnet', ['build', PROJECT, '-c', 'Release', '--nologo', '-v', 'q'], {
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
    }),
  );
  if (build.error) throw new Error(`could not run dotnet to build the app: ${build.error.message}`);
  if (build.status !== 0) {
    process.stderr.write(build.stdout);
    throw new Error(`building the app failed (dotnet build exited ${build.status})`);
  }
  // bin/Release/<target framework>/, whichever framework Directory.Build.props names.
  const release = path.join(root, 'dotnet', 'App', 'bin', 'Release');
  const found = fs
    .readdirSync(release)
    .map((framework) => path.join(release, framework, ASSEMBLY))
    .filter((file) => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!found) throw new Error(`the build left no ${ASSEMBLY} under ${release}`);
  built = found;
  return built;
}

/** Whether the .NET SDK is here to build the app with. */
export function canBuildApp() {
  return spawnSync('dotnet', ['--version'], { stdio: 'ignore' }).status === 0;
}

/** Run `--dev <command> ...args` and return its answers, one parsed JSON value per line. */
export function devApp(command, ...args) {
  const run = spawnSync('dotnet', [assembly(), '--dev', command, ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`--dev ${command} exited ${run.status}: ${run.stderr.trim().split('\n').at(-1) ?? ''}`);
  return run.stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** Write `items` as JSON lines to `file`, the list format the `--dev` commands read. */
export function writeList(file, items) {
  fs.writeFileSync(file, items.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n') + '\n');
  return file;
}

/**
 * `npm start`: the app from this checkout, on its data folder, as start.bat runs it.
 *
 * Started with `OSU_LOCAL_PROFILES_LAUNCHER=restarts`, the app offers Restart (issue #43): it exits
 * with 75, and this runs it again, built from the checkout as it is then. The variable and the
 * code are the app's `Instance.LauncherEnv` and `Updater.RestartExitCode`. Any other exit ends
 * this with the app's own status.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESTART_EXIT_CODE = 75;

// Ctrl+C reaches the app too, which stops on it; this waits for it rather than leaving first.
process.on('SIGINT', () => {});

for (;;) {
  const run = spawnSync('dotnet', ['run', '--project', path.join('dotnet', 'App'), '-c', 'Release', '--', ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, OSU_LOCAL_PROFILES_LAUNCHER: 'restarts' },
  });
  if (run.error) {
    console.error(`could not run dotnet: ${run.error.message}`);
    process.exit(1);
  }
  if (run.status !== RESTART_EXIT_CODE) process.exit(run.status ?? 1);
  console.log('\n  Restarting.\n');
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleModules } from '../web/js/bundle.js';

/*
 * The shared copy of the page runs the page's own modules from one <script>, so the bundler
 * is tested on made-up modules for what it promises, and on the page itself for the one
 * thing that matters: the real code bundles, and the result parses.
 */

const from = (files: Record<string, string>) => (name: string) => {
  const source = files[name];
  if (source === undefined) throw new Error(`no ${name}`);
  return source;
};

test('dependencies run first, each with names of its own', async () => {
  const code = await bundleModules(
    'main.js',
    from({
      'main.js': "import { a } from './a.js';\nimport { b } from './b.js';\nconst x = 'main';\nout.value = a() + b() + x;\n",
      'a.js': "import { b } from './b.js';\nconst x = 'a';\nexport function a() {\n  return x + b();\n}\n",
      'b.js': "const x = 'b';\nexport const b = () => x;\n",
    }),
  );
  const out = { value: '' };
  new Function('out', code)(out);
  assert.equal(out.value, 'abbmain');
  assert.ok(code.indexOf('// ---- b.js') < code.indexOf('// ---- a.js'), 'b before a, which needs it');
  assert.ok(code.indexOf('// ---- a.js') < code.indexOf('// ---- main.js'), 'the entry last');
});

test('an import may be renamed, and multi-line imports are read whole', async () => {
  const code = await bundleModules(
    'main.js',
    from({
      'main.js': "import {\n  one as first,\n  two,\n} from './lib.js';\nout.value = first + two;\n",
      'lib.js': "export const one = 1;\nexport const two = 2;\n",
    }),
  );
  const out = { value: 0 };
  new Function('out', code)(out);
  assert.equal(out.value, 3);
});

test('a form it cannot copy faithfully is refused by name, not bundled wrong', async () => {
  const refuse = (source: string, why: RegExp) =>
    assert.rejects(bundleModules('main.js', from({ 'main.js': source })), why);
  await refuse("export default function () {}\n", /cannot bundle "export default/);
  await refuse("export let counter = 0;\n", /cannot bundle "export let/);
  await refuse("import * as all from './x.js';\n", /cannot bundle "import \* as all/);
  await refuse("const m = await import('./x.js');\n", /dynamic import/);
});

test('an import of something not exported, or a circle, fails loudly', async () => {
  await assert.rejects(
    bundleModules('main.js', from({ 'main.js': "import { nope } from './a.js';\n", 'a.js': 'export const yes = 1;\n' })),
    /imports nope from a\.js, which does not export it/,
  );
  await assert.rejects(
    bundleModules(
      'main.js',
      from({
        'main.js': "import { a } from './a.js';\n",
        'a.js': "import { b } from './b.js';\nexport const a = 1;\n",
        'b.js': "import { a } from './a.js';\nexport const b = 2;\n",
      }),
    ),
    /imported in a circle/,
  );
});

test("the page's own modules bundle into one script that parses, the snapshot reader first", async () => {
  const dir = fileURLToPath(new URL('../web/js/', import.meta.url));
  const code = await bundleModules('main.js', (name) => fs.readFileSync(path.join(dir, name), 'utf8'));

  // It answers requests from the snapshot, so it has to be in place before anything asks.
  assert.ok(code.startsWith('// ---- static-mode.js'), 'static-mode.js runs before every other module');
  // Inlined into a <script>, the text must not be able to end it.
  assert.equal(/<\/script/i.test(code), false);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-bundle-'));
  try {
    const file = path.join(tmp, 'bundle.mjs');
    fs.writeFileSync(file, code);
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

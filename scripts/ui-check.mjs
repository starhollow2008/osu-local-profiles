/**
 * Drives the real page in headless Chrome over the DevTools protocol.
 *
 * Exists because of a bug that no unit test would have caught: `.backdrop` set
 * `display: grid`, which outranks the browser's low-specificity `[hidden] { display: none }`,
 * so the reset dialog was visible on load and Cancel appeared to do nothing. Only computed
 * style tells you that.
 *
 *   node scripts/ui-check.mjs [url]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_UNDER_TEST = process.argv[2] ?? 'http://localhost:7272/';
const PORT = 9333;

const CHROMES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const binary = CHROMES.find((p) => fs.existsSync(p));
if (!binary) {
  console.error('no Chromium browser found');
  process.exit(1);
}

const chrome = spawn(
  binary,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-'))}`,
    '--window-size=1280,900',
    URL_UNDER_TEST,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

let chromeLog = '';
chrome.stdout.on('data', (d) => (chromeLog += d));
chrome.stderr.on('data', (d) => (chromeLog += d));
chrome.on('exit', (code) => { if (code !== 0 && code !== null) chromeLog += `
chrome exited ${code}`; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`chrome did not expose a debugging target
${chromeLog.slice(0, 800)}`);
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('websocket failed'));
});

let nextId = 1;
const waiting = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  const resolve = waiting.get(msg.id);
  if (resolve) {
    waiting.delete(msg.id);
    resolve(msg);
  }
};

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => waiting.set(id, res));
}

/** Evaluate an expression in the page and return its value. */
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? 'page threw');
  }
  return r.result?.result?.value;
}

// Wait for the page's own scripts to have wired everything up.
for (let i = 0; i < 40; i++) {
  const ready = await evaluate(
    "!!(document.getElementById('optionsBtn') && document.getElementById('resetModal'))",
  );
  if (ready) break;
  await sleep(250);
}

const shown = (id) =>
  evaluate(`getComputedStyle(document.getElementById('${id}')).display`);

const checks = [];
const check = (name, actual, expected) => {
  const pass = actual === expected;
  checks.push(pass);
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `  (got "${actual}", want "${expected}")`}`);
};

console.log('\non load');
check('reset dialog is hidden', await shown('resetModal'), 'none');
check('options menu is hidden', await shown('optionsMenu'), 'none');

console.log('\nafter clicking Options');
await evaluate("document.getElementById('optionsBtn').click()");
check('options menu opens', await shown('optionsMenu'), 'block');
check('reset dialog still hidden', await shown('resetModal'), 'none');

console.log('\nafter clicking elsewhere');
await evaluate("document.body.click()");
check('options menu closes', await shown('optionsMenu'), 'none');

console.log('\nafter choosing Reset profile');
await evaluate("document.getElementById('optionsBtn').click()");
await evaluate("document.getElementById('optReset').click()");
check('reset dialog opens', await shown('resetModal'), 'grid');
check('options menu closed behind it', await shown('optionsMenu'), 'none');
console.log(`  summary text: "${await evaluate("document.getElementById('resetSummary').textContent")}"`);

console.log('\nafter clicking Cancel');
await evaluate("document.getElementById('resetCancel').click()");
check('reset dialog closes', await shown('resetModal'), 'none');

console.log('\nafter reopening and clicking the backdrop');
await evaluate("document.getElementById('optionsBtn').click()");
await evaluate("document.getElementById('optReset').click()");
await evaluate(`(() => {
  const el = document.getElementById('resetModal');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
})()`);
check('backdrop click closes it', await shown('resetModal'), 'none');

console.log('\nafter reopening and pressing Escape');
await evaluate("document.getElementById('optionsBtn').click()");
await evaluate("document.getElementById('optReset').click()");
await evaluate(
  "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
);
check('Escape closes it', await shown('resetModal'), 'none');

console.log('\nimport past plays dialog');
check('import dialog is hidden on load', await shown('backfillModal'), 'none');
await evaluate("document.getElementById('optionsBtn').click()");
await evaluate("document.getElementById('optBackfill').click()");
check('import dialog opens', await shown('backfillModal'), 'grid');
check('options menu closed behind it', await shown('optionsMenu'), 'none');
check(
  'Import is disabled until a preview has run',
  await evaluate("document.getElementById('backfillConfirm').disabled"),
  true,
);
await evaluate("document.getElementById('backfillCancel').click()");
check('Cancel closes the import dialog', await shown('backfillModal'), 'none');

await evaluate("document.getElementById('optionsBtn').click()");
await evaluate("document.getElementById('optBackfill').click()");
await evaluate(
  "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
);
check('Escape closes the import dialog', await shown('backfillModal'), 'none');

console.log('\nmod settings are surfaced');
const pill = await evaluate(
  "import('/js/badges.js').then((m) => m.modPill({ acronym: 'DT', settings: { speed_change: 1.3 } }))",
);
check('a customised rate is shown on the pill', pill.includes('DT 1.3x'), true);
check('a customised mod is marked', pill.includes('mod--customised'), true);
check(
  'the settings are in the tooltip',
  pill.includes('Rate 1.3x'),
  true,
);
const plain = await evaluate("import('/js/badges.js').then((m) => m.modPill({ acronym: 'HD' }))");
check('a default mod is not marked', plain.includes('mod--customised'), false);

/*
 * The token layer. A mistyped custom property (--hsl-b4 -> --hsl-b44) makes the whole
 * declaration invalid at computed-value time, so the element falls back to transparent --
 * which reads as a slightly-off shade rather than as an error. Comparing the computed
 * background against the literal colour it is supposed to resolve to catches that.
 */
const literal = (colour) => evaluate(`(() => {
  const d = document.createElement('div');
  d.style.backgroundColor = ${JSON.stringify(colour)};
  document.body.appendChild(d);
  const v = getComputedStyle(d).backgroundColor;
  d.remove();
  return v;
})()`);

const bg = (sel) =>
  evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).backgroundColor`);

console.log('\nosu-web colour tokens resolve');
check('page background is b6', await bg('body'), await literal('hsl(333, 10%, 10%)'));
check('header is b3', await bg('.profile-info'), await literal('hsl(333, 10%, 25%)'));
check('section panel is b4', await bg('.page-extra'), await literal('hsl(333, 10%, 20%)'));
check('stats box is b4', await bg('.profile-stats'), await literal('hsl(333, 10%, 20%)'));

console.log('\nthe page rendered');
check('four game modes', await evaluate("document.querySelectorAll('#modes a').length"), 4);
check(
  'five grade counts',
  await evaluate("document.querySelectorAll('.profile-rank-count__item').length"),
  5,
);
check(
  'stats box filled in',
  await evaluate("document.querySelectorAll('#profileStats .profile-stats__entry').length"),
  7,
);
check('three sections', await evaluate("document.querySelectorAll('.page-extra').length"), 3);
// Consecutive headings must stack: they were inline-block once, which overlapped
// "Top Ranks" with "Best Performance".
check(
  'section headings stack',
  await evaluate(`(() => {
    const t = document.querySelector('#section-top_ranks .title');
    const s = document.querySelector('#section-top_ranks .title--sub');
    return s.getBoundingClientRect().top >= t.getBoundingClientRect().bottom;
  })()`),
  true,
);

const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);

ws.close();
chrome.kill();
process.exit(failed === 0 ? 0 : 1);

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

/*
 * Wait for the page's own scripts to have wired everything up.
 *
 * Waiting for the static elements is not enough -- they are in index.html and exist before
 * main.js has run, so a click can land before its handler is attached and the menu silently
 * fails to open. The mode tabs are rendered by main.js after its first fetch, so their
 * presence means the module has finished booting.
 */
for (let i = 0; i < 40; i++) {
  const ready = await evaluate(
    "!!(document.querySelector('#modes a') && document.getElementById('optionsBtn'))",
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

console.log('\nsettings dialog');
check('settings dialog is hidden on load', await shown('settingsModal'), 'none');
await evaluate("document.getElementById('optionsBtn').click()");
await evaluate("document.getElementById('optSettings').click()");
check('settings dialog opens', await shown('settingsModal'), 'grid');
check('options menu closed behind it', await shown('optionsMenu'), 'none');
// The fields are generated from SETTINGS_FIELDS, so an empty list means the render broke.
check(
  'every setting has a control and a hint',
  await evaluate(`(() => {
    const settings = document.querySelectorAll('#settingsFields .setting');
    if (settings.length === 0) return 'no settings rendered';
    return [...settings].every(
      (s) =>
        s.querySelector('input, select') && s.querySelector('.setting__hint').textContent.trim(),
    );
  })()`),
  true,
);
check(
  'the dialog names the profile it applies to',
  await evaluate("document.getElementById('settingsProfileName').textContent.trim().length > 0"),
  true,
);
check(
  'the unranked-mods toggle is a checkbox',
  await evaluate("document.getElementById('set-includeUnrankedMods').type"),
  'checkbox',
);
/*
 * The relax pricing choice only means anything while unranked mods are being counted, so it
 * follows the toggle. Dimmed rather than hidden: its hint is most of the reason to open
 * this dialog at all.
 */
check(
  'the relax pricing choice follows the toggle',
  await evaluate(`(() => {
    const toggle = document.getElementById('set-includeUnrankedMods');
    const choice = document.getElementById('set-unrankedModPp');
    const setTo = (on) => {
      toggle.checked = on;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      return [choice.disabled, choice.closest('.setting').classList.contains('setting--inactive')];
    };
    const off = setTo(false);
    const on = setTo(true);
    return JSON.stringify({ off, on });
  })()`),
  JSON.stringify({ off: [true, true], on: [false, false] }),
);
await evaluate("document.getElementById('settingsCancel').click()");
check('Cancel closes the settings dialog', await shown('settingsModal'), 'none');

await evaluate("document.getElementById('optionsBtn').click()");
await evaluate("document.getElementById('optSettings').click()");
await evaluate(
  "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
);
check('Escape closes the settings dialog', await shown('settingsModal'), 'none');

await evaluate("document.getElementById('optionsBtn').click()");
await evaluate("document.getElementById('optSettings').click()");
await evaluate(`(() => {
  const el = document.getElementById('settingsModal');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
})()`);
check('backdrop click closes the settings dialog', await shown('settingsModal'), 'none');

console.log('\nprofiles dialog');
check('profiles dialog is hidden on load', await shown('profilesModal'), 'none');
await evaluate("document.getElementById('optionsBtn').click()");
await evaluate("document.getElementById('optProfiles').click()");
check('profiles dialog opens', await shown('profilesModal'), 'grid');
check(
  'the active profile is listed and marked',
  await evaluate("document.querySelectorAll('.profile-row--active').length"),
  1,
);
// The only profile must not be deletable: the app needs somewhere to write the next score.
check(
  'Delete is disabled when there is only one profile',
  await evaluate(`(() => {
    const rows = document.querySelectorAll('.profile-row');
    if (rows.length !== 1) return 'skipped';
    return document.querySelector('.profile-row [data-act="delete"]').disabled;
  })()`),
  true,
);
check(
  'the active profile offers no "Switch to"',
  await evaluate(
    "document.querySelector('.profile-row--active [data-act=\"switch\"]') === null",
  ),
  true,
);
await evaluate("document.getElementById('profilesClose').click()");
check('Close closes the profiles dialog', await shown('profilesModal'), 'none');

await evaluate("document.getElementById('optionsBtn').click()");
await evaluate("document.getElementById('optProfiles').click()");
await evaluate(
  "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
);
check('Escape closes the profiles dialog', await shown('profilesModal'), 'none');

/*
 * A profile counting things osu! does not must say so where the total is, not only on the
 * rows. This drives the renderer directly rather than saving a setting, so the check does
 * not depend on -- or change -- how the running profile is configured.
 */
console.log('\nunofficial scoring is disclosed');
// The element is hidden via the `hidden` attribute on a styled div -- the same shape as the
// bug this whole script exists for -- so check computed display, not just the attribute.
check('nothing is said while the profile matches osu!', await shown('countingNote'), 'none');

const noteFor = (counting) =>
  evaluate(
    `import('/js/sections.js').then((m) => m.countingNoteText(${JSON.stringify(counting)}))`,
  );

check('no note for an official profile', await noteFor({ includeUnrankedMods: false }), '');
const stripped = await noteFor({ includeUnrankedMods: true, preferStrippedPp: true });
check('it says the profile is not comparable', stripped.includes('not comparable'), true);
check('and names the stripped-mod pricing', stripped.includes('as if the mod had been off'), true);
check('and points at the asterisk on the rows', stripped.includes('marked with *'), true);
const asPlayed = await noteFor({ includeUnrankedMods: true, preferStrippedPp: false });
check('the as-played wording differs', asPlayed.includes('as played'), true);
check('and does not claim mods were removed', asPlayed.includes('as if the mod'), false);

console.log('\npp cells say when a value is not osu!s');
const ppCellFor = (play) =>
  evaluate(
    `import('/js/sections.js').then((m) => m.playRow(Object.assign(
      { title: 'x', version: 'y', mods: [], accuracy: 0.99, grade: 'S', playedAt: Date.now(),
        counted: true, ranked: true, passed: true, pp: 100, ppBasis: 'as-played' },
      ${JSON.stringify(play)},
    )))`,
  );

const officialPp = await ppCellFor({});
check('an official value is unmarked', officialPp.includes('play-detail__pp--unofficial'), false);
check('and carries no asterisk', officialPp.includes('play-detail__pp-mark'), false);

const unofficial = await ppCellFor({ ppBasis: 'without-unranked-mods', ranked: false });
check('a stripped-mod value is marked', unofficial.includes('play-detail__pp--unofficial'), true);
check('with an asterisk beside it', unofficial.includes('play-detail__pp-mark'), true);
check('and says osu! never awards it', unofficial.includes('never awards'), true);

const uncounted = await ppCellFor({ counted: false, ranked: false });
check('a value that does not count is dimmed', uncounted.includes('play-detail__pp--uncounted'), true);
const failedPlay = await ppCellFor({ counted: false, passed: false });
check('a failed play says so', failedPlay.includes('failed play never counts'), true);

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

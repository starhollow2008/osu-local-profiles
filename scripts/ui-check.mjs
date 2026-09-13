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
import { findBrowser } from '../src/http/screenshot.ts';

const URL_UNDER_TEST = process.argv[2] ?? 'http://localhost:7272/';
const PORT = 9333;

// The same finder the screenshot feature uses, rather than a second list that would only
// know about Windows -- which is what this was before, so the check could not run at all on
// macOS or Linux.
const binary = findBrowser();
if (!binary) {
  console.error('no Chromium browser found (looked in the usual places and on PATH)');
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
    // The preview check presses play from script, which is not a user gesture.
    '--autoplay-policy=no-user-gesture-required',
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

/*
 * `SKIP` is for a check that cannot be made against the profile this is being run on -- not
 * for one that failed. Returning it counted as a failure before, so a machine with two
 * profiles saw a permanently red line that said nothing about the build.
 */
const SKIP = Symbol('skipped');

const check = (name, actual, expected) => {
  if (actual === SKIP || actual === 'skipped') {
    console.log(`  SKIP  ${name}  (does not apply to this profile)`);
    return;
  }
  const pass = actual === expected;
  checks.push(pass);
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `  (got "${actual}", want "${expected}")`}`);
};

console.log('\non load');
check('reset dialog is hidden', await shown('resetModal'), 'none');
// The beatmap index notice is for a first launch or a slow re-check, never a normal start.
check(
  'the beatmap index notice is not shown once the index exists',
  await evaluate(`(async () => {
    const s = (await (await fetch('/api/state')).json()).indexing;
    if (s.active) return 'skipped';
    return getComputedStyle(document.getElementById('indexNotice')).display;
  })()`),
  'none',
);
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
// The kinds to import are offered by a preview, each with its count; before one, nothing is.
check('the kinds of play to import are hidden until a preview has run', await shown('backfillSources'), 'none');
await evaluate("document.getElementById('backfillCancel').click()");
check('Cancel closes the import dialog', await shown('backfillModal'), 'none');

await evaluate("document.getElementById('optionsBtn').click()");
await evaluate("document.getElementById('optBackfill').click()");
await evaluate(
  "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
);
check('Escape closes the import dialog', await shown('backfillModal'), 'none');

/*
 * The play tracking filter. Everything here is generated, three-state and long enough to
 * scroll, so nothing about it is visible to a unit test: whether the controls are really inert
 * while the switch is off, whether a chip's state shows, and whether the sentence under the
 * grid says what the grid means.
 */
console.log('\nplay tracking filter');
/*
 * These assert the dialog's *starting* state, which only means anything on a profile that has
 * not set a filter. Rather than overwrite a real one to make the check pass -- the filter is
 * the one setting whose effect cannot be undone -- a profile that has one is skipped, the same
 * way the favourites checks are.
 */
const filterInUse = await evaluate(
  "(async () => (await (await fetch('/api/state')).json()).settings.trackingFilter.enabled)()",
);
const unlessSet = (value) => (filterInUse ? SKIP : value);

check('the filter dialog is hidden on load', await shown('filterModal'), 'none');
await evaluate("document.getElementById('optionsBtn').click()");
await evaluate("document.getElementById('optFilter').click()");
check('the filter dialog opens', await shown('filterModal'), 'grid');
check('options menu closed behind it', await shown('optionsMenu'), 'none');
check(
  'it opens switched off',
  unlessSet(await evaluate("document.getElementById('filterEnabled').checked")),
  false,
);
check(
  'every criterion is inert while it is off',
  unlessSet(
    await evaluate(
      "[...document.querySelectorAll('#filterBody input, #filterBody button')].every((c) => c.disabled)",
    ),
  ),
  true,
);
check(
  'and the nine criteria are all there',
  await evaluate("document.querySelectorAll('#filterBody .tfilter-section').length"),
  9,
);
// Every mod in all four rulesets, less Autoplay, Cinema and ScoreV2, plus this app's own nomod.
check(
  'every mod in the game has a chip',
  await evaluate("document.querySelectorAll('#tf-mods .mod-chip').length"),
  67,
);
check(
  'the readout starts by saying nothing is excluded',
  unlessSet(await evaluate("document.getElementById('tf-mods-readout').textContent.trim()")),
  'Every mod combination counts.',
);

console.log('\nafter switching the filter on');
await evaluate(`(() => {
  const box = document.getElementById('filterEnabled');
  box.checked = true;
  box.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
check(
  'the criteria become editable',
  await evaluate(
    "[...document.querySelectorAll('#filterBody input, #filterBody button')].some((c) => !c.disabled)",
  ),
  true,
);
const chips = await evaluate(`(() => {
  // From a known state, so the sentence below is this click's doing and not the profile's.
  document.getElementById('tf-mods-all').click();
  const chip = document.querySelector('#tf-mods .mod-chip[data-mod="HD"]');
  const out = {};
  chip.click();
  out.required = chip.classList.contains('mod-chip--required');
  out.readoutRequired = document.getElementById('tf-mods-readout').textContent.trim();
  chip.click();
  out.excluded = chip.classList.contains('mod-chip--excluded');
  chip.click();
  out.backToPlain =
    !chip.classList.contains('mod-chip--required') && !chip.classList.contains('mod-chip--excluded');
  document.getElementById('tf-mods-none').click();
  out.readoutNone = document.getElementById('tf-mods-readout').textContent.trim();
  document.getElementById('tf-mods-all').click();
  out.readoutAll = document.getElementById('tf-mods-readout').textContent.trim();
  return out;
})()`);
check('one click on a mod requires it', chips.required, true);
check('and the readout says so', chips.readoutRequired, 'Tracks plays that use HD.');
check('a second click excludes it', chips.excluded, true);
check('a third click lets it be either', chips.backToPlain, true);
check('"Allow none" means no mods at all', chips.readoutNone, 'Tracks plays with no mods at all.');
check('"Allow every mod" clears the section', chips.readoutAll, 'Every mod combination counts.');

const range = await evaluate(`(() => {
  const root = document.getElementById('tf-stars');
  const max = root.querySelector('[data-bound="max"]');
  max.value = '69';
  max.dispatchEvent(new Event('input', { bubbles: true }));
  const fields = root.nextElementSibling;
  const fill = root.querySelector('[data-fill]');
  return {
    typed: fields.querySelector('[data-field="max"]').value,
    // The filled span has to stop where the handle is, or the control lies about its range.
    fill: getComputedStyle(fill).right !== '0px',
  };
})()`);
check('dragging the star ceiling in sets the text field', range.typed, '6.90');
check('and the filled track follows it', range.fill, true);
check(
  'a filter that can match nothing says so',
  await evaluate(`(() => {
    for (const box of document.querySelectorAll('#filterBody [data-mode]')) {
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const warning = document.getElementById('filterImpossible');
    return getComputedStyle(warning).display !== 'none' && warning.textContent.includes('No mode');
  })()`),
  true,
);

console.log('\nleaving the filter dialog');
await evaluate("document.getElementById('filterCancel').click()");
check('Cancel closes it', await shown('filterModal'), 'none');
check(
  'and nothing it changed was saved',
  unlessSet(
    await evaluate(
      "(async () => (await (await fetch('/api/state')).json()).settings.trackingFilter.enabled)()",
    ),
  ),
  false,
);
await evaluate("document.getElementById('optionsBtn').click()");
await evaluate("document.getElementById('optFilter').click()");
await evaluate(
  "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
);
check('Escape closes it', await shown('filterModal'), 'none');

console.log('\nfavorite beatmaps');
check(
  'the Beatmaps section has its Favorite Beatmaps heading',
  await evaluate("document.querySelector('#section-beatmaps h3.title').firstChild.textContent.trim()"),
  'Favorite Beatmaps',
);
// osu! opens with three rows of two.
check(
  'at most six cards before "show more"',
  await evaluate("document.querySelectorAll('#favoriteBeatmaps .beatmapset-panel').length <= 6"),
  true,
);
check(
  'the difficulty popup is hidden on load',
  await shown('beatmapsPopup'),
  'none',
);
const fav = await evaluate(`(async () => {
  const panel = document.querySelector('#favoriteBeatmaps .beatmapset-panel');
  if (!panel) return null;
  const row = panel.querySelector('[data-beatmaps-popup]');
  row.scrollIntoView({ block: 'center' });
  await new Promise((r) => setTimeout(r, 50));
  row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const popup = document.getElementById('beatmapsPopup');
  const stats = panel.querySelector('.beatmapset-panel__info-row--stats').getBoundingClientRect();
  const extra = row.getBoundingClientRect();
  const p = popup.getBoundingClientRect();
  const c = panel.getBoundingClientRect();
  const result = {
    height: c.height,
    open: getComputedStyle(popup).display !== 'none',
    rows: popup.querySelectorAll('.beatmaps-popup-item').length,
    under: Math.abs(p.top - c.bottom) < 2 && Math.abs(p.width - c.width) < 2,
    menu: getComputedStyle(panel.querySelector('.beatmapset-panel__menu')).opacity,
    // Everything the card shows while open has to fit inside it without overlapping.
    fits: stats.bottom <= extra.top + 1 && extra.bottom <= c.bottom + 1,
  };
  document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 650));
  result.closes = getComputedStyle(popup).display === 'none';
  return result;
})()`);
if (fav === null) {
  for (const name of ['cards are 100px', 'hovering the difficulties opens the popup', 'it lists them',
    'it sits under the card, the same width', 'the heart and download show', 'the rows fit the card',
    'it closes after the pointer leaves']) check(name, SKIP);
} else {
  check("cards are osu!'s 100px", fav.height, 100);
  check('hovering the difficulties opens the popup', fav.open, true);
  check('it lists them', fav.rows > 0, true);
  check('it sits under the card, the same width', fav.under, true);
  check('the heart and download show', fav.menu, '1');
  check('the rows fit the card', fav.fits, true);
  check('it closes after the pointer leaves', fav.closes, true);
}
check(
  'a score row offers to favourite or unfavourite its beatmap',
  await evaluate(`(() => {
    const button = document.querySelector('#topRanks [data-play-menu][data-set]:not([data-set=""])');
    if (!button) return ${JSON.stringify('skipped')};
    button.click();
    const menu = document.getElementById('playMenu');
    const fav = !menu.querySelector('[data-act="favorite"]').hidden;
    const unfav = !menu.querySelector('[data-act="unfavorite"]').hidden;
    document.body.click();
    return fav !== unfav;
  })()`),
  true,
);

/*
 * The audio preview and osu-web's floating player. Pressing play must reach "playing", move
 * the ring and bring the bar up; pressing again must *pause* and keep the place, and once
 * more carry on from it. Needs osu.ppy.sh, so no network is a skip.
 */
const audio = await evaluate(`(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  const buttons = [...document.querySelectorAll('#favoriteBeatmaps [data-audio-play]')];
  if (buttons.length === 0) return null;
  const button = buttons[0];
  const panel = button.closest('.beatmapset-panel');
  const bar = document.getElementById('audioPlayer');
  const out = { hiddenBefore: getComputedStyle(bar).opacity === '0' };
  const progressOf = (el) => Number(getComputedStyle(el).getPropertyValue('--progress'));
  const until = async (test) => { for (let i = 0; i < 40 && !test(); i++) await w(100); return test(); };

  button.click();
  if (!(await until(() => panel.dataset.audioState === 'playing'))) {
    button.click();
    return { reached: false };
  }
  out.reached = true;
  await w(900);
  out.progress = progressOf(panel);
  out.ring = getComputedStyle(panel.querySelector('.beatmapset-panel__play-progress')).opacity;
  const r = bar.getBoundingClientRect();
  out.placed = Math.round(r.bottom) === window.innerHeight && Math.round(r.right) === document.documentElement.clientWidth
    && r.height === 40 && r.width <= 520 && getComputedStyle(bar).opacity === '1';
  out.time = document.getElementById('audioCurrent').textContent + ' / ' + document.getElementById('audioTotal').textContent;
  out.prevOnFirst = bar.dataset.audioHasPrev;

  button.click();
  await until(() => panel.dataset.audioState === 'paused');
  out.paused = panel.dataset.audioState + ' ' + bar.dataset.audioState;
  const pausedAt = progressOf(bar);
  await w(400);
  out.kept = pausedAt > 0 && progressOf(bar) === pausedAt;

  button.click();
  await until(() => panel.dataset.audioState === 'playing');
  await w(200);
  out.resumed = panel.dataset.audioState === 'playing' && progressOf(bar) >= pausedAt;

  document.getElementById('audioToggle').click();
  await until(() => bar.dataset.audioState === 'paused');
  out.barPauses = bar.dataset.audioState;

  // The volume bar, pressed a quarter of the way along.
  const vol = document.getElementById('audioVolume');
  const vr = vol.getBoundingClientRect();
  const at = { clientX: vr.left + vr.width / 4, clientY: vr.top + 1, button: 0, pointerId: 1, bubbles: true };
  vol.dispatchEvent(new PointerEvent('pointerdown', at));
  vol.dispatchEvent(new PointerEvent('pointerup', at));
  out.volume = Math.abs(Number(getComputedStyle(bar).getPropertyValue('--volume')) - 0.25) < 0.02
    && bar.dataset.audioVolume === 'quiet'
    && JSON.parse(localStorage.getItem('osu-local-profiles:audio')).volume < 0.3;
  document.getElementById('audioMute').click();
  out.muted = bar.dataset.audioVolume;
  document.getElementById('audioMute').click();

  // Next goes to the next playable card and leaves the first as a plain card.
  if (buttons.length > 1) {
    bar.querySelector('[data-audio-nav=next]').click();
    const second = buttons[1].closest('.beatmapset-panel');
    await until(() => second.dataset.audioState === 'playing');
    out.next = second.dataset.audioState === 'playing' && !panel.hasAttribute('data-audio-state');
    buttons[1].click();
    await until(() => second.dataset.audioState === 'paused');
  }
  await w(4300);
  out.hidesAfter = bar.dataset.audioVisible + ' ' + getComputedStyle(bar).opacity;
  return out;
})()`);
const AUDIO_CHECKS = ['the player bar is hidden until something plays', 'pressing play plays the preview',
  'the ring moves', 'it stays visible while playing', "the bar comes up in the bottom right, osu!'s 520x40",
  "it shows the clip's time", 'previous is dimmed on the first card', 'pressing the card again pauses it',
  'and keeps its place', 'pressing it once more carries on from there', "the bar's own button pauses too",
  'the volume slider sets and keeps the volume', 'mute shows the muted speaker',
  'next plays the next card', 'the bar goes four seconds after pausing'];
if (audio === null || audio.reached === false) {
  for (const name of AUDIO_CHECKS) check(name, SKIP);
} else {
  check(AUDIO_CHECKS[0], audio.hiddenBefore, true);
  check(AUDIO_CHECKS[1], audio.reached, true);
  check(AUDIO_CHECKS[2], audio.progress > 0, true);
  check(AUDIO_CHECKS[3], audio.ring, '1');
  check(AUDIO_CHECKS[4], audio.placed, true);
  check(AUDIO_CHECKS[5], /^\d:\d\d \/ \d:\d\d$/.test(audio.time), true);
  check(AUDIO_CHECKS[6], audio.prevOnFirst, '0');
  check(AUDIO_CHECKS[7], audio.paused, 'paused paused');
  check(AUDIO_CHECKS[8], audio.kept, true);
  check(AUDIO_CHECKS[9], audio.resumed, true);
  check(AUDIO_CHECKS[10], audio.barPauses, 'paused');
  check(AUDIO_CHECKS[11], audio.volume, true);
  check(AUDIO_CHECKS[12], audio.muted, 'muted');
  check(AUDIO_CHECKS[13], audio.next ?? SKIP, true);
  check(AUDIO_CHECKS[14], audio.hidesAfter, '0 0');
}
check(
  'an Explicit card has no play button',
  await evaluate(`(() => {
    const explicit = [...document.querySelectorAll('#favoriteBeatmaps .beatmapset-panel')]
      .filter((p) => p.querySelector('.beatmapset-badge--nsfw'));
    if (explicit.length === 0) return ${JSON.stringify('skipped')};
    return explicit.every((p) => !p.querySelector('[data-audio-play]'));
  })()`),
  true,
);

// An unfinished play has no score to pin or remove: its menu is the beatmap's alone.
check(
  "an unfinished play's menu offers only its beatmap",
  await evaluate(`(() => {
    const button = document.querySelector('#recentPlays [data-play-menu][data-kind="incomplete"]');
    if (!button) return ${JSON.stringify('skipped')};
    button.click();
    const visible = [...document.querySelectorAll('#playMenu [data-act]')]
      .filter((b) => !b.hidden).map((b) => b.dataset.act).join(',');
    document.body.click();
    return visible === 'favorite' || visible === 'unfavorite';
  })()`),
  true,
);

console.log('\nopen in browser on start');
// Read, flip, read back from the server, flip back: the check must leave config.json as it
// found it, since it runs against a real install.
const toggle = await evaluate(`(async () => {
  const state = async () => (await (await fetch('/api/state')).json()).app.config.openBrowser;
  document.getElementById('optionsBtn').click();
  const button = document.getElementById('optOpenBrowser');
  const before = await state();
  const shownBefore = button.getAttribute('aria-checked') === String(before);
  button.click();
  await new Promise((r) => setTimeout(r, 300));
  const after = await state();
  const menuOpen = getComputedStyle(document.getElementById('optionsMenu')).display !== 'none';
  const shownAfter = button.getAttribute('aria-checked') === String(after);
  button.click();
  await new Promise((r) => setTimeout(r, 300));
  const restored = (await state()) === before;
  document.body.click();
  return { shownBefore, flipped: after === !before, shownAfter, menuOpen, restored };
})()`);
check('the switch shows the saved setting', toggle.shownBefore, true);
check('pressing it saves the opposite', toggle.flipped, true);
check('and the switch follows', toggle.shownAfter, true);
check('the menu stays open while it is pressed', toggle.menuOpen, true);
check('pressing it again puts it back', toggle.restored, true);

console.log('\nshare dialog');
check('the share dialog is hidden on load', await shown('shareModal'), 'none');
await evaluate("document.getElementById('optionsBtn').click()");
await evaluate("document.getElementById('optShare').click()");
check('it opens', await shown('shareModal'), 'grid');
check(
  'the web page export is the primary action',
  await evaluate("document.getElementById('shareHtml').classList.contains('primary')"),
  true,
);
/*
 * Whether an image can be rendered depends on a browser being installed. Either way the
 * button and its note have to agree, rather than offering something that cannot happen.
 */
check(
  'the image button agrees with whether a browser was found',
  await evaluate(`(() => {
    const button = document.getElementById('shareScreenshot');
    const note = document.getElementById('shareScreenshotNote').textContent;
    return button.disabled === note.includes('Needs Chrome');
  })()`),
  true,
);
// The live page is never offered to the network any more: the option was removed outright.
check(
  'the dialog offers no network sharing',
  await evaluate(`(() => {
    const text = document.getElementById('shareModal').textContent;
    return !document.getElementById('shareNetwork') && !/network|shareOnNetwork/i.test(text);
  })()`),
  true,
);
await evaluate(
  "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
);
check('Escape closes the share dialog', await shown('shareModal'), 'none');

/*
 * `?export=1` hides everything that only makes sense while using the page. The screenshot
 * renderer relies on it, so a control leaking through would end up in someone's image.
 */
/*
 * The shared copy: built exactly as Share builds it, then loaded into a frame and used. It
 * must render the same profile, keep the controls that change it out of sight, carry nothing
 * about this machine, and -- the point of it -- respond: Show more has to show more.
 */
console.log('\nshared copy');
const sharedCopy = JSON.parse(await evaluate(`(async () => {
  const { buildInteractiveHtml } = await import('/js/share-copy.js');
  const html = await buildInteractiveHtml();
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:900px;opacity:0;pointer-events:none';
  document.body.append(frame);
  const loaded = new Promise((r) => frame.addEventListener('load', r, { once: true }));
  frame.srcdoc = html;
  await loaded;
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  for (let i = 0; i < 100 && doc.body.dataset.rendered !== 'true'; i++) await new Promise((r) => setTimeout(r, 100));
  const display = (selector) => {
    const el = doc.querySelector(selector);
    return el ? win.getComputedStyle(el).display : 'missing';
  };
  const snap = JSON.parse(doc.getElementById('snapshot').textContent);
  const rows = () => doc.querySelectorAll('#recentPlays .play-detail').length;
  const before = rows();
  const more = doc.querySelector('#recentPlays [data-show-more]');
  more?.click();
  for (let i = 0; i < 30 && rows() === before; i++) await new Promise((r) => setTimeout(r, 100));
  const out = {
    rendered: doc.body.dataset.rendered === 'true',
    sameName: doc.getElementById('pname').textContent === document.getElementById('pname').textContent,
    sameMedals:
      doc.querySelectorAll('#medalGroups [data-medal]').length ===
      document.querySelectorAll('#medalGroups [data-medal]').length,
    options: display('#optionsBtn'),
    installs: snap.state.installs.length,
    me: display('#section-me'),
    meEmpty: document.getElementById('aboutView').classList.contains('about--empty'),
    showMore: more ? rows() > before : 'none needed',
    kb: Math.round(html.length / 1024),
  };
  frame.remove();
  return JSON.stringify(out);
})()`));
check('the copy renders on its own', sharedCopy.rendered, true);
check('as the same profile', sharedCopy.sameName, true);
check('with the same medals', sharedCopy.sameMedals, true);
check('and none of the controls that change it', sharedCopy.options, 'none');
check('it says nothing about where osu! is installed', sharedCopy.installs, 0);
if (sharedCopy.meEmpty) {
  check('an empty me! is left out, rather than asking a visitor to write it', sharedCopy.me, 'none');
}
if (sharedCopy.showMore === 'none needed') {
  console.log('  SKIP  show more  (this profile has too few plays to need it)');
} else {
  check('show more shows more', sharedCopy.showMore, true);
}
console.log(`  (the copy is ${sharedCopy.kb}KB)`);

console.log('\nexport mode');
check(
  'the page reports when it has finished drawing',
  await evaluate("document.body.dataset.rendered"),
  'true',
);
check(
  'export mode hides every control',
  await evaluate(`(() => {
    document.body.classList.add('export-mode');
    const hidden = ['.menu-wrap', '.tracking-pill', '.section-order', '.play-detail__menu']
      .map((sel) => document.querySelector(sel))
      .filter(Boolean)
      .every((el) => getComputedStyle(el).display === 'none');
    document.body.classList.remove('export-mode');
    return hidden;
  })()`),
  true,
);

console.log('\nheader figures');
// osu-web's three figures under the chart, in its order.
check(
  'the figures are Medals, pp and Total Play Time',
  await evaluate(
    "[...document.querySelectorAll('.profile-detail-stats__values--grid .value-display__label')].map((l) => l.textContent.trim()).join(' | ')",
  ),
  'Medals | pp | Total Play Time',
);
check(
  "play time reads as osu!'s does",
  await evaluate("/^(\\d[\\d,]*d )?\\d+h \\d+m$/.test(document.getElementById('playTime').textContent)"),
  true,
);
check(
  'play time spans two columns',
  await evaluate("getComputedStyle(document.getElementById('playTime').parentElement).gridColumnEnd"),
  'span 2',
);
check(
  'the medal figure is a whole number',
  await evaluate("/^\\d[\\d,]*$/.test(document.getElementById('medalTotal').textContent)"),
  true,
);
check(
  "the level number is set at osu!'s size",
  await evaluate("getComputedStyle(document.querySelector('.user-level__level')).fontSize"),
  '20px',
);

console.log('\nmedals');
check(
  "medals are osu!'s groups, in its order: Mod Introduction, then Skill & Dedication",
  await evaluate(
    "[...document.querySelectorAll('#medalGroups .medals-group__title')].map((t) => t.textContent).join('|')",
  ),
  'Mod Introduction|Skill & Dedication',
);
check(
  'the section heading carries no count',
  await evaluate("document.querySelector('#section-medals h2.title').textContent.trim()"),
  'Medals',
);
// No names, dates or progress on the page: all of that is in the hover card. Rendered text
// rather than textContent, because the offline placeholder behind each icon stamps a star
// level on its face and is hidden once osu!'s own icon has loaded.
// Waits for the icons to settle first: until one arrives its placeholder is what shows.
check(
  'the medals themselves carry no text',
  await evaluate(`(async () => {
    const images = [...document.querySelectorAll('#medalGroups img')];
    await Promise.all(images.map((i) => i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })));
    await new Promise((r) => setTimeout(r, 50));
    return document.getElementById('medalGroups').innerText.replace(/\\s+/g, ' ').trim();
  })()`),
  'Mod Introduction Skill & Dedication',
);
check(
  'there are no progress bars',
  await evaluate("document.querySelectorAll('#medalGroups [class*=progress]').length"),
  0,
);
/*
 * Every medal carries osu!'s own icon over a drawn placeholder, so a failed request -- or a
 * page opened with no network -- still shows a complete medal rather than a broken image.
 */
check(
  'each medal has both an icon and a drawn fallback',
  await evaluate(`(() => {
    const medals = [...document.querySelectorAll('#medalGroups .badge-achievement')];
    return medals.length > 0 && medals.every(
      (m) => m.querySelector('img.badge-achievement__image') && m.querySelector('svg.badge-achievement__placeholder'),
    );
  })()`),
  true,
);
check(
  "a listing medal is osu!'s 70px wide",
  await evaluate("document.querySelector('#medalGroups .badge-achievement').getBoundingClientRect().width"),
  70,
);
check(
  'the medal card is hidden on load',
  await shown('medalTooltip'),
  'none',
);

// Hover a medal in view, as a pointer would, and read the card that comes up.
const card = await evaluate(`(async () => {
  const badge = document.querySelector('#medalGroups [data-medal]');
  badge.scrollIntoView({ block: 'center' });
  await new Promise((r) => setTimeout(r, 50));
  badge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 350));
  const el = document.getElementById('medalTooltip');
  const b = badge.getBoundingClientRect();
  const c = el.getBoundingClientRect();
  return {
    display: getComputedStyle(el).display,
    grouping: el.querySelector('.medal-tooltip__grouping')?.textContent ===
      badge.closest('.medals-group__group').querySelector('.medals-group__title').textContent,
    name: el.querySelector('.medal-tooltip__name')?.textContent === badge.getAttribute('aria-label'),
    description: (el.querySelector('.medal-tooltip__description')?.textContent ?? '').length > 0,
    date: /^(Achieved|Locked)/.test(el.querySelector('.medal-tooltip__date')?.textContent.trim() ?? ''),
    width: c.width,
    placed: c.bottom <= b.top || c.top >= b.bottom,
    onScreen: c.left >= 0 && c.right <= innerWidth && c.top >= 0 && c.bottom <= innerHeight,
  };
})()`);
check('hovering a medal opens its card', card.display, 'block');
check('the card is headed by the group its medal is in', card.grouping, true);
check("the card names the medal", card.name, true);
check('the card describes it', card.description, true);
check('the card says when it was achieved, or that it is locked', card.date, true);
check("the card is osu!'s 200px", card.width, 200);
check('the card sits clear of the medal, not over it', card.placed, true);
check('the card is fully on screen', card.onScreen, true);
check(
  'moving away closes it',
  await evaluate(`(async () => {
    document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 350));
    return getComputedStyle(document.getElementById('medalTooltip')).display;
  })()`),
  'none',
);

console.log('\nsection order');
check(
  'every section has reorder controls',
  await evaluate(
    "[...document.querySelectorAll('.page-extra')].every((s) => s.querySelector(':scope > .section-order'))",
  ),
  true,
);
// Hidden until the section is hovered, so they do not clutter a page nobody is editing.
check(
  'they are out of the way until hovered',
  await evaluate(
    "getComputedStyle(document.querySelector('.section-order')).opacity",
  ),
  '0',
);
// The ends cannot move further, and saying so beats a control that silently does nothing.
check(
  'the first section cannot move up and the last cannot move down',
  await evaluate(`(() => {
    const sections = [...document.querySelectorAll('.page-extra')];
    const first = sections[0].querySelector('[data-move="up"]');
    const last = sections[sections.length - 1].querySelector('[data-move="down"]');
    return JSON.stringify({ first: first.disabled, last: last.disabled });
  })()`),
  JSON.stringify({ first: true, last: true }),
);
check(
  'the tab bar follows the sections',
  await evaluate(`(() => {
    const tabs = [...document.querySelectorAll('#sectionTabs a')].map((a) => a.getAttribute('href'));
    const sections = [...document.querySelectorAll('.page-extra')].map((s) => '#' + s.id);
    return JSON.stringify(tabs) === JSON.stringify(sections);
  })()`),
  true,
);
// Moving is a real DOM move, so the check is that the order actually changed.
const reordered = await evaluate(`(() => {
  const before = [...document.querySelectorAll('.page-extra')].map((s) => s.id);
  document.querySelector('.page-extra [data-move="down"]').click();
  const after = [...document.querySelectorAll('.page-extra')].map((s) => s.id);
  return JSON.stringify({ before, after });
})()`);
const { before, after } = JSON.parse(reordered);
check('moving a section down swaps it with the next', after[0] === before[1] && after[1] === before[0], true);
/*
 * Put the page back the way it was found, so the check leaves no trace on the profile.
 *
 * Polled rather than slept on. Each move posts the new order and re-renders when the server
 * answers, so a fixed wait races that response -- which made this check fail perhaps one run
 * in three while the stored order was correct the whole time.
 */
await evaluate("document.querySelectorAll('.page-extra')[1].querySelector('[data-move=\"up\"]').click()");
let restored = '';
for (let i = 0; i < 20; i++) {
  restored = await evaluate("[...document.querySelectorAll('.page-extra')].map((s) => s.id).join(',')");
  if (restored === before.join(',')) break;
  await sleep(150);
}
check('and moving it back restores the original order', restored, before.join(','));

console.log('\nthe me! section');
// Not "the first section": the order is the user's to choose, which is the point of 5.7.
check('it is one of the sections', await evaluate(
  "!!document.querySelector('.page-extra#section-me')"), true);
check('the editor starts closed', await shown('aboutEdit'), 'none');
check(
  'clicking the text opens the editor',
  await evaluate(`(() => {
    document.getElementById('aboutView').click();
    return JSON.stringify({
      edit: getComputedStyle(document.getElementById('aboutEdit')).display,
      view: getComputedStyle(document.getElementById('aboutView')).display,
    });
  })()`),
  JSON.stringify({ edit: 'block', view: 'none' }),
);
check(
  'Cancel puts it back without saving',
  await evaluate(`(() => {
    document.getElementById('aboutText').value = 'discard me';
    document.getElementById('aboutCancel').click();
    return JSON.stringify({
      edit: getComputedStyle(document.getElementById('aboutEdit')).display,
      text: document.getElementById('aboutView').textContent.includes('discard me'),
    });
  })()`),
  JSON.stringify({ edit: 'none', text: false }),
);

/*
 * me! is osu!'s BBCode, rendered by web/js/bbcode.js. Anything that is not one of its tags
 * must render as the characters it is: HTML typed or imported into it never becomes HTML.
 */
const aboutFor = (text) =>
  evaluate("import('/js/bbcode.js').then((m) => m.bbcodeHtml(" + JSON.stringify(text) + '))');

const hostile = await aboutFor('<script>alert(1)</script> & <b>bold</b>');
check('a script tag is escaped, not rendered', hostile.includes('<script>'), false);
check('and survives as visible text', hostile.includes('&lt;script&gt;'), true);
check('an ampersand is escaped once', hostile.includes('&amp;'), true);

const paragraphs = await aboutFor('one' + String.fromCharCode(10, 10) + 'two');
check('a blank line is two line breaks, as on osu!', paragraphs, 'one<br><br>two');
const lineBreak = await aboutFor('one' + String.fromCharCode(10) + 'two');
check('a single newline is a line break', lineBreak, 'one<br>two');

const link = await aboutFor('see https://osu.ppy.sh/users/2 for more');
check('a bare URL becomes a link', link.includes('href="https://osu.ppy.sh/users/2"'), true);
check('and it opens safely', link.includes('noopener'), true);
/*
 * Typed anchor markup: the URL inside it is a URL the user wrote, so linking it is the
 * honest plain-text behaviour. What must never happen is the surrounding markup becoming
 * real -- and the href must not swallow the rest of the line, which is what escaping before
 * matching used to do.
 */
const fakeLink = await aboutFor('<a href="https://evil.example">click</a>');
check('the surrounding markup stays visible text', fakeLink.includes('&lt;a href='), true);
check('and does not become an element', /<a [^>]*>click/.test(fakeLink), false);
check(
  'the href stops at the quote instead of eating the line',
  fakeLink.includes('href="https://evil.example"'),
  true,
);
const punctuated = await aboutFor('see https://osu.ppy.sh/users/2, then stop.');
check(
  'a trailing comma is punctuation, not part of the URL',
  punctuated.includes('href="https://osu.ppy.sh/users/2"'),
  true,
);
check('and it is still shown', punctuated.includes('</a>, then stop.'), true);

check('nothing at all renders as nothing', await aboutFor(''), '');
check('a link that could run something stays text', (await aboutFor('[url=javascript:alert(1)]x[/url]')).includes('<a'), false);

console.log('\nme! editor');
check(
  "the toolbar is osu!'s, in its order",
  await evaluate("[...document.querySelectorAll('#aboutToolbar [data-bb]')].map((b) => b.dataset.bb).join(' ')"),
  'bold italic strikethrough heading link spoilerbox list-numbered list image imagemap',
);
check(
  'then Font Size and Help',
  await evaluate(`JSON.stringify([
    [...document.querySelectorAll('#aboutSize option')].filter((o) => o.value).map((o) => o.textContent + ' ' + o.value).join(', '),
    document.querySelector('#aboutToolbar .bbcode-editor__help').textContent.trim(),
  ])`),
  JSON.stringify(['Tiny 50, Small 85, Normal 100, Large 150', 'Help']),
);
check(
  'Bold wraps the selection and keeps it selected, as osu! does',
  await evaluate(`(() => {
    document.getElementById('aboutView').click();
    const box = document.getElementById('aboutText');
    box.value = 'say hello';
    box.setSelectionRange(4, 9);
    document.querySelector('#aboutToolbar [data-bb="bold"]').click();
    const out = JSON.stringify([box.value, box.value.slice(box.selectionStart, box.selectionEnd)]);
    document.getElementById('aboutCancel').click();
    return out;
  })()`),
  JSON.stringify(['say [b]hello[/b]', '[b]hello[/b]']),
);
check(
  'with nothing selected the cursor lands between the tags',
  await evaluate(`(() => {
    document.getElementById('aboutView').click();
    const box = document.getElementById('aboutText');
    box.value = '';
    box.setSelectionRange(0, 0);
    document.querySelector('#aboutToolbar [data-bb="heading"]').click();
    const out = JSON.stringify([box.value, box.selectionStart]);
    document.getElementById('aboutCancel').click();
    return out;
  })()`),
  JSON.stringify(['[heading][/heading]', 9]),
);
check(
  'Preview shows the page, and hides the text and toolbar',
  await evaluate(`(() => {
    document.getElementById('aboutView').click();
    document.getElementById('aboutText').value = '[b]x[/b]';
    document.getElementById('aboutPreviewToggle').click();
    const out = JSON.stringify([
      document.getElementById('aboutPreview').innerHTML,
      getComputedStyle(document.getElementById('aboutText')).display,
      getComputedStyle(document.getElementById('aboutToolbar')).display,
      document.getElementById('aboutPreviewToggle').textContent,
    ]);
    document.getElementById('aboutCancel').click();
    return out;
  })()`),
  JSON.stringify(['<strong>x</strong>', 'none', 'none', 'Write']),
);
check(
  'Save is the green one',
  await evaluate("parseInt(getComputedStyle(document.getElementById('aboutSave')).backgroundColor.split(',')[1], 10) > 150"),
  true,
);

console.log('\nedit profile dialog');
check('the identity dialog is hidden on load', await shown('identityModal'), 'none');
// The avatar and the name are the affordance -- osu!'s own header has no button here.
check(
  'the avatar opens it',
  await evaluate(`(() => {
    document.getElementById('avatar').click();
    return getComputedStyle(document.getElementById('identityModal')).display;
  })()`),
  'grid',
);
check(
  'it is prefilled with the profile name',
  await evaluate(
    "document.getElementById('identityName').value === document.getElementById('pname').textContent",
  ),
  true,
);
check(
  'both images offer upload and remove',
  // No nested template literals here: the inner one would interpolate in this one.
  await evaluate(
    "['avatar', 'cover'].every((k) => " +
      "document.querySelector('[data-upload=' + JSON.stringify(k) + ']') && " +
      "document.querySelector('[data-clear=' + JSON.stringify(k) + ']'))",
  ),
  true,
);
// The file picker must never be visible: it is opened from script.
check('the file picker stays out of the layout', await shown('identityFile'), 'none');
check(
  'looking up an account needs a press, and says so',
  await evaluate(
    "document.querySelector('.identity-heading + .setting__hint').textContent.includes('when you press the button')",
  ),
  true,
);
await evaluate(
  "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
);
check('Escape closes the identity dialog', await shown('identityModal'), 'none');

await evaluate("document.getElementById('pname').click()");
check('the name opens it too', await shown('identityModal'), 'grid');
await evaluate("document.getElementById('identityClose').click()");
check('Close closes it', await shown('identityModal'), 'none');

/*
 * The osu!stable note. Both halves of it were measured (roadmap 5.12): stable writes a score
 * when the results screen is left, and never records a play that was quit or failed.
 */
console.log('\nosu!stable note');
const stableNote = JSON.parse(await evaluate(`(() => {
  const notes = [...document.querySelectorAll('[data-stable-note]')];
  const state = notes.map((n) => n.hidden);
  return JSON.stringify({
    places: notes.length,
    inRecentPlays: !!document.querySelector('#section-recent_plays [data-stable-note]'),
    inScores: !!document.querySelector('#section-top_ranks [data-stable-note]'),
    hidden: state,
    text: notes[0]?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    dismissible: notes[0] ? notes[0].querySelectorAll('[data-dismiss-stable]').length : 0,
  });
})()`));
check('it can appear in Recent Plays', stableNote.inRecentPlays, true);
check('and in Scores', stableNote.inScores, true);
if (stableNote.hidden.every((h) => h)) {
  console.log('  SKIP  the note itself  (no osu!stable on this machine, or it was dismissed)');
} else {
  check('it says when a stable score arrives', stableNote.text.includes('leave the results'), true);
  check('and that quit or failed plays are not counted', stableNote.text.includes('not counted'), true);
  check('it can be dismissed two ways, as the counting note is', stableNote.dismissible, 2);
}

/*
 * osu!'s own two scoring scales, and the Classic mod on a stable play. Both are parity with
 * osu!'s own profile page: it lists a stable score as carrying CL, and its options menu has a
 * "lazer scoring" switch that is on by default.
 */
/*
 * An install with osu!stable and no osu!lazer has nothing that can say whether a beatmap is
 * ranked, so every beatmap counts toward pp and the page has to say so. That cannot happen on
 * a machine with lazer, so the wording is checked directly.
 */
console.log('\nno beatmap status source');
const noStatus = await evaluate(
  "import('/js/sections.js').then((m) => m.countingNoteText({ countUnresolved: true }))",
);
check('it says why every beatmap counts', noStatus.includes('does not record whether a beatmap is ranked'), true);
check('and that the beatmap settings cannot change it', noStatus.includes('cannot change'), true);
check('and that the profile is not comparable with osu!', noStatus.includes('not comparable'), true);

console.log('\nosu! scoring parity');
const scoring = JSON.parse(await evaluate(`(() => {
  const rows = [...document.querySelectorAll('#recentPlays .play-detail, #topRanks .play-detail')];
  // A badge's text is its title and then its acronym, so the acronym is the last text node.
  const mods = rows.map((r) =>
    [...r.querySelectorAll('.play-detail__mods .mod')].map((m) => [...m.querySelectorAll('text')].pop()?.textContent.trim() ?? ''));
  return JSON.stringify({
    toggle: !!document.getElementById('optLazerScoring'),
    on: document.getElementById('optLazerScoring')?.getAttribute('aria-checked'),
    withClassic: mods.filter((m) => m.includes('CL')).length,
    rows: rows.length,
  });
})()`));
check('the options menu carries a lazer scoring switch', scoring.toggle, true);
check('and it is on by default, as on osu!', scoring.on, 'true');
if (scoring.withClassic === 0) {
  console.log('  SKIP  the Classic mod  (this profile has no osu!stable scores on screen)');
} else {
  check('a stable play is listed with Classic, as osu! lists it', scoring.withClassic > 0, true);
}

/*
 * Switching scales moves the numbers with no recalculation -- both are stored per score. The
 * switch is put back afterwards, because this runs against a real profile.
 */
const switched = JSON.parse(await evaluate(`(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const totals = () => [...document.querySelectorAll('.profile-stats__value')].map((v) => v.textContent).join('|');
  const switchEl = document.getElementById('optLazerScoring');
  const before = totals();
  switchEl.click();
  await wait(1500);
  const after = totals();
  const checked = switchEl.getAttribute('aria-checked');
  switchEl.click();
  await wait(1500);
  return JSON.stringify({ changed: before !== after, checked, restored: totals() === before, back: switchEl.getAttribute('aria-checked') });
})()`));
check('switching to classic scoring changes the score totals', switched.changed, true);
check('and the switch reads as off while it is', switched.checked, 'false');
check('switching back restores the totals', switched.restored, true);
check('and the switch with them', switched.back, 'true');

console.log('\nimport from osu!');
check('the import dialog is hidden on load', await shown('importModal'), 'none');
check('Options offers it', await evaluate("!!document.getElementById('optImport')"), true);
await evaluate("document.getElementById('optionsBtn').click()");
await evaluate("document.getElementById('optImport').click()");
check('it opens', await shown('importModal'), 'grid');
check(
  'avatar, banner, flag and me! are ticked; favorites are not',
  await evaluate(`JSON.stringify(Object.fromEntries(
    [...document.querySelectorAll('#importModal [data-import]')].map((b) => [b.dataset.import, b.checked])))`),
  JSON.stringify({ avatar: true, cover: true, country: true, aboutMe: true, favorites: false }),
);
check(
  'nothing is asked of osu! until a button is pressed',
  await evaluate("document.getElementById('importFound').querySelector('.identity-candidate') === null"),
  true,
);
await evaluate("document.getElementById('importClose').click()");
check('Close closes it', await shown('importModal'), 'none');
check(
  'the favorites reminder only shows while the list is empty',
  await evaluate(`(() => {
    const count = Number(document.getElementById('favoriteCount').textContent.replace(/,/g, ''));
    return count > 0 ? document.getElementById('favoritesNote').hidden : true;
  })()`),
  true,
);

console.log('\nsettings dialog');
check('settings dialog is hidden on load', await shown('settingsModal'), 'none');
await evaluate("document.getElementById('optionsBtn').click()");
await evaluate("document.getElementById('optSettings').click()");
check('settings dialog opens', await shown('settingsModal'), 'grid');
check(
  'favorites are shared by every profile unless switched off',
  await evaluate("document.getElementById('sharedFavorites').checked"),
  true,
);
check('options menu closed behind it', await shown('optionsMenu'), 'none');

/*
 * A dialog taller than the window has to scroll itself. The backdrop is `position: fixed`
 * and centres its child, so an uncapped dialog runs off the top of the screen where
 * nothing -- not the dialog, not the page behind it -- can scroll to reach it. Settings is
 * the one that grows, so measure it rather than trusting the rule is still there.
 */
const dialogFit = await evaluate(`(() => {
  const el = document.querySelector('#settingsModal .modal');
  const r = el.getBoundingClientRect();
  return JSON.stringify({
    withinViewport: r.top >= -1 && r.bottom <= window.innerHeight + 1,
    scrolls: getComputedStyle(el).overflowY,
  });
})()`);
check('the settings dialog stays inside the window', JSON.parse(dialogFit).withinViewport, true);
check('and scrolls its own content', JSON.parse(dialogFit).scrolls, 'auto');
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
 * Counting attempts osu! could not submit is a plain toggle, and the only setting whose hint is
 * generated rather than fixed -- it says how many have been recorded -- so it is the one that
 * would render empty if the hint function were ever called wrongly.
 */
check(
  'the unsubmitted-attempts toggle is a checkbox',
  await evaluate("document.getElementById('set-countUnsubmittedAttempts').type"),
  'checkbox',
);
check(
  'and its hint says how many attempts have been recorded',
  await evaluate(`(() => {
    const hint = document.getElementById('set-countUnsubmittedAttempts')
      .closest('.setting').querySelector('.setting__hint').textContent;
    return hint.includes('so far.') || hint.includes('None have been recorded yet.');
  })()`),
  true,
);
// Six beatmap states, each its own box: they are separate decisions, not one switch.
check(
  'every unranked beatmap state has its own box',
  await evaluate(
    "document.querySelectorAll('#set-includeUnrankedMaps input[type=checkbox]').length",
  ),
  6,
);
check(
  'and that field stacks instead of squeezing into a row',
  await evaluate(`getComputedStyle(
    document.getElementById('set-includeUnrankedMaps').closest('.field')
  ).flexDirection`),
  'column',
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

/*
 * Deleting a removed score for good. The check presses a minus *once*: that must only ask,
 * never delete -- this runs against a real profile, and the second press would be real.
 */
if (await evaluate('Number(document.getElementById("removedCount")?.textContent || 0) > 0 || true')) {
  await evaluate("document.getElementById('optionsBtn').click()");
  await evaluate("document.getElementById('optSettings').click()");
  await sleep(700);
  const removed = JSON.parse(await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#removedList .removed-row')];
    const minus = rows.map((r) => r.querySelector('[data-delete]')).filter(Boolean);
    const first = minus[0];
    const before = first ? first.textContent.trim() : null;
    first?.click();
    return JSON.stringify({
      rows: rows.length,
      minus: minus.length,
      red: first ? parseInt(getComputedStyle(first).backgroundColor.slice(4), 10) > 150 : null,
      asked: first ? first.textContent.trim() : null,
      before,
      still: document.querySelectorAll('#removedList .removed-row').length,
      all: !!document.getElementById('removedDeleteAll'),
    });
  })()`));
  if (removed.rows === 0) {
    console.log('  SKIP  no removed scores on this profile to check the delete buttons against');
  } else {
    check('every removed score has a delete button', removed.minus, removed.rows);
    check('and it is red', removed.red, true);
    check('the first press only asks', removed.asked, 'Delete?');
    check('and deletes nothing', removed.still, removed.rows);
    check('there is a button to delete them all', removed.all, true);
  }
  await evaluate("document.getElementById('settingsCancel').click()");
}

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
console.log('\nscore actions');
check('the score menu is hidden on load', await shown('playMenu'), 'none');
check(
  'every score row offers one',
  await evaluate(`(() => {
    // Not every row in Recent Plays is a score. A play that was quit or failed has no
    // score behind it and so nothing to pin, reorder or remove -- excluded here rather
    // than given a menu whose every action would be meaningless.
    const rows = document.querySelectorAll(
      '#recentPlays .play-detail:not(.play-detail--incomplete)',
    );
    if (rows.length === 0) return 'no scores tracked';
    return [...rows].every((r) => r.querySelector('[data-play-menu]'));
  })()`),
  true,
);
check(
  'the menu opens beside the row that asked for it',
  await evaluate(`(() => {
    // An unpinned score's menu: Recent Plays can begin with an unfinished play, whose menu
    // has no Pin at all, and the check below is about an unpinned score.
    const button = document.querySelector(
      '#recentPlays [data-play-menu][data-kind="score"][data-pinned="0"]',
    );
    if (!button) return 'no scores tracked';
    button.click();
    const menu = document.getElementById('playMenu');
    if (getComputedStyle(menu).display === 'none') return 'stayed hidden';
    // Positioned in viewport coordinates, so it must be on screen and near the button.
    const m = menu.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    return m.left >= 0 && m.right <= window.innerWidth && Math.abs(m.top - b.bottom) < 20;
  })()`),
  true,
);
check(
  'an unpinned score is offered Pin, not Unpin',
  await evaluate(`(() => {
    const menu = document.getElementById('playMenu');
    return JSON.stringify({
      pin: menu.querySelector('[data-act=pin]').hidden,
      unpin: menu.querySelector('[data-act=unpin]').hidden,
      up: menu.querySelector('[data-act="move-up"]').hidden,
    });
  })()`),
  JSON.stringify({ pin: false, unpin: true, up: true }),
);
await evaluate(
  "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
);
check('Escape closes the score menu', await shown('playMenu'), 'none');

await evaluate("document.querySelector('#recentPlays [data-play-menu]')?.click()");
await evaluate('document.body.click()');
check('clicking elsewhere closes it', await shown('playMenu'), 'none');

/*
 * View Details and Download Replay (roadmap 5.21). The card is a `.backdrop`, which is the
 * element the [hidden] trap was found on, so its visibility is checked the same way.
 */
console.log('\nview details');
check('the score card is hidden on load', await shown('scoreModal'), 'none');

// Opens the first score in Recent Plays and waits for its card; null when there is none.
const openCard = `(async () => {
  const button = document.querySelector('#recentPlays [data-play-menu][data-kind=score]');
  if (!button) return null;
  button.click();
  const menu = document.getElementById('playMenu');
  const offered = {
    details: !menu.querySelector('[data-act=details]').hidden,
    replay: !menu.querySelector('[data-act=replay]').hidden,
    hasReplay: button.dataset.replay === '1',
  };
  menu.querySelector('[data-act=details]').click();
  for (let i = 0; i < 40 && !document.querySelector('#scoreCard .score-page'); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return JSON.stringify(offered);
})()`;
const escape = () =>
  evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");

const offered = await evaluate(openCard);
if (offered === null) {
  for (const name of ['the menu offers View Details', 'and Download Replay exactly when there is one',
    'View Details opens the card', "it is osu!'s page, 1000px at most", 'the dial or letter is 200px',
    "the grade tower is osu!'s 32x16 badges", "it takes osu!'s beatmaps hue, not the profile's",
    "its own menu has neither View Details nor Download Replay",
    'and has Copy link, Save screenshot and Copy screenshot', "the link is the score's own page",
    'Escape closes that menu first',
    'a second Escape closes the card', 'clicking beside the card closes it', 'the X closes it',
    'the replay is there to download']) check(name, SKIP);
} else {
  const o = JSON.parse(offered);
  check('the menu offers View Details', o.details, true);
  check('and Download Replay exactly when there is one', o.replay, o.hasReplay);
  check('View Details opens the card', await shown('scoreModal'), 'grid');
  check(
    "it is osu!'s page, 1000px at most",
    await evaluate(`(() => {
      const w = document.querySelector('.score-modal').getBoundingClientRect().width;
      return w > 0 && w <= 1000;
    })()`),
    true,
  );
  check(
    'the dial or letter is 200px',
    await evaluate("document.querySelector('.score-dial, .legacy-rank')?.getBoundingClientRect().width"),
    200,
  );
  check(
    "the grade tower is osu!'s 32x16 badges",
    await evaluate(`(() => {
      const r = [...document.querySelectorAll('.score-tower .score-rank')].map((e) => e.getBoundingClientRect());
      return r.length === 6 && r.every((b) => b.width === 32 && b.height === 16);
    })()`),
    true,
  );
  // Compared against a probe rather than a literal, so a browser's hsl() rounding is not
  // what the check measures.
  check(
    "it takes osu!'s beatmaps hue, not the profile's",
    await evaluate(`(() => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'hsl(200, 10%, 20%)';
      document.body.append(probe);
      const want = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return getComputedStyle(document.querySelector('.score-beatmap')).backgroundColor === want;
    })()`),
    true,
  );
  check(
    'its own menu has neither View Details nor Download Replay',
    await evaluate(`(() => {
      document.querySelector('.score-buttons [data-play-menu]').click();
      const menu = document.getElementById('playMenu');
      if (getComputedStyle(menu).display === 'none') return 'did not open';
      return menu.querySelector('[data-act=details]').hidden && menu.querySelector('[data-act=replay]').hidden;
    })()`),
    true,
  );
  check(
    'and has Copy link, Save screenshot and Copy screenshot',
    await evaluate(`[...document.querySelectorAll('#playMenu [data-act]')]
      .filter((b) => !b.hidden && /^(copy-link|save-image|copy-image)$/.test(b.dataset.act)).length`),
    3,
  );
  check(
    "the link is the score's own page",
    await evaluate(`(async () => {
      const id = document.querySelector('.score-buttons [data-play-menu]').dataset.id;
      const r = await fetch('/scores/' + id);
      return r.ok && (await r.text()).includes('/js/score-page.js');
    })()`),
    true,
  );
  await escape();
  check(
    'Escape closes that menu first',
    `${await shown('playMenu')} ${await shown('scoreModal')}`,
    'none grid',
  );
  await escape();
  check('a second Escape closes the card', await shown('scoreModal'), 'none');

  await evaluate(openCard);
  // On the backdrop itself -- beside the card, not on it.
  await evaluate("document.getElementById('scoreModal').click()");
  check('clicking beside the card closes it', await shown('scoreModal'), 'none');

  await evaluate(openCard);
  await evaluate("document.getElementById('scoreClose').click()");
  check('the X closes it', await shown('scoreModal'), 'none');

  check(
    'the replay is there to download',
    o.hasReplay
      ? await evaluate(`(async () => {
          const id = document.querySelector('#recentPlays [data-play-menu][data-kind=score]').dataset.id;
          const r = await fetch('/api/scores/' + id + '/replay', { method: 'HEAD' });
          return r.status === 200 && (r.headers.get('content-disposition') ?? '').startsWith('attachment;');
        })()`)
      : SKIP,
    true,
  );
}

console.log('\npinned scores');

check(
  'Pinned Scores is there, above Best Performance',
  await evaluate(`(() => {
    const pinned = document.getElementById('pinnedPlays');
    const top = document.getElementById('topRanks');
    return pinned.getBoundingClientRect().top < top.getBoundingClientRect().top;
  })()`),
  true,
);
// As on osu!: nothing pinned leaves the space blank rather than explaining itself.
check(
  'an empty Pinned Scores list is blank',
  await evaluate(`(() => {
    const pinned = document.getElementById('pinnedPlays');
    if (pinned.querySelector('.play-detail')) return ${JSON.stringify('skipped')};
    return pinned.innerHTML.trim();
  })()`),
  '',
);

console.log('\nthe update button');
check('the update dialog is hidden on load', await shown('updateModal'), 'none');
/*
 * The button is the server's verdict rendered, not the page's own guess: it appears only
 * when a newer release exists, there is a build for this platform, and this install is one
 * that can be replaced at all. Derived from /api/state so this passes on a checkout (where
 * it must never appear) and on a packaged build alike.
 */
const updateState = await evaluate(`fetch('/api/state').then((r) => r.json()).then(
  (s) => JSON.stringify(s.app.update ?? {}),
)`);
const u = JSON.parse(updateState);
check(
  'it is shown exactly when an update can be installed',
  await evaluate("document.getElementById('updateBtn').hidden"),
  !(u.available === true && u.blocked === null),
);
check(
  'a source checkout is never offered an update',
  u.blocked === null ? 'packaged' : 'blocked',
  // This script normally runs against the dev tree, where updating would overwrite the repo.
  u.currentVersion === null || u.blocked !== null ? 'blocked' : 'packaged',
);

console.log('\nthe page says what it is');
check(
  'the footer links to the source',
  await evaluate("document.querySelector('.site-footer a')?.href ?? 'missing'"),
  'https://github.com/jonathant09/osu-local-profiles',
);
// Compared against what the server reports rather than pattern-matched, so a footer that
// silently prints someone else's version fails instead of passing on its shape.
check(
  'and names the running version',
  await evaluate(`fetch('/api/state').then((r) => r.json()).then(
    (s) => document.getElementById('footerVersion').textContent === 'osu! local profiles v' + s.app.version,
  )`),
  true,
);

console.log('\nunofficial scoring is disclosed');
/*
 * The warning can be dismissed for good, so when it *is* up it has to carry the control
 * that does that. Checked without clicking: a click would write a setting into whatever
 * profile this is being run against.
 */
check(
  'a shown warning offers a way to stop showing it',
  // Not shown is a legitimate state -- this profile may score officially, or may have used
  // the dismissal this very check is about -- so it skips rather than failing.
  (await evaluate(`(() => {
    const note = document.getElementById('countingNote');
    if (note.hidden) return 'skipped';
    return note.querySelectorAll('[data-dismiss-note]').length === 2;
  })()`)),
  true,
);
/*
 * The element is hidden via the `hidden` attribute on a styled div -- the same shape as the
 * bug this whole script exists for -- so check computed display, not just the attribute.
 *
 * What it should say depends on the profile being run against, so derive the expectation
 * from that profile rather than assuming a default one: the note is up exactly when a
 * setting has made the profile incomparable *and* it has not been dismissed. Asserting a
 * bare 'none' here failed on any profile that had turned unranked scoring on.
 */
const noteState = await evaluate(`fetch('/api/state').then((r) => r.json()).then((s) => {
  const counting = s.settings.includeUnrankedMods || (s.settings.includeUnrankedMaps ?? []).length > 0;
  return JSON.stringify({ expected: counting && s.settings.showCountingNote !== false });
})`);
check(
  'the warning is up exactly when this profile has earned it',
  await shown('countingNote'),
  JSON.parse(noteState).expected ? 'flex' : 'none',
);

const noteFor = (counting) =>
  evaluate(
    `import('/js/sections.js').then((m) => m.countingNoteText(${JSON.stringify(counting)}))`,
  );

check('no note for an official profile', await noteFor({ includeUnrankedMods: false }), '');
const stripped = await noteFor({ includeUnrankedMods: true, preferStrippedPp: true });
check('it says the profile is not comparable', stripped.includes('not comparable'), true);
check('and names the stripped-mod pricing', stripped.includes('as if the mod had been off'), true);
check('and points at the asterisk on the rows', stripped.includes('marked with *'), true);
check('and says which of the two rules is on', stripped.includes('plays on mods osu! does not rank'), true);

const asPlayed = await noteFor({ includeUnrankedMods: true, preferStrippedPp: false });
check('the as-played wording differs', asPlayed.includes('as played'), true);
check('and does not claim mods were removed', asPlayed.includes('as if the mod'), false);

// Unranked beatmaps are a separate rule and must be disclosed on their own.
const mapsOnly = await noteFor({ includeUnrankedMods: false, extraMapStatuses: [4] });
check('unranked beatmaps alone are disclosed', mapsOnly.includes('beatmaps osu! does not rank'), true);
check('without mentioning relax', mapsOnly.includes('Relax'), false);
const both = await noteFor({ includeUnrankedMods: true, preferStrippedPp: true, extraMapStatuses: [4] });
check('both rules together name both', both.includes('mods and beatmaps'), true);

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

/*
 * A play that was started and never finished. It has no accuracy, no combo, no mods and no
 * pp -- lazer records none of that for a play it discards -- so the row has to read as
 * "nothing is known here" rather than as a score whose numbers all came out zero. The
 * dimming is the whole cue, which makes it exactly the kind of thing worth asserting
 * against computed style rather than markup.
 */
console.log('\nan unfinished play is shown as one');
const incompleteRow = (play) =>
  evaluate(`import('/js/sections.js').then((m) => {
    const host = document.createElement('div');
    host.innerHTML = m.playList([Object.assign(
      { kind: 'incomplete', id: 1, title: 'A map', version: 'Insane', artist: 'Someone',
        beatmapMd5: 'abc', beatmapId: null, beatmapsetId: null, creator: null,
        playedAt: Date.now(), attempts: 1 },
      ${JSON.stringify(play)},
    )]);
    document.body.appendChild(host);
    const row = host.querySelector('.play-detail');
    const style = getComputedStyle(row);
    const out = {
      html: host.innerHTML,
      opacity: Number(style.opacity),
      display: style.display,
      attempts: host.querySelector('.play-detail__attempts')?.textContent ?? '',
    };
    host.remove();
    return out;
  })`);

const dnf = await incompleteRow({});
check('it says the play was not finished', dnf.html.includes('Didn&rsquo;t finish') || dnf.html.includes('Didn’t finish'), true);
check('it is dimmed against the scored rows', dnf.opacity < 1, true);
check('but it is still shown', dnf.display !== 'none', true);
// The numbers a score has must be absent, not zero: nobody knows what they were.
check('no accuracy is invented', dnf.html.includes('play-detail__accuracy'), false);
check('no pp cell is invented', dnf.html.includes('play-detail__pp'), false);
// `F` is a real osu! grade for a score that exists and failed. These have no score at all.
check('it does not borrow the F grade badge', dnf.html.includes('>F</text>'), false);
check('a single attempt shows no count', dnf.attempts, '');

const collapsed = await incompleteRow({ attempts: 4 });
check('a collapsed run says how many attempts', collapsed.attempts.includes('4'), true);

/*
 * The charts. osu-web's profile line chart is `@yellow` (#ffcc22) at 2px, with the marker
 * and tooltip drawn as HTML over the plot rather than inside the SVG -- the chart stretches
 * with preserveAspectRatio="none", so a circle drawn in it would render as an ellipse whose
 * shape depended on the window width.
 */
console.log('\nthe charts match osu!s profile');
const chartLine = (id) =>
  evaluate(`(() => {
    const line = document.querySelector('#${id} .chart__line');
    if (!line) return 'no chart';
    const s = getComputedStyle(line);
    return { stroke: s.stroke, width: s.strokeWidth };
  })()`);

for (const [name, id] of [['rank', 'ppChart'], ['play history', 'playcountChart']]) {
  const line = await chartLine(id);
  if (line === 'no chart') {
    check(`the ${name} chart is drawn`, 'missing', 'present');
    continue;
  }
  check(`the ${name} chart line is osu!s yellow`, line.stroke, 'rgb(255, 204, 34)');
  check(`the ${name} chart line is 2px`, line.width, '2px');
}

check(
  'the play history is a line, not bars',
  await evaluate("document.querySelectorAll('#playcountChart .chart__bar').length"),
  0,
);
check(
  'the section is called Play History, as on osu!',
  await evaluate("document.querySelector('#section-historical .title--sub-first')?.textContent"),
  'Play History',
);

/*
 * The area fill reaches its colour through var(--chart-line) inside an SVG gradient stop.
 * A presentation attribute would silently not resolve it -- the same trap the grade badges
 * hit -- and the fill would simply be absent.
 */
check(
  'the area fill resolves its colour',
  await evaluate(`(() => {
    const stop = document.querySelector('#playcountChart svg stop');
    if (stop == null) return 'no gradient';
    return getComputedStyle(stop).stopColor;
  })()`),
  'rgb(255, 204, 34)',
);

console.log('\nthe charts are hoverable');
check(
  'nothing is shown until the mouse is over the chart',
  await evaluate("document.querySelector('#ppChart .chart__hover')?.hidden"),
  true,
);

const hoverChart = (id) =>
  evaluate(`(() => {
    const plot = document.querySelector('#${id} .chart__plot');
    if (plot == null) return 'no chart';
    const r = plot.getBoundingClientRect();
    plot.dispatchEvent(new MouseEvent('mousemove', {
      clientX: r.left + r.width * 0.6, clientY: r.top + r.height / 2, bubbles: true,
    }));
    const hover = document.querySelector('#${id} .chart__hover');
    const out = {
      hidden: hover.hidden,
      y: hover.querySelector('.chart__hover-y').textContent,
      x: hover.querySelector('.chart__hover-x').textContent,
      circle: hover.querySelector('.chart__hover-circle').style.left,
    };
    plot.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    return out;
  })()`);

const rankHover = await hoverChart('ppChart');
check('hovering the rank chart shows a reading', rankHover.hidden, false);
// osu-web's wording exactly: `<strong>Global Ranking</strong> #123` over a days-ago line.
check('it names the global ranking', /^Global Ranking #[\d,]+$/.test(rankHover.y), true);
check('and says how long ago, by day', /^(now|[\d,]+ days? ago)$/.test(rankHover.x), true);
check('and marks the point it read', rankHover.circle.endsWith('%'), true);

const playsHover = await hoverChart('playcountChart');
// `<strong>Plays</strong> 430` over `March 2020`, at monthly granularity.
check('hovering the play history shows a month', /^Plays [\d,]+$/.test(playsHover.y), true);
check('named in full, as on osu!', /^[A-Z][a-z]+ \d{4}$/.test(playsHover.x), true);

check(
  'the marker is hidden again when the mouse leaves',
  await evaluate("document.querySelector('#ppChart .chart__hover')?.hidden"),
  true,
);

/*
 * Paged sections: five rows to begin with, as on osu!, then twenty-five, then twenty-five
 * more at a time. Each check is skipped rather than failed when the profile has too few
 * rows to page -- a freshly reset profile is a legitimate state to run this in.
 */
console.log('\nlong sections start short and expand');
const SECTION_ROWS = {
  recent: '#recentPlays .play-detail',
  top: '#topRanks .play-detail',
  mostPlayed: '#mostPlayed .beatmap-playcount',
  events: '#recentActivity .activity',
};

let expandable = null;
for (const [section, selector] of Object.entries(SECTION_ROWS)) {
  const state = await evaluate(`({
    rows: document.querySelectorAll('${selector}').length,
    button: !!document.querySelector('[data-show-more="${section}"]'),
  })`);

  if (state.rows === 0) continue;
  check(`${section} shows at most five rows at first`, state.rows <= 5, true);
  if (state.rows === 5 && state.button) expandable ??= section;
  // The other half of the rule: no button where pressing it would reveal nothing.
  if (state.rows < 5) check(`${section} offers no button when it is complete`, state.button, false);
}

if (expandable == null) {
  console.log('  SKIP  no section has more than five rows to expand');
} else {
  const rowsIn = (section) =>
    evaluate(`document.querySelectorAll('${SECTION_ROWS[section]}').length`);

  const before = await rowsIn(expandable);
  await evaluate(`document.querySelector('[data-show-more="${expandable}"]').click()`);
  await sleep(1500);
  const after = await rowsIn(expandable);

  check(`${expandable} grows when show more is pressed`, after > before, true);
  check('and stops at twenty-five, or at the end of the list', after <= 25, true);
}

console.log('\nmod settings are surfaced');
const pill = await evaluate(
  "import('/js/badges.js').then((m) => m.modPill({ acronym: 'DT', settings: { speed_change: 1.3 } }))",
);
// osu! writes the rate to two places and two precisions: the extender tab and the tooltip.
check('a customised rate is shown on the extender', pill.includes('1.30×'), true);
check('a customised mod is marked with a cog', pill.includes('mod__customised-indicator'), true);
check('the tooltip names the mod, not its acronym', pill.includes('Double Time (1.3×)'), true);
const plain = await evaluate("import('/js/badges.js').then((m) => m.modPill({ acronym: 'HD' }))");
check('a default mod is not marked', plain.includes('mod__customised-indicator'), false);
check('and carries no extender, so it stays one badge wide', plain.includes('viewBox="0 0 100 70"'), true);

/*
 * Where the accuracy sits inside its cell, which only a measurement can tell you.
 *
 * The cell stretches to the row, and in Best Performance its second line -- "weighted x%" --
 * fills the space under the accuracy. Pinned Scores and Recent Plays have no second line, and
 * an `align-items: baseline` here pinned their single line to the top of a stretched cell
 * instead, leaving the accuracy floating 9px above the pp beside it. Nothing about the markup
 * says so; the number is the only way to see it.
 */
console.log('\nthe accuracy sits where it should in its cell');
const accuracyOffsets = await evaluate(`(() => {
  const offsets = (id) => {
    // The first score row: an unfinished play has no accuracy cell to measure.
    const row = document.querySelector('#' + id + ' .play-detail:not(.play-detail--incomplete)');
    if (!row) return null;
    const cell = row.querySelector('.play-detail__score-detail');
    const accuracy = row.querySelector('.play-detail__accuracy');
    const pp = row.querySelector('.play-detail__pp');
    if (!cell || !accuracy || !pp) return null;
    const middle = (el) => {
      const box = el.getBoundingClientRect();
      return (box.top + box.bottom) / 2;
    };
    return {
      weighted: row.querySelector('.play-detail__pp-weight') !== null,
      // Positive is below the middle of the cell, negative above.
      fromCentre: Math.round(middle(accuracy) - middle(cell)),
      fromPp: Math.round(middle(accuracy) - middle(pp)),
    };
  };
  return { best: offsets('topRanks'), pinned: offsets('pinnedPlays'), recent: offsets('recentPlays') };
})()`);
for (const [section, name] of [['recent', 'Recent Plays'], ['pinned', 'Pinned Scores']]) {
  const measured = accuracyOffsets[section];
  check(
    `${name} centres the accuracy in its cell`,
    measured === null ? SKIP : measured.fromCentre,
    0,
  );
  check(
    `and level with the pp beside it`,
    measured === null ? SKIP : measured.fromPp,
    0,
  );
}
check(
  'Best Performance keeps the accuracy above its weighting',
  accuracyOffsets.best === null || !accuracyOffsets.best.weighted
    ? SKIP
    : accuracyOffsets.best.fromCentre < 0,
  true,
);

/*
 * The badge's whole size comes from the row's font-size, so a missing rule shows up as a
 * badge of the wrong height rather than as anything visibly broken. Measure it rendered.
 */
console.log('\nmods and flags are sized off their row');
const modHeight = await evaluate(`(() => {
  const row = document.createElement('div');
  row.className = 'play-detail__mods';
  document.body.appendChild(row);
  row.innerHTML = ${JSON.stringify(pill)};
  const h = row.querySelector('.mod').getBoundingClientRect().height;
  row.remove();
  return Math.round(h);
})()`);
check('a mod badge is @mod-height-normal tall', modHeight, 22);

/*
 * The flag's width is derived from its height by osu!'s 100/72 ratio, which is what crops
 * a 36x36 Twemoji SVG down to the flag inside it. A wrong ratio is a letterboxed flag.
 */
const flag = await evaluate(`(() => {
  const row = document.createElement('div');
  row.className = 'profile-info__flags';
  row.style.fontSize = '20px';
  row.innerHTML = '<span class="flag-country"></span>';
  document.body.appendChild(row);
  const r = row.querySelector('.flag-country').getBoundingClientRect();
  row.remove();
  // Two decimals, not three: the width lands on a subpixel, so 100/72 measures 1.3883.
  return { h: Math.round(r.height), ratio: Math.round((r.width / r.height) * 100) };
})()`);
check('a flag is one line tall', flag.h, 20);
check('and 100/72 as wide, as on osu!', flag.ratio, 139);
check(
  'a flag for the vendored set resolves',
  await evaluate("fetch('/flags/us.svg').then((r) => r.status)"),
  200,
);

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
// The graph and stats band is osu-page's b5: darker than the b3 header and level bar either
// side of it, so it reads as its own region, with the b4 stats card lighter on top.
check('stats band is b5', await bg('.profile-detail'), await literal('hsl(333, 10%, 15%)'));
check('level bar is b3', await bg('.profile-detail-bar'), await literal('hsl(333, 10%, 25%)'));

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
/*
 * Named rather than counted, so adding a section is a deliberate edit here -- but compared
 * as a set, because the order belongs to the profile and this check must not depend on how
 * the user has arranged their page.
 */
check(
  'every expected section is present',
  await evaluate(
    "[...document.querySelectorAll('.page-extra')].map((s) => s.id).sort().join(',')",
  ),
  'section-beatmaps,section-historical,section-me,section-medals,section-recent,section-recent_plays,section-top_ranks',
);
check(
  'Recent Plays is a section of its own, and the feed is called Milestones',
  await evaluate(`(() => [
    document.querySelector('#section-recent_plays > h2.title')?.firstChild.textContent.trim(),
    !!document.querySelector('#section-recent_plays #recentPlays'),
    !document.querySelector('#section-historical #recentPlays'),
    document.querySelector('#section-recent > h2.title')?.textContent.trim(),
  ].join('|'))()`),
  'Recent Plays|true|true|Milestones',
);
// osu-web's own names: `extra.top_ranks.title` is "Scores", its pinned list "Pinned Scores".
check(
  "the scores section uses osu!'s names",
  await evaluate(`(() => {
    const s = document.getElementById('section-top_ranks');
    const main = s.querySelector('h2.title').textContent.trim();
    const pinned = s.querySelector('h3.title').firstChild.textContent.trim();
    const tab = document.querySelector('#sectionTabs a[href="#section-top_ranks"]').textContent;
    return [main, pinned, tab].join(' | ');
  })()`),
  'Scores | Pinned Scores | Scores',
);
check(
  'the tab icon is served, and actually draws',
  // Loaded as an image rather than just fetched: an SVG that is served fine but is not
  // well-formed XML -- a `--` inside a comment is enough -- renders as nothing at all.
  await evaluate(`(async () => {
    const href = document.querySelector('link[rel="icon"]').getAttribute('href');
    const r = await fetch(href);
    if (!r.ok || !(r.headers.get('content-type') ?? '').startsWith('image/svg+xml')) return 'not served';
    const img = new Image();
    img.src = href;
    try { await img.decode(); } catch { return 'does not decode'; }
    return img.naturalWidth > 0;
  })()`),
  true,
);
// Consecutive headings must stack: they were inline-block once, which overlapped
// "Scores" with "Pinned Scores".
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

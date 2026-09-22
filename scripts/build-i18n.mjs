/**
 * Keep the page's English and `web/i18n/en.json` from drifting apart.
 *
 * `en.json` is the source of truth for every string: the page's HTML carries the English too
 * -- so the page reads correctly before any script runs -- and the two have to agree, or a
 * translator is working from text that is no longer on screen.
 *
 * Two modes:
 *
 *   node scripts/build-i18n.mjs          report what disagrees, exit non-zero
 *   node scripts/build-i18n.mjs --write  rewrite en.json from the HTML, keeping JS-only keys
 *
 * `--write` is for after editing the page's wording. Nothing here ever writes a *translation*
 * file: those are edited by hand, and a key one of them is missing simply falls back to
 * English at runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(root, 'web');
const i18nDir = path.join(webDir, 'i18n');

const HTML_FILES = ['index.html', 'score.html'];

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&mdash;': '-', '&ndash;': '–', '&rarr;': '→',
  '&larr;': '←', '&times;': '×', '&rsquo;': '’', '&lsquo;': '‘',
  '&ldquo;': '“', '&rdquo;': '”', '&hellip;': '…', '&middot;': '·',
  '&copy;': '©',
};

/** What a browser's `textContent` would read, given this HTML source. */
export function decodeEntities(source) {
  return source.replace(/&#?\w+;/g, (e) => {
    if (e in ENTITIES) return ENTITIES[e];
    const numeric = /^&#(\d+);$/.exec(e);
    return numeric ? String.fromCodePoint(Number(numeric[1])) : e;
  });
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Every translated string the HTML declares, as the browser would see it.
 *
 * The markers are the contract with `web/js/i18n.js`: `data-i18n` is text, `data-i18n-html`
 * is text with markup in it, and `data-i18n-attr` is `attribute:key` pairs.
 */
/**
 * The content of the element whose opening tag ends at `from`.
 *
 * Found by counting opening and closing tags of the same name rather than by matching to the
 * first `</div>`, because these elements nest -- a paragraph inside a dialog inside a
 * backdrop, all divs -- and the first close is almost never the right one.
 */
function innerHtml(source, from, name) {
  const tag = new RegExp(`<(/?)${name}\\b((?:"[^"]*"|'[^']*'|[^>])*)>`, 'gi');
  tag.lastIndex = from;
  let depth = 1;
  for (let m = tag.exec(source); m; m = tag.exec(source)) {
    const selfClosing = m[2].trimEnd().endsWith('/');
    if (m[1] === '/') depth--;
    else if (!selfClosing) depth++;
    if (depth === 0) return source.slice(from, m.index);
  }
  return source.slice(from);
}

export function stringsFromHtml(source) {
  const out = new Map();

  for (const m of source.matchAll(/<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g)) {
    const [whole, name, attrs] = m;
    if (whole.startsWith('</')) continue;

    for (const pair of /\bdata-i18n-attr="([^"]+)"/.exec(attrs)?.[1].split(';') ?? []) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (!attr || !key) continue;
      const value = new RegExp(`\\b${attr}="([^"]*)"`).exec(attrs)?.[1];
      if (value !== undefined) out.set(key, collapse(decodeEntities(value)));
    }

    const textKey = /\bdata-i18n="([^"]+)"/.exec(attrs)?.[1];
    const htmlKey = /\bdata-i18n-html="([^"]+)"/.exec(attrs)?.[1];
    if (!textKey && !htmlKey) continue;

    const inner = innerHtml(source, m.index + whole.length, name);
    // `data-i18n` becomes textContent, so entities are resolved; `data-i18n-html` becomes
    // innerHTML, where they are still source and must be left exactly as written.
    if (textKey) out.set(textKey, collapse(decodeEntities(inner)));
    if (htmlKey) out.set(htmlKey, collapse(inner));
  }

  return out;
}

/**
 * Every key the page's scripts ask for.
 *
 * Only a literal `t('key')` is found, which is the whole point: a key built at runtime
 * cannot be checked, so the page does not build any. A `t(variable)` would pass silently
 * here and fail on somebody's screen.
 */
export function keysFromJs(source) {
  return [...source.matchAll(/\bt\(\s*'([\w.-]+)'/g)].map((m) => m[1]);
}

function readWeb(rel) {
  return fs.readFileSync(path.join(webDir, rel), 'utf8');
}

/**
 * The locale list out of `web/js/i18n.js`, as `[code, done]` pairs.
 *
 * Read with a regex rather than imported: that module imports `static-mode.js`, which reads
 * the DOM, and this script has no DOM. The list is one literal per line by design, so the
 * pattern is as stable as the file's own formatting.
 */
export function localesFromJs(source = readWeb(path.join('js', 'i18n.js'))) {
  return [...source.matchAll(/^ {2}\{ code: '([\w-]+)'(.*)\},$/gm)].map((m) => [
    m[1],
    m[2].includes('done: true'),
  ]);
}

function collect() {
  const html = new Map();
  for (const file of HTML_FILES) {
    for (const [key, value] of stringsFromHtml(readWeb(file))) html.set(key, value);
  }

  const js = new Map();
  for (const file of fs.readdirSync(path.join(webDir, 'js')).filter((f) => f.endsWith('.js'))) {
    for (const key of keysFromJs(readWeb(path.join('js', file)))) {
      if (!js.has(key)) js.set(key, file);
    }
  }
  return { html, js };
}

export function check() {
  const { html, js } = collect();
  const en = JSON.parse(fs.readFileSync(path.join(i18nDir, 'en.json'), 'utf8'));
  const problems = [];

  for (const [key, value] of html) {
    if (!(key in en)) problems.push(`en.json has no "${key}" (the page declares it)`);
    else if (en[key] !== value) {
      problems.push(
        `"${key}" differs:\n    page:    ${JSON.stringify(value)}\n    en.json: ${JSON.stringify(en[key])}`,
      );
    }
  }
  for (const [key, file] of js) {
    if (!(key in en)) problems.push(`en.json has no "${key}" (${file} asks for it)`);
  }
  for (const key of Object.keys(en)) {
    if (!html.has(key) && !js.has(key)) problems.push(`en.json has "${key}", which nothing uses`);
  }

  /*
   * A translation may be incomplete -- that is the design, and a missing key falls back to
   * English. A key it has that English does *not* is a different thing: a rename that was
   * applied to en.json and nowhere else, which shows as untranslated text forever.
   */
  for (const file of fs.readdirSync(i18nDir).filter((f) => f.endsWith('.json') && f !== 'en.json')) {
    const locale = JSON.parse(fs.readFileSync(path.join(i18nDir, file), 'utf8'));
    for (const key of Object.keys(locale)) {
      if (!(key in en)) problems.push(`${file} has "${key}", which en.json does not`);
    }
  }

  /*
   * `done` in web/js/i18n.js decides which languages the picker offers, and it is a hand-set
   * flag, so it can lie in both directions: a language offered with no file renders English
   * for somebody who asked for their own language, and a language with a file that nobody can
   * pick is finished work nobody can reach. Both are checked here against what is on disk.
   */
  for (const [code, done] of localesFromJs()) {
    const exists = fs.existsSync(path.join(i18nDir, `${code}.json`));
    if (done && !exists) problems.push(`${code} is marked done in web/js/i18n.js, but ${code}.json does not exist`);
    if (!done && exists) problems.push(`${code}.json exists, but ${code} is not marked done in web/js/i18n.js`);
  }

  return problems;
}

/** Rewrite en.json from the page, keeping the keys only the scripts use. */
function write() {
  const { html, js } = collect();
  const en = JSON.parse(fs.readFileSync(path.join(i18nDir, 'en.json'), 'utf8'));

  const next = {};
  for (const key of [...html.keys(), ...js.keys()].sort((a, b) => a.localeCompare(b))) {
    // The page's own text wins for a key the page declares; a script-only key keeps whatever
    // en.json already said, because there is nowhere else for its English to live.
    next[key] = html.has(key) ? html.get(key) : (en[key] ?? key);
  }
  fs.writeFileSync(path.join(i18nDir, 'en.json'), `${JSON.stringify(next, null, 2)}\n`);
  return Object.keys(next).length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes('--write')) {
    console.log(`en.json: ${write()} keys`);
  } else {
    const problems = check();
    for (const problem of problems) console.error(`  ${problem}`);
    console.log(problems.length === 0 ? '  i18n: en.json matches the page' : `  ${problems.length} problem(s)`);
    process.exitCode = problems.length === 0 ? 0 : 1;
  }
}

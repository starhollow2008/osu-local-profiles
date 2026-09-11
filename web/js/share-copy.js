/**
 * Share -> Save as a web page: this page, as one file that works like it.
 *
 * The file is the page itself -- its markup, its stylesheets, and its own modules bundled
 * into one script (bundle.js) -- carrying a snapshot of what the API answered: every mode at
 * full length, and View Details for every score it lists. static-mode.js serves that snapshot
 * back to the same code in place of the app, so Show more, the mode tabs, View Details, the
 * medal cards, the charts and the previews all work, with or without this app.
 *
 * It is made to be handed to other people -- or put online -- so two things are left out on
 * purpose: anything that could change the profile (hidden in the copy, and refused by
 * static-mode.js if it is reached anyway), and anything about this machine: no install
 * paths, no other profiles.
 */
import { escapeHtml } from './format.js';
import { bundleModules } from './bundle.js';

/** How much of each list the copy carries: every row the page could ask for, within reason. */
const LENGTHS = { events: 500, top: 100, recent: 500, mostPlayed: 500, favorites: 500 };

const ABOUT_IMAGE = /\/api\/about-image\/\d+\/[0-9a-f]{16}\.(?:png|jpg|webp|gif)/g;

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`could not read ${url}`);
  return r.text();
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`could not read ${url}`);
  return r.json();
}

/** A same-origin file as a data: URI, so the copy needs nothing from the app. */
async function fetchDataUri(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`could not read ${url}`);
  const blob = await r.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`could not encode ${url}`));
    reader.readAsDataURL(blob);
  });
}

/** Every score the copy lists, so View Details works for each of them. */
function listedScores(profiles) {
  const ids = new Set();
  for (const profile of Object.values(profiles)) {
    for (const row of [...(profile.pinned ?? []), ...(profile.top ?? []), ...(profile.recent ?? [])]) {
      if (row.kind !== 'incomplete' && Number.isInteger(row.id)) ids.add(row.id);
    }
  }
  return [...ids];
}

/**
 * Build the copy. `progress` is told what is happening, for a profile big enough to take a
 * moment: most of the time goes on View Details, one request per score.
 */
export async function buildInteractiveHtml(progress = () => {}) {
  progress('Reading the profile...');
  const state = await fetchJson('/api/state');

  const profiles = {};
  for (const mode of [0, 1, 2, 3]) {
    const query = new URLSearchParams({ mode: String(mode) });
    for (const [section, length] of Object.entries(LENGTHS)) query.set(section, String(length));
    profiles[mode] = await fetchJson(`/api/profile?${query}`);
  }

  const ids = listedScores(profiles);
  const scores = {};
  for (const [index, id] of ids.entries()) {
    progress(`Reading score ${index + 1} of ${ids.length}...`);
    try {
      scores[id] = await fetchJson(`/api/scores/${id}`);
    } catch {
      /* left out: its card says the copy does not include it */
    }
  }

  // Pictures the app serves travel inside the file, keyed by the address the page asks for.
  progress('Packing the pictures...');
  const assets = {};
  const carry = async (url) => {
    if (typeof url !== 'string' || !url.startsWith('/')) return url;
    if (!(url in assets)) {
      try {
        assets[url] = await fetchDataUri(url);
      } catch {
        return url;
      }
    }
    return assets[url];
  };
  const flag = (code) => (code ? carry(`/flags/${code.toLowerCase()}.svg`) : null);

  if (state.profile.hasAvatar) await carry('/api/image/avatar');
  if (state.profile.hasCover) await carry('/api/image/cover');
  await flag(state.profile.country);
  // Every score's owner is this profile, whose pictures are carried once, under the header's
  // own addresses; each score card looks them up there (assetUrl) rather than every score
  // carrying a copy of its own -- which made a profile of forty scores sixteen megabytes.
  const own = (url) => (typeof url === 'string' ? url.replace(`?profile=${state.profile.id}`, '') : url);
  for (const detail of Object.values(scores)) {
    if (!detail.owner) continue;
    detail.owner.avatar = own(detail.owner.avatar);
    detail.owner.cover = own(detail.owner.cover);
    await carry(detail.owner.avatar);
    await carry(detail.owner.cover);
    await flag(detail.owner.country);
  }

  // Pictures in me! go into its text as data: images, which the BBCode renderer accepts.
  let about = state.settings?.aboutMe ?? '';
  for (const url of new Set(about.match(ABOUT_IMAGE) ?? [])) {
    const uri = await fetchDataUri(url).catch(() => null);
    if (uri) about = about.split(url).join(uri);
  }

  const snapshot = {
    exportedAt: new Date().toISOString(),
    state: {
      ...state,
      settings: { ...state.settings, aboutMe: about },
      // Nothing about this machine or its other profiles goes into a file meant for others.
      installs: [],
      profiles: (state.profiles ?? []).filter((p) => p.id === state.profile.id),
      tracking: false,
      scoresThisSession: 0,
      hiddenScores: 0,
      staleScores: 0,
      indexing: { ...(state.indexing ?? {}), active: false },
      sharing: { canScreenshot: false },
      app: { version: state.app?.version ?? null, update: null, config: {} },
    },
    profiles,
    scores,
    assets,
  };

  progress('Packing the page...');
  const code = await bundleModules('main.js', (name) => fetchText(`/js/${name}`));
  let html = await fetchText('/');

  // Every replacement is a function: the text going in is CSS and JavaScript, full of `$`,
  // which a replacement *string* would read as patterns.
  for (const [tag, href] of [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)]) {
    const css = await fetchText(href);
    html = html.replace(tag, () => `<style>\n${css}\n</style>`);
  }
  const icon = /<link rel="icon"[^>]*href="([^"]+)"[^>]*>/.exec(html);
  if (icon) {
    const uri = await fetchDataUri(icon[1]).catch(() => null);
    html = html.replace(icon[0], () => (uri ? icon[0].replace(icon[1], uri) : ''));
  }
  html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(state.profile.name)} - osu! local profiles</title>`);

  // This file writes its closing script tags in two halves, so that bundled into a copy it
  // contains none that could end the copy's own script early.
  const close = '<' + '/script>';
  const entry = `<script type="module" src="/js/main.js">${close}`;
  if (!html.includes(entry)) throw new Error('the page no longer loads /js/main.js the way the copy expects');
  // Neither may end its <script> early: every `<` in the data is escaped, and so is any
  // closing script tag in the code.
  const data = JSON.stringify(snapshot).replace(/</g, '\\u003c');
  html = html.replace(
    entry,
    () =>
      `<script id="snapshot" type="application/json">${data}${close}\n` +
      `<script type="module">\n${code.replace(/<\/script/gi, '<\\/script')}\n${close}`,
  );

  const note = `osu! local profiles - "${state.profile.name}" as of ${new Date().toLocaleString()}. ` +
    'A copy: nothing in it can change the profile. Not an osu! page.';
  return html.replace(/^<!doctype html>/i, (doctype) => `${doctype}\n<!-- ${escapeHtml(note).replace(/--/g, '- -')} -->`);
}

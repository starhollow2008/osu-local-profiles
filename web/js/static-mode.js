/**
 * The page as a shared copy.
 *
 * A copy saved from Share (web/js/share-copy.js) is this same page, carrying a snapshot of
 * what the API answered. Here, that snapshot answers the page's requests in place of the app
 * -- `/api/state`, `/api/profile` cut to the lengths asked for, `/api/scores/<id>` -- so the
 * rest of the code runs unchanged: Show more, the mode tabs and View Details all work.
 * Anything that would change the profile is refused, and live updates are switched off,
 * because a copy never changes.
 *
 * main.js imports this first, so it is in place before any other code asks for anything. In
 * the running app there is no snapshot, and this does nothing at all.
 */

const carried = typeof document === 'undefined' ? null : document.getElementById('snapshot');

/** What the shared copy carries, or null in the running app. */
export const snapshot = carried ? JSON.parse(carried.textContent) : null;

export const isStatic = snapshot !== null;

/** An image the app serves, as the copy carries it -- or the address itself in the app. */
export const assetUrl = (url) => snapshot?.assets?.[url] ?? url;

const READ_ONLY = 'This is a copy of the profile, so nothing in it can be changed.';
const PAGED = ['events', 'top', 'recent', 'mostPlayed', 'favorites'];

const reply = (body, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

/**
 * One mode's profile, cut to the lengths asked for, as the server cuts it. Totals are left as
 * they were: "show more" stops when a page comes back short, which the cut already does.
 */
function profileFor(params) {
  const full = snapshot.profiles[params.get('mode') ?? '0'] ?? snapshot.profiles['0'];
  const out = { ...full };
  for (const section of PAGED) {
    const asked = Number(params.get(section));
    if (Array.isArray(full[section]) && Number.isFinite(asked) && asked > 0) {
      out[section] = full[section].slice(0, asked);
    }
  }
  return out;
}

function answer(path, method, params) {
  if (method !== 'GET' && method !== 'HEAD') return reply({ error: READ_ONLY }, 403);
  if (path === 'state') return reply(snapshot.state);
  if (path === 'profile') return reply(profileFor(params));
  const score = /^scores\/(\d+)$/.exec(path);
  if (score) {
    const detail = snapshot.scores?.[score[1]];
    return detail ? reply(detail) : reply({ error: 'This copy of the profile does not include that score.' }, 404);
  }
  if (path === 'update') return reply({ available: false, blocked: null });
  return reply({ error: READ_ONLY }, 404);
}

if (isStatic) {
  document.documentElement.classList.add('static-copy');

  const passThrough = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const href = typeof input === 'string' ? input : input.url;
    // Only the app's own requests are answered here; osu!'s art and previews go out as usual.
    const api = /^https?:\/\//i.test(href) ? null : /(?:^|\/)api\/([^?#]*)(?:\?([^#]*))?/.exec(href);
    if (!api) return passThrough(input, init);
    return answer(api[1], String(init.method ?? 'GET').toUpperCase(), new URLSearchParams(api[2] ?? ''));
  };

  // Live updates come from the app, which is not there.
  window.EventSource = class {
    addEventListener() {}
    removeEventListener() {}
    close() {}
  };
}

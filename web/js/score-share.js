/**
 * What can be done with one score from its View Details card, wherever the card is shown:
 * the pop-up over the profile and the score's own page (`/scores/<id>`).
 *
 * Every function reports through the page's toast rather than throwing, because each is the
 * whole of what a menu item does.
 */
import { assetUrl } from './static-mode.js';
import { generatedAvatar } from './badges.js';
import { countryName } from './format.js';
import { downloadBlob, toast } from './ui.js';

/** This app's `osu.ppy.sh/scores/<id>`: the score's own page, on this machine. */
export const scoreLink = (id) => `${location.origin}/scores/${id}`;

/**
 * The card's user card, from the `owner` /api/scores/<id> sends: the profile the score
 * belongs to, which on a score's own page need not be the one the app is showing.
 */
export function cardOwner(owner) {
  const code = owner?.country ? owner.country.toUpperCase() : '';
  return {
    name: owner?.name ?? '',
    avatar: owner?.avatar ? `<img src="${assetUrl(owner.avatar)}" alt="">` : generatedAvatar(owner?.name ?? ''),
    country: code,
    countryName: code ? countryName(code) : '',
    // In a saved copy these are carried once by address; see share-copy.js.
    cover: owner?.cover ? assetUrl(owner.cover) : null,
    tracking: owner?.tracking === true,
  };
}

/** The clipboard API, with the pre-API route for a browser that refuses it. */
async function writeText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* fall through */
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('the browser would not copy it');
}

export async function copyScoreLink(id) {
  const link = scoreLink(id);
  try {
    await writeText(link);
    toast(`Link copied - ${link}`);
  } catch {
    toast(`Could not copy the link. It is ${link}`);
  }
}

const screenshotUrl = (id) => `/api/scores/${id}/screenshot`;

/** The PNG, or an Error carrying the server's own reason -- no browser installed, say. */
async function fetchScreenshot(id) {
  const r = await fetch(screenshotUrl(id));
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error ?? 'the screenshot could not be made');
  }
  return r;
}

/** The name the server gave the file, from its Content-Disposition. */
function fileNameOf(response, fallback) {
  const header = response.headers.get('content-disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      /* fall back to the plain one */
    }
  }
  return /filename="([^"]+)"/.exec(header)?.[1] ?? fallback;
}

/*
 * The screenshot is rendered by a browser already installed on this machine, driven by the
 * app -- the same way the profile's PNG is made -- rather than in this page. That is the only
 * way to include the beatmap's cover: it comes from osu!'s servers, and a picture of another
 * site's image cannot be read back out of a web page. It takes a few seconds, so say so.
 */
export async function saveScoreImage(id) {
  toast('Making the screenshot...');
  try {
    const r = await fetchScreenshot(id);
    downloadBlob(await r.blob(), fileNameOf(r, `score-${id}.png`));
    toast('Screenshot saved to your downloads');
  } catch (err) {
    toast(err.message);
  }
}

export async function copyScoreImage(id) {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    toast('This browser cannot copy images - use Save screenshot instead');
    return;
  }
  toast('Making the screenshot...');
  try {
    // Handed over as a promise, so the copy still counts as part of the click that asked for
    // it even though the image takes seconds to arrive.
    const blob = fetchScreenshot(id).then((r) => r.blob());
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Screenshot copied - paste it anywhere');
  } catch (err) {
    toast(err?.message && !/Document is not focused/.test(err.message)
      ? err.message
      : 'Could not copy the screenshot - use Save screenshot instead');
  }
}

/*
 * Download Replay: the replay file, saved by the browser like any download.
 *
 * Asked about first, because a download that fails is reported only in the browser's own
 * download list -- "Failed - No file" -- and never on the page. A replay can vanish from
 * under a score: osu! owns that file and may delete it.
 */
export async function downloadReplay(id) {
  const url = `/api/scores/${id}/replay`;
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok) {
      // HEAD carries no body; the same request as a GET says why.
      const d = await fetch(url).then((r) => r.json()).catch(() => ({}));
      throw new Error(d.error ?? 'the replay could not be downloaded');
    }
  } catch (err) {
    toast(err.message);
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  // Empty: the server's Content-Disposition names the file, as lazer names an exported one.
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

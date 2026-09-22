/**
 * Beatmap names, in the script the song was written in.
 *
 * osu! offers "prefer metadata in original language", and this is the page's half of it: the
 * server sends both names with every beatmap (see `src/calc/metadata.ts`) and everything that
 * draws one asks here which to use. So switching it redraws the page from what it already
 * has, with no request and no reload -- the same instant switch the language picker makes,
 * and the reason the checkbox can sit in that menu at all.
 *
 * The answer is kept in two places, exactly as the language is: `localStorage`, so the page
 * starts in it before the app has answered anything, and `config.json`, so the *app* starts
 * in it and a second browser on the same machine agrees with the first.
 *
 * An original-language name arrives only when it differs from the romanised one, so `??` is
 * the whole rule: most beatmaps repeat their romanised title in `TitleUnicode` or carry none
 * at all, and those send nothing.
 */

const STORAGE_KEY = 'osu-local-profiles.original-metadata';

/*
 * Not an exported `let`: an imported binding is a snapshot of the value, so every module
 * would read whatever this was when the page loaded. The shared copy of the page bundles
 * these modules (web/js/bundle.js) and refuses `export let` for that reason.
 */
let preferOriginal = read();

function read() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // A browser with site data blocked. The app's own config still arrives shortly.
    return false;
  }
}

/** Whether beatmaps are shown in their original language. */
export function preferOriginalMetadata() {
  return preferOriginal;
}

/**
 * Remember the choice. Returns whether it actually changed, so a caller can skip a redraw.
 *
 * Only the page's copy: saving it to the app is `chooseOriginalMetadata` in
 * web/js/language-picker.js, which is also what tells the page to redraw.
 */
export function setPreferOriginalMetadata(on) {
  const next = on === true;
  if (next === preferOriginal) return false;
  preferOriginal = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    /* site data blocked: the app's config still remembers */
  }
  return true;
}

/**
 * Pick between a romanised name and the same name in its own script.
 *
 * The one rule the whole feature comes down to, so everything else here is written in terms
 * of it -- including the names the server had to join up itself, such as the beatmap a medal
 * was earned on.
 */
export function original(romanised, inOwnScript) {
  return (preferOriginal ? inOwnScript : null) ?? romanised ?? null;
}

/** A beatmap's artist, as this page shows artists. */
export function beatmapArtist(item) {
  return original(item?.artist, item?.artistUnicode);
}

/** A beatmap's title, as this page shows titles. */
export function beatmapTitle(item) {
  return original(item?.title, item?.titleUnicode);
}

/** `artist - title`, the way every list writes it. '' when the beatmap has neither. */
export function beatmapName(item) {
  return [beatmapArtist(item), beatmapTitle(item)].filter(Boolean).join(' - ');
}

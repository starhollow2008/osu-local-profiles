/**
 * The page's typeface: Nunito, which ships with the app (web/css/fonts.css), or the system's
 * own font at osu-web's weights as asked. Other settings -> Font.
 *
 * Kept the way the language and original-language metadata are (web/js/metadata.js):
 * `localStorage`, so the page starts in it before the app has answered anything, and
 * `config.json`, so a second browser, a score screenshot and a saved copy agree with the first.
 * The choice is an attribute on <html> that web/css/tokens.css reads, set as soon as this
 * module loads.
 */

const STORAGE_KEY = 'osu-local-profiles.font';

/** The two choices, the first being the default. */
export const FONTS = ['nunito', 'system'];

const clean = (font) => (FONTS.includes(font) ? font : FONTS[0]);

// Not an exported `let`: the shared copy bundles these modules (web/js/bundle.js), and an
// imported binding would be a snapshot of whatever this was when the page loaded.
let current = read();
apply();

function read() {
  try {
    return clean(localStorage.getItem(STORAGE_KEY));
  } catch {
    // A browser with site data blocked. The app's own config still arrives shortly.
    return FONTS[0];
  }
}

function apply() {
  document.documentElement.dataset.font = current;
}

/** The typeface in use, `nunito` or `system`. */
export function pageFont() {
  return current;
}

/**
 * Use a typeface and remember it in this browser. Returns whether it changed. Saving it to the
 * app is the caller's, through /api/app-config.
 */
export function setPageFont(font) {
  const next = clean(font);
  if (next === current) return false;
  current = next;
  apply();
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* site data blocked: the app's config still remembers */
  }
  return true;
}

/**
 * The app's answer, applied once it arrives. A config that has never said (an older
 * config.json) leaves this browser's answer alone.
 */
export function applyConfigFont(config) {
  const wanted = config?.font;
  if (FONTS.includes(wanted)) setPageFont(wanted);
}

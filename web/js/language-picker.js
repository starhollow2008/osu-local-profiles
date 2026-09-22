/**
 * The flag in the corner, and the menu it opens.
 *
 * Every language is listed under its own name -- Deutsch, 日本語, Português (Brasil) --
 * because somebody looking for their language is not reading the one the page is currently
 * in. That is the whole rule this menu follows, and it is why the English names are only a
 * search aid and never the label.
 *
 * The flag beside each name is a convention rather than a fact: languages are not countries,
 * and a few of these have no country at all. It is what osu! players expect a language
 * switcher to look like, so it is what this is, with the language's own name doing the
 * actual work of identifying it.
 */

import { escapeHtml } from './format.js';
import { availableLocales, currentLocale, localeFlagUrl, localeInfo, t, useLocale } from './i18n.js';
import { preferOriginalMetadata, setPreferOriginalMetadata } from './metadata.js';

const $ = (id) => document.getElementById(id);

/** Called after a language change so the page controller can re-render what it drew. */
let onChange = () => {};

function renderButton() {
  const info = localeInfo(currentLocale());
  $('langFlag').src = localeFlagUrl(info.code);
  $('langFlag').alt = info.native;
  $('langBtn').title = t('lang.change');
  $('langBtn').setAttribute('aria-label', `${t('lang.change')}: ${info.native}`);
}

/**
 * The one thing in here that is not a language, and it belongs here anyway: whether a beatmap
 * reads 夜に駆ける or Yoru ni Kakeru is the same question as which language the page is in --
 * how this person reads it -- and this menu is where they have just come to answer it.
 *
 * Above the list rather than below it, because the list scrolls once enough languages are
 * translated and anything under it would be reachable only by scrolling past forty flags.
 */
function renderOriginalToggle() {
  $('langOriginal').setAttribute('aria-checked', String(preferOriginalMetadata()));
}

function renderMenu() {
  const active = currentLocale();
  // Only the translated ones: see `availableLocales` in i18n.js for why an untranslated
  // language is kept in the list but not offered.
  $('langOptions').innerHTML = availableLocales().map(
    (l) => `
      <button type="button" class="lang-option${l.code === active ? ' lang-option--active' : ''}"
              role="menuitemradio" aria-checked="${l.code === active}" data-locale="${l.code}"
              lang="${l.code}">
        <img class="lang-option__flag" src="${escapeHtml(localeFlagUrl(l.code))}" alt="" loading="lazy">
        <span class="lang-option__name">${escapeHtml(l.native)}</span>
        <span class="lang-option__english">${escapeHtml(l.english)}</span>
      </button>`,
  ).join('');
}

export function languageMenuOpen() {
  return !$('langMenu').hidden;
}

export function setLanguageMenuOpen(open) {
  $('langMenu').hidden = !open;
  $('langBtn').setAttribute('aria-expanded', String(open));
  if (open) {
    renderMenu();
    renderOriginalToggle();
    // Bring the language in use into view: the list scrolls once there are enough of them,
    // and the one you are in is the one you are looking for when you open this by accident.
    $('langMenu').querySelector('.lang-option--active')?.scrollIntoView({ block: 'center' });
  }
}

/**
 * Switch language, persist it, and tell the page to redraw.
 *
 * Saved in two places on purpose: `config.json` so the app starts in it, and `localStorage`
 * (inside `useLocale`) so the *page* starts in it -- config arrives with the first API
 * response, which is after the first paint.
 */
export async function chooseLanguage(code) {
  await useLocale(code);
  renderButton();
  setLanguageMenuOpen(false);
  // Best effort: a page that could not save its choice is still in the language now, and
  // localStorage has it for next time.
  fetch('/api/app-config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: code }),
  }).catch(() => {});
  onChange(code);
}

/**
 * Switch between romanised and original-language beatmap metadata, persist it, and redraw.
 *
 * Saved in the same two places the language is, for the same two reasons: `localStorage`
 * (inside `setPreferOriginalMetadata`) so the *page* starts in it, and `config.json` so the
 * app does. Nothing is re-fetched -- both names are already on every beatmap the page holds.
 */
export function chooseOriginalMetadata(on) {
  if (!setPreferOriginalMetadata(on)) return;
  renderOriginalToggle();
  fetch('/api/app-config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ originalMetadata: on === true }),
  }).catch(() => {});
  onChange(currentLocale());
}

/** Wire the picker up. Called once, from the page controller. */
export function bindLanguagePicker(afterChange) {
  onChange = afterChange ?? (() => {});
  renderButton();

  $('langBtn').onclick = (e) => {
    e.stopPropagation();
    setLanguageMenuOpen(!languageMenuOpen());
  };
  $('langMenu').onclick = (e) => {
    const option = e.target.closest('[data-locale]');
    if (option) void chooseLanguage(option.dataset.locale);
  };
  // In the menu but not a language, so it is wired on its own -- and it leaves the menu open,
  // the way every other menu switch does: the point is to watch the page change behind it.
  $('langOriginal').onclick = (e) => {
    e.stopPropagation();
    chooseOriginalMetadata(!preferOriginalMetadata());
  };
  document.addEventListener('click', (e) => {
    if (languageMenuOpen() && !e.target.closest('.lang-wrap')) setLanguageMenuOpen(false);
  });
}

/** Keep the flag and the checkbox in step when either was changed from somewhere else. */
export function refreshLanguageButton() {
  renderButton();
  renderOriginalToggle();
}

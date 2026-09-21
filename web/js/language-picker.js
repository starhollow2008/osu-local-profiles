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

function renderMenu() {
  const active = currentLocale();
  // Only the translated ones: see `availableLocales` in i18n.js for why an untranslated
  // language is kept in the list but not offered.
  $('langMenu').innerHTML = availableLocales().map(
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
  document.addEventListener('click', (e) => {
    if (languageMenuOpen() && !e.target.closest('.lang-wrap')) setLanguageMenuOpen(false);
  });
}

/** Keep the flag in step when the language was changed from somewhere else. */
export function refreshLanguageButton() {
  renderButton();
}

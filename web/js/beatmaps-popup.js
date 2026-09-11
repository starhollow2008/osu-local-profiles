/**
 * The difficulty popup under a Favorite Beatmaps card.
 */
import { beatmapsPopupContent } from './beatmapsets.js';

const $ = (id) => document.getElementById(id);

/*
 * The difficulty popup, osu-web's `beatmaps-popup`: hovering a card's row of dots opens it
 * under the card after 100ms, and leaving closes it after 500ms unless the pointer has
 * moved onto the popup itself. Placed in page coordinates, so it scrolls with its card.
 */
/** The Favorite Beatmaps cards on the page, by set id, for the popup to read from. */
let cards = new Map();

/** Called with each render of Favorite Beatmaps; any open popup belongs to the old cards. */
export function setPopupCards(list) {
  cards = new Map(list.map((c) => [c.id, c]));
  hideBeatmapsPopup();
}

let popupFor = null;
let popupTimer = null;
/** What the pending timer will do, so a countdown to close is not restarted by every move. */
let popupPending = null;

function hideBeatmapsPopup() {
  clearTimeout(popupTimer);
  popupTimer = null;
  popupPending = null;
  $('beatmapsPopup').hidden = true;
  document.querySelector('.beatmapset-panel--popup-open')?.classList.remove('beatmapset-panel--popup-open');
  popupFor = null;
}

function showBeatmapsPopup(panel) {
  const card = cards.get(Number(panel.dataset.setId));
  if (!card) return;
  const popup = $('beatmapsPopup');
  if (popupFor !== panel) {
    hideBeatmapsPopup();
    popup.innerHTML = beatmapsPopupContent(card);
    popupFor = panel;
    panel.classList.add('beatmapset-panel--popup-open');
  }
  const box = panel.getBoundingClientRect();
  popup.style.left = `${box.left + window.scrollX}px`;
  popup.style.top = `${box.bottom + window.scrollY}px`;
  popup.style.width = `${box.width}px`;
  popup.hidden = false;
}

const schedulePopup = (what, fn, ms) => {
  if (popupPending === what) return;
  clearTimeout(popupTimer);
  popupPending = what;
  popupTimer = setTimeout(() => {
    popupPending = null;
    popupTimer = null;
    fn();
  }, ms);
};

const cancelPopupTimer = () => {
  clearTimeout(popupTimer);
  popupTimer = null;
  popupPending = null;
};

document.addEventListener('mouseover', (e) => {
  const dots = e.target.closest?.('[data-beatmaps-popup]');
  if (dots) {
    const panel = dots.closest('.beatmapset-panel');
    if (popupFor === panel && !$('beatmapsPopup').hidden) cancelPopupTimer();
    else schedulePopup(`show:${panel.dataset.setId}`, () => showBeatmapsPopup(panel), 100);
    return;
  }
  // On the popup, or anywhere on the card that owns it: keep it, as osu!'s does.
  if (e.target.closest?.('#beatmapsPopup') || (popupFor !== null && popupFor.contains(e.target))) {
    if (popupPending === 'hide') cancelPopupTimer();
    return;
  }
  if (popupFor !== null) schedulePopup('hide', hideBeatmapsPopup, 500);
  else if (popupPending !== null) cancelPopupTimer();
});
window.addEventListener('resize', hideBeatmapsPopup);

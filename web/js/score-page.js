/**
 * A score's own page, `/scores/<id>`: the View Details card on a page of its own, so a score
 * has an address that can be pasted into a browser -- this app's `osu.ppy.sh/scores/<id>`.
 *
 * The server answers for the profile that owns the score, whichever one the app is showing,
 * so a copied link keeps working after a profile switch. Pinning is offered only when the
 * score is the active profile's, because pins are changed on the active profile.
 */
import { scoreCard } from './score-card.js';
import {
  cardOwner,
  copyScoreImage,
  copyScoreLink,
  downloadReplay,
  saveScoreImage,
} from './score-share.js';
import { postJson, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const id = Number(/^\/scores\/(\d+)/.exec(location.pathname)?.[1]);
const exporting = new URLSearchParams(location.search).get('export') === '1';
if (exporting) document.body.classList.add('export-mode');

let owner = null;
let score = null;

async function load() {
  try {
    const r = await fetch(`/api/scores/${id}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? 'that score could not be loaded');
    score = d.score;
    owner = d.owner;
    $('scoreCard').innerHTML = scoreCard(score, cardOwner(owner));
    // osu-web's page title: `:username on :title [:version]`.
    document.title = `${owner.name} on ${score.title ?? 'unknown beatmap'}${
      score.version ? ` [${score.version}]` : ''
    } | osu! local profiles`;
    $('scoreBack').textContent = `‹ back to ${owner.active ? `${owner.name}'s profile` : 'the profile'}`;
  } catch (err) {
    $('scoreCard').innerHTML = `<div class="score-modal__loading">${
      // Nothing from the server goes in as markup.
      String(err.message).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
    }. It may have been removed from its profile.</div>`;
  }
  // What the screenshot waits for, as the profile page's export does.
  document.body.dataset.rendered = 'true';
}

/* ------------------------------------------------------------------- menu */

const menu = $('scoreMenu');
const closeMenu = () => (menu.hidden = true);

function openMenu(button) {
  const pinned = score?.pinned === true;
  menu.querySelector('[data-act="pin"]').hidden = !owner?.active || pinned;
  menu.querySelector('[data-act="unpin"]').hidden = !owner?.active || !pinned;
  menu.hidden = false;
  const box = button.getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.left = `${Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8))}px`;
  menu.style.top = `${box.bottom + 4}px`;
}

document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-play-menu]');
  if (button) {
    e.stopPropagation();
    if (menu.hidden) openMenu(button);
    else closeMenu();
    return;
  }
  const replay = e.target.closest('[data-replay-download]');
  if (replay) {
    e.preventDefault();
    void downloadReplay(id);
    return;
  }
  if (!e.target.closest('#scoreMenu')) closeMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
window.addEventListener('scroll', closeMenu, { passive: true });

menu.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  closeMenu();
  if (act === 'copy-link') return copyScoreLink(id);
  if (act === 'save-image') return saveScoreImage(id);
  if (act === 'copy-image') return copyScoreImage(id);
  if (act === 'pin' || act === 'unpin') {
    try {
      await postJson('/api/scores', { action: act, id });
      toast(act === 'pin' ? 'Pinned' : 'Unpinned');
      await load();
    } catch (err) {
      toast(err.message);
    }
  }
});

void load();

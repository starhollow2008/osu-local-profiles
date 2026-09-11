/**
 * The Medals section and the card that opens over a medal, anywhere on the page.
 */
import { escapeHtml, fmt, shortDate } from './format.js';
import { medalBadge } from './badges.js';
import { toast } from './ui.js';

const $ = (id) => document.getElementById(id);

/**
 * The Medals section, laid out as osu-web's `medals-group`: one group, "Skill & Dedication",
 * holding one row of icons per family in osu!'s own `ordering`. There is no text on the
 * page at all -- a medal's name, description and date are in the card that appears on
 * hover, exactly as on osu!.
 *
 * osu!'s own icon is used where it loads, over a generated placeholder that stays visible
 * if it does not -- the same arrangement as beatmap covers, and for the same reason: the
 * page has to be complete with no network.
 */

/*
 * osu!'s groups, in the order its page lists them, each heading its icons and its medals'
 * cards. Within a group every `ordering` is one row: Mod Introduction is a single row, and
 * Skill & Dedication's families are combo 0, plays 1, rank 2, hits 3, pass 4, fc 5.
 */
const MEDAL_GROUPS = [
  ['Mod Introduction', ['intro']],
  ['Skill & Dedication', ['combo', 'plays', 'rank', 'hits', 'pass', 'fc']],
];

/** Every medal currently on the page, by slug, for the hover card to read from. */
let medalsBySlug = new Map();

/** A medal on the page, for anything else that describes one (the HTML export does). */
export const medalFor = (slug) => medalsBySlug.get(slug);

/** What this page last saw earned, so a newly unlocked medal can be announced once. */
let lastEarned = { mode: null, slugs: new Set() };

/**
 * The card's content, osu-web's `tooltip-achievement`: the group, then the icon, name and
 * description on a darker panel, then when it was achieved -- or "Locked".
 *
 * A rank medal is decided from the current estimated rank rather than replayed play by play,
 * so it has no real date to give; it says what it is instead of borrowing the last play's.
 */
function medalCard(medal) {
  let achieved;
  if (medal.achievedAt === null) {
    achieved = 'Locked';
  } else if (!medal.dated) {
    achieved = 'Achieved &middot; from the estimated rank';
  } else {
    achieved = `Achieved on <time datetime="${new Date(medal.achievedAt).toISOString()}"
      title="${escapeHtml(new Date(medal.achievedAt).toLocaleString())}">${escapeHtml(shortDate(medal.achievedAt))}</time>`;
  }

  return `<div class="medal-tooltip__grouping">${escapeHtml(medal.grouping ?? 'Skill & Dedication')}</div>
    <div class="medal-tooltip__middle">
      <div class="medal-tooltip__badge">${medalBadge(medal, 'tooltip')}</div>
      <div class="medal-tooltip__name">${escapeHtml(medal.name)}</div>
      <div class="medal-tooltip__description">${escapeHtml(medal.description)}</div>
    </div>
    <div class="medal-tooltip__achieved">
      <div class="medal-tooltip__date">${achieved}</div>
    </div>`;
}

export function renderMedals(summary, mode) {
  if (!summary) return;

  medalsBySlug = new Map(summary.medals.map((m) => [m.slug, m]));
  announceNewMedals(summary, mode);

  /*
   * An FC cannot be told from a near-miss without the beatmap's own maximum combo, which
   * older scores were never given. Say so rather than quietly under-awarding, and point at
   * the fix.
   */
  const note = $('medalsNote');
  if (summary.fcUnknown > 0) {
    note.hidden = false;
    note.textContent =
      `${fmt(summary.fcUnknown)} play${summary.fcUnknown === 1 ? '' : 's'} ` +
      `${summary.fcUnknown === 1 ? 'was' : 'were'} tracked before this app recorded each ` +
      "beatmap's maximum combo, so a full combo cannot be told apart from a near-miss on " +
      'them. Settings can recalculate those from their replay files.';
  } else {
    note.hidden = true;
  }

  const groups = MEDAL_GROUPS.map(([grouping, families]) => {
    const rows = families.map((family) => {
      const medals = summary.medals.filter((m) => m.family === family);
      if (medals.length === 0) return '';
      return `<div class="medals-group__medals">${medals.map((m) => medalBadge(m)).join('')}</div>`;
    }).join('');
    return rows
      ? `<div class="medals-group__group">
          <h3 class="medals-group__title">${escapeHtml(grouping)}</h3>
          ${rows}
        </div>`
      : '';
  }).join('');

  $('medalGroups').innerHTML = groups
    ? `<div class="medals-group">${groups}</div>`
    : '<div class="u-empty">No medals apply to this mode yet.</div>';
}

/**
 * Say so when a medal is unlocked while the page is open.
 *
 * Only against what this page already saw *in the same mode*: the first render of a mode
 * sets the baseline, so opening the page or switching tabs never announces medals that were
 * earned long ago. The Recent feed is the permanent record; this is the moment itself.
 */
function announceNewMedals(summary, mode) {
  const earned = summary.medals.filter((m) => m.achievedAt !== null);
  const slugs = new Set(earned.map((m) => m.slug));

  if (lastEarned.mode === mode) {
    const fresh = earned.filter((m) => !lastEarned.slugs.has(m.slug));
    if (fresh.length === 1) toast(`Medal unlocked: ${fresh[0].name}`);
    else if (fresh.length > 1) toast(`${fresh.length} medals unlocked: ${fresh.map((m) => m.name).join(', ')}`);
  }
  lastEarned = { mode, slugs };
}

/* ------------------------------------------------------------ medal card */

/*
 * The card that opens over a medal, as osu-web's qtip does: above the icon and centred on
 * it, after a short delay, and kept open while the pointer moves onto the card itself --
 * `hide: { delay: 200, fixed: true }` there. One card serves every medal on the page, in
 * the section and in the Recent feed alike.
 */
const MEDAL_CARD_DELAY = 200;
let medalCardFor = null;
let medalShowTimer = null;
let medalHideTimer = null;

function positionMedalCard(anchor) {
  const card = $('medalTooltip');
  const box = anchor.getBoundingClientRect();
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  const tip = 20;

  // Centred over the icon, but never past either edge of the window; the tip follows the
  // icon even when the card itself has been pushed sideways.
  const centre = box.left + box.width / 2;
  const left = Math.max(8, Math.min(centre - width / 2, window.innerWidth - width - 8));
  const below = box.top - height - tip < 8;
  const top = below ? box.bottom + tip : box.top - height - tip;

  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  card.style.setProperty('--tip-x', `${centre - left}px`);
  card.classList.toggle('medal-tooltip--below', below);
}

function showMedalCard(anchor) {
  medalShowTimer = null;
  const medal = medalsBySlug.get(anchor.dataset.medal);
  if (!medal) return;
  cancelMedalHide();
  const card = $('medalTooltip');
  if (medalCardFor === anchor && !card.hidden) return;

  medalCardFor = anchor;
  card.innerHTML = medalCard(medal);
  card.hidden = false;
  positionMedalCard(anchor);
}

function hideMedalCard() {
  clearTimeout(medalShowTimer);
  medalShowTimer = null;
  medalHideTimer = null;
  $('medalTooltip').hidden = true;
  medalCardFor = null;
}

const scheduleMedalHide = () => {
  clearTimeout(medalShowTimer);
  medalShowTimer = null;
  clearTimeout(medalHideTimer);
  medalHideTimer = setTimeout(hideMedalCard, MEDAL_CARD_DELAY);
};

const cancelMedalHide = () => {
  clearTimeout(medalHideTimer);
  medalHideTimer = null;
};

document.addEventListener('mouseover', (e) => {
  const badge = e.target.closest?.('[data-medal]');
  if (badge) {
    cancelMedalHide();
    if (medalCardFor === badge) return;
    clearTimeout(medalShowTimer);
    // Moving from one medal straight to the next swaps at once, as osu!'s does.
    if (!$('medalTooltip').hidden) showMedalCard(badge);
    else medalShowTimer = setTimeout(() => showMedalCard(badge), MEDAL_CARD_DELAY);
    return;
  }
  if (e.target.closest?.('#medalTooltip')) {
    cancelMedalHide();
    return;
  }
  // Anywhere else: let an open card go, or cancel one about to open. Otherwise nothing.
  if ((medalCardFor !== null && medalHideTimer === null) || medalShowTimer !== null) {
    scheduleMedalHide();
  }
});

document.addEventListener('focusin', (e) => {
  const badge = e.target.closest?.('[data-medal]');
  if (badge) showMedalCard(badge);
});
document.addEventListener('focusout', (e) => {
  if (e.target.closest?.('[data-medal]')) scheduleMedalHide();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideMedalCard();
});
// The card is positioned in window coordinates, so it would drift off its medal.
window.addEventListener('scroll', hideMedalCard, { passive: true });
window.addEventListener('resize', hideMedalCard);

/*
 * The drawn placeholder is only there until osu!'s icon arrives. osu!'s icons are not round,
 * so once one has loaded the circle behind it has to go or it shows round the edges. `load`
 * does not bubble, hence the capture.
 */
document.addEventListener(
  'load',
  (e) => {
    if (e.target instanceof HTMLImageElement && e.target.matches('.badge-achievement__image')) {
      e.target.closest('.badge-achievement')?.classList.add('badge-achievement--loaded');
    }
  },
  true,
);

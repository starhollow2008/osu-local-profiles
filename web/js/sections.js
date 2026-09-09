/** Markup builders for the repeated rows on the profile page. */
import { escapeHtml, fmt, pct, timeAgo, fullDate } from './format.js';
import { coverUrl, gradeBadge, modList } from './badges.js';

function titleOf(item) {
  const name = [item.artist, item.title].filter(Boolean).join(' - ');
  return name || `unknown beatmap (${(item.beatmapMd5 ?? '').slice(0, 12)})`;
}

/** Links back to osu.ppy.sh when we know the id, and is inert when we do not. */
function beatmapHref(item) {
  return item.beatmapId ? `https://osu.ppy.sh/b/${item.beatmapId}` : null;
}

function maybeLink(href, inner, className) {
  return href
    ? `<a class="${className}" href="${href}" target="_blank" rel="noreferrer noopener">${inner}</a>`
    : `<span class="${className}">${inner}</span>`;
}

/**
 * What to say, once, above a total that was not calculated the way osu! would calculate it.
 * Empty string when the profile is scoring officially, which is the default.
 *
 * A pure function so the wording is testable without a running profile: the alternative is
 * saving a setting to see it, which means the check would have to change how the user's
 * profile is configured.
 */
export function countingNoteText(counting) {
  const included = [];
  if (counting?.includeUnrankedMods) included.push('mods');
  if (counting?.extraMapStatuses?.length) included.push('beatmaps');
  if (included.length === 0) return '';

  let text = `This profile counts plays on ${included.join(' and ')} osu! does not rank. `;
  if (counting.includeUnrankedMods) {
    text += counting.preferStrippedPp
      ? 'Relax and Autopilot plays are priced as if the mod had been off, which osu! never ' +
        'awards - those are marked with *. '
      : 'Relax and Autopilot plays use osu!’s own pp for the mods as played. ';
  }
  return `${text}The pp and rank here are not comparable with a real osu! account.`;
}

/**
 * The pp figure for one play, and why it is what it is.
 *
 * There are more cases here than on osu!, because this profile can be configured to count
 * things osu! does not. Every departure has to be visible on the row itself -- a number
 * that osu! would never award, shown the same way as one it would, is the one thing this
 * page must not do.
 */
function ppCell(play) {
  // No pp at all: an unranked map or mod combination before the settings allowed it, or a
  // beatmap that was never downloaded so there is no local .osu to calculate from.
  if (play.pp == null) {
    return `<div class="play-detail__pp play-detail__pp--none" title="${
      play.ranked ? 'no pp -- the beatmap file was not found locally' : 'unranked'
    }">-</div>`;
  }

  const classes = ['play-detail__pp'];
  const notes = [];
  let marker = '';

  if (play.counted === false) {
    classes.push('play-detail__pp--uncounted');
    notes.push(
      play.passed === false
        ? 'A failed play never counts toward pp.'
        : 'This does not count toward the profile: osu! would not rank it, and the settings do not include it.',
    );
  }

  if (play.ppBasis === 'without-unranked-mods') {
    classes.push('play-detail__pp--unofficial');
    marker = '<span class="play-detail__pp-mark" aria-hidden="true">*</span>';
    notes.push(
      'Priced with Relax or Autopilot removed, as if the mod had not been on. ' +
        'osu! never awards this, and it flatters the score.',
    );
  }

  const title = notes.length ? ` title="${escapeHtml(notes.join(' '))}"` : '';
  return `<div class="${classes.join(' ')}"${title}>${fmt(play.pp, 0)}${marker}<span class="play-detail__pp-unit">pp</span></div>`;
}

/**
 * One score, laid out as osu-web's `.play-detail`: grade and title on the left, then
 * accuracy, mods and pp stepping right.
 */
export function playRow(play, { showWeight = false } = {}) {
  const artist = play.artist ? ` <small class="play-detail__artist">by ${escapeHtml(play.artist)}</small>` : '';
  const title = maybeLink(
    beatmapHref(play),
    `${escapeHtml(play.title ?? titleOf(play))}${artist}`,
    'play-detail__title u-ellipsis',
  );

  const weighted =
    showWeight && play.pp != null
      ? `<span class="play-detail__weighted-pp">${fmt(play.weightedPp, 0)}pp</span>`
      : '';
  const weightNote =
    showWeight && play.weight != null
      ? `<div class="play-detail__pp-weight">weighted ${Math.round(play.weight * 100)}%</div>`
      : '';

  const pp = ppCell(play);

  const stars = play.stars != null ? ` &middot; ${fmt(play.stars, 2)}&#9733;` : '';

  return `<div class="play-detail">
  <div class="play-detail__group play-detail__group--top">
    <div class="play-detail__icon">${gradeBadge(play.grade)}</div>
    <div class="play-detail__detail">
      ${title}
      <div class="play-detail__beatmap-and-time">
        <span class="play-detail__beatmap u-ellipsis">${escapeHtml(play.version ?? '')}${stars}</span>
        <span class="play-detail__time" title="${escapeHtml(fullDate(play.playedAt))}">${escapeHtml(timeAgo(play.playedAt))}</span>
      </div>
    </div>
  </div>
  <div class="play-detail__group play-detail__group--bottom">
    <div class="play-detail__score-detail">
      <div>
        <div class="play-detail__accuracy-and-weighted-pp">
          <span class="play-detail__accuracy">${pct(play.accuracy)}</span>${weighted}
        </div>
        ${weightNote}
      </div>
    </div>
    <div class="play-detail__mods-pp">
      <div class="play-detail__mods">${modList(play.mods)}</div>
      ${pp}
    </div>
  </div>
</div>`;
}

export function playList(plays, options = {}) {
  if (!plays || plays.length === 0) {
    return `<div class="u-empty">${escapeHtml(options.empty ?? 'Nothing here yet.')}</div>`;
  }
  return `<div class="play-detail-list">${plays.map((p) => playRow(p, options)).join('')}</div>`;
}

/**
 * A most-played row. The cover is the one place the page reaches for the network: it is
 * set as a background so a failed request simply leaves the placeholder colour behind.
 */
export function beatmapPlaycountRow(item) {
  const cover = coverUrl(item.beatmapsetId);
  const style = cover ? ` style="background-image: url('${cover}')"` : '';
  const artist = item.artist ? ` <span class="beatmap-playcount__artist">by ${escapeHtml(item.artist)}</span>` : '';

  return `<div class="beatmap-playcount">
  <div class="beatmap-playcount__cover"${style}></div>
  <div class="beatmap-playcount__detail">
    ${maybeLink(
      beatmapHref(item),
      `${escapeHtml(item.title ?? titleOf(item))}${artist}`,
      'beatmap-playcount__title u-ellipsis',
    )}
    <div class="beatmap-playcount__version u-ellipsis">${escapeHtml(item.version ?? '')}</div>
  </div>
  <div class="beatmap-playcount__count"><b>${fmt(item.count)}</b> play${item.count === 1 ? '' : 's'}</div>
</div>`;
}

export function beatmapPlaycountList(items) {
  if (!items || items.length === 0) {
    return '<div class="u-empty">No beatmaps played yet.</div>';
  }
  return items.map(beatmapPlaycountRow).join('');
}

/**
 * The Recent section. osu! fills this with account events (medals, rank milestones); a
 * fresh profile has its own equivalents, derived in src/calc/history.ts.
 */
export function activityRow(event) {
  let text;
  switch (event.type) {
    case 'best':
      text = `New best performance: <span class="activity__highlight">${fmt(event.pp, 0)}pp</span> on
              <span class="activity__map">${escapeHtml(event.title)}${
                event.version ? ` [${escapeHtml(event.version)}]` : ''
              }</span>`;
      break;
    case 'level':
      text = `Reached <span class="activity__highlight">level ${fmt(event.level)}</span>`;
      break;
    case 'first':
      text = 'Started tracking this profile';
      break;
    default:
      return '';
  }

  return `<div class="activity">
  <div class="activity__text">${text}</div>
  <div class="activity__time" title="${escapeHtml(fullDate(event.at))}">${escapeHtml(timeAgo(event.at))}</div>
</div>`;
}

export function activityList(events) {
  if (!events || events.length === 0) {
    return '<div class="u-empty">Nothing has happened yet.</div>';
  }
  return events.map(activityRow).join('');
}

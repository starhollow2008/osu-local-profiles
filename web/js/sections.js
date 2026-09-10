/** Markup builders for the repeated rows on the profile page. */
import { escapeHtml, fmt, pct, timeAgo, fullDate } from './format.js';
import { coverUrl, gradeBadge, incompleteBadge, modList } from './badges.js';

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
 * The profile's own description, as markup.
 *
 * Plain text in, escaped HTML out. osu! itself accepts BBCode here, but a local profile
 * gains nothing from an HTML sanitiser it would have to get exactly right, and everything
 * to lose by getting it wrong. So: escape everything, keep the line breaks, and turn bare
 * URLs into links -- that is the whole feature.
 *
 * URLs are found in the *raw* text and escaped individually, rather than escaping the whole
 * string first and matching afterwards. Escaping first looks safer and is worse: it turns
 * a typed quote into `&quot;`, which contains no character the URL pattern stops at, so the
 * match runs straight through the entity and swallows the rest of the line into the href.
 */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/g;

/** Sentence punctuation almost never belongs to the URL it follows. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

export function aboutHtml(text) {
  if (!text) return '';

  let out = '';
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const found = match[0];
    const url = found.replace(TRAILING_PUNCTUATION, '');
    out += escapeHtml(text.slice(cursor, match.index));
    // Both the href and the visible text are escaped: everything here came from the user.
    const safe = escapeHtml(url);
    out += `<a href="${safe}" target="_blank" rel="noreferrer noopener">${safe}</a>`;
    // Whatever was trimmed is punctuation belonging to the sentence, not the link.
    cursor = match.index + url.length;
  }
  out += escapeHtml(text.slice(cursor));

  const BREAK = String.fromCharCode(10);
  return out
    .split(BREAK + BREAK)
    .map((paragraph) => `<p>${paragraph.split(BREAK).join('<br>')}</p>`)
    .join('');
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
export function playRow(play, { showWeight = false, actions = false, reorderable = false } = {}) {
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

  /*
   * One shared popover does the menu (see #playMenu), so a row only carries the button and
   * the state the menu needs. Rendering a menu per row would put 100 hidden dialogs on the
   * page and put each of them inside a container that clips them.
   */
  const menu = actions
    ? `<button class="play-detail__menu" type="button" data-play-menu
         data-id="${play.id}" data-pinned="${play.pinned ? 1 : 0}"
         aria-haspopup="true" aria-label="Options for this score" title="Options">&#8943;</button>`
    : '';

  // The drag handle is a convenience; the menu's Move up / Move down do the same job for
  // anyone not using a mouse.
  const grip = reorderable
    ? '<div class="play-detail__grip" aria-hidden="true" title="Drag to reorder">&#8942;&#8942;</div>'
    : '';

  return `<div class="play-detail${reorderable ? ' play-detail--reorderable' : ''}"
    data-score-id="${play.id}"${reorderable ? ' draggable="true"' : ''}>
  ${grip}
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
    ${menu}
  </div>
</div>`;
}

/**
 * A play osu! counted that never produced a score: a quit, a retry, or an HP fail.
 *
 * lazer only writes a replay for a map played to the end, so there is no accuracy here, no
 * combo, no mods and no pp -- the game never records them for a play it does not keep. The
 * row is built to look like what it is: the beatmap and when, dimmed, and *no* zeroes
 * standing in for numbers nobody knows.
 */
export function incompleteRow(play) {
  const artist = play.artist
    ? ` <small class="play-detail__artist">by ${escapeHtml(play.artist)}</small>`
    : '';
  const title = maybeLink(
    beatmapHref(play),
    `${escapeHtml(play.title ?? titleOf(play))}${artist}`,
    'play-detail__title u-ellipsis',
  );

  const attempts =
    play.attempts > 1
      ? `<span class="play-detail__attempts" title="${play.attempts} attempts in a row on this beatmap, none finished">&times;${fmt(play.attempts)}</span>`
      : '';

  return `<div class="play-detail play-detail--incomplete" data-incomplete-id="${play.id}">
  <div class="play-detail__group play-detail__group--top">
    <div class="play-detail__icon">${incompleteBadge()}</div>
    <div class="play-detail__detail">
      ${title}
      <div class="play-detail__beatmap-and-time">
        <span class="play-detail__beatmap u-ellipsis">${escapeHtml(play.version ?? '')}</span>
        <span class="play-detail__time" title="${escapeHtml(fullDate(play.playedAt))}">${escapeHtml(timeAgo(play.playedAt))}</span>
      </div>
    </div>
  </div>
  <div class="play-detail__group play-detail__group--bottom">
    <div class="play-detail__score-detail">
      <span class="play-detail__didnt-finish"
            title="Started but not finished - quit, retried, or failed. osu! counts this toward your play count, but there is no score to show: lazer only saves a replay for a map played to the end.">Didn&rsquo;t finish</span>
    </div>
    <div class="play-detail__mods-pp">${attempts}</div>
  </div>
</div>`;
}

/*
 * osu-web's `show-more-link`: a pill with the label between two chevrons, and the number
 * still hidden in brackets after it. The chevron is drawn here rather than pulled from an
 * icon font, the way every other icon on this page is.
 */
const CHEVRON =
  '<svg class="show-more-link__chevron" viewBox="0 0 10 6" aria-hidden="true">' +
  '<path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"' +
  ' stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * The control that lengthens one of the paged sections.
 *
 * Returns nothing once everything is shown -- a button that would reveal nothing is worse
 * than no button, because it reads as a list with more in it.
 *
 * Knowing when to stop takes both halves of the test, and neither alone is enough. A list
 * shorter than what was asked for is definitely complete, which is the reliable half. But
 * `total` counts *plays*, and Recent Plays can draw fewer rows than it has plays, because a
 * run of retries on one beatmap collapses into a single row -- so a page that came back
 * exactly full might still be the end of the list. Requiring both means the button appears
 * only when there is genuinely more behind it.
 */
export function showMore(section, returned, requested, total) {
  const complete = returned < requested || (Number.isFinite(total) && total <= returned);
  if (complete) return '';

  return `<button class="show-more-link" type="button" data-show-more="${escapeHtml(section)}">
  ${CHEVRON}
  <span class="show-more-link__text">show more</span>
  ${CHEVRON}
</button>`;
}

export function playList(plays, options = {}) {
  if (!plays || plays.length === 0) {
    return `<div class="u-empty">${escapeHtml(options.empty ?? 'Nothing here yet.')}</div>`;
  }
  return `<div class="play-detail-list">${plays
    .map((p) => (p.kind === 'incomplete' ? incompleteRow(p) : playRow(p, options)))
    .join('')}</div>`;
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

/** Markup builders for the repeated rows on the profile page. */
import { escapeHtml, fmt, pct, timeAgo, fullDate } from './format.js';
import { coverUrl, gradeBadge, incompleteBadge, medalBadge, modList } from './badges.js';
import { t } from './i18n.js';
import { beatmapArtist, beatmapName, beatmapTitle, original } from './metadata.js';

function titleOf(item) {
  return beatmapName(item) || t('beatmap.unknown', {
    md5: (item.beatmapMd5 ?? '').slice(0, 12),
  });
}

/** The `by <artist>` after a play's title, in whichever script the page is showing. */
function playArtist(play) {
  const artist = beatmapArtist(play);
  return artist ? ` <small class="play-detail__artist">by ${escapeHtml(artist)}</small>` : '';
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
  // The play count's own departure from osu!, said beside whatever the pp note says -- or on
  // its own, since counting these changes no pp at all.
  // Only once something is actually counted: on by default, it would otherwise be said to
  // every profile, whether or not it had ever played offline.
  const plays =
    counting?.countUnsubmitted && counting.unsubmittedAttempts > 0
      ? t('note.unsubmittedCount')
      : '';

  /*
   * Nothing on this machine can say whether a beatmap is ranked: only osu!lazer ships the
   * database that records it, and this install has osu!stable alone. Every beatmap counts
   * instead, which has to be said plainly -- it is the one case where the profile counts
   * unranked plays without anybody having asked it to.
   */
  if (counting?.countUnresolved) {
    return (
      t('note.stableOnly') + (plays ? ` ${plays}` : '')
    );
  }

  const included = [];
  if (counting?.includeUnrankedMods) included.push(t('note.mods'));
  if (counting?.extraMapStatuses?.length) included.push(t('note.beatmaps'));
  if (included.length === 0) return plays;

  // "mods", "beatmaps", or both joined. The joining word is translated too: a language that
  // does not put "and" between two nouns the way English does still reads correctly.
  let text = `${t('note.countsUnranked', { what: included.join(t('note.and')) })} `;
  if (counting.includeUnrankedMods) {
    text += counting.preferStrippedPp
      ? `${t('note.strippedPp')} `
      : `${t('note.officialPp')} `;
  }
  return `${text}${t('note.notComparable')}${plays ? ` ${plays}` : ''}`;
}

/**
 * A saved section order, brought up to date with the sections that exist now.
 *
 * Unknown ids are dropped and duplicates ignored. A section the saved order has never seen
 * -- one added in a later version -- goes in right after the section it follows in the
 * default order, not at the very end: appending put Beatmaps below Medals on a profile that
 * had moved Medals to the bottom, which is the one place it should not be. With nothing it
 * follows present, it goes first.
 */
export function reconcileSectionOrder(saved, defaultOrder, retiredDefaults = []) {
  /*
   * A saved order exactly equal to an earlier version's default was not a choice anyone made
   * -- the page saved it as it stood, after a section was moved and moved back, say. Such a
   * page gets the current default, which is what it would have shown had nothing been saved;
   * a page that really was rearranged keeps its arrangement.
   */
  const same = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
  if (Array.isArray(saved) && retiredDefaults.some((old) => same(saved, old))) return [...defaultOrder];

  const out = [];
  for (const id of saved ?? []) {
    if (defaultOrder.includes(id) && !out.includes(id)) out.push(id);
  }
  defaultOrder.forEach((id, index) => {
    if (out.includes(id)) return;
    // The nearest section before it in the default order that the saved order does have.
    const before = defaultOrder.slice(0, index).reverse().find((prev) => out.includes(prev));
    out.splice(before === undefined ? 0 : out.indexOf(before) + 1, 0, id);
  });
  return out;
}

/**
 * Why a play's pp reads the way it does, shared by the row and the View Details card so the
 * two can never explain the same number differently.
 */
export function ppNotes(play) {
  if (play.pp == null) {
    // No pp at all: an unranked map or mod combination before the settings allowed it, or a
    // beatmap that was never downloaded so there is no local .osu to calculate from.
    return {
      none: play.ranked
        ? t('pp.noBeatmapFile')
        : t('pp.unranked'),
      uncounted: false,
      unofficial: false,
      notes: [],
    };
  }

  const notes = [];
  const uncounted = play.counted === false;
  const unofficial = play.ppBasis === 'without-unranked-mods';
  if (uncounted) {
    notes.push(
      play.passed === false
        ? t('pp.failedNeverCounts')
        : t('pp.notCounted'),
    );
  }
  if (unofficial) {
    notes.push(
      t('pp.strippedBasis'),
    );
  }
  return { none: null, uncounted, unofficial, notes };
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
  const why = ppNotes(play);
  if (why.none !== null) {
    return `<div class="play-detail__pp play-detail__pp--none" title="${why.none}">-</div>`;
  }

  const classes = ['play-detail__pp'];
  const notes = why.notes;
  let marker = '';

  if (why.uncounted) classes.push('play-detail__pp--uncounted');
  if (why.unofficial) {
    classes.push('play-detail__pp--unofficial');
    marker = '<span class="play-detail__pp-mark" aria-hidden="true">*</span>';
  }

  const title = notes.length ? ` title="${escapeHtml(notes.join(' '))}"` : '';
  return `<div class="${classes.join(' ')}"${title}>${fmt(play.pp, 0)}${marker}<span class="play-detail__pp-unit">pp</span></div>`;
}

/**
 * One score, laid out as osu-web's `.play-detail`: grade and title on the left, then
 * accuracy, mods and pp stepping right.
 */
export function playRow(play, { showWeight = false, actions = false, reorderable = false } = {}) {
  const artist = playArtist(play);
  const title = maybeLink(
    beatmapHref(play),
    `${escapeHtml(beatmapTitle(play) ?? titleOf(play))}${artist}`,
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
    ? `<button class="play-detail__menu" type="button" data-play-menu data-kind="score"
         data-id="${play.id}" data-pinned="${play.pinned ? 1 : 0}" data-set="${play.beatmapsetId ?? ''}"
         data-replay="${play.hasReplay ? 1 : 0}" aria-haspopup="true" aria-label="Options for this score" title="Options">&#8943;</button>`
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
export function incompleteRow(play, { actions = false } = {}) {
  const artist = playArtist(play);
  const title = maybeLink(
    beatmapHref(play),
    `${escapeHtml(beatmapTitle(play) ?? titleOf(play))}${artist}`,
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
    <div class="play-detail__score-detail">${
      // Listed at all only while the profile counts attempts osu! could not submit, and then
      // labelled apart, because osu! itself never counted it.
      play.unsubmitted
        ? `<span class="play-detail__didnt-finish"
            title="Started but not finished while osu! could not submit it - offline, signed out, or a beatmap osu! cannot submit. osu! never counted this; it is listed because this profile counts plays osu! could not submit.">Not submitted</span>`
        : `<span class="play-detail__didnt-finish"
            title="Started but not finished - quit, retried, or failed. osu! counts this toward your play count, but there is no score to show: lazer only saves a replay for a map played to the end.">Didn&rsquo;t finish</span>`
    }
    </div>
    <div class="play-detail__mods-pp">${attempts}</div>
    ${
      // No score to pin or view, but the play can be removed -- every attempt the row stands
      // for -- and its beatmap favourited when there is a beatmapset.
      actions
        ? `<button class="play-detail__menu" type="button" data-play-menu data-kind="incomplete"
             data-id="${play.id}" data-ids="${(play.ids ?? [play.id]).join(',')}"
             data-set="${play.beatmapsetId ?? ''}"
             aria-haspopup="true" aria-label="Options for this play" title="Options">&#8943;</button>`
        : ''
    }
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
    // An empty string asks for nothing at all, not an empty placeholder box.
    if (options.empty === '') return '';
    return `<div class="u-empty">${escapeHtml(options.empty ?? t('section.empty'))}</div>`;
  }
  return `<div class="play-detail-list">${plays
    .map((p) => (p.kind === 'incomplete' ? incompleteRow(p, options) : playRow(p, options)))
    .join('')}</div>`;
}

/**
 * A most-played row. The cover is the one place the page reaches for the network: it is
 * set as a background so a failed request simply leaves the placeholder colour behind.
 */
export function beatmapPlaycountRow(item) {
  const cover = coverUrl(item.beatmapsetId);
  const style = cover ? ` style="background-image: url('${cover}')"` : '';
  const artist = beatmapArtist(item);
  const by = artist ? ` <span class="beatmap-playcount__artist">by ${escapeHtml(artist)}</span>` : '';

  return `<div class="beatmap-playcount">
  <div class="beatmap-playcount__cover"${style}></div>
  <div class="beatmap-playcount__detail">
    ${maybeLink(
      beatmapHref(item),
      `${escapeHtml(beatmapTitle(item) ?? titleOf(item))}${by}`,
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
 * local profile has its own equivalents, derived in src/calc/history.ts.
 */
export function activityRow(event) {
  let text;
  // osu-web gives every entry a 28px icon column; only a medal has something to put in it,
  // but the column is kept on every row so the text lines up down the feed.
  let icon = '';
  switch (event.type) {
    case 'medal':
      // osu!'s own wording (`events.achievement`), with the profile standing in for the user.
      text = t('activity.medal', { name: escapeHtml(event.name) });
      icon = medalBadge({ ...event, achievedAt: event.at }, 'recent-activity');
      break;
    case 'best':
      text = t('activity.best', {
        pp: fmt(event.pp, 0),
        map:
          escapeHtml(original(event.title, event.titleOriginal)) +
          (event.version ? ` [${escapeHtml(event.version)}]` : ''),
      });
      break;
    case 'level':
      text = t('activity.level', { level: fmt(event.level) });
      break;
    case 'first':
      text = t('activity.first');
      break;
    default:
      return '';
  }

  return `<div class="activity">
  <div class="activity__icon">${icon}</div>
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

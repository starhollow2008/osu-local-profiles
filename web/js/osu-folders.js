/**
 * Options -> osu! folders: where the app looks for osu!, and how to correct it.
 *
 * This dialog exists because auto-detection missed. Somebody had osu!stable in
 * `D:\Games\osu!\osu!`, the app found their lazer install, decided it was done, and told
 * them osu!stable was not installed. Detection is much better now -- the registry, lazer's
 * `storage.ini`, the Start Menu, and a search of every drive -- and it will still miss
 * sometimes, because osu! goes wherever the player put it.
 *
 * So the page has to be able to say where. Everything here is written for the person that
 * already happened to: the folders it found are listed with the one in use marked, adding a
 * folder explains itself when it is refused, and the search can be run again on demand.
 */

import { escapeHtml } from './format.js';
import { hint, postJson, toast } from './ui.js';
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);

/** The last answer from `/api/installs`, so rendering never has to refetch. */
let folders = null;
/** True while the machine is being searched, which takes seconds rather than milliseconds. */
let searching = false;

const setHint = (message, isError = false) => hint('foldersHint', message, isError);

/** Each kind of folder, by the name its game goes by. */
const KIND_NAMES = { lazer: 'osu!lazer', stable: 'osu!stable', mcosu: 'McOsu' };

function render() {
  const list = $('folderList');
  if (!folders) {
    list.innerHTML = `<p class="setting__hint">${escapeHtml(t('folders.loading'))}</p>`;
    return;
  }

  if (folders.candidates.length === 0) {
    list.innerHTML = `<p class="setting__hint">${escapeHtml(
      folders.searched ? t('folders.noneAfterSearch') : t('folders.none'),
    )}</p>`;
  } else {
    list.innerHTML = folders.candidates
      .map((c) => {
        /*
         * Three states worth telling apart, and the difference matters: "in use" is what the
         * tracker has open right now, "will be used" is what a restart would pick, and the
         * rest are folders that exist and are not being tracked.
         */
        const badges = [];
        if (c.active) badges.push(`<span class="folder__badge folder__badge--active">${escapeHtml(t('folders.inUse'))}</span>`);
        if (c.configured) badges.push(`<span class="folder__badge">${escapeHtml(t('folders.yours'))}</span>`);
        return `
          <div class="folder${c.active ? ' folder--active' : ''}">
            <div class="folder__info">
              <div class="folder__kind">${KIND_NAMES[c.kind] ?? c.kind}${badges.join('')}</div>
              <div class="folder__path" title="${escapeHtml(c.root)}">${escapeHtml(c.root)}</div>
            </div>
            ${
              c.configured
                ? `<button type="button" class="folder__remove" data-remove="${escapeHtml(c.root)}"
                     title="${escapeHtml(t('folders.forget'))}">&times;</button>`
                : ''
            }
          </div>`;
      })
      .join('');
  }

  // A change here cannot take effect until the app restarts: the watchers and the beatmap
  // resolver are built from this list once, at startup. Saying so is the honest option --
  // the alternative is a page that looks like it worked and a tracker still watching the
  // old folder.
  $('folderRestart').hidden = !folders.needsRestart;
  $('folderSearchNote').hidden = folders.searched || searching;
  $('folderRescan').disabled = searching;
  $('folderRescan').textContent = searching ? t('folders.searching') : t('folders.rescan');
}

async function send(body, failure) {
  const result = await postJson('/api/installs', body, failure);
  folders = result;
  render();
  return result;
}

export async function openOsuFolders() {
  $('foldersModal').hidden = false;
  setHint(' ');
  render();
  try {
    folders = await (await fetch('/api/installs')).json();
    render();
  } catch {
    setHint(t('folders.loadFailed'), true);
  }
}

export function closeOsuFolders() {
  $('foldersModal').hidden = true;
}

export function osuFoldersOpen() {
  return !$('foldersModal').hidden;
}

/** Wire the dialog up. Called once, from the page controller. */
export function bindOsuFolders() {
  $('foldersModal').onclick = (e) => {
    if (e.target === $('foldersModal')) closeOsuFolders();
  };
  $('foldersClose').onclick = closeOsuFolders;

  $('folderList').onclick = async (e) => {
    const button = e.target.closest('[data-remove]');
    if (!button) return;
    button.disabled = true;
    try {
      await send({ remove: button.dataset.remove }, t('folders.removeFailed'));
      toast(t('folders.removed'));
    } catch (err) {
      setHint(err.message, true);
      button.disabled = false;
    }
  };

  $('folderAdd').onclick = async () => {
    const input = $('folderPath');
    const value = input.value.trim();
    if (!value) return setHint(t('folders.needPath'), true);

    $('folderAdd').disabled = true;
    setHint(t('folders.checking'));
    try {
      await send({ add: value }, t('folders.addFailed'));
      input.value = '';
      setHint(' ');
      toast(t('folders.added'));
    } catch (err) {
      // The server's own sentence, which names what was wrong with *this* folder -- most
      // often that the one above the install was picked, since that is the one called
      // "osu!" in Explorer.
      setHint(err.message, true);
    } finally {
      $('folderAdd').disabled = false;
    }
  };

  $('folderPath').onkeydown = (e) => {
    if (e.key === 'Enter') $('folderAdd').click();
  };

  $('folderRescan').onclick = async () => {
    searching = true;
    render();
    setHint(t('folders.searchingHint'));
    try {
      const result = await send({ rescan: true }, t('folders.searchFailed'));
      setHint(' ');
      toast(
        result.candidates.length === 0
          ? t('folders.searchFoundNothing')
          : t('folders.searchFound', { count: result.candidates.length }),
      );
    } catch (err) {
      setHint(err.message, true);
    } finally {
      searching = false;
      render();
    }
  };
}

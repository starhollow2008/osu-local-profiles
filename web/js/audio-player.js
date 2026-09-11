/**
 * The beatmap audio preview: the play button on a Favorite Beatmaps card and the bar in the corner.
 */
import { audioTime } from './format.js';
import { previewUrl } from './beatmapsets.js';
import { toast } from './ui.js';

const $ = (id) => document.getElementById(id);

/*
 * The audio preview: osu-web's `osu-audio` player, one clip at a time.
 *
 * Pressing a card's play loads its preview from the top and stops any other. Pressing the
 * playing card again *pauses* it, and pressing it once more carries on from where it was --
 * osu!'s `togglePlay`, not a restart. The floating bar in the corner (#audioPlayer) does the
 * same from its own button, and adds previous / next through the Favorite Beatmaps cards,
 * seeking, volume, mute and autoplay. It slides up while a clip loads or plays and away four
 * seconds after it pauses or ends, exactly as osu-web's `setState` times it.
 *
 * The card and the bar both carry `data-audio-state` and `--progress`, which is all the CSS
 * needs for the pause faces, the ring and the progress bar.
 *
 * The clip is osu!'s own short preview, streamed only when pressed and cached by the browser
 * -- nothing is stored by this app. The volume, mute and autoplay choices are kept in this
 * browser's localStorage, which is where osu-web keeps them for a visitor who is not signed in.
 */
const AUDIO_HIDE_MS = 4000;
const AUDIO_PREFS_KEY = 'osu-local-profiles:audio';
const preview = new Audio();
preview.preload = 'none';

/** osu!'s defaults: 45% volume, not muted, no autoplay. */
const audioPrefs = { volume: 0.45, muted: false, autoplay: false };
try {
  Object.assign(audioPrefs, JSON.parse(localStorage.getItem(AUDIO_PREFS_KEY) ?? '{}'));
} catch {
  /* private mode or a hand-edited value: the defaults stand */
}
preview.volume = Math.min(1, Math.max(0, Number(audioPrefs.volume) || 0));
preview.muted = audioPrefs.muted === true;

function saveAudioPrefs() {
  audioPrefs.volume = preview.volume;
  audioPrefs.muted = preview.muted;
  try {
    localStorage.setItem(AUDIO_PREFS_KEY, JSON.stringify(audioPrefs));
  } catch {
    /* not persisted, but the choice still holds for this visit */
  }
}

let previewSet = null;
let audioState = 'paused';
let audioFrame = null;
let hideAudioTimer = null;
/** Which bar is being dragged, so playback does not fight the pointer for the position. */
let draggingBar = null;

const audioPlayer = $('audioPlayer');

/** The card for the playing set, found fresh each time: a re-render replaces the element. */
const previewPanel = () =>
  previewSet === null ? null : document.querySelector(`#favoriteBeatmaps [data-set-id="${previewSet}"]`);

/** The sets that can be played, in page order: what previous and next walk through. */
const playableSets = () =>
  [...document.querySelectorAll('#favoriteBeatmaps [data-audio-play]')].map((b) => Number(b.dataset.audioPlay));

function neighbours() {
  const sets = playableSets();
  const i = previewSet === null ? -1 : sets.indexOf(previewSet);
  return { prev: i > 0 ? sets[i - 1] : null, next: i >= 0 && i < sets.length - 1 ? sets[i + 1] : null };
}

/** Position, time and duration onto the bar and the playing card. */
function syncProgress() {
  const duration = preview.duration;
  const known = Number.isFinite(duration) && duration > 0;
  audioPlayer.dataset.audioHasDuration = known ? '1' : '0';
  if (!known) return;
  const progress = String(preview.currentTime / duration);
  if (draggingBar !== 'progress') audioPlayer.style.setProperty('--progress', progress);
  $('audioSeek').setAttribute('aria-valuenow', String(Math.round(Number(progress) * 100)));
  previewPanel()?.style.setProperty('--progress', progress);
  $('audioCurrent').textContent = audioTime(preview.currentTime, duration);
  $('audioTotal').textContent = audioTime(duration, duration);
}

/** The volume bar and the speaker icon, from the audio element itself. */
function syncVolume() {
  audioPlayer.style.setProperty('--volume', String(preview.volume));
  $('audioVolume').setAttribute('aria-valuenow', String(Math.round(preview.volume * 100)));
  // osu-web's `volumeIcon`.
  audioPlayer.dataset.audioVolume = preview.muted
    ? 'muted'
    : preview.volume === 0 ? 'silent' : preview.volume < 0.4 ? 'quiet' : 'normal';
  $('audioMute').title = preview.muted ? 'Unmute' : 'Mute';
  audioPlayer.dataset.audioAutoplay = audioPrefs.autoplay ? '1' : '0';
  $('audioAutoplay').setAttribute('aria-pressed', String(audioPrefs.autoplay));
}

/** Everything that shows the player's state: the bar, the card, and where prev/next lead. */
export function syncPlayers() {
  audioPlayer.dataset.audioState = audioState;
  const panel = previewPanel();
  if (panel) panel.dataset.audioState = audioState;
  const { prev, next } = neighbours();
  audioPlayer.dataset.audioHasPrev = prev === null ? '0' : '1';
  audioPlayer.dataset.audioHasNext = next === null ? '0' : '1';
  syncProgress();
  syncVolume();
}

function setAudioState(state) {
  audioState = state;
  syncPlayers();
  clearTimeout(hideAudioTimer);
  if (state === 'playing' || state === 'loading') {
    audioPlayer.dataset.audioVisible = '1';
  } else {
    hideAudioTimer = setTimeout(() => (audioPlayer.dataset.audioVisible = '0'), AUDIO_HIDE_MS);
  }
}

/** Keeps the ring and the bar moving smoothly; `timeupdate` fires only a few times a second. */
function tickAudio() {
  syncProgress();
  if (!preview.paused) audioFrame = requestAnimationFrame(tickAudio);
}

/** Stop and rewind, leaving the card that was playing as a plain card again. */
function stopPreview() {
  cancelAnimationFrame(audioFrame);
  preview.pause();
  if (Number.isFinite(preview.duration)) preview.currentTime = 0;
  // State first: it paints the card, which is then cleared rather than left saying "paused".
  setAudioState('paused');
  const panel = previewPanel();
  if (panel) {
    panel.removeAttribute('data-audio-state');
    panel.style.removeProperty('--progress');
  }
}

async function loadPreview(setId) {
  stopPreview();
  previewSet = setId;
  preview.src = previewUrl(setId);
  preview.currentTime = 0;
  audioPlayer.style.setProperty('--progress', '0');
  setAudioState('loading');
  try {
    await preview.play();
  } catch (err) {
    // Replaced by another press before it started: nothing went wrong.
    if (previewSet !== setId || err?.name === 'AbortError') return;
    stopPreview();
    previewSet = null;
    toast("The preview could not be played - it comes from osu.ppy.sh, which may be unreachable");
  }
}

/** osu-web's `togglePlay`: pause where it is, or carry on from there. */
function togglePreview() {
  if (previewSet === null) return;
  if (preview.paused) {
    void preview.play().catch(() => setAudioState('paused'));
  } else {
    preview.pause();
  }
}

preview.addEventListener('playing', () => {
  setAudioState('playing');
  tickAudio();
});
preview.addEventListener('pause', () => {
  // A pause on the way to the end is reported by `ended`, which rewinds as well.
  if (!preview.ended) setAudioState('paused');
});
preview.addEventListener('timeupdate', () => {
  if (preview.paused) syncProgress();
});
preview.addEventListener('ended', () => {
  const { next } = neighbours();
  stopPreview();
  if (next !== null && audioPrefs.autoplay) void loadPreview(next);
});

document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-audio-play]');
  if (!button) return;
  e.preventDefault();
  const setId = Number(button.dataset.audioPlay);
  if (setId === previewSet) togglePreview();
  else void loadPreview(setId);
});

$('audioToggle').onclick = togglePreview;

audioPlayer.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-audio-nav]');
  if (!nav) return;
  const { prev, next } = neighbours();
  const target = nav.dataset.audioNav === 'prev' ? prev : next;
  if (target !== null) void loadPreview(target);
});

$('audioMute').onclick = () => {
  preview.muted = !preview.muted;
  saveAudioPrefs();
  syncVolume();
};

$('audioAutoplay').onclick = () => {
  audioPrefs.autoplay = !audioPrefs.autoplay;
  saveAudioPrefs();
  syncVolume();
};

/*
 * osu-web's `Slider`: press anywhere on a bar and drag, with the position following the
 * pointer until it is released. Pointer capture covers the mouse and touch in one path.
 * Seeking lands on release, as osu!'s does; the volume follows the pointer as it moves.
 */
function bindBar(bar, name, onMove, onEnd) {
  const fraction = (e) => {
    const r = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (name === 'progress' && !(preview.duration > 0)) return;
    e.preventDefault();
    try {
      bar.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer the browser no longer tracks: the press still counts, only the drag is lost */
    }
    draggingBar = name;
    bar.dataset.audioDragging = '1';
    onMove(fraction(e));
  });
  bar.addEventListener('pointermove', (e) => {
    if (draggingBar === name) onMove(fraction(e));
  });
  const end = (e) => {
    if (draggingBar !== name) return;
    draggingBar = null;
    bar.dataset.audioDragging = '0';
    onEnd(fraction(e));
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
}

bindBar(
  $('audioSeek'),
  'progress',
  (f) => audioPlayer.style.setProperty('--progress', String(f)),
  (f) => {
    // osu! stops just short of the end, so a seek to 100% does not count as finishing.
    preview.currentTime = f === 1 ? preview.duration - 0.01 : preview.duration * f;
    syncProgress();
  },
);

bindBar(
  $('audioVolume'),
  'volume',
  (f) => {
    preview.volume = f;
    syncVolume();
  },
  () => saveAudioPrefs(),
);

syncVolume();

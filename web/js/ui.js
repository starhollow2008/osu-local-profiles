/**
 * The few things every page of this app does the same way: send a change to the server, hand
 * the browser a file, and say what happened.
 */

/**
 * POST a JSON body and return the JSON answer. A refusal throws the server's own reason --
 * every endpoint answers `{ error }` -- or `failure` when it gave none.
 */
export async function postJson(url, body, failure = 'that did not work') {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? failure);
  return d;
}

/** Save a blob the page already holds, under `filename`, as a normal download. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked later: revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

let toastTimer = null;

/** A line in the page's `#toast`, gone after four seconds. */
export function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

/** A dialog's status line: the message, in the error colour when it is one. */
export function hint(id, message, isError = false) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.classList.toggle('profile-hint--error', isError);
}

/**
 * Close a dialog when its backdrop is clicked, and only then: the press and the release both on
 * the backdrop. A browser calls it a click on the backdrop too when the press was in the dialog,
 * selecting text in a box or dragging a slider, and the release outside it, or when what was
 * pressed went from under the pointer as the dialog changed. Neither should close it.
 */
export function closeOnBackdrop(backdrop, close) {
  let pressed = false;
  backdrop.addEventListener('pointerdown', (e) => {
    pressed = e.target === backdrop;
  });
  backdrop.addEventListener('click', (e) => {
    const outside = pressed && e.target === backdrop;
    pressed = false;
    if (outside) close();
  });
}

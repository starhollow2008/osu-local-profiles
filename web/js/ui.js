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

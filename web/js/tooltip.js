/**
 * osu-web's default tooltip (`core-legacy/tooltip-default.coffee`, `tooltip-default.less`): a
 * small dark label above whatever the pointer is over, centred on it, with a 10x8 tip pointing
 * down at it. osu-web turns every `title` into one; here an element asks for one with
 * `data-tooltip`, which keeps the browser's own tooltip from appearing beside it.
 *
 * Shown at once on hover or keyboard focus, as osu-web's is (`show: { event, ready: true }`), and
 * gone on leaving or clicking (`hide: { event: 'click mouseleave' }`). One label for the page.
 */

const TIP = 8;
const EDGE = 8;

let label = null;
let anchor = null;

function element() {
  if (label === null) {
    label = document.createElement('div');
    label.className = 'tooltip-default';
    label.setAttribute('role', 'tooltip');
    label.hidden = true;
    document.body.append(label);
  }
  return label;
}

/** Above the anchor and centred on it, kept inside the window; below when there is no room above. */
function position(target) {
  const el = element();
  const box = target.getBoundingClientRect();
  const centre = box.left + box.width / 2;
  const left = Math.max(EDGE, Math.min(centre - el.offsetWidth / 2, window.innerWidth - el.offsetWidth - EDGE));
  const below = box.top - el.offsetHeight - TIP < EDGE;
  el.style.left = `${left}px`;
  el.style.top = `${below ? box.bottom + TIP : box.top - el.offsetHeight - TIP}px`;
  el.style.setProperty('--tip-x', `${centre - left}px`);
  el.classList.toggle('tooltip-default--below', below);
}

export function showTooltip(target) {
  const text = target.dataset.tooltip;
  if (!text) return;
  const el = element();
  anchor = target;
  el.textContent = text;
  el.hidden = false;
  position(target);
}

export function hideTooltip() {
  anchor = null;
  if (label) label.hidden = true;
}

document.addEventListener('mouseover', (e) => {
  const target = e.target.closest?.('[data-tooltip]');
  if (target === anchor) return;
  if (target) showTooltip(target);
  else if (anchor) hideTooltip();
});
document.addEventListener('focusin', (e) => {
  const target = e.target.closest?.('[data-tooltip]');
  if (target) showTooltip(target);
});
document.addEventListener('focusout', hideTooltip);
document.addEventListener('click', hideTooltip, true);
window.addEventListener('scroll', hideTooltip, { passive: true });

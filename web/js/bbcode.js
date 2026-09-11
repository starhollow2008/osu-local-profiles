/**
 * osu!'s BBCode, rendered for the me! section.
 *
 * The tags and what they mean are osu!'s -- which tags exist, sizes clamped to 30..200%,
 * lists opened by [*], boxes titled by their argument, a line break for every newline --
 * taken as facts from osu-web. The code is this project's own: nothing is copied from
 * osu-web's (AGPL) BBCode library.
 *
 * **Why this is safe to show text from anywhere.** me! can be imported from someone else's
 * osu! profile, so it is treated as hostile. The input is never parsed as HTML: every piece
 * of text is escaped, and the only markup that comes out is the fixed set of tags below,
 * each written here. Every argument that reaches an attribute is checked first -- colours
 * against a pattern, sizes as numbers, links and images by scheme -- and a tag whose
 * argument fails, or which is never closed, stays on the page as the characters it is.
 */

/** Every tag understood. Anything else in square brackets is just text. */
const TAGS = new Set([
  'b', 'i', 'u', 's', 'strike', 'color', 'size', 'centre', 'left', 'right', 'heading',
  'url', 'email', 'profile', 'img', 'quote', 'code', 'c', 'spoiler', 'box', 'spoilerbox',
  'list', '*', 'notice', 'youtube', 'audio', 'imagemap',
]);

/** Tags whose content is taken as written, not parsed for more tags. */
const RAW = new Set(['code', 'c', 'img', 'imagemap', 'youtube', 'audio', 'profile']);

/** Block tags swallow the newline that follows them, as osu! does, so they do not add a gap. */
const BLOCK = new Set([
  'centre', 'left', 'right', 'heading', 'quote', 'box', 'spoilerbox', 'list', 'notice',
  'code', 'imagemap', 'youtube',
]);

const TAG = /\[(\/?)(\*|[a-z]+)(?:=([^\]\n]*))?\]/gi;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'[\]]+/gi;
/** Punctuation that ends a sentence, not a URL: "see https://osu.ppy.sh, then stop." */
const TRAILING = /[.,;:!?'")\]}]+$/;

const LINK_REL = 'rel="nofollow noopener noreferrer" target="_blank"';

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** A link target that cannot run anything: http(s), mailto, osu://, or a bare domain. */
function safeHref(raw) {
  const url = String(raw ?? '').trim();
  if (/^(?:https?:\/\/|mailto:|osu:\/\/)[^\s<>"']+$/i.test(url)) return url;
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:[/?#][^\s<>"']*)?$/i.test(url)) return `https://${url}`;
  return null;
}

/** An image: from the web, one pasted into this editor, or inlined by an export. */
function safeImage(raw) {
  const src = String(raw ?? '').trim();
  if (/^https?:\/\/[^\s<>"']+$/i.test(src)) return src;
  if (/^\/api\/about-image\/\d+\/[0-9a-f]{16}\.(?:png|jpg|webp|gif)$/.test(src)) return src;
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(src)) return src;
  return null;
}

const COLOUR = /^(?:#[0-9a-f]{3}|#[0-9a-f]{6}|[a-z]{3,20})$/i;
const EMAIL = /^[^\s@<>"'[\]]+@[^\s@<>"'[\]]+\.[^\s@<>"'[\]]+$/;

/** Whether an opening tag's argument is one this tag can use. */
function validArg(name, arg) {
  switch (name) {
    case 'color':
      return arg !== undefined && COLOUR.test(arg.trim());
    case 'size':
      return arg !== undefined && /^\d{1,3}$/.test(arg.trim());
    case 'url':
      return arg !== undefined && safeHref(arg) !== null;
    case 'email':
      return arg !== undefined && EMAIL.test(arg.trim());
    case 'box':
    case 'list':
    case 'quote':
      return true;
    default:
      return arg === undefined;
  }
}

/** A tag whose content is taken as written. Null when the content is not usable. */
function rawTag(name, arg, content) {
  switch (name) {
    case 'code':
      return arg === undefined ? `<pre>${esc(content.replace(/^\n+|\n+$/g, ''))}</pre>` : null;
    case 'c':
      return arg === undefined ? `<code>${esc(content)}</code>` : null;
    case 'img': {
      const src = arg === undefined ? safeImage(content) : null;
      return src === null ? null : `<img src="${esc(src)}" alt="" loading="lazy">`;
    }
    case 'youtube': {
      const id = content.trim();
      return arg === undefined && /^[\w-]{6,20}$/.test(id)
        ? `<iframe class="bbcode__youtube" src="https://www.youtube.com/embed/${id}?rel=0" allowfullscreen loading="lazy" title="YouTube video"></iframe>`
        : null;
    }
    case 'audio': {
      const src = arg === undefined && /^https?:\/\//i.test(content.trim()) ? safeHref(content) : null;
      return src === null ? null : `<audio controls preload="none" src="${esc(src)}"></audio>`;
    }
    case 'profile': {
      const username = content.trim();
      if (!username || (arg !== undefined && !/^\d+$/.test(arg.trim()))) return null;
      const href =
        arg !== undefined
          ? `https://osu.ppy.sh/users/${arg.trim()}`
          : `https://osu.ppy.sh/users/@${encodeURIComponent(username)}`;
      return `<a href="${esc(href)}" ${LINK_REL}>${esc(username)}</a>`;
    }
    case 'url': {
      const href = safeHref(content);
      return href === null ? null : `<a href="${esc(href)}" ${LINK_REL}>${esc(content.trim())}</a>`;
    }
    case 'email':
      return EMAIL.test(content.trim())
        ? `<a href="mailto:${esc(content.trim())}" ${LINK_REL}>${esc(content.trim())}</a>`
        : null;
    case 'imagemap':
      return arg === undefined ? imagemap(content) : null;
    default:
      return null;
  }
}

/**
 * osu!'s image map: an image, then one line per area -- left, top, width and height in
 * percent, a link (or # for none) and an optional title. Anything malformed and the whole
 * map stays as text, as on osu!.
 */
function imagemap(content) {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  const src = lines.length > 0 ? safeImage(lines[0]) : null;
  if (src === null) return null;

  const areas = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);
    if (parts.length < 5) return null;
    const box = parts.slice(0, 4).map(Number);
    if (box.some((n) => !Number.isFinite(n) || n < 0 || n > 100)) return null;
    const style = `left:${box[0]}%;top:${box[1]}%;width:${box[2]}%;height:${box[3]}%`;
    const title = esc(parts.slice(5).join(' '));
    if (parts[4] === '#') {
      areas.push(`<span class="imagemap__link" style="${style}" title="${title}"></span>`);
    } else {
      const href = safeHref(parts[4]);
      if (href === null) return null;
      areas.push(`<a class="imagemap__link" href="${esc(href)}" ${LINK_REL} style="${style}" title="${title}"></a>`);
    }
  }
  return `<div class="imagemap"><img class="imagemap__image" src="${esc(src)}" alt="" loading="lazy">${areas.join('')}</div>`;
}

/* ---------------------------------------------------------------- parsing */

/**
 * Text into a tree: a node per tag that was both opened and closed, strings for the text.
 * A tag left open, or closed out of order, is put back as the characters it was.
 */
function parse(text) {
  const root = { name: null, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let cursor = 0;
  let swallowNewline = false;

  const pushText = (s) => {
    let t = s;
    if (swallowNewline && t.startsWith('\n')) t = t.slice(1);
    swallowNewline = false;
    if (t) top().children.push(t);
  };
  /** Close everything above `index`: list items properly, anything else as literal text. */
  const closeAbove = (index) => {
    while (stack.length - 1 > index) {
      const node = stack.pop();
      if (node.name === '*') top().children.push(node);
      else top().children.push(node.open, ...node.children);
    }
  };
  const indexOf = (name) => {
    for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === name) return i;
    return -1;
  };

  TAG.lastIndex = 0;
  let m;
  while ((m = TAG.exec(text)) !== null) {
    const [whole, slash, rawName, arg] = m;
    let name = rawName.toLowerCase();
    if (!TAGS.has(name)) continue;
    if (name === 'strike') name = 's';

    pushText(text.slice(cursor, m.index));
    cursor = m.index + whole.length;

    if (slash) {
      const index = name === '*' ? -1 : indexOf(name);
      if (index < 0) {
        top().children.push(whole);
        continue;
      }
      closeAbove(index);
      const node = stack.pop();
      top().children.push(node);
      swallowNewline = BLOCK.has(name);
      continue;
    }

    const raw = RAW.has(name) || ((name === 'url' || name === 'email') && arg === undefined);
    if (raw) {
      const rest = text.slice(cursor);
      const end = rest.search(new RegExp(`\\[/${rawName === 'strike' ? 's' : name}\\]`, 'i'));
      const html = end >= 0 ? rawTag(name, arg, rest.slice(0, end)) : null;
      if (html === null) {
        top().children.push(whole);
        continue;
      }
      top().children.push({ html });
      cursor += end + name.length + 3;
      TAG.lastIndex = cursor;
      swallowNewline = BLOCK.has(name);
      continue;
    }

    if (name === '*') {
      const list = indexOf('list');
      if (list < 0) {
        top().children.push(whole);
        continue;
      }
      closeAbove(list);
      stack.push({ name: '*', open: whole, children: [] });
      continue;
    }

    if (!validArg(name, arg)) {
      top().children.push(whole);
      continue;
    }
    stack.push({ name, arg: arg?.trim(), open: whole, children: [] });
    swallowNewline = BLOCK.has(name);
  }
  pushText(text.slice(cursor));
  closeAbove(0);
  return root.children;
}

/* -------------------------------------------------------------- rendering */

/** Plain text: escaped, bare URLs linked (unless already inside a link), newlines kept. */
function textHtml(s, inLink) {
  let out = '';
  let cursor = 0;
  if (!inLink) {
    for (const m of s.matchAll(URL_IN_TEXT)) {
      if (m.index < cursor) continue;
      const url = m[0].replace(TRAILING, '');
      if (!url) continue;
      out += esc(s.slice(cursor, m.index));
      out += `<a href="${esc(url)}" ${LINK_REL}>${esc(url)}</a>`;
      cursor = m.index + url.length;
    }
  }
  out += esc(s.slice(cursor));
  return out.replace(/\n/g, '<br>');
}

/** A list item's text, without the whitespace that only separated it from the next [*]. */
function trimmed(children) {
  const out = [...children];
  if (typeof out[0] === 'string') out[0] = out[0].replace(/^\s+/, '');
  const last = out.length - 1;
  if (typeof out[last] === 'string') out[last] = out[last].replace(/\s+$/, '');
  return out;
}

function renderAll(children, inLink) {
  return children.map((c) => render(c, inLink)).join('');
}

function render(node, inLink) {
  if (typeof node === 'string') return textHtml(node, inLink);
  if (node.html !== undefined) return node.html;

  const inner = () => renderAll(node.children, inLink);
  switch (node.name) {
    case 'b':
      return `<strong>${inner()}</strong>`;
    case 'i':
      return `<em>${inner()}</em>`;
    case 'u':
      return `<u>${inner()}</u>`;
    case 's':
      return `<del>${inner()}</del>`;
    case 'color':
      return `<span style="color:${esc(node.arg)}">${inner()}</span>`;
    case 'size':
      return `<span style="font-size:${Math.min(200, Math.max(30, Number(node.arg)))}%">${inner()}</span>`;
    case 'centre':
    case 'left':
    case 'right':
      return `<div class="bbcode__align-${node.name}">${inner()}</div>`;
    case 'heading':
      return `<h2>${inner()}</h2>`;
    case 'spoiler':
      return `<span class="spoiler">${inner()}</span>`;
    case 'notice':
      return `<div class="bbcode__notice">${inner()}</div>`;
    case 'quote': {
      const who = (node.arg ?? '').replace(/^"(.*)"$/, '$1').trim();
      return `<blockquote>${who ? `<h4>${esc(who)} wrote:</h4>` : ''}${inner()}</blockquote>`;
    }
    case 'box':
    case 'spoilerbox':
      // A <details> opens and closes with no script, so it works in an exported file too.
      return `<details class="bbcode-spoilerbox"><summary class="bbcode-spoilerbox__link">${esc(
        node.arg || 'SPOILER',
      )}</summary><div class="bbcode-spoilerbox__body">${inner()}</div></details>`;
    case 'url':
      // A link inside a link is not HTML; the outer one wins.
      return inLink
        ? inner()
        : `<a href="${esc(safeHref(node.arg))}" ${LINK_REL}>${renderAll(node.children, true)}</a>`;
    case 'email':
      return inLink
        ? inner()
        : `<a href="mailto:${esc(node.arg)}" ${LINK_REL}>${renderAll(node.children, true)}</a>`;
    case 'list': {
      const items = node.children.filter((c) => typeof c === 'object' && c.name === '*');
      const title = renderAll(node.children.filter((c) => !items.includes(c)), inLink).replace(/^(?:\s|<br>)+|(?:\s|<br>)+$/g, '');
      const tag = node.arg !== undefined ? 'ol' : 'ul';
      return `${title ? `<div class="bbcode__list-title">${title}</div>` : ''}<${tag}>${items
        .map((item) => `<li>${renderAll(trimmed(item.children), inLink)}</li>`)
        .join('')}</${tag}>`;
    }
    case '*':
      return `<li>${renderAll(trimmed(node.children), inLink)}</li>`;
    default:
      return inner();
  }
}

/** A me! page as HTML, or '' when there is nothing in it. */
export function bbcodeHtml(input) {
  const text = String(input ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return '';
  return renderAll(parse(text), false);
}

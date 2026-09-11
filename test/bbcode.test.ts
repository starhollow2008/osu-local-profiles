import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bbcodeHtml } from '../web/js/bbcode.js';

/*
 * me! can be imported from anyone's osu! profile, so the renderer is tested as the one thing
 * standing between that text and the page: whatever is not one of its tags must come out as
 * the characters it is.
 */

/* ---------------------------------------------------------------- safety */

test('HTML never becomes HTML, and an ampersand is escaped once', () => {
  const out = bbcodeHtml('<script>alert(1)</script> & <b>bold</b>');
  assert.equal(out.includes('<script>'), false);
  assert.equal(out.includes('<b>'), false);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &lt;b&gt;bold&lt;\/b&gt;/);
});

test('a link that could run something stays text', () => {
  assert.equal(bbcodeHtml('[url=javascript:alert(1)]x[/url]'), '[url=javascript:alert(1)]x[/url]');
  assert.equal(bbcodeHtml('[url]javascript:alert(1)[/url]'), '[url]javascript:alert(1)[/url]');
  assert.equal(bbcodeHtml('[img]javascript:alert(1)[/img]'), '[img]javascript:alert(1)[/img]');
  assert.equal(bbcodeHtml('[img]data:text/html;base64,PHNjcmlwdD4=[/img]').includes('<img'), false);
});

test('a colour or size that is not one stays text rather than reaching a style', () => {
  assert.equal(bbcodeHtml('[color=red;background:url(x)]a[/color]').includes('<span'), false);
  assert.equal(bbcodeHtml('[size=big]a[/size]').includes('<span'), false);
  assert.equal(bbcodeHtml('[color=#ff66aa]a[/color]'), '<span style="color:#ff66aa">a</span>');
});

test('an argument with a quote in it cannot leave its attribute', () => {
  const out = bbcodeHtml('[box=a" onmouseover="x]b[/box]');
  assert.equal(out.includes('onmouseover="x"'), false);
  assert.match(out, /a&quot; onmouseover=&quot;x/);
});

/* ------------------------------------------------------------ the basics */

test('every newline is a line break, as on osu!', () => {
  assert.equal(bbcodeHtml('one\ntwo'), 'one<br>two');
  assert.equal(bbcodeHtml('one\n\ntwo'), 'one<br><br>two');
  assert.equal(bbcodeHtml('one\r\ntwo'), 'one<br>two');
});

test('nothing at all renders as nothing', () => {
  assert.equal(bbcodeHtml(''), '');
  assert.equal(bbcodeHtml('  \n '), '');
  assert.equal(bbcodeHtml(null), '');
});

test('a bare URL becomes a link, without the punctuation after it', () => {
  const out = bbcodeHtml('see https://osu.ppy.sh/users/2, then stop.');
  assert.match(out, /<a href="https:\/\/osu\.ppy\.sh\/users\/2" rel="nofollow noopener noreferrer" target="_blank">/);
  assert.match(out, /<\/a>, then stop\.$/);
});

test('typed anchor markup stays text, and its URL stops at the quote', () => {
  const out = bbcodeHtml('<a href="https://evil.example">click</a>');
  assert.match(out, /&lt;a href=&quot;<a href="https:\/\/evil\.example"/);
  assert.equal(/<a [^>]*>click/.test(out), false);
});

test('inline tags nest, and strike is s', () => {
  assert.equal(
    bbcodeHtml('[b]bold [i]both[/i][/b] [u]u[/u] [s]s[/s] [strike]t[/strike]'),
    '<strong>bold <em>both</em></strong> <u>u</u> <del>s</del> <del>t</del>',
  );
});

test('a tag never closed, or closed out of order, is put back as text', () => {
  assert.equal(bbcodeHtml('[b]open'), '[b]open');
  assert.equal(bbcodeHtml('stray[/b]'), 'stray[/b]');
  assert.equal(bbcodeHtml('[b][i]x[/b][/i]'), '<strong>[i]x</strong>[/i]');
  assert.equal(bbcodeHtml('[notatag]x[/notatag]'), '[notatag]x[/notatag]');
});

test('sizes are clamped to 30..200%, as on osu!', () => {
  assert.equal(bbcodeHtml('[size=500]a[/size]'), '<span style="font-size:200%">a</span>');
  assert.equal(bbcodeHtml('[size=5]a[/size]'), '<span style="font-size:30%">a</span>');
});

/* ------------------------------------------------------------- the blocks */

test('a block tag swallows the newline after it', () => {
  assert.equal(
    bbcodeHtml('[centre]\nhi\n[/centre]\nafter'),
    '<div class="bbcode__align-centre">hi<br></div>after',
  );
  assert.equal(bbcodeHtml('[heading]Title[/heading]\nbody'), '<h2>Title</h2>body');
});

test('lists: [list] is bulleted, [list=1] numbered, and [*] starts each item', () => {
  assert.equal(bbcodeHtml('[list]\n[*]one\n[*]two\n[/list]'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(bbcodeHtml('[list=1]\n[*]a\n[*][b]b[/b]\n[/list]'), '<ol><li>a</li><li><strong>b</strong></li></ol>');
  assert.equal(bbcodeHtml('[*] not in a list'), '[*] not in a list');
});

test('a spoiler box is a <details>, titled by its argument or SPOILER', () => {
  assert.equal(
    bbcodeHtml('[box=Secrets]\ninside\n[/box]'),
    '<details class="bbcode-spoilerbox"><summary class="bbcode-spoilerbox__link">Secrets</summary>' +
      '<div class="bbcode-spoilerbox__body">inside<br></div></details>',
  );
  assert.match(bbcodeHtml('[spoilerbox]x[/spoilerbox]'), /<summary[^>]*>SPOILER<\/summary>/);
});

test('code is shown as written, tags and all', () => {
  assert.equal(bbcodeHtml('[code]\n[b]x[/b] <i>\n[/code]'), '<pre>[b]x[/b] &lt;i&gt;</pre>');
  assert.equal(bbcodeHtml('[c][u]y[/u][/c]'), '<code>[u]y[/u]</code>');
});

test('quotes name who wrote them', () => {
  assert.equal(bbcodeHtml('[quote="peppy"]hi[/quote]'), '<blockquote><h4>peppy wrote:</h4>hi</blockquote>');
});

/* ------------------------------------------------------- links and images */

test('a link keeps its label, and a URL in the label is not linked twice', () => {
  assert.equal(
    bbcodeHtml('[url=https://osu.ppy.sh]https://osu.ppy.sh[/url]'),
    '<a href="https://osu.ppy.sh" rel="nofollow noopener noreferrer" target="_blank">https://osu.ppy.sh</a>',
  );
  assert.match(bbcodeHtml('[url]osu.ppy.sh/wiki[/url]'), /href="https:\/\/osu\.ppy\.sh\/wiki"/);
});

test('profiles link to osu!, by id or by name', () => {
  assert.match(bbcodeHtml('[profile=2]peppy[/profile]'), /href="https:\/\/osu\.ppy\.sh\/users\/2"/);
  assert.match(bbcodeHtml('[profile]peppy[/profile]'), /href="https:\/\/osu\.ppy\.sh\/users\/@peppy"/);
});

test('images: from the web, pasted into this editor, or inlined by an export', () => {
  assert.equal(bbcodeHtml('[img]https://i.ppy.sh/x.png[/img]'), '<img src="https://i.ppy.sh/x.png" alt="" loading="lazy">');
  assert.match(bbcodeHtml('[img]/api/about-image/1/0123456789abcdef.png[/img]'), /<img src="\/api\/about-image/);
  assert.match(bbcodeHtml('[img]data:image/png;base64,iVBORw0KGgo=[/img]'), /<img src="data:image\/png/);
  assert.equal(bbcodeHtml('[img]/api/about-image/1/../../x.png[/img]').includes('<img'), false);
});

test('an image map places its areas in percent; a malformed one stays text', () => {
  const out = bbcodeHtml('[imagemap]\nhttps://i.ppy.sh/m.png\n0 10 10 50 https://osu.ppy.sh home\n5 5 5 5 # nothing\n[/imagemap]');
  assert.match(out, /^<div class="imagemap"><img class="imagemap__image" src="https:\/\/i\.ppy\.sh\/m\.png"/);
  assert.match(out, /<a class="imagemap__link" href="https:\/\/osu\.ppy\.sh"[^>]*style="left:0%;top:10%;width:10%;height:50%" title="home">/);
  assert.match(out, /<span class="imagemap__link" style="left:5%;top:5%;width:5%;height:5%" title="nothing">/);
  assert.equal(bbcodeHtml('[imagemap]\nhttps://i.ppy.sh/m.png\n0 0 999 1 # x\n[/imagemap]').includes('<div'), false);
});

test("peppy's real me! page renders with no tag left over", () => {
  const raw =
    '[centre]\n[size=85]([color=#f462a3]๑[/color]・ω・[color=#f462a3]๑[/color])[/size]\n\n[/centre]\n\n' +
    '[centre][size=85][url=http://blog.ppy.sh/]dev blog[/url] | [url=http://osu.ppy.sh/p/changelog]changelog[/url][/size][/centre]';
  const out = bbcodeHtml(raw);
  assert.equal(/\[\/?(?:centre|size|color|url)/.test(out), false);
  assert.match(out, /<span style="color:#f462a3">๑<\/span>/);
  assert.match(out, /<a href="http:\/\/blog\.ppy\.sh\/"[^>]*>dev blog<\/a>/);
});

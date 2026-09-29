import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const web = path.join(import.meta.dirname, '..', 'web');
const css = fs.readFileSync(path.join(web, 'css', 'fonts.css'), 'utf8');

interface Face {
  url: string;
  lo: number;
  hi: number;
  /** The weight it is drawn at, or null for the weight as asked. */
  drawn: number | null;
}

const faces: Face[] = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
  const body = m[1] ?? '';
  const url = /url\("([^"]+)"\)/.exec(body)?.[1];
  const weights = /font-weight:\s*(\d+)\s+(\d+)/.exec(body);
  const drawn = /"wght"\s+(\d+)/.exec(body)?.[1];
  assert.ok(url && weights, `a face with a url and a weight range: ${body}`);
  return { url, lo: Number(weights[1]), hi: Number(weights[2]), drawn: drawn === undefined ? null : Number(drawn) };
});

test('every font the stylesheet names ships with the app, with its licence', () => {
  assert.ok(faces.length > 0);
  for (const { url } of faces) {
    // A relative url(), so a saved copy inlines it (inlineCssUrls) and the app serves it.
    assert.ok(!/^[a-z]+:/i.test(url), `${url} is not relative`);
    assert.ok(fs.existsSync(path.join(web, 'css', url)), `${url} exists`);
  }
  assert.match(fs.readFileSync(path.join(web, 'fonts', 'nunito', 'OFL.txt'), 'utf8'), /SIL Open Font License/);
});

test('Nunito covers every weight, drawing all but the light ones heavier', () => {
  for (const url of new Set(faces.map((f) => f.url))) {
    const bands = faces.filter((f) => f.url === url).sort((a, b) => a.lo - b.lo);
    const at = (weight: number) => bands.find((b) => b.lo <= weight && weight <= b.hi);
    // No gap and no overlap from 100 to 1000, or a weight would fall to another face.
    assert.equal(bands[0]?.lo, 100, url);
    assert.equal(bands.at(-1)?.hi, 1000, url);
    for (let i = 1; i < bands.length; i++) assert.equal(bands[i]?.lo, (bands[i - 1]?.hi ?? 0) + 1, url);
    // 300 is drawn as asked; osu-web's 400 and 600/700 are drawn heavier than asked.
    assert.equal(at(300)?.drawn, null, url);
    for (const asked of [400, 600, 700]) assert.ok((at(asked)?.drawn ?? 0) > asked, `${url} at ${asked}`);
  }
});

test('the profile page and the score page both load the fonts', () => {
  for (const page of ['index.html', 'score.html']) {
    const html = fs.readFileSync(path.join(web, page), 'utf8');
    assert.ok(html.includes('<link rel="stylesheet" href="/css/fonts.css">'), page);
  }
});

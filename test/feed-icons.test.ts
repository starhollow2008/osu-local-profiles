import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/*
 * The Recent feed's icons, as scripts/build-feed-icons.mjs vendors them from the media repo. A
 * missing or wrong-size file is a broken image in the feed, so the set is checked against the
 * page code that names it.
 */

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'web', 'feed-icons');

test('every feed icon the page names is vendored, as an 88px PNG', () => {
  const sections = fs.readFileSync(path.join(root, 'web', 'js', 'sections.js'), 'utf8');
  const names = [...sections.matchAll(/feedIcon\('([^']+\.png)'\)/g)].map((m) => m[1] ?? '');
  assert.ok(names.length >= 2, 'sections.js names no feed icons');
  for (const name of names) {
    const file = path.join(dir, name);
    assert.ok(fs.existsSync(file), `web/feed-icons/${name} is missing`);
    const png = fs.readFileSync(file);
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG', `${name} is not a PNG`);
    assert.equal(png.readUInt32BE(16), 88, `${name} width`);
    assert.equal(png.readUInt32BE(20), 88, `${name} height`);
  }
});

test('a shared copy carries every feed icon', () => {
  const share = fs.readFileSync(path.join(root, 'web', 'js', 'share-copy.js'), 'utf8');
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.png'))) {
    assert.ok(share.includes(`/feed-icons/${name}`), `share-copy.js does not carry ${name}`);
  }
});

test('the vendored icons record where they came from and under what licence', () => {
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.match(readme, /starhollow2008\/osu-local-profiles-ext-media/);
  assert.match(readme, /commit\s+`[0-9a-f]{40}`/);
  assert.match(readme, /CC BY 4\.0/);
  const notices = fs.readFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  assert.match(notices, /osu-local-profiles-ext-media/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile, type Db } from '../src/db/index.ts';
import { createProfile, deleteProfile } from '../src/profiles.ts';
import { defaultSettings, getSettings, updateSettings } from '../src/settings.ts';

function harness(): { db: Db; profileId: number; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-settings-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'First');
  return {
    db,
    profileId,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test('a profile with nothing stored reads back the defaults', () => {
  const h = harness();
  try {
    assert.deepEqual(getSettings(h.db, h.profileId), defaultSettings());
  } finally {
    h.cleanup();
  }
});

test('values round-trip', () => {
  const h = harness();
  try {
    const saved = updateSettings(h.db, h.profileId, { country: 'us', tagline: '  left hand  ' });
    assert.equal(saved.country, 'US');
    assert.equal(saved.tagline, 'left hand');
    assert.deepEqual(getSettings(h.db, h.profileId), saved);
  } finally {
    h.cleanup();
  }
});

test('a patch only touches the keys it names', () => {
  const h = harness();
  try {
    updateSettings(h.db, h.profileId, { country: 'GB', tagline: 'mouse only' });
    const after = updateSettings(h.db, h.profileId, { tagline: 'tablet' });
    assert.equal(after.country, 'GB');
    assert.equal(after.tagline, 'tablet');
  } finally {
    h.cleanup();
  }
});

test('unknown keys are ignored rather than stored', () => {
  const h = harness();
  try {
    const after = updateSettings(h.db, h.profileId, { country: 'JP', nonsense: 42 });
    assert.equal(after.country, 'JP');
    assert.equal('nonsense' in after, false);

    const rows = h.db
      .prepare('SELECT key FROM profile_settings WHERE profile_id = ?')
      .all(h.profileId) as { key: string }[];
    assert.deepEqual(rows.map((r) => r.key), ['country']);
  } finally {
    h.cleanup();
  }
});

test('a country that is not a two-letter code is rejected, not stored as-is', () => {
  const h = harness();
  try {
    for (const bad of ['USA', 'u', '', '12', '  ', null, 7]) {
      assert.equal(updateSettings(h.db, h.profileId, { country: bad }).country, '');
    }
  } finally {
    h.cleanup();
  }
});

test('text is flattened to one line and truncated', () => {
  const h = harness();
  try {
    const saved = updateSettings(h.db, h.profileId, { tagline: `left${'\n'}hand${'x'.repeat(200)}` });
    assert.equal(saved.tagline.includes('\n'), false);
    assert.equal(saved.tagline.length, 120);
    assert.ok(saved.tagline.startsWith('left hand'));
  } finally {
    h.cleanup();
  }
});

test('settings are per profile, not shared', () => {
  const h = harness();
  try {
    const second = createProfile(h.db, 'Left hand');
    updateSettings(h.db, h.profileId, { tagline: 'tablet' });
    updateSettings(h.db, second.id, { tagline: 'mouse' });

    assert.equal(getSettings(h.db, h.profileId).tagline, 'tablet');
    assert.equal(getSettings(h.db, second.id).tagline, 'mouse');
  } finally {
    h.cleanup();
  }
});

/*
 * config.json seeds a profile that has never edited a setting, but must not be able to
 * resurrect a value the user has deliberately cleared.
 */
test('config fallbacks apply until the profile stores its own value', () => {
  const h = harness();
  try {
    const fallbacks = { country: 'AU', tagline: 'from config' };
    assert.equal(getSettings(h.db, h.profileId, fallbacks).country, 'AU');

    updateSettings(h.db, h.profileId, { country: '' }, fallbacks);
    assert.equal(getSettings(h.db, h.profileId, fallbacks).country, '');
    // The key that was never touched still falls back.
    assert.equal(getSettings(h.db, h.profileId, fallbacks).tagline, 'from config');
  } finally {
    h.cleanup();
  }
});

test('deleting a profile takes its settings with it', () => {
  const h = harness();
  try {
    const second = createProfile(h.db, 'Left hand');
    updateSettings(h.db, second.id, { tagline: 'mouse' });

    deleteProfile(h.db, second.id);

    const rows = h.db
      .prepare('SELECT COUNT(*) AS n FROM profile_settings WHERE profile_id = ?')
      .get(second.id) as { n: number };
    assert.equal(rows.n, 0);
  } finally {
    h.cleanup();
  }
});

test('a corrupt stored value falls back to the default instead of throwing', () => {
  const h = harness();
  try {
    h.db
      .prepare('INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)')
      .run(h.profileId, 'tagline', 'not json');
    assert.equal(getSettings(h.db, h.profileId).tagline, '');
  } finally {
    h.cleanup();
  }
});

/* ------------------------------------------------------------------- me! */

test('the description keeps paragraphs but not stray control characters', () => {
  const h = harness();
  try {
    const nl = String.fromCharCode(10);
    const cr = String.fromCharCode(13);
    const tab = String.fromCharCode(9);

    const saved = updateSettings(h.db, h.profileId, {
      aboutMe: `Left hand.${cr}${nl}${nl}Going${tab}slowly.`,
    }).aboutMe;

    assert.equal(saved, `Left hand.${nl}${nl}Going slowly.`);
  } finally {
    h.cleanup();
  }
});

test('runs of blank lines collapse, so pasted text cannot stretch the page', () => {
  const h = harness();
  try {
    const nl = String.fromCharCode(10);
    const saved = updateSettings(h.db, h.profileId, {
      aboutMe: `a${nl.repeat(9)}b`,
    }).aboutMe;
    assert.equal(saved, `a${nl}${nl}b`);
  } finally {
    h.cleanup();
  }
});

test('the description is capped, and is not a place to store a novel', () => {
  const h = harness();
  try {
    const saved = updateSettings(h.db, h.profileId, { aboutMe: 'x'.repeat(70000) }).aboutMe;
    // Room for a whole osu! me! page, which is what an import brings in.
    assert.equal(saved.length, 60000);
  } finally {
    h.cleanup();
  }
});

/*
 * Stored verbatim, escaped at render time. Anything that mangled markup here would be a
 * sanitiser -- which is exactly what plain text exists to avoid needing.
 */
test('markup typed into the description is stored as the text it is', () => {
  const h = harness();
  try {
    const hostile = '<script>alert(1)</script> & <b>bold</b>';
    assert.equal(updateSettings(h.db, h.profileId, { aboutMe: hostile }).aboutMe, hostile);
    assert.equal(getSettings(h.db, h.profileId).aboutMe, hostile);
  } finally {
    h.cleanup();
  }
});

test('the osu!stable note is offered until a profile turns it off', () => {
  const h = harness();
  try {
    // Shown by default, like the counting note: it explains something surprising about how
    // stable reaches the page (roadmap 5.12), and only where stable was found.
    assert.equal(getSettings(h.db, h.profileId).showStableNote, true);
    assert.equal(updateSettings(h.db, h.profileId, { showStableNote: false }).showStableNote, false);
    assert.equal(getSettings(h.db, h.profileId).showStableNote, false);
  } finally {
    h.cleanup();
  }
});

test('a new profile counts every unranked mod and beatmap status by default', () => {
  const h = harness();
  try {
    const settings = getSettings(h.db, h.profileId);
    assert.equal(settings.includeUnrankedMods, true);
    assert.deepEqual(
      [...settings.includeUnrankedMaps].sort(),
      ['graveyard', 'loved', 'pending', 'qualified', 'unsubmitted', 'wip'],
    );
    // And the note that says so is shown until it is dismissed.
    assert.equal(settings.showCountingNote, true);
  } finally {
    h.cleanup();
  }
});

test('a profile from before those defaults keeps counting what it counted, once and for good', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-settings-pin-'));
  const file = path.join(tmp, 'test.db');
  try {
    // A database written by an earlier version: its profiles exist, and nothing is pinned.
    let db = openDb(file);
    const untouched = getOrCreateProfile(db, 'Never opened Other settings');
    const chose = getOrCreateProfile(db, 'Turned unranked mods on');
    updateSettings(db, chose, { includeUnrankedMods: true });
    db.prepare("DELETE FROM kv WHERE key = 'countingDefaultsPinned'").run();
    db.close();

    db = openDb(file);
    // Kept on osu!'s own rules, which were the defaults it was made under...
    assert.equal(getSettings(db, untouched).includeUnrankedMods, false);
    assert.deepEqual(getSettings(db, untouched).includeUnrankedMaps, []);
    // ...while a choice a profile made is its own.
    assert.equal(getSettings(db, chose).includeUnrankedMods, true);
    assert.deepEqual(getSettings(db, chose).includeUnrankedMaps, []);

    // A profile made afterwards gets the new defaults, and reopening pins nothing more.
    const fresh = getOrCreateProfile(db, 'Made after the update');
    db.close();
    db = openDb(file);
    assert.equal(getSettings(db, fresh).includeUnrankedMods, true);
    assert.equal(getSettings(db, fresh).includeUnrankedMaps.length, 6);
    db.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/*
 * Relax and Autopilot are priced as osu! prices them by default. A profile from before that
 * default keeps "as if the mod were off", which it was made under: its relax plays' pp would
 * otherwise roughly halve on an update it did not ask for.
 */
test('relax is priced as osu! prices it by default, and older profiles keep their pricing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-settings-relax-'));
  const file = path.join(tmp, 'test.db');
  try {
    let db = openDb(file);
    const untouched = getOrCreateProfile(db, 'Never chose');
    const chose = getOrCreateProfile(db, 'Chose osu! pricing');
    updateSettings(db, chose, { unrankedModPp: 'as-played' });
    db.prepare("DELETE FROM kv WHERE key = 'relaxPricingPinned'").run();
    db.prepare("DELETE FROM profile_settings WHERE profile_id = ? AND key = 'unrankedModPp'").run(untouched);
    db.close();

    db = openDb(file);
    assert.equal(getSettings(db, untouched).unrankedModPp, 'without-the-mod');
    assert.equal(getSettings(db, chose).unrankedModPp, 'as-played');

    const fresh = getOrCreateProfile(db, 'Made after the update');
    db.close();
    db = openDb(file);
    assert.equal(getSettings(db, fresh).unrankedModPp, 'as-played');
    db.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile } from '../src/db/index.ts';
import { Status } from '../src/clients/beatmaps.ts';
import { VANILLA } from '../src/calc/eligibility.ts';
import { scoresTable, workbookTables, type Table } from '../src/export/tables.ts';
import { localDateTime, toCsv } from '../src/export/csv.ts';
import { columnName, serialDate, sheetNames, toXlsx, xmlText } from '../src/export/xlsx.ts';
import { translator } from '../src/export/words.ts';
import { entryData, readZipEntries } from '../src/update/zip.ts';

/*
 * Share & back up -> Export to a spreadsheet: a profile's scores as .csv, and the whole profile
 * as an .xlsx workbook. Checked here for what a spreadsheet does with the bytes; the workbook was
 * also opened in Excel 16 and read back with openpyxl while it was written (roadmap 5.71).
 */

const table = (rows: Table['rows'], headers = ['A', 'B']): Table => ({
  name: 'Scores',
  columns: headers.map((header) => ({ header })),
  rows,
});

/* ------------------------------------------------------------------ csv */

test('a .csv opens in Excel as written: a byte order mark, CRLF, and quoting where it is needed', () => {
  const csv = toCsv(table([['plain', 'with, comma'], ['with "quotes"', 'two\nlines']])).toString('utf8');
  assert.ok(csv.startsWith('﻿A,B\r\n'), 'without the mark Excel reads UTF-8 titles as mojibake');
  assert.equal(csv, '﻿A,B\r\nplain,"with, comma"\r\n"with ""quotes""","two\nlines"\r\n');
});

test('a title a spreadsheet would run as a formula is written as text; numbers are left alone', () => {
  const csv = toCsv(table([['=HYPERLINK("x")', '+1'], ['-Sunset-', '@me'], [-5, 12.5]])).toString('utf8');
  const lines = csv.split('\r\n');
  assert.equal(lines[1], `"'=HYPERLINK(""x"")",'+1`);
  assert.equal(lines[2], `'-Sunset-,'@me`);
  assert.equal(lines[3], '-5,12.5', 'a number is a number');
});

test('a moment is written as local date and time, which a spreadsheet reads as one', () => {
  const at = new Date(2026, 8, 27, 14, 7, 5).getTime();
  assert.equal(localDateTime(at), '2026-09-27 14:07:05');
  assert.equal(toCsv(table([[{ date: at }, null]])).toString('utf8').split('\r\n')[1], '2026-09-27 14:07:05,');
});

/* ----------------------------------------------------------------- xlsx */

test("a column's letters run A to Z, then AA", () => {
  assert.deepEqual([0, 25, 26, 51, 701, 702].map(columnName), ['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
});

test('sheet names are what a workbook allows: short, no forbidden characters, no two alike', () => {
  assert.deepEqual(sheetNames(['Scores', 'a/b:c', 'x'.repeat(40), 'Scores', 'scores']), [
    'Scores',
    'a b c',
    'x'.repeat(31),
    'Scores 2',
    'scores 3',
  ]);
});

test('text is escaped for XML, and what XML cannot carry at all is dropped', () => {
  assert.equal(xmlText('a & <b> "c"\u0001\u0008d'), 'a &amp; &lt;b&gt; &quot;c&quot;d');
  assert.equal(xmlText('夜に駆ける 🎵'), '夜に駆ける 🎵');
});

test("a date is a spreadsheet's serial day, in local time", () => {
  const noon = new Date(2026, 0, 1, 12, 0, 0).getTime();
  // 1 January 2026 is day 46023 counting from 1899-12-30; noon is half a day on.
  assert.equal(serialDate(noon), 46023.5);
});

test('a workbook has every part a spreadsheet needs, and text never becomes a formula', () => {
  const at = new Date(2026, 0, 1, 12).getTime();
  const book = toXlsx([
    table([['=1+1', 3.5], [{ date: at }, null]]),
    { name: 'Medals', columns: [{ header: 'Medal' }], rows: [] },
  ]);
  const entries = readZipEntries(book);
  const read = (name: string) => {
    const entry = entries.find((e) => e.name === name);
    assert.ok(entry, `${name} is in the workbook`);
    return entryData(book, entry).toString('utf8');
  };
  assert.match(read('[Content_Types].xml'), /sheet2\.xml/);
  assert.match(read('_rels/.rels'), /xl\/workbook\.xml/);
  assert.match(read('xl/workbook.xml'), /<sheet name="Scores" sheetId="1" r:id="rId1"\/><sheet name="Medals"/);
  read('xl/styles.xml');

  const sheet = read('xl/worksheets/sheet1.xml');
  assert.ok(sheet.includes('<c r="A2" t="inlineStr"><is><t xml:space="preserve">=1+1</t></is></c>'), 'text, not a formula');
  assert.ok(!sheet.includes('<f>'));
  assert.ok(sheet.includes('<c r="B2"><v>3.5</v></c>'));
  assert.ok(sheet.includes('<c r="A3" s="2"><v>46023.5</v></c>'), 'a date, styled as one');
  assert.ok(sheet.includes('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'));
  assert.ok(sheet.includes('<autoFilter ref="A1:B3"/>'));
  // An empty table is still a sheet with its header.
  assert.ok(read('xl/worksheets/sheet2.xml').includes('<autoFilter ref="A1:A1"/>'));
});

/* --------------------------------------------------------------- tables */

function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-export-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Export');
  let n = 0;
  db.prepare(
    `INSERT INTO beatmaps (md5, beatmap_id, beatmapset_id, artist, title, artist_unicode, title_unicode, version, creator, status, cached_at)
     VALUES ('m1', 11, 1, 'YOASOBI', 'Yoru ni Kakeru', 'YOASOBI', '夜に駆ける', 'Insane', 'mapper', 1, 0),
            ('m2', 22, 2, 'Artist', 'Song', 'Artist', 'Song', 'Hard', 'other', 1, 0)`,
  ).run();
  const add = (f: { md5?: string; pp?: number | null; mode?: number; hidden?: boolean; miss?: number; combo?: number } = {}) => {
    n++;
    db.prepare(
      `INSERT INTO scores
        (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
         count300, count100, count50, count_geki, count_katu, count_miss,
         accuracy, max_combo, total_score, passed, grade, stars, pp, beatmap_max_combo,
         map_status, mods_ranked, mods_countable, ranked, played_at, hidden_at)
       VALUES (?,?,?,?,'lazer','[{"acronym":"DT","settings":{"speed_change":1.3}}]','DT',
               100,2,0,0,0,?, 0.98,?,900000,1,'S',5.5,?,500, 1,1,1,1,?,?)`,
    ).run(
      profileId, `k${n}`, f.mode ?? 0, f.md5 ?? 'm1', f.miss ?? 0, f.combo ?? 500,
      f.pp === undefined ? 100 : f.pp, 1_700_000_000_000 + n * 60_000, f.hidden ? 1 : null,
    );
  };
  return { db, profileId, add, cleanup: () => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

const col = (t: Table, header: string) => {
  const i = t.columns.findIndex((c) => c.header === header);
  assert.ok(i >= 0, `no ${header} column`);
  return t.rows.map((r) => r[i]);
};

test('the scores are every score this profile shows, by pp from highest, no pp last', () => {
  const h = harness();
  try {
    h.add({ pp: 50 });
    h.add({ pp: null, md5: 'm2' });
    h.add({ pp: 200, md5: 'm2', mode: 3 });
    h.add({ pp: 999, hidden: true }); // removed from the profile: not one of its scores
    const t = scoresTable(h.db, h.profileId, VANILLA);
    assert.deepEqual(col(t, 'pp'), [200, 50, null]);
    assert.deepEqual(col(t, 'Mode'), ['osu!mania', 'osu!', 'osu!']);
    assert.deepEqual(col(t, 'Best performance #'), [1, 1, null], 'each mode has its own best performances');
  } finally {
    h.cleanup();
  }
});

test('a score row says what a person would want to know, in words', () => {
  const h = harness();
  try {
    h.add({ pp: 100 });
    h.add({ pp: 80, miss: 1, combo: 300 });
    const t = scoresTable(h.db, h.profileId, VANILLA);
    assert.deepEqual(col(t, 'Title'), ['Yoru ni Kakeru', 'Yoru ni Kakeru']);
    // The song's own script only where it differs (roadmap 5.55).
    assert.deepEqual(col(t, 'Title (original)'), ['夜に駆ける', '夜に駆ける']);
    assert.deepEqual(col(t, 'Artist (original)'), [null, null]);
    assert.deepEqual(col(t, 'Mods'), ['DT', 'DT']);
    assert.deepEqual(col(t, 'Mod settings'), ['DT speed_change 1.3', 'DT speed_change 1.3']);
    assert.deepEqual(col(t, 'Full combo'), ['Yes', 'No']);
    assert.deepEqual(col(t, 'Accuracy %'), [98, 98]);
    assert.deepEqual(col(t, 'Grade'), ['S', 'S']);
    assert.deepEqual(col(t, 'Counts toward pp'), ['Yes', 'Yes']);
    assert.deepEqual(col(t, 'Source'), ['Replay', 'Replay']);
    assert.deepEqual(col(t, 'Beatmap link'), ['https://osu.ppy.sh/b/11', 'https://osu.ppy.sh/b/11']);
    assert.deepEqual(col(t, 'Beatmap status'), ['Ranked', 'Ranked']);
    assert.equal(typeof (col(t, 'Date set')[0] as { date: number }).date, 'number');
  } finally {
    h.cleanup();
  }
});

test('the workbook puts scores first, a sheet per mode only when there is more than one', () => {
  const h = harness();
  try {
    h.add({ pp: 50 });
    const one = workbookTables(h.db, h.profileId, 'Export', VANILLA, h.profileId, null).map((t) => t.name);
    assert.deepEqual(one, ['Scores', 'Summary', 'Most Played Beatmaps', 'Favorite Beatmaps', 'Medals']);

    h.add({ pp: 20, mode: 3, md5: 'm2' });
    const two = workbookTables(h.db, h.profileId, 'Export', VANILLA, h.profileId, null).map((t) => t.name);
    assert.deepEqual(two, [
      'Scores', 'Scores (osu!)', 'Scores (osu!mania)', 'Summary', 'Most Played Beatmaps', 'Favorite Beatmaps', 'Medals',
    ]);
  } finally {
    h.cleanup();
  }
});

test("an export is in the page's language: headers, sheets and words, names as osu! writes them", () => {
  const h = harness();
  try {
    h.add({ pp: 50 });
    h.add({ pp: 20, mode: 3, md5: 'm2', miss: 1, combo: 10 });
    const de = translator('de');
    const t = scoresTable(h.db, h.profileId, VANILLA, null, de);
    const headers = t.columns.map((c) => c.header);
    assert.ok(headers.includes('Interpret') && headers.includes('Titel') && headers.includes('Sterne'), headers.join());
    assert.deepEqual(col(t, 'Bestanden'), ['Ja', 'Ja']);
    assert.deepEqual(col(t, 'Full Combo'), ['Ja', 'Nein']);
    // A mode, a grade and pp are osu!'s own names, in every language.
    assert.deepEqual(col(t, 'Modus'), ['osu!', 'osu!mania']);
    assert.ok(headers.includes('pp'));

    const sheets = workbookTables(h.db, h.profileId, 'Export', VANILLA, h.profileId, null, de).map((s) => s.name);
    assert.equal(sheets[0], 'Scores');
    assert.equal(sheets[1], 'Scores (osu!)');
    assert.ok(sheets.includes('Übersicht'), sheets.join());

    // A language this app does not have is English, not a column of raw keys.
    assert.equal(scoresTable(h.db, h.profileId, VANILLA, null, translator('xx')).columns[0]!.header, 'Date set');
  } finally {
    h.cleanup();
  }
});

import type { Cell, Table } from './tables.ts';

/**
 * One table as a `.csv` a spreadsheet opens with a double-click.
 *
 * Written for Excel first, since that is what most people will open it with, and Excel is the
 * fussy one: a UTF-8 byte order mark, or every Japanese title reads as mojibake; CRLF between
 * rows; a date as `2026-09-27 14:37:05`, which it reads as a date and time.
 *
 * And one guard. A spreadsheet runs a cell that begins `=`, `+`, `-` or `@` as a formula, and
 * a beatmap's title is whatever its mapper typed -- so a title like `=HYPERLINK(...)` would be
 * a live formula in whoever opens the file. Such text is written with a leading apostrophe,
 * which spreadsheets take to mean "this is text"; numbers are never touched.
 */

const FORMULA = /^[=+\-@\t\r]/;

/** A moment as local time, the way a spreadsheet parses a date and time. */
export function localDateTime(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function field(cell: Cell): string {
  if (cell === null) return '';
  if (typeof cell === 'number') return String(cell);
  let text = typeof cell === 'string' ? cell : localDateTime(cell.date);
  if (typeof cell === 'string' && FORMULA.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(table: Table): Buffer {
  const lines = [table.columns.map((c) => field(c.header)), ...table.rows.map((row) => row.map(field))];
  return Buffer.from(`﻿${lines.map((l) => l.join(',')).join('\r\n')}\r\n`, 'utf8');
}

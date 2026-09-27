import { writeZip } from '../update/zip.ts';
import type { Cell, Table } from './tables.ts';

/**
 * Tables as an `.xlsx` workbook, one sheet each, written by hand: a workbook is a zip of a few
 * XML files (ECMA-376, SpreadsheetML), and the smallest set Excel, LibreOffice and Google
 * Sheets all open is small enough to write here rather than bring in a library for.
 *
 * Made for someone who has never used a filter: every sheet has its header row in bold and
 * frozen while the rest scrolls, a filter (sort and filter arrows) on every column, sensible
 * column widths, and dates as real dates. Text is always written as text (`inlineStr`), never as
 * something a spreadsheet evaluates -- a beatmap titled `=...` stays a title.
 */

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** The styles below, by index: plain, the bold header, a date and time. */
const STYLE = { plain: 0, header: 1, date: 2 } as const;

/** Excel's own limit on one cell's text. */
const MAX_CELL_TEXT = 32_767;

/** Text as XML may carry it: escaped, and without the control characters XML 1.0 forbids. */
export function xmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A column's letters: 0 is A, 25 is Z, 26 is AA. */
export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/**
 * A moment as a spreadsheet date: days since 1899-12-30, in local time -- the time the player
 * would have read off their own clock.
 */
export function serialDate(ms: number): number {
  const local = ms - new Date(ms).getTimezoneOffset() * 60_000;
  return local / 86_400_000 + 25_569;
}

/**
 * Sheet names as a workbook allows them: at most 31 characters, none of `[]:*?/\`, and no two
 * the same.
 */
export function sheetNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const base = raw.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

function cell(ref: string, value: Cell, style: number = STYLE.plain): string {
  if (value === null) return '';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${value}</v></c>` : '';
  }
  if (typeof value === 'object') return `<c r="${ref}" s="${STYLE.date}"><v>${serialDate(value.date)}</v></c>`;
  const text = xmlText(value.slice(0, MAX_CELL_TEXT));
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${text}</t></is></c>`;
}

function worksheet(table: Table, first: boolean): string {
  const last = columnName(Math.max(table.columns.length, 1) - 1);
  const rows = [
    `<row r="1">${table.columns.map((c, i) => cell(`${columnName(i)}1`, c.header, STYLE.header)).join('')}</row>`,
    ...table.rows.map(
      (row, r) => `<row r="${r + 2}">${row.map((v, i) => cell(`${columnName(i)}${r + 2}`, v)).join('')}</row>`,
    ),
  ];
  const cols = table.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 12}" customWidth="1"/>`)
    .join('');
  return (
    `${HEAD}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">` +
    `<dimension ref="A1:${last}${table.rows.length + 1}"/>` +
    `<sheetViews><sheetView workbookViewId="0"${first ? ' tabSelected="1"' : ''}>` +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${rows.join('')}</sheetData>` +
    `<autoFilter ref="A1:${last}${table.rows.length + 1}"/>` +
    '</worksheet>'
  );
}

const STYLES =
  `${HEAD}<styleSheet xmlns="${MAIN}">` +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

export function toXlsx(tables: readonly Table[], at = new Date()): Buffer {
  const names = sheetNames(tables.map((t) => t.name));
  const sheets = tables.map((t, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(worksheet(t, i === 0), 'utf8') }));

  const contentTypes =
    `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    '</Types>';

  const rootRels =
    `${HEAD}<Relationships xmlns="${PACKAGE_REL}">` +
    `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>` +
    '</Relationships>';

  // The filter each sheet has, named as Excel names it, so Excel treats it as the sheet's own.
  const filters = tables
    .map((t, i) => {
      const range = `$A$1:$${columnName(Math.max(t.columns.length, 1) - 1)}$${t.rows.length + 1}`;
      return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlText(names[i]!.replaceAll("'", "''"))}'!${range}</definedName>`;
    })
    .join('');
  const workbook =
    `${HEAD}<workbook xmlns="${MAIN}" xmlns:r="${REL}">` +
    '<bookViews><workbookView activeTab="0"/></bookViews>' +
    `<sheets>${names.map((n, i) => `<sheet name="${xmlText(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
    `<definedNames>${filters}</definedNames>` +
    '</workbook>';

  const workbookRels =
    `${HEAD}<Relationships xmlns="${PACKAGE_REL}">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/>` +
    '</Relationships>';

  return writeZip(
    [
      { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
      { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
      { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
      { name: 'xl/styles.xml', data: Buffer.from(STYLES, 'utf8') },
      ...sheets,
    ],
    at,
  );
}

/**
 * Excel workbooks (.xlsx) written and read in-house.
 *
 * Writing produces the handful of parts Excel needs — workbook, sheets,
 * shared strings, styles, properties — with a fixed set of named styles
 * built from the app's theme, so a report or a template opens looking like
 * the app that made it. Reading takes the same parts back: sheet names and
 * a dense grid of plain values per sheet, with shared and inline strings
 * resolved, booleans and numbers typed, and date-formatted numbers turned
 * into ISO dates. Nothing else of the format is interpreted.
 *
 * writeWorkbook({ sheets: [{ name, rows, widths, freeze, autoFilter, validations, merges, hyperlinks, tabColor }], theme, title })
 *   → Promise<Uint8Array>
 * readWorkbook(bytes) → Promise<{ sheets: [{ name, rows: Array<Array<string|number|boolean|null>> }] }>
 *
 * A cell in `rows` is a primitive, or `{ v, s }` with `s` one of STYLES.
 */

import { zipWrite, zipRead } from '../utils/zip.js';
import { escapeXml, parseXml, childrenOf, firstChild, textOf, attr } from '../utils/xml.js';

/** The app's tokens, as hex without '#'. The browser passes the live ones. */
export const DEFAULT_THEME = Object.freeze({
  accent: '2F6FED', accentStrong: '2158C9', accentSoft: 'E8F0FE',
  text: '1C2128', text2: '57606A', text3: '8B949E',
  border: 'E1E5EA', borderStrong: 'C9D0D8', surface2: 'F1F3F6', bg: 'F5F6F8',
  warning: 'B35900', warningSoft: 'FFF5E0', success: '1A7F37', successSoft: 'E3F5E8', danger: 'CF222E', dangerSoft: 'FFEBE9',
  font: 'Arial', mono: 'Consolas',
});

export const STYLES = Object.freeze(['default', 'header', 'headerRequired', 'title', 'subtitle', 'muted', 'label', 'hint', 'example', 'mono', 'wrap', 'text', 'zebra', 'zebraMono', 'zebraText', 'link', 'ok', 'warn', 'bad', 'date']);

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_SHEET = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const REL_STYLES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';
const REL_SST = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings';
const MAX_ROW = 1048576;

// ------------------------------------------------------------------ cells
export function colLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function cellRef(row, col) {
  return `${colLetter(col)}${row + 1}`;
}

function cellOf(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { v: raw.v, s: raw.s || 'default' };
  return { v: raw, s: 'default' };
}

// ------------------------------------------------------------------ styles
function buildStyles(theme) {
  const T = { ...DEFAULT_THEME, ...(theme || {}) };
  const fonts = [];
  const fills = [{ pattern: 'none' }, { pattern: 'gray125' }];
  const borders = [{}];
  const xfs = [];
  const index = {};
  const dedupe = (list, item) => {
    const key = JSON.stringify(item);
    let at = list.findIndex((x) => JSON.stringify(x) === key);
    if (at === -1) {
      list.push(item);
      at = list.length - 1;
    }
    return at;
  };
  const font = (o = {}) => dedupe(fonts, { name: T.font, sz: 10, color: T.text, ...o });
  const fill = (color) => (color ? dedupe(fills, { pattern: 'solid', color }) : 0);
  const border = (o = null) => (o ? dedupe(borders, o) : 0);
  const define = (name, { f = {}, bg = null, b = null, align = null, numFmt = 0 } = {}) => {
    index[name] = xfs.length;
    xfs.push({ fontId: font(f), fillId: fill(bg), borderId: border(b), align, numFmt });
  };

  define('default');
  define('header', { f: { bold: true, color: 'FFFFFF' }, bg: T.accent, b: { bottom: T.accentStrong }, align: { vertical: 'center' } });
  define('headerRequired', { f: { bold: true, color: 'FFFFFF' }, bg: T.accentStrong, b: { bottom: T.accentStrong }, align: { vertical: 'center' } });
  define('title', { f: { bold: true, sz: 15, color: T.text } });
  define('subtitle', { f: { sz: 10, color: T.text2 } });
  define('muted', { f: { sz: 9, color: T.text3 } });
  define('label', { f: { bold: true, sz: 10, color: T.text2 } });
  define('hint', { f: { italic: true, sz: 9, color: T.text3 }, bg: T.surface2, align: { vertical: 'top', wrap: true } });
  define('example', { f: { italic: true, sz: 10, color: T.text2 }, bg: T.accentSoft });
  define('mono', { f: { name: T.mono, sz: 10 } });
  define('wrap', { align: { vertical: 'top', wrap: true } });
  define('text', { numFmt: 49 });
  define('zebra', { bg: T.bg });
  define('zebraMono', { f: { name: T.mono, sz: 10 }, bg: T.bg });
  define('zebraText', { bg: T.bg, numFmt: 49 });
  define('link', { f: { color: T.accent, underline: true } });
  define('ok', { f: { color: T.success }, bg: T.successSoft });
  define('warn', { f: { color: T.warning }, bg: T.warningSoft });
  define('bad', { f: { color: T.danger }, bg: T.dangerSoft });
  define('date', { numFmt: 164 });

  const fontXml = (f) => `<font>${f.bold ? '<b/>' : ''}${f.italic ? '<i/>' : ''}${f.underline ? '<u/>' : ''}<sz val="${f.sz}"/><color rgb="FF${f.color}"/><name val="${escapeXml(f.name)}"/><family val="2"/></font>`;
  const fillXml = (f) => (f.pattern === 'solid' ? `<fill><patternFill patternType="solid"><fgColor rgb="FF${f.color}"/><bgColor indexed="64"/></patternFill></fill>` : `<fill><patternFill patternType="${f.pattern}"/></fill>`);
  const borderXml = (b) => `<border><left/><right/><top/>${b.bottom ? `<bottom style="thin"><color rgb="FF${b.bottom}"/></bottom>` : '<bottom/>'}<diagonal/></border>`;
  const xfXml = (x) => {
    const align = x.align ? `<alignment${x.align.vertical ? ` vertical="${x.align.vertical}"` : ''}${x.align.wrap ? ' wrapText="1"' : ''}/>` : '';
    return `<xf numFmtId="${x.numFmt}" fontId="${x.fontId}" fillId="${x.fillId}" borderId="${x.borderId}" xfId="0" applyFont="1" applyFill="1" applyBorder="1"${x.numFmt ? ' applyNumberFormat="1"' : ''}${align ? ' applyAlignment="1"' : ''}>${align}</xf>`;
  };
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS_MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="${fonts.length}">${fonts.map(fontXml).join('')}</fonts><fills count="${fills.length}">${fills.map(fillXml).join('')}</fills><borders count="${borders.length}">${borders.map(borderXml).join('')}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.map(xfXml).join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  return { xml, index, theme: T };
}

// ------------------------------------------------------------------ writing
function sheetName(name, used) {
  const base = String(name == null ? '' : name).replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
  let out = base;
  let n = 2;
  while (used.has(out.toLowerCase())) {
    const suffix = ` ${n}`;
    out = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    n += 1;
  }
  used.add(out.toLowerCase());
  return out;
}

function quoteSheet(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

function autoWidths(rows, explicit = []) {
  const max = [];
  rows.forEach((row, r) => {
    (row || []).forEach((raw, c) => {
      const { v } = cellOf(raw);
      if (v == null || v === '') return;
      const len = Math.max(...String(v).split('\n').map((line) => line.length)) + (r === 0 ? 2 : 0);
      max[c] = Math.max(max[c] || 0, len);
    });
  });
  const out = [];
  const n = Math.max(max.length, explicit.length);
  for (let c = 0; c < n; c += 1) {
    if (explicit[c] != null) out[c] = explicit[c];
    else out[c] = Math.min(60, Math.max(8, (max[c] || 6) * 1.1 + 2));
  }
  return out;
}

function sheetXml(sheet, styles, sst, { selected }) {
  const rows = sheet.rows || [];
  const widths = autoWidths(rows, sheet.widths || []);
  let maxCol = widths.length;
  const rowXml = [];
  rows.forEach((row, r) => {
    const cells = [];
    (row || []).forEach((raw, c) => {
      const { v, s } = cellOf(raw);
      maxCol = Math.max(maxCol, c + 1);
      const sIx = styles.index[s] ?? 0;
      const sAttr = sIx ? ` s="${sIx}"` : '';
      const ref = cellRef(r, c);
      if (v == null || v === '') {
        if (sIx) cells.push(`<c r="${ref}"${sAttr}/>`);
        return;
      }
      if (typeof v === 'number' && Number.isFinite(v)) cells.push(`<c r="${ref}"${sAttr}><v>${v}</v></c>`);
      else if (typeof v === 'boolean') cells.push(`<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`);
      else cells.push(`<c r="${ref}"${sAttr} t="s"><v>${sst.add(String(v))}</v></c>`);
    });
    if (cells.length) rowXml.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });
  const lastRow = Math.max(rows.length, 1);
  const dimension = `A1:${cellRef(lastRow - 1, Math.max(maxCol, 1) - 1)}`;

  const freezeRows = sheet.freeze && sheet.freeze.rows ? sheet.freeze.rows : 0;
  const pane = freezeRows ? `<pane ySplit="${freezeRows}" topLeftCell="A${freezeRows + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${freezeRows + 1}" sqref="A${freezeRows + 1}"/>` : '';
  const views = `<sheetViews><sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ''} showGridLines="${sheet.gridLines === false ? 0 : 1}">${pane}</sheetView></sheetViews>`;
  const cols = widths.length ? `<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${Number(w).toFixed(2)}" customWidth="1"/>`).join('')}</cols>` : '';

  let autoFilterRef = null;
  if (sheet.autoFilter) {
    const af = sheet.autoFilter === true ? { row: 0 } : sheet.autoFilter;
    autoFilterRef = `A${af.row + 1}:${cellRef(lastRow - 1, maxCol - 1)}`;
  }
  const autoFilter = autoFilterRef ? `<autoFilter ref="${autoFilterRef}"/>` : '';
  const merges = sheet.merges && sheet.merges.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  const validations = sheet.validations && sheet.validations.length
    ? `<dataValidations count="${sheet.validations.length}">${sheet.validations.map((dv) => {
      const from = (dv.fromRow ?? 0) + 1;
      const sqref = `${colLetter(dv.col)}${from}:${colLetter(dv.col)}${MAX_ROW}`;
      return `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${sqref}"><formula1>"${escapeXml(dv.list.join(','))}"</formula1></dataValidation>`;
    }).join('')}</dataValidations>`
    : '';
  const hyperlinks = sheet.hyperlinks && sheet.hyperlinks.length
    ? `<hyperlinks>${sheet.hyperlinks.map((l) => `<hyperlink ref="${l.ref}" location="${escapeXml(`${quoteSheet(l.sheet)}!A1`)}" display="${escapeXml(l.display || l.sheet)}"/>`).join('')}</hyperlinks>`
    : '';
  const tab = sheet.tabColor ? `<sheetPr><tabColor rgb="FF${sheet.tabColor}"/></sheetPr>` : '';
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">${tab}<dimension ref="${dimension}"/>${views}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rowXml.join('')}</sheetData>${autoFilter}${merges}${validations}${hyperlinks}<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/></worksheet>`;
  return { xml, autoFilterRef };
}

class SharedStrings {
  constructor() {
    this.list = [];
    this.index = new Map();
  }

  add(s) {
    let at = this.index.get(s);
    if (at === undefined) {
      at = this.list.length;
      this.list.push(s);
      this.index.set(s, at);
    }
    return at;
  }

  xml() {
    const items = this.list.map((s) => `<si><t${/^\s|\s$/.test(s) ? ' xml:space="preserve"' : ''}>${escapeXml(s)}</t></si>`);
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="${NS_MAIN}" count="${this.list.length}" uniqueCount="${this.list.length}">${items.join('')}</sst>`;
  }
}

/**
 * @param {{ sheets: Array<object>, theme?: object, title?: string, creator?: string, now?: Date }} spec
 * @returns {Promise<Uint8Array>}
 */
export async function writeWorkbook({ sheets, theme = null, title = 'Metric Studio', creator = 'Metric Studio', now = new Date() }) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('A workbook needs at least one sheet');
  const styles = buildStyles(theme);
  const sst = new SharedStrings();
  const used = new Set();
  const parts = [];
  const names = [];
  const filters = [];
  sheets.forEach((sheet, i) => {
    const name = sheetName(sheet.name, used);
    names.push(name);
    const { xml, autoFilterRef } = sheetXml(sheet, styles, sst, { selected: i === 0 });
    if (autoFilterRef) filters.push({ i, name, ref: autoFilterRef });
    parts.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml });
  });
  const definedNames = filters.length
    ? `<definedNames>${filters.map((f) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${f.i}" hidden="1">${escapeXml(quoteSheet(f.name))}!${f.ref.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>`).join('')}</definedNames>`
    : '';
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><workbookPr/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="13000" activeTab="0"/></bookViews><sheets>${names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${definedNames}</workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_PKG_REL}">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_SHEET}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${names.length + 1}" Type="${REL_STYLES}" Target="styles.xml"/><Relationship Id="rId${names.length + 2}" Type="${REL_SST}" Target="sharedStrings.xml"/></Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>${escapeXml(creator)}</dc:creator><cp:lastModifiedBy>${escapeXml(creator)}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Metric Studio</Application></Properties>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

  return zipWrite([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'docProps/core.xml', data: core },
    { name: 'docProps/app.xml', data: app },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: styles.xml },
    { name: 'xl/sharedStrings.xml', data: sst.xml() },
    ...parts,
  ], { now });
}

// ------------------------------------------------------------------ reading
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormat(code) {
  const stripped = String(code || '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dmyhs]/i.test(stripped) && !/general/i.test(stripped);
}

/** Excel serial (1900 system) → ISO date, with a time part when the serial has one. */
export function serialToIso(serial) {
  if (!Number.isFinite(serial)) return null;
  const whole = Math.floor(serial);
  const frac = serial - whole;
  const ms = Math.round((whole - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const date = whole > 0 ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` : '';
  if (frac < 1e-9) return date || null;
  const secs = Math.round(frac * 86400);
  const time = `${String(Math.floor(secs / 3600) % 24).padStart(2, '0')}:${String(Math.floor(secs / 60) % 60).padStart(2, '0')}${secs % 60 ? `:${String(secs % 60).padStart(2, '0')}` : ''}`;
  return date ? `${date} ${time}` : time;
}

function parseRels(xml) {
  const map = new Map();
  if (!xml) return map;
  for (const r of childrenOf(parseXml(xml), 'Relationship')) {
    if (attr(r, 'TargetMode') === 'External') continue;
    map.set(attr(r, 'Id'), attr(r, 'Target'));
  }
  return map;
}

function resolvePart(base, target) {
  if (!target) return null;
  if (target.startsWith('/')) return target.slice(1);
  const parts = `${base}${target}`.split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const si of childrenOf(parseXml(xml), 'si')) out.push(richText(si));
  return out;
}

/** Text of an <si> or <is>: every <t> that is not phonetic guidance. */
function richText(node) {
  let out = '';
  const stack = [node];
  const parts = [];
  while (stack.length) {
    const cur = stack.pop();
    if (typeof cur === 'string') continue;
    if (cur.local === 'rPh') continue;
    if (cur.local === 't') {
      parts.push(textOf(cur));
      continue;
    }
    for (let i = cur.children.length - 1; i >= 0; i -= 1) stack.push(cur.children[i]);
  }
  for (const p of parts) out += p;
  return out;
}

function parseStyles(xml) {
  const dateXf = [];
  if (!xml) return dateXf;
  const root = parseXml(xml);
  const custom = new Map();
  for (const f of childrenOf(firstChild(root, 'numFmts'), 'numFmt')) custom.set(Number(attr(f, 'numFmtId')), attr(f, 'formatCode'));
  for (const xf of childrenOf(firstChild(root, 'cellXfs'), 'xf')) {
    const id = Number(attr(xf, 'numFmtId') || 0);
    dateXf.push(DATE_FMT_IDS.has(id) || (custom.has(id) && isDateFormat(custom.get(id))));
  }
  return dateXf;
}

function parseSheet(root, sst, dateXf) {
  const rows = [];
  let maxCol = 0;
  for (const row of childrenOf(firstChild(root, 'sheetData'), 'row')) {
    const rAttr = Number(attr(row, 'r'));
    const r = Number.isFinite(rAttr) && rAttr > 0 ? rAttr - 1 : rows.length;
    const cells = rows[r] || [];
    let nextCol = 0;
    for (const c of childrenOf(row, 'c')) {
      const ref = attr(c, 'r');
      const m = ref ? /^([A-Z]+)/i.exec(ref) : null;
      const col = m ? colIndex(m[1]) : nextCol;
      nextCol = col + 1;
      cells[col] = cellValue(c, sst, dateXf);
      maxCol = Math.max(maxCol, col + 1);
    }
    rows[r] = cells;
  }
  // Dense grid: every row has every column, missing cells are null.
  const out = [];
  for (let r = 0; r < rows.length; r += 1) {
    const src = rows[r] || [];
    const row = new Array(maxCol).fill(null);
    for (let c = 0; c < maxCol; c += 1) if (src[c] !== undefined) row[c] = src[c];
    out.push(row);
  }
  while (out.length && out[out.length - 1].every((v) => v == null || v === '')) out.pop();
  return out;
}

/**
 * An Excel error cell: #N/A, #REF!, #VALUE! and the rest.
 *
 * It is not a value, and it is emphatically not a blank. The importer reads
 * a blank as "keep what the record already has", so folding an error into
 * null would turn a broken lookup in the workbook into a silent no-op on
 * exactly the field the author meant to set.
 */
export class CellError {
  constructor(code) {
    this.code = String(code || '').trim() || '#ERROR';
  }

  toString() {
    return this.code;
  }

  toJSON() {
    return this.code;
  }
}

export function isCellError(value) {
  return value instanceof CellError;
}

function cellValue(c, sst, dateXf) {
  const t = attr(c, 't');
  const s = Number(attr(c, 's') || 0);
  const v = firstChild(c, 'v');
  const raw = v ? textOf(v) : '';
  if (t === 's') {
    const at = Number(raw);
    return Number.isInteger(at) && sst[at] !== undefined ? sst[at] : '';
  }
  if (t === 'inlineStr') return richText(firstChild(c, 'is'));
  if (t === 'str') return raw;
  if (t === 'b') return raw === '1' || raw === 'true';
  if (t === 'e') return new CellError(raw);
  if (t === 'd') return raw;
  if (raw === '') return null;
  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  if (dateXf[s]) return serialToIso(num);
  return num;
}

/**
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<{ sheets: Array<{ name: string, rows: Array<Array<string|number|boolean|null>>, hidden: boolean }> }>}
 */
export async function readWorkbook(bytes) {
  const files = await zipRead(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const dec = new TextDecoder();
  const text = (name) => {
    const f = files.get(name);
    return f ? dec.decode(f) : null;
  };
  const wbXml = text('xl/workbook.xml');
  if (!wbXml) throw new Error('Not an Excel workbook: xl/workbook.xml is missing');
  const wb = parseXml(wbXml);
  const rels = parseRels(text('xl/_rels/workbook.xml.rels'));
  let sstPath = 'xl/sharedStrings.xml';
  let stylesPath = 'xl/styles.xml';
  for (const [, target] of rels) {
    const path = resolvePart('xl/', target);
    if (/sharedStrings/i.test(path)) sstPath = path;
    if (/styles/i.test(path)) stylesPath = path;
  }
  const sst = parseSharedStrings(text(sstPath));
  const dateXf = parseStyles(text(stylesPath));
  const sheets = [];
  for (const sh of childrenOf(firstChild(wb, 'sheets'), 'sheet')) {
    const path = resolvePart('xl/', rels.get(attr(sh, 'id')));
    const xml = path ? text(path) : null;
    if (!xml) continue;
    sheets.push({ name: attr(sh, 'name') || `Sheet${sheets.length + 1}`, rows: parseSheet(parseXml(xml), sst, dateXf), hidden: attr(sh, 'state') === 'hidden' });
  }
  return { sheets };
}

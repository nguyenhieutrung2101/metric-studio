import test from 'node:test';
import assert from 'node:assert/strict';
import { zipWrite, zipRead, crc32 } from '../src/utils/zip.js';
import { parseXml, childrenOf, firstChild, textOf, attr, escapeXml } from '../src/utils/xml.js';
import { writeWorkbook, readWorkbook, colLetter, colIndex, serialToIso, STYLES, isCellError } from '../src/services/xlsx.js';

test('zip: entries round-trip, deflated when smaller, with correct CRCs', async () => {
  const big = 'metric studio '.repeat(500);
  const bytes = await zipWrite([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.txt', data: big }, { name: 'empty.txt', data: '' }]);
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  const back = await zipRead(bytes);
  const dec = new TextDecoder();
  assert.equal(dec.decode(back.get('a.txt')), 'hello');
  assert.equal(dec.decode(back.get('dir/b.txt')), big);
  assert.equal(back.get('empty.txt').length, 0);
  assert.ok(bytes.length < big.length, 'the repetitive entry was compressed');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  await assert.rejects(zipRead(new Uint8Array([1, 2, 3])), /Not a ZIP/);
});

test('xml: a tolerant parser for the parts a workbook is made of', () => {
  const root = parseXml('<?xml version="1.0"?><!-- c --><x:root xmlns:x="u" a="1" b=\'two &amp; three\'><x:item r:id="rId1" flag/><item>t&#233;xt<![CDATA[<raw>]]></item><empty/></x:root>');
  assert.equal(root.local, 'root');
  assert.equal(root.attrs.a, '1');
  assert.equal(root.attrs.b, 'two & three');
  const items = childrenOf(root, 'item');
  assert.equal(items.length, 2);
  assert.equal(attr(items[0], 'id'), 'rId1');
  assert.equal(items[0].attrs.flag, '');
  assert.equal(textOf(items[1]), 'téxt<raw>');
  assert.ok(firstChild(root, 'empty'));
  assert.equal(escapeXml('a<b>&"c"'), 'a&lt;b&gt;&amp;&quot;c&quot;');
});

test('cell references', () => {
  assert.equal(colLetter(0), 'A');
  assert.equal(colLetter(25), 'Z');
  assert.equal(colLetter(26), 'AA');
  assert.equal(colLetter(701), 'ZZ');
  assert.equal(colLetter(702), 'AAA');
  for (let i = 0; i < 2000; i += 1) assert.equal(colIndex(colLetter(i)), i);
  assert.equal(serialToIso(45658), '2025-01-01');
  assert.equal(serialToIso(45658.5), '2025-01-01 12:00');
  assert.equal(serialToIso(0.25), '06:00');
});

test('workbook: what is written is what is read, styles and all', async () => {
  const rows = [
    [{ v: 'Code', s: 'header' }, { v: 'Name *', s: 'headerRequired' }, { v: 'Amount', s: 'header' }, { v: 'Flag', s: 'header' }, { v: 'When', s: 'header' }],
    [{ v: 'x', s: 'hint' }, { v: 'A hint row', s: 'hint' }, null, null, null],
    ['REV', 'Doanh thu — "quoted" & <tagged>', 1234.5, true, '2026-09-14'],
    [{ v: 'VOL', s: 'zebraText' }, { v: '  padded  ', s: 'zebra' }, { v: 0, s: 'zebra' }, { v: false, s: 'zebra' }, { v: '', s: 'zebra' }],
    ['LONG', 'a'.repeat(200), -1, null, null],
  ];
  const bytes = await writeWorkbook({
    title: 'Test',
    sheets: [
      { name: 'Data [1]: with/bad*chars?', rows, freeze: { rows: 2 }, autoFilter: { row: 0 }, validations: [{ col: 3, fromRow: 2, list: ['yes', 'no'] }] },
      { name: 'Data [1]: with/bad*chars?', rows: [['second']], tabColor: '2F6FED', hyperlinks: [{ ref: 'A1', sheet: 'Data 1 with bad chars', display: 'go' }] },
    ],
  });
  const wb = await readWorkbook(bytes);
  assert.deepEqual(wb.sheets.map((s) => s.name), ['Data 1 with bad chars', 'Data 1 with bad chars 2']);
  const got = wb.sheets[0].rows;
  assert.equal(got.length, 5);
  assert.deepEqual(got[0], ['Code', 'Name *', 'Amount', 'Flag', 'When']);
  assert.deepEqual(got[1], ['x', 'A hint row', null, null, null]);
  assert.deepEqual(got[2], ['REV', 'Doanh thu — "quoted" & <tagged>', 1234.5, true, '2026-09-14']);
  assert.deepEqual(got[3], ['VOL', '  padded  ', 0, false, null]);
  assert.equal(got[4][1].length, 200);
  assert.deepEqual(wb.sheets[1].rows, [['second']]);

  // The parts Excel insists on are all there, and the styles cover every name.
  const { zipRead: read } = await import('../src/utils/zip.js');
  const files = await read(bytes);
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'docProps/core.xml', 'docProps/app.xml']) {
    assert.ok(files.has(name), `${name} present`);
  }
  const dec = new TextDecoder();
  const styles = parseXml(dec.decode(files.get('xl/styles.xml')));
  assert.equal(childrenOf(firstChild(styles, 'cellXfs'), 'xf').length, STYLES.length);
  const sheet1 = dec.decode(files.get('xl/worksheets/sheet1.xml'));
  assert.match(sheet1, /<pane ySplit="2" topLeftCell="A3"/);
  assert.match(sheet1, /<autoFilter ref="A1:E5"\/>/);
  assert.match(sheet1, /<dataValidation type="list"[^>]*sqref="D3:D1048576"><formula1>"yes,no"<\/formula1>/);
  const workbook = dec.decode(files.get('xl/workbook.xml'));
  assert.match(workbook, /_xlnm\._FilterDatabase/);
  const sheet2 = dec.decode(files.get('xl/worksheets/sheet2.xml'));
  assert.match(sheet2, /<hyperlink ref="A1" location="&apos;Data 1 with bad chars&apos;!A1"/);
  assert.match(sheet2, /<tabColor rgb="FF2F6FED"\/>/);
});

test('workbook: reads what other producers write — inline strings, rich text, dates, missing refs', async () => {
  // A minimal workbook the way another tool might write it: prefixed
  // elements, inline strings, a rich-text shared string with phonetic
  // guidance, a date-styled serial, a formula with a cached value, and a
  // row whose cells have no r attribute.
  const parts = [
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'xl/workbook.xml', data: '<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="Metrics" sheetId="1" r:id="rId7"/><x:sheet name="Hidden" sheetId="2" state="hidden" r:id="rId8"/></x:sheets></x:workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="w" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId8" Type="w" Target="worksheets/sheet2.xml"/><Relationship Id="rId9" Type="s" Target="sharedStrings.xml"/><Relationship Id="rId10" Type="st" Target="styles.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>plain</t></si><si><r><t>rich </t></r><r><rPr><b/></rPr><t>text</t></r><rPh sb="0" eb="1"><t>ignored</t></rPh></si></sst>' },
    { name: 'xl/styles.xml', data: '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="170" formatCode="[$-409]d\\-mmm\\-yy;@"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="170"/></cellXfs></styleSheet>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>1</x:v></x:c><x:c r="C1" t="inlineStr"><x:is><x:t>inline</x:t></x:is></x:c></x:row><x:row r="3"><x:c r="A3" s="1"><x:v>45658</x:v></x:c><x:c r="B3" s="2"><x:v>45658.75</x:v></x:c><x:c r="C3" t="str"><x:f>A1&amp;B1</x:f><x:v>computed</x:v></x:c><x:c r="D3" t="e"><x:v>#DIV/0!</x:v></x:c><x:c r="E3" t="b"><x:v>1</x:v></x:c></x:row><x:row><x:c><x:v>7</x:v></x:c><x:c><x:v>8</x:v></x:c></x:row></x:sheetData></x:worksheet>' },
    { name: 'xl/worksheets/sheet2.xml', data: '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>' },
  ];
  const wb = await readWorkbook(await zipWrite(parts));
  assert.equal(wb.sheets.length, 2);
  assert.equal(wb.sheets[0].name, 'Metrics');
  assert.equal(wb.sheets[1].hidden, true);
  const rows = wb.sheets[0].rows;
  assert.deepEqual(rows[0], ['plain', 'rich text', 'inline', null, null]);
  assert.deepEqual(rows[1], [null, null, null, null, null], 'a skipped row is an empty row, not a shifted one');
  // An error cell keeps its code. It is not a value, and folding it into
  // null would make a broken lookup read as "this cell was left blank".
  assert.deepEqual(rows[2].filter((_, i) => i !== 3), ['2025-01-01', '2025-01-01 18:00', 'computed', true]);
  assert.ok(isCellError(rows[2][3]));
  assert.equal(String(rows[2][3]), '#DIV/0!');
  assert.deepEqual(rows[3], [7, 8, null, null, null]);
  assert.deepEqual(wb.sheets[1].rows, []);
});

/**
 * A grid costs its area, not its contents, and both the area and the bytes
 * behind it are claims the file makes. A few kilobytes must not be able to
 * ask for hundreds of megabytes.
 */
const sheetOf = (cells) => [
  { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
  { name: 'xl/workbook.xml', data: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Metrics" sheetId="1" r:id="rId1"/></sheets></workbook>' },
  { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="w" Target="worksheets/sheet1.xml"/></Relationships>' },
  { name: 'xl/worksheets/sheet1.xml', data: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>` },
];

test('a far cell holding nothing but a style does not become a grid of millions of cells', async () => {
  // Two rows of data, and one formatted but empty cell 20,000 rows down.
  const bytes = await zipWrite(sheetOf(
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Code</t></is></c><c r="B1" t="inlineStr"><is><t>Name</t></is></c></row>'
    + '<row r="2"><c r="A2" t="inlineStr"><is><t>M.1</t></is></c><c r="B2" t="inlineStr"><is><t>Doanh thu</t></is></c></row>'
    + '<row r="20000"><c r="IV20000" s="1"/></row>',
  ));
  assert.ok(bytes.length < 4096, 'the file itself is tiny');
  const wb = await readWorkbook(bytes);
  const rows = wb.sheets[0].rows;
  assert.equal(rows.length, 2, 'the sheet is as tall as its data');
  assert.equal(rows[0].length, 2, 'and as wide');
  assert.deepEqual(rows[1], ['M.1', 'Doanh thu']);
});

test('a sheet that really is enormous is refused, not allocated', async () => {
  const bytes = await zipWrite(sheetOf(
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Code</t></is></c></row>'
    + '<row r="40000"><c r="IV40000"><v>1</v></c></row>',
  ));
  await assert.rejects(() => readWorkbook(bytes), /more than this can read at once/);
});

test('a part that claims to unpack to more than the budget is refused before it is read', async () => {
  const bytes = await zipWrite(sheetOf('<row r="1"><c r="A1"><v>1</v></c></row>'));
  // Rewrite what the central directory claims the last part unpacks to. The
  // archive is still only a few hundred bytes; the claim is what is checked.
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let patched = 0;
  for (let i = 0; i < bytes.length - 4; i += 1) {
    if (v.getUint32(i, true) === 0x02014b50) {
      v.setUint32(i + 24, 900 * 1024 * 1024, true);
      patched += 1;
    }
  }
  assert.ok(patched > 0, 'the central directory was found');
  await assert.rejects(() => readWorkbook(bytes), /unpacks to 900 MB, more than the 64 MB/);
});

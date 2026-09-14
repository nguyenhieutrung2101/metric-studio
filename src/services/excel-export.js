/**
 * Excel reports: the datasets a person can export, the fields of each, and
 * the workbook built from a selection of them — a cover sheet, then one
 * sheet per dataset, headers and zebra rows in the app's theme.
 *
 * The catalogue datasets share their rows with the import template
 * (`catalogueRows`), so what a report shows and what a template holds are
 * the same values; the derived datasets (dependency edges, quality issues)
 * are the tables the app already exports as CSV.
 */

import { catalogueRows, TEMPLATE_SHEETS, pick } from './excel-template.js';
import { EDGE_COLUMNS } from './export-tables.js';
import { writeWorkbook } from './xlsx.js';

const L = (en, vi) => ({ en, vi });

const COLUMN_LABELS = {
  Code: L('Code', 'Mã'), Name: L('Name', 'Tên'), Description: L('Description', 'Mô tả'), Sort_Order: L('Sort order', 'Thứ tự'),
  Parent_Code: L('Parent code', 'Mã cha'), Parent_Name: L('Parent', 'Nhóm cha'), Owner: L('Owner', 'Phụ trách'), Path: L('Path', 'Đường dẫn'),
  Aliases: L('Aliases', 'Tên gọi khác'), Unit_Code: L('Unit', 'Đơn vị'), Unit_Name: L('Unit name', 'Tên đơn vị'), Status: L('Status', 'Trạng thái'),
  Owners: L('Owners', 'Đơn vị phụ trách'), Tags: L('Tags', 'Nhãn'), Definition: L('Definition', 'Định nghĩa'),
  Structure_Codes: L('Structure groups', 'Nhóm cấu trúc'), Structure_Path: L('Primary placement', 'Vị trí chính'), Dimension_Codes: L('Dimensions', 'Chiều phân tích'),
  Metric_Code: L('Metric code', 'Mã chỉ tiêu'), Metric_Name: L('Metric', 'Chỉ tiêu'), Scenario_Code: L('Scenario', 'Kịch bản'), Scenario_Name: L('Scenario name', 'Tên kịch bản'),
  Type: L('Binding type', 'Loại gắn'), Formula: L('Formula', 'Công thức'), Formula_Mode: L('Formula mode', 'Dạng công thức'),
  Source_System: L('Source system', 'Hệ thống nguồn'), Source_Dataset: L('Dataset / table', 'Tập dữ liệu / bảng'), Source_Field: L('Field', 'Trường'), Source_Owner: L('Data owner', 'Người phụ trách dữ liệu'), Source_Frequency: L('Frequency', 'Tần suất'),
  Assumption_Value: L('Assumption value', 'Giá trị giả định'), Assumption_Basis: L('Basis / rationale', 'Cơ sở'), Valid_From: L('Valid from', 'Hiệu lực từ'), Valid_To: L('Valid to', 'Hiệu lực đến'),
  Legacy_Code: L('Legacy code', 'Mã cũ'), Note: L('Note', 'Ghi chú'),
  Dimension_Code: L('Dimension', 'Chiều'), Dimension_Name: L('Dimension name', 'Tên chiều'), Level: L('Level', 'Cấp'),
  Required: L('Required', 'Bắt buộc'), Max_Level: L('Max level', 'Cấp tối đa'), Allowed_Member_Codes: L('Allowed members', 'Thành phần được phép'),
  Updated_At: L('Updated', 'Cập nhật'),
};

const EXTRA_FIELDS = {
  metrics: [{ key: 'Unit_Name' }, { key: 'Structure_Path', wide: true }, { key: 'Updated_At' }],
  bindings: [{ key: 'Metric_Name' }, { key: 'Scenario_Name' }, { key: 'Updated_At' }],
  structure: [{ key: 'Parent_Name' }, { key: 'Path', wide: true }],
  members: [{ key: 'Dimension_Name' }, { key: 'Level', numeric: true }],
  metricDimensions: [{ key: 'Metric_Name' }, { key: 'Dimension_Name' }],
  dimensions: [],
  units: [],
  scenarios: [],
};

/** Fields after the template's own columns are inserted where a reader expects them. */
function orderedFields(spec) {
  const own = spec.columns.map((c) => ({ key: c.key, label: COLUMN_LABELS[c.key] || L(c.key.replace(/_/g, ' '), c.key.replace(/_/g, ' ')), mono: !!c.mono, wide: !!c.wide, numeric: !!c.numeric, pick: (r) => r[c.key] }));
  const extra = (EXTRA_FIELDS[spec.key] || []).map((e) => ({ key: e.key, label: COLUMN_LABELS[e.key] || L(e.key, e.key), mono: false, wide: !!e.wide, numeric: !!e.numeric, pick: (r) => r[e.key] }));
  const out = [];
  for (const f of own) {
    out.push(f);
    // Names next to their codes, the way a person reads a report.
    for (const e of extra) if (e.key === `${f.key.replace(/_Code$/, '')}_Name` || (f.key === 'Code' && e.key === 'Level')) out.push(e);
  }
  for (const e of extra) if (!out.includes(e)) out.push(e);
  return out;
}

const SEVERITY_STYLE = { error: 'bad', warning: 'warn', info: 'zebra' };

export const EXPORT_DATASETS = [
  ...['metrics', 'bindings', 'structure', 'dimensions', 'members', 'metricDimensions', 'units', 'scenarios'].map((key) => {
    const spec = TEMPLATE_SHEETS.find((s) => s.key === key);
    return { key, label: spec.title, description: spec.description, fields: orderedFields(spec), rows: (src) => src.catalogue[key] };
  }),
  {
    key: 'dependencies',
    label: L('Dependency edges', 'Cạnh phụ thuộc'),
    description: L('One row per reference inside a formula: target, source, scenario, sequence, operator, AST path.', 'Mỗi dòng một tham chiếu trong công thức: đích, nguồn, kịch bản, thứ tự, toán tử, đường dẫn AST.'),
    fields: EDGE_COLUMNS.map(([name, pickFn]) => ({ key: name, label: L(name.replace(/_/g, ' '), name.replace(/_/g, ' ')), mono: /_ID$|_Code$|Formula_Text|Reference_Text|AST_Path/.test(name), wide: name === 'Formula_Text', numeric: name === 'Sequence', pick: pickFn })),
    rows: (src) => (src.dependencies ? src.dependencies.referenceRows() : []),
  },
  {
    key: 'quality',
    label: L('Quality issues', 'Vấn đề chất lượng'),
    description: L('Every rule the catalogue breaks, with the metric, scenario or record it is about.', 'Mọi quy tắc mà danh mục vi phạm, kèm chỉ tiêu, kịch bản hoặc bản ghi liên quan.'),
    fields: [
      { key: 'Severity', label: L('Severity', 'Mức độ'), pick: (r) => r.severity },
      { key: 'Rule', label: L('Rule', 'Quy tắc'), mono: true, pick: (r) => r.code },
      { key: 'Entity', label: L('Entity', 'Đối tượng'), pick: (r) => r.entity.type },
      { key: 'Metric_Code', label: COLUMN_LABELS.Metric_Code, mono: true, pick: (r) => r.metricCode },
      { key: 'Metric_Name', label: COLUMN_LABELS.Metric_Name, pick: (r) => r.metricName },
      { key: 'Scenario_Code', label: COLUMN_LABELS.Scenario_Code, mono: true, pick: (r) => r.scenarioCode },
      { key: 'Message', label: L('Message', 'Nội dung'), wide: true, pick: (r) => r.message },
    ],
    rows: (src) => (src.issues || []).map((i) => {
      const m = i.metricId ? src.store.get('metrics', i.metricId) : null;
      const s = i.scenarioId ? src.store.get('scenarios', i.scenarioId) : null;
      return { ...i, metricCode: m ? m.code : '', metricName: m ? m.name : '', scenarioCode: s ? s.code : '', message: src.describeIssue ? src.describeIssue(i) : i.message };
    }),
    rowStyle: (r) => SEVERITY_STYLE[r.severity] || null,
  },
];

export const EXPORT_DATASET_BY_KEY = Object.fromEntries(EXPORT_DATASETS.map((d) => [d.key, d]));

/** Everything, every field: the default selection. */
export function defaultExportSelection() {
  return EXPORT_DATASETS.map((d) => ({ key: d.key, fields: d.fields.map((f) => f.key) }));
}

/** Rows of every dataset, computed once for a dialog or a build. */
export function exportSource({ store, dependencies = null, issues = [], describeIssue = null }) {
  return { store, dependencies, issues, describeIssue, catalogue: catalogueRows(store) };
}

const COVER = {
  title: L('Metric Studio — report', 'Metric Studio — báo cáo'),
  generated: L('Generated', 'Tạo lúc'),
  sheets: L('Sheets in this workbook', 'Các sheet trong file'),
  rows: L('rows', 'dòng'),
  catalogue: L('Catalogue', 'Danh mục'),
  quality: L('Quality', 'Chất lượng'),
  severity: { error: L('errors', 'lỗi'), warning: L('warnings', 'cảnh báo'), info: L('notes', 'ghi chú') },
  counts: {
    metrics: L('metrics', 'chỉ tiêu'), bindings: L('bindings', 'gắn kịch bản'), structureNodes: L('structure groups', 'nhóm cấu trúc'),
    dimensions: L('dimensions', 'chiều phân tích'), dimensionMembers: L('dimension members', 'thành phần chiều'), scenarios: L('scenarios', 'kịch bản'), units: L('units', 'đơn vị'),
  },
};

/**
 * @param {ReturnType<typeof exportSource>} source
 * @param {Array<{ key: string, fields: string[] }>} selection datasets and fields, in order
 * @returns {Promise<{ bytes: Uint8Array, sheets: Array<{ name, rows }> }>}
 */
export async function buildExportWorkbook(source, selection, { language = 'en', theme = null, cover = true, now = new Date() } = {}) {
  const lang = language === 'vi' ? 'vi' : 'en';
  const sheets = [];
  const summary = [];
  for (const sel of selection) {
    const dataset = EXPORT_DATASET_BY_KEY[sel.key];
    if (!dataset) continue;
    const fields = dataset.fields.filter((f) => !sel.fields || sel.fields.includes(f.key));
    if (!fields.length) continue;
    const rows = dataset.rows(source);
    const header = fields.map((f) => ({ v: pick(f.label, lang), s: 'header' }));
    const body = rows.map((r, i) => {
      const zebra = i % 2 === 1;
      const rowStyle = dataset.rowStyle ? dataset.rowStyle(r) : null;
      return fields.map((f) => {
        let v = f.pick(r);
        if (v == null) v = '';
        if (typeof v === 'boolean') v = v ? 'yes' : 'no';
        if (Array.isArray(v)) v = v.join('; ');
        const s = rowStyle || (f.wide ? 'wrap' : f.mono ? (zebra ? 'zebraMono' : 'mono') : zebra ? 'zebra' : 'default');
        return { v, s };
      });
    });
    const name = pick(dataset.label, lang);
    sheets.push({ name, rows: [header, ...body], freeze: { rows: 1 }, autoFilter: { row: 0 }, widths: fields.map((f) => (f.wide ? 48 : null)) });
    summary.push({ name, rows: rows.length, description: pick(dataset.description, lang) });
  }
  if (!sheets.length) throw new Error('Nothing selected to export');
  if (cover) sheets.unshift(coverSheet(source, summary, lang, now));
  const bytes = await writeWorkbook({ sheets, theme, title: pick(COVER.title, lang), now });
  return { bytes, sheets: summary };
}

function coverSheet(source, summary, lang, now) {
  const rows = [];
  const push = (...cells) => rows.push(cells);
  push({ v: pick(COVER.title, lang), s: 'title' });
  push({ v: `${pick(COVER.generated, lang)}: ${now.toISOString().slice(0, 16).replace('T', ' ')}`, s: 'muted' });
  push();
  push({ v: pick(COVER.sheets, lang), s: 'label' });
  const hyperlinks = [];
  for (const s of summary) {
    push({ v: s.name, s: 'link' }, { v: s.rows, s: 'default' }, { v: pick(COVER.rows, lang), s: 'muted' }, { v: s.description, s: 'wrap' });
    hyperlinks.push({ ref: `A${rows.length}`, sheet: s.name, display: s.name });
  }
  push();
  push({ v: pick(COVER.catalogue, lang), s: 'label' });
  for (const [collection, label] of Object.entries(COVER.counts)) push({ v: pick(label, lang), s: 'subtitle' }, { v: source.store.count(collection) });
  if (source.issues && source.issues.length) {
    push();
    push({ v: pick(COVER.quality, lang), s: 'label' });
    for (const sev of ['error', 'warning', 'info']) {
      const n = source.issues.filter((i) => i.severity === sev).length;
      push({ v: pick(COVER.severity[sev], lang), s: 'subtitle' }, { v: n, s: n && sev !== 'info' ? (sev === 'error' ? 'bad' : 'warn') : 'default' });
    }
  }
  return { name: lang === 'vi' ? 'Báo cáo' : 'Report', rows, widths: [26, 10, 8, 90], hyperlinks, gridLines: false };
}

/**
 * The Excel template: one sheet per kind of record, machine-readable column
 * keys in the header, a hint row, and example rows that show every typical
 * way of filling a row. The same sheet definitions drive reading a filled
 * template back (excel-import.js), so the template and the importer cannot
 * drift apart.
 *
 * Conventions the template teaches, and the importer honours:
 *   - Codes are the keys. A row whose code exists updates that record; any
 *     other row creates one. Blank cells keep an existing record's value.
 *   - `Skip` = x marks a row the importer ignores: the hint row and the
 *     examples are marked, so a template imported untouched imports nothing.
 *   - Lists (aliases, owners, structure codes…) are separated by ';'.
 */

import { BINDING_TYPES, BINDING_STATUSES, FORMULA_MODES } from '../core/models/binding.js';
import { METRIC_STATUSES } from '../core/models/metric.js';
import { writeWorkbook } from './xlsx.js';
import { referenceKey } from '../utils/text.js';

export const SKIP_COLUMN = 'Skip';
export const LIST_SEPARATOR = '; ';
const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];
const YES_NO = ['yes', 'no'];
const REPORT_KIND_LIST = ['folder', 'report'];

const L = (en, vi) => ({ en, vi });

/**
 * @typedef {{ key: string, required?: boolean, hint: {en,vi}, list?: string[], mono?: boolean, wide?: boolean, numeric?: boolean }} TemplateColumn
 */
export const TEMPLATE_SHEETS = [
  {
    key: 'units', name: 'Units', title: L('Units', 'Đơn vị'),
    description: L('Units of measure metrics refer to by code.', 'Đơn vị đo mà chỉ tiêu tham chiếu theo mã.'),
    columns: [
      { key: 'Code', required: true, mono: true, hint: L('Unique unit code, e.g. VND, PCT', 'Mã đơn vị duy nhất, ví dụ VND, PCT') },
      { key: 'Name', required: true, hint: L('Display name', 'Tên hiển thị') },
    ],
    examples: [['VND', 'Đồng Việt Nam'], ['PCT', 'Percent']],
  },
  {
    key: 'scenarios', name: 'Scenarios', title: L('Scenarios', 'Kịch bản'),
    description: L('Scenarios a metric can be bound in (Actual, Planning…). Code: a letter, then up to 7 letters, digits or underscores.', 'Kịch bản mà chỉ tiêu được gắn (Thực tế, Kế hoạch…). Mã: một chữ cái, rồi tối đa 7 chữ/số/gạch dưới.'),
    columns: [
      { key: 'Code', required: true, mono: true, hint: L('Short code used in formulas: [TT:REVENUE]', 'Mã ngắn dùng trong công thức: [TT:REVENUE]') },
      { key: 'Name', required: true, hint: L('Display name', 'Tên hiển thị') },
      { key: 'Description', wide: true, hint: L('Optional', 'Không bắt buộc') },
      { key: 'Sort_Order', numeric: true, hint: L('Number; lower comes first', 'Số; nhỏ hơn xếp trước') },
    ],
    examples: [['TT', 'Thực tế / Actual', 'What actually happened', 1], ['GD', 'Giả định / Planning', 'The planning assumption', 2]],
  },
  {
    key: 'structure', name: 'Structure', title: L('Structure', 'Cấu trúc'),
    description: L('Groups of the governance hierarchy. Parent_Code nests a group under another; leave it blank for a top-level group.', 'Các nhóm trong cây phân cấp. Parent_Code đặt nhóm dưới nhóm khác; để trống nếu là nhóm cấp cao nhất.'),
    columns: [
      { key: 'Code', required: true, mono: true, hint: L('Unique group code', 'Mã nhóm duy nhất') },
      { key: 'Name', required: true, hint: L('Group name', 'Tên nhóm') },
      { key: 'Parent_Code', mono: true, hint: L('Code of the parent group, or blank', 'Mã nhóm cha, hoặc để trống') },
      { key: 'Owner', hint: L('Optional', 'Không bắt buộc') },
      { key: 'Description', wide: true, hint: L('Optional', 'Không bắt buộc') },
      { key: 'Sort_Order', numeric: true, hint: L('Number; lower comes first among siblings', 'Số; nhỏ hơn xếp trước trong cùng cấp') },
    ],
    examples: [['KD', 'Kinh doanh', '', 'Sales lead', 'Commercial metrics', 1], ['KD_DT', 'Doanh thu', 'KD', '', 'Revenue group under Kinh doanh', 1]],
  },
  {
    key: 'reports', name: 'Reports', title: L('Reports', 'Báo cáo'),
    description: L('Report folders and reports: where metrics are shown. Kind is folder or report; Parent_Code nests an item under a folder. Link metrics with Report_Codes on the Metrics sheet or rows on Report_Metrics.', 'Thư mục và báo cáo: nơi chỉ tiêu được hiển thị. Kind là folder hoặc report; Parent_Code đặt mục dưới một thư mục. Liên kết chỉ tiêu bằng Report_Codes ở sheet Metrics hoặc các dòng ở Report_Metrics.'),
    columns: [
      { key: 'Code', required: true, mono: true, hint: L('Unique report code', 'Mã báo cáo duy nhất') },
      { key: 'Name', required: true, hint: L('Folder or report name', 'Tên thư mục hoặc báo cáo') },
      { key: 'Kind', list: REPORT_KIND_LIST, hint: L('folder or report (blank = report)', 'folder hoặc report (trống = report)') },
      { key: 'Parent_Code', mono: true, hint: L('Code of the parent folder, or blank', 'Mã thư mục cha, hoặc để trống') },
      { key: 'Owner', hint: L('Optional', 'Không bắt buộc') },
      { key: 'Description', wide: true, hint: L('Optional', 'Không bắt buộc') },
      { key: 'Sort_Order', numeric: true, hint: L('Number; lower comes first among siblings', 'Số; nhỏ hơn xếp trước trong cùng cấp') },
    ],
    examples: [['BOD', 'Board reports', 'folder', '', 'Planning', 'Everything the board reads', 1], ['BOD_M', 'Monthly BOD pack', 'report', 'BOD', 'Planning', 'Revenue, cost, margin and the main operating KPIs', 1]],
  },
  {
    key: 'metrics', name: 'Metrics', title: L('Metrics', 'Chỉ tiêu'),
    description: L('One row per metric. Structure_Codes and Dimension_Codes take several codes separated by ";" — the first structure code is the primary placement.', 'Mỗi dòng một chỉ tiêu. Structure_Codes và Dimension_Codes nhận nhiều mã cách nhau bằng ";" — mã cấu trúc đầu tiên là vị trí chính.'),
    columns: [
      { key: 'Code', required: true, mono: true, hint: L('Unique metric code; used in formulas as [CODE]', 'Mã chỉ tiêu duy nhất; dùng trong công thức là [MÃ]') },
      { key: 'Name', required: true, hint: L('Display name', 'Tên hiển thị') },
      { key: 'Aliases', hint: L('Other names, separated by ";"', 'Tên gọi khác, cách nhau bằng ";"') },
      { key: 'Unit_Code', mono: true, hint: L('A code from the Units sheet', 'Một mã trong sheet Units') },
      { key: 'Status', list: METRIC_STATUSES, hint: L('draft, approved or deprecated', 'draft, approved hoặc deprecated') },
      { key: 'Owners', hint: L('People or teams, separated by ";"', 'Người hoặc đơn vị, cách nhau bằng ";"') },
      { key: 'Tags', hint: L('Free tags, separated by ";"', 'Nhãn tự do, cách nhau bằng ";"') },
      { key: 'Definition', wide: true, hint: L('What the metric measures and how', 'Chỉ tiêu đo gì và đo thế nào') },
      { key: 'Structure_Codes', mono: true, hint: L('Group codes from the Structure sheet, ";"-separated; first = primary. Replaces the current placements when filled.', 'Mã nhóm trong sheet Structure, cách nhau bằng ";"; mã đầu là vị trí chính. Khi điền sẽ thay thế vị trí hiện có.') },
      { key: 'Dimension_Codes', mono: true, hint: L('Dimension codes the metric can be sliced by, ";"-separated. Replaces the current links when filled.', 'Mã chiều mà chỉ tiêu có thể phân tích, cách nhau bằng ";". Khi điền sẽ thay thế liên kết hiện có.') },
      { key: 'Report_Codes', mono: true, hint: L('Report codes from the Reports sheet (reports, not folders), ";"-separated. Replaces the current report links when filled.', 'Mã báo cáo trong sheet Reports (báo cáo, không phải thư mục), cách nhau bằng ";". Khi điền sẽ thay thế liên kết báo cáo hiện có.') },
    ],
    examples: [
      ['REVENUE', 'Doanh thu', 'DT; Rev', 'VND', 'approved', 'Sales lead; Finance', 'kpi', 'Net revenue from completed trips in the period, before VAT.', 'KD_DT', 'PRODUCT; CHANNEL', 'BOD_M'],
      ['VOLUME', 'Sản lượng', 'SL', '', 'approved', 'Ops lead', '', 'Completed trips in the period.', 'KD', 'PRODUCT', 'BOD_M'],
      ['PRICE', 'Giá bình quân', '', 'VND', 'draft', '', '', 'Average fare per completed trip.', 'KD_DT', '', ''],
      ['UTILIZATION', 'Hiệu suất sử dụng xe', '', 'PCT', 'draft', 'Fleet', '', 'Trips per vehicle against SOP capacity.', 'KD', '', ''],
    ],
  },
  {
    key: 'bindings', name: 'Bindings', title: L('Bindings', 'Gắn kịch bản'),
    description: L('How a metric gets its value in one scenario: exactly one row per Metric_Code × Scenario_Code. Fill the columns of the Type you chose; the others stay blank.', 'Cách chỉ tiêu có giá trị trong một kịch bản: đúng một dòng cho mỗi Metric_Code × Scenario_Code. Điền các cột của Type đã chọn; các cột khác để trống.'),
    columns: [
      { key: 'Metric_Code', required: true, mono: true, hint: L('A code from the Metrics sheet or already in the catalogue', 'Mã trong sheet Metrics hoặc đã có trong danh mục') },
      { key: 'Scenario_Code', required: true, mono: true, hint: L('A scenario code', 'Mã kịch bản') },
      { key: 'Type', required: true, list: BINDING_TYPES, hint: L('source, formula, assumption or none', 'source, formula, assumption hoặc none') },
      { key: 'Formula', mono: true, wide: true, hint: L('For formula: [VOLUME] * [PRICE]; cross-scenario [TT:REVENUE]', 'Cho formula: [VOLUME] * [PRICE]; chéo kịch bản [TT:REVENUE]') },
      { key: 'Formula_Mode', list: FORMULA_MODES, hint: L('expression (checked, default) or text (a description in words; rare; always a warning)', 'expression (được kiểm tra, mặc định) hoặc text (mô tả bằng lời; hiếm dùng; luôn có cảnh báo)') },
      { key: 'Source_System', hint: L('For source: ERP, CRM, PMS…', 'Cho source: ERP, CRM, PMS…') },
      { key: 'Source_Dataset', hint: L('For source: table or dataset', 'Cho source: bảng hoặc tập dữ liệu') },
      { key: 'Source_Field', mono: true, hint: L('For source: field or column', 'Cho source: trường hoặc cột') },
      { key: 'Source_Owner', hint: L('For source: data owner', 'Cho source: người phụ trách dữ liệu') },
      { key: 'Source_Frequency', list: FREQUENCIES, hint: L('daily, weekly, monthly, quarterly, yearly', 'daily, weekly, monthly, quarterly, yearly') },
      { key: 'Assumption_Value', hint: L('For assumption: the value, as text', 'Cho assumption: giá trị, dạng chữ') },
      { key: 'Assumption_Basis', wide: true, hint: L('For assumption: where the number comes from', 'Cho assumption: con số lấy từ đâu') },
      { key: 'Valid_From', hint: L('For assumption: e.g. 2027-01', 'Cho assumption: ví dụ 2027-01') },
      { key: 'Valid_To', hint: L('For assumption: e.g. 2027-12', 'Cho assumption: ví dụ 2027-12') },
      { key: 'Legacy_Code', mono: true, hint: L('Code from an older workbook; metadata only', 'Mã từ file cũ; chỉ là siêu dữ liệu') },
      { key: 'Status', list: BINDING_STATUSES, hint: L('draft or approved', 'draft hoặc approved') },
      { key: 'Note', wide: true, hint: L('Optional', 'Không bắt buộc') },
    ],
    examples: [
      ['REVENUE', 'TT', 'formula', '[VOLUME] * [PRICE]', 'expression', '', '', '', '', '', '', '', '', '', 'TT-KD001', 'approved', ''],
      ['REVENUE', 'GD', 'formula', '[TT:REVENUE] * (1 + [GROWTH_RATE])', 'expression', '', '', '', '', '', '', '', '', '', 'GD-KD001', 'draft', 'Plan = last actual × (1 + growth)'],
      ['VOLUME', 'TT', 'source', '', '', 'Ops Platform', 'trips', 'completed_trips', 'Ops data team', 'monthly', '', '', '', '', 'TT-VH010', 'approved', ''],
      ['PRICE', 'GD', 'assumption', '', '', '', '', '', '', '', '95000', 'Approved 2027 price list (+5% vs 2026)', '2027-01', '2027-12', 'GD-KD003', 'approved', ''],
      ['UTILIZATION', 'GD', 'formula', 'Per the SOP v3 productivity table: [TRIPS_PER_VEHICLE] against [TT:TRIP_CAPACITY], seasonally adjusted (appendix 2)', 'text', '', '', '', '', '', '', '', '', '', '', 'draft', 'Free-text formula: rare, always a warning'],
      ['PRICE', 'TT', 'none', '', '', '', '', '', '', '', '', '', '', '', '', 'draft', 'Explicitly no binding yet'],
    ],
  },
  {
    key: 'dimensions', name: 'Dimensions', title: L('Dimensions', 'Chiều phân tích'),
    description: L('Axes a metric can be sliced by.', 'Các trục mà chỉ tiêu có thể phân tích theo.'),
    columns: [
      { key: 'Code', required: true, mono: true, hint: L('Unique dimension code', 'Mã chiều duy nhất') },
      { key: 'Name', required: true, hint: L('Display name', 'Tên hiển thị') },
      { key: 'Description', wide: true, hint: L('Optional', 'Không bắt buộc') },
      { key: 'Sort_Order', numeric: true, hint: L('Number; lower comes first', 'Số; nhỏ hơn xếp trước') },
    ],
    examples: [['PRODUCT', 'Sản phẩm', 'Product line', 1], ['CHANNEL', 'Kênh', 'Sales channel', 2]],
  },
  {
    key: 'members', name: 'Members', title: L('Dimension members', 'Thành phần chiều'),
    description: L('Members of a dimension, with an optional parent for hierarchies. Codes are unique within their dimension.', 'Thành phần của một chiều, có thể có cha để tạo phân cấp. Mã là duy nhất trong từng chiều.'),
    columns: [
      { key: 'Dimension_Code', required: true, mono: true, hint: L('A code from the Dimensions sheet', 'Một mã trong sheet Dimensions') },
      { key: 'Code', required: true, mono: true, hint: L('Member code, unique in the dimension', 'Mã thành phần, duy nhất trong chiều') },
      { key: 'Name', required: true, hint: L('Display name', 'Tên hiển thị') },
      { key: 'Parent_Code', mono: true, hint: L('Code of the parent member in the same dimension, or blank', 'Mã thành phần cha trong cùng chiều, hoặc để trống') },
      { key: 'Aliases', hint: L('Other names, separated by ";"', 'Tên gọi khác, cách nhau bằng ";"') },
      { key: 'Sort_Order', numeric: true, hint: L('Number; lower comes first among siblings', 'Số; nhỏ hơn xếp trước trong cùng cấp') },
    ],
    examples: [['PRODUCT', 'ALL', 'Tất cả sản phẩm', '', '', 1], ['PRODUCT', 'HRC', 'HRC', 'ALL', 'Hot rolled coil', 1], ['PRODUCT', 'CRC', 'CRC', 'ALL', '', 2], ['CHANNEL', 'ONLINE', 'Online', '', 'Web; App', 1]],
  },
  {
    key: 'metricDimensions', name: 'Metric_Dimensions', title: L('Metric × dimension links', 'Liên kết chỉ tiêu × chiều'),
    description: L('Optional detail for a metric ↔ dimension link: whether the slice is required, how deep it may go, which members are allowed. Dimension_Codes on the Metrics sheet is enough for a plain link.', 'Chi tiết tuỳ chọn cho liên kết chỉ tiêu ↔ chiều: bắt buộc hay không, sâu đến cấp nào, thành phần nào được phép. Với liên kết đơn giản, cột Dimension_Codes ở sheet Metrics là đủ.'),
    columns: [
      { key: 'Metric_Code', required: true, mono: true, hint: L('A metric code', 'Mã chỉ tiêu') },
      { key: 'Dimension_Code', required: true, mono: true, hint: L('A dimension code', 'Mã chiều') },
      { key: 'Required', list: YES_NO, hint: L('yes if every value of the metric must be sliced by this dimension', 'yes nếu mọi giá trị của chỉ tiêu phải phân tích theo chiều này') },
      { key: 'Max_Level', numeric: true, hint: L('Deepest member level allowed, or blank', 'Cấp thành phần sâu nhất được phép, hoặc để trống') },
      { key: 'Allowed_Member_Codes', mono: true, hint: L('Member codes allowed, ";"-separated, or blank for all', 'Mã thành phần được phép, cách nhau bằng ";", hoặc để trống nếu tất cả') },
    ],
    examples: [['REVENUE', 'PRODUCT', 'yes', 2, 'HRC; CRC'], ['REVENUE', 'CHANNEL', 'no', '', '']],
  },
  {
    key: 'reportMetrics', name: 'Report_Metrics', title: L('Report contents', 'Nội dung báo cáo'),
    description: L('One row per metric shown in a report, in the order the report lists them. Report_Codes on the Metrics sheet is enough for a plain link; this sheet adds order and a note, and reads naturally report by report.', 'Mỗi dòng một chỉ tiêu hiển thị trong một báo cáo, theo thứ tự báo cáo liệt kê. Cột Report_Codes ở sheet Metrics đủ cho liên kết đơn giản; sheet này thêm thứ tự và ghi chú, và đọc tự nhiên theo từng báo cáo.'),
    columns: [
      { key: 'Report_Code', required: true, mono: true, hint: L('A report code (not a folder)', 'Mã báo cáo (không phải thư mục)') },
      { key: 'Metric_Code', required: true, mono: true, hint: L('A metric code', 'Mã chỉ tiêu') },
      { key: 'Sort_Order', numeric: true, hint: L('Number; lower comes first in the report', 'Số; nhỏ hơn xếp trước trong báo cáo') },
      { key: 'Note', wide: true, hint: L('Optional: how the metric is presented in this report', 'Không bắt buộc: cách trình bày chỉ tiêu trong báo cáo này') },
    ],
    examples: [['BOD_M', 'REVENUE', 1, 'Headline number, with YoY'], ['BOD_M', 'VOLUME', 2, '']],
  },
];

export const TEMPLATE_SHEET_BY_KEY = Object.fromEntries(TEMPLATE_SHEETS.map((s) => [s.key, s]));

/** Header text of a column: the key, with a star on required ones. */
export function columnHeader(col) {
  return col.required ? `${col.key} *` : col.key;
}

/** Column key for a header as read back, tolerant of stars, case, spaces and underscores. */
export function normalizeHeader(text) {
  return String(text == null ? '' : text).replace(/\*/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function pick(text, language) {
  if (!text) return '';
  return text[language] || text.en || '';
}

// ------------------------------------------------------------------ rows from the catalogue
/**
 * The catalogue as template rows: one object per record, keyed by column
 * key, ids resolved to codes. What "Download template with my data" fills
 * in, and what the Excel export starts from.
 */
export function catalogueRows(store) {
  const unitCode = new Map(store.list('units').map((u) => [u.id, u.code]));
  const nodeCode = new Map(store.list('structureNodes').map((n) => [n.id, n.code || n.name]));
  const dimCode = new Map(store.list('dimensions').map((d) => [d.id, d.code]));
  const memberCode = new Map(store.list('dimensionMembers').map((m) => [m.id, m.code]));
  const metricCode = new Map(store.list('metrics').map((m) => [m.id, m.code || m.name]));
  const scenarioCode = new Map(store.list('scenarios').map((s) => [s.id, s.code]));
  const join = (list) => (list || []).filter(Boolean).join(LIST_SEPARATOR);
  const byMetricPlacements = new Map();
  for (const p of [...store.list('metricStructures')].sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0) || a.sortOrder - b.sortOrder)) {
    if (!byMetricPlacements.has(p.metricId)) byMetricPlacements.set(p.metricId, []);
    byMetricPlacements.get(p.metricId).push(nodeCode.get(p.structureNodeId));
  }
  const byMetricDims = new Map();
  for (const l of store.list('metricDimensions')) {
    if (!byMetricDims.has(l.metricId)) byMetricDims.set(l.metricId, []);
    byMetricDims.get(l.metricId).push(dimCode.get(l.dimensionId));
  }
  const reportCode = new Map(store.list('reports').map((r) => [r.id, r.code || r.name]));
  const reportName = new Map(store.list('reports').map((r) => [r.id, r.name]));
  const reportById = new Map(store.list('reports').map((r) => [r.id, r]));
  const byMetricReports = new Map();
  for (const l of [...store.list('metricReports')].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (!byMetricReports.has(l.metricId)) byMetricReports.set(l.metricId, []);
    byMetricReports.get(l.metricId).push(reportCode.get(l.reportId));
  }
  const reportPath = (id) => {
    const parts = [];
    const guard = new Set();
    let cur = reportById.get(id);
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      parts.unshift(cur.name || cur.code);
      cur = cur.parentId ? reportById.get(cur.parentId) : null;
    }
    return parts.join(' › ');
  };
  const unitName = new Map(store.list('units').map((u) => [u.id, u.name]));
  const nodeById = new Map(store.list('structureNodes').map((n) => [n.id, n]));
  const nodePath = (id) => {
    const parts = [];
    const guard = new Set();
    let cur = nodeById.get(id);
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      parts.unshift(cur.name || cur.code);
      cur = cur.parentId ? nodeById.get(cur.parentId) : null;
    }
    return parts.join(' › ');
  };
  const primaryNode = new Map();
  for (const p of store.list('metricStructures')) if (p.isPrimary || !primaryNode.has(p.metricId)) primaryNode.set(p.metricId, p.structureNodeId);
  const dimName = new Map(store.list('dimensions').map((d) => [d.id, d.name]));
  const metricName = new Map(store.list('metrics').map((m) => [m.id, m.name]));
  const scenarioName = new Map(store.list('scenarios').map((s) => [s.id, s.name]));
  const sortCode = (a, b) => String(a.Code || '').localeCompare(String(b.Code || ''), undefined, { numeric: true });
  return {
    units: store.list('units').map((u) => ({ id: u.id, Code: u.code, Name: u.name })).sort(sortCode),
    scenarios: [...store.list('scenarios')].sort((a, b) => a.sortOrder - b.sortOrder).map((s) => ({ id: s.id, Code: s.code, Name: s.name, Description: s.description, Sort_Order: s.sortOrder })),
    structure: [...store.list('structureNodes')].sort((a, b) => a.sortOrder - b.sortOrder || String(a.code).localeCompare(String(b.code))).map((n) => ({ id: n.id, Code: n.code, Name: n.name, Parent_Code: n.parentId ? nodeCode.get(n.parentId) || '' : '', Parent_Name: n.parentId && nodeById.get(n.parentId) ? nodeById.get(n.parentId).name : '', Path: nodePath(n.id), Owner: n.owner, Description: n.description, Sort_Order: n.sortOrder })),
    metrics: store.list('metrics').map((m) => ({
      id: m.id, Code: m.code, Name: m.name, Aliases: join(m.aliases), Unit_Code: m.unitId ? unitCode.get(m.unitId) || '' : '', Unit_Name: m.unitId ? unitName.get(m.unitId) || '' : '', Status: m.status, Owners: join(m.owners), Tags: join(m.tags), Definition: m.definition,
      Structure_Codes: join(byMetricPlacements.get(m.id)), Structure_Path: primaryNode.has(m.id) ? nodePath(primaryNode.get(m.id)) : '', Dimension_Codes: join(byMetricDims.get(m.id)), Report_Codes: join(byMetricReports.get(m.id)), Updated_At: m.updatedAt,
    })).sort(sortCode),
    reports: [...store.list('reports')].sort((a, b) => reportPath(a.id).localeCompare(reportPath(b.id)) || a.sortOrder - b.sortOrder).map((r) => ({ id: r.id, Code: r.code, Name: r.name, Kind: r.kind, Parent_Code: r.parentId ? reportCode.get(r.parentId) || '' : '', Parent_Name: r.parentId ? reportName.get(r.parentId) || '' : '', Path: reportPath(r.id), Owner: r.owner, Description: r.description, Sort_Order: r.sortOrder })),
    reportMetrics: store.list('metricReports').map((l) => ({
      id: l.id, Report_Code: reportCode.get(l.reportId) || '', Report_Name: reportName.get(l.reportId) || '', Report_Path: reportPath(l.reportId), Metric_Code: metricCode.get(l.metricId) || '', Metric_Name: metricName.get(l.metricId) || '', Sort_Order: l.sortOrder, Note: l.note,
    })).sort((a, b) => String(a.Report_Path).localeCompare(String(b.Report_Path)) || a.Sort_Order - b.Sort_Order || String(a.Metric_Code).localeCompare(String(b.Metric_Code), undefined, { numeric: true })),
    bindings: store.list('bindings').map((b) => ({
      id: b.id, Metric_Code: metricCode.get(b.metricId) || b.metricId, Metric_Name: metricName.get(b.metricId) || '', Scenario_Code: scenarioCode.get(b.scenarioId) || b.scenarioId, Scenario_Name: scenarioName.get(b.scenarioId) || '', Type: b.type,
      Formula: b.type === 'formula' ? b.formulaText : '', Formula_Mode: b.type === 'formula' ? b.formulaMode || 'expression' : '',
      Source_System: b.source.system, Source_Dataset: b.source.dataset, Source_Field: b.source.field, Source_Owner: b.source.owner, Source_Frequency: b.source.frequency,
      Assumption_Value: b.assumption.value, Assumption_Basis: b.assumption.basis, Valid_From: b.assumption.validFrom, Valid_To: b.assumption.validTo,
      Legacy_Code: b.legacyCode, Status: b.status, Note: b.note, Updated_At: b.updatedAt,
    })).sort((a, b) => String(a.Metric_Code).localeCompare(String(b.Metric_Code), undefined, { numeric: true }) || String(a.Scenario_Code).localeCompare(String(b.Scenario_Code))),
    dimensions: [...store.list('dimensions')].sort((a, b) => a.sortOrder - b.sortOrder || String(a.code).localeCompare(String(b.code))).map((d) => ({ id: d.id, Code: d.code, Name: d.name, Description: d.description, Sort_Order: d.sortOrder })),
    members: [...store.list('dimensionMembers')].sort((a, b) => String(dimCode.get(a.dimensionId)).localeCompare(String(dimCode.get(b.dimensionId))) || a.level - b.level || a.sortOrder - b.sortOrder).map((m) => ({
      id: m.id, Dimension_Code: dimCode.get(m.dimensionId) || '', Dimension_Name: dimName.get(m.dimensionId) || '', Code: m.code, Name: m.name, Parent_Code: m.parentId ? memberCode.get(m.parentId) || '' : '', Aliases: join(m.aliases), Sort_Order: m.sortOrder, Level: m.level,
    })),
    metricDimensions: store.list('metricDimensions').map((l) => ({
      id: l.id, Metric_Code: metricCode.get(l.metricId) || '', Metric_Name: metricName.get(l.metricId) || '', Dimension_Code: dimCode.get(l.dimensionId) || '', Dimension_Name: dimName.get(l.dimensionId) || '', Required: l.required ? 'yes' : 'no', Max_Level: l.maxLevel == null ? '' : l.maxLevel,
      Allowed_Member_Codes: l.allowedMemberIds ? join(l.allowedMemberIds.map((id) => memberCode.get(id))) : '',
    })).sort((a, b) => String(a.Metric_Code).localeCompare(String(b.Metric_Code), undefined, { numeric: true }) || String(a.Dimension_Code).localeCompare(String(b.Dimension_Code))),
  };
}

// ------------------------------------------------------------------ the template workbook
const README = {
  title: L('Metric Studio — import template', 'Metric Studio — mẫu nhập liệu'),
  intro: L('Fill the sheets, then import the file in Import / Export → Import from Excel. Preview first; nothing changes until you confirm, and a restore point is taken before the import.', 'Điền các sheet, rồi nhập file tại Nhập / Xuất → Nhập từ Excel. Xem trước rồi mới xác nhận; không gì thay đổi cho đến khi bạn đồng ý, và một điểm khôi phục được tạo trước khi nhập.'),
  rules: [
    L('Row 1 of every sheet holds the column keys; a star marks a required column. Row 2 explains each column. Do not rename the columns.', 'Dòng 1 của mỗi sheet là khoá cột; dấu sao là cột bắt buộc. Dòng 2 giải thích từng cột. Không đổi tên cột.'),
    L('Rows with x in the Skip column are ignored — the hint row and the shaded example rows are already marked. Leave Skip empty on your own rows.', 'Dòng có x ở cột Skip sẽ bị bỏ qua — dòng gợi ý và các dòng ví dụ tô màu đã được đánh dấu. Để trống Skip ở dòng của bạn.'),
    L('Codes are the keys. A row whose code already exists updates that record; any other row creates a new one. Blank cells keep an existing record\'s value.', 'Mã là khoá. Dòng có mã đã tồn tại sẽ cập nhật bản ghi đó; dòng khác sẽ tạo mới. Ô trống giữ nguyên giá trị hiện có.'),
    L('Lists — aliases, owners, tags, structure codes, dimension codes — are separated by ";". To clear a value of an existing record, write a single dash: -', 'Danh sách — tên khác, người phụ trách, nhãn, mã cấu trúc, mã chiều — cách nhau bằng ";". Để xoá một giá trị của bản ghi đã có, ghi một dấu gạch ngang: -'),
    L('References inside formulas are written in brackets: [CODE], [ALIAS] or [Exact name]; another scenario\'s value is [TT:CODE]. A formula that cannot be an expression may be marked text in Formula_Mode: it is allowed, never checked, and always reported as a warning.', 'Tham chiếu trong công thức viết trong ngoặc vuông: [MÃ], [TÊN KHÁC] hoặc [Tên đầy đủ]; giá trị của kịch bản khác là [TT:MÃ]. Công thức không viết được thành biểu thức có thể đánh dấu text ở Formula_Mode: được phép, không kiểm tra, và luôn có cảnh báo.'),
    L('Sheets are read in this order: Units, Scenarios, Structure, Reports, Dimensions, Members, Metrics, Bindings, Metric_Dimensions, Report_Metrics — so a code defined earlier in the file can be used later in it.', 'Các sheet được đọc theo thứ tự: Units, Scenarios, Structure, Reports, Dimensions, Members, Metrics, Bindings, Metric_Dimensions, Report_Metrics — nên mã định nghĩa ở sheet trước dùng được ở sheet sau.'),
  ],
  sheets: L('Sheets', 'Các sheet'),
  reference: L('Codes already in your catalogue', 'Mã đã có trong danh mục của bạn'),
  generated: L('Generated', 'Tạo lúc'),
  withData: L('This template is filled with your current catalogue: edit rows, add new ones below, and import it back.', 'Mẫu này đã điền sẵn danh mục hiện tại: sửa các dòng, thêm dòng mới bên dưới, rồi nhập lại.'),
  blank: L('Fill your rows under the examples on each sheet.', 'Điền các dòng của bạn dưới các ví dụ ở mỗi sheet.'),
};

/**
 * @param {{ store: object, language?: 'en'|'vi', includeData?: boolean, theme?: object, now?: Date }} options
 * @returns {Promise<Uint8Array>}
 */
export async function buildTemplateWorkbook({ store, language = 'en', includeData = false, theme = null, now = new Date() }) {
  const lang = language === 'vi' ? 'vi' : 'en';
  const data = includeData ? catalogueRows(store) : null;
  const sheets = TEMPLATE_SHEETS.map((spec) => templateSheet(spec, lang, data ? data[spec.key] : null));
  const readme = readmeSheet(store, lang, includeData, now, sheets.map((s) => s.name));
  return writeWorkbook({ sheets: [readme, ...sheets], theme, title: pick(README.title, lang), now });
}

function templateSheet(spec, lang, rows) {
  const cols = [{ key: SKIP_COLUMN, hint: L('x = ignore this row', 'x = bỏ qua dòng này') }, ...spec.columns];
  const header = cols.map((c) => ({ v: c === cols[0] ? SKIP_COLUMN : columnHeader(c), s: c.required ? 'headerRequired' : 'header' }));
  const hint = cols.map((c, i) => ({ v: i === 0 ? 'x' : pick(c.hint, lang), s: 'hint' }));
  const examples = spec.examples.map((ex) => [{ v: 'x', s: 'example' }, ...spec.columns.map((c, i) => ({ v: ex[i] == null ? '' : ex[i], s: 'example' }))]);
  const filled = (rows || []).map((r) => ['', ...spec.columns.map((c) => cellStyle(c, r[c.key]))]);
  const widths = cols.map((c, i) => (i === 0 ? 6 : c.wide ? 44 : c.key.length > 12 ? Math.max(16, c.key.length + 2) : null));
  const validations = [];
  cols.forEach((c, i) => { if (c.list) validations.push({ col: i, fromRow: 2, list: c.list }); });
  return {
    name: spec.name,
    rows: [header, hint, ...examples, ...filled],
    widths,
    freeze: { rows: 2 },
    autoFilter: { row: 0 },
    validations,
  };
}

function cellStyle(col, value) {
  const v = value == null ? '' : value;
  if (col.mono) return { v, s: 'mono' };
  if (col.wide) return { v, s: 'wrap' };
  if (!col.numeric && typeof v === 'string' && /^[0-9+\-=@]/.test(v)) return { v, s: 'text' };
  return v;
}

function readmeSheet(store, lang, includeData, now, sheetNames) {
  const rows = [];
  const push = (...cells) => rows.push(cells);
  push({ v: pick(README.title, lang), s: 'title' });
  push({ v: pick(README.intro, lang), s: 'subtitle' });
  push({ v: `${pick(README.generated, lang)}: ${now.toISOString().slice(0, 16).replace('T', ' ')}`, s: 'muted' });
  push({ v: pick(includeData ? README.withData : README.blank, lang), s: 'subtitle' });
  push();
  README.rules.forEach((r, i) => push({ v: `${i + 1}.`, s: 'label' }, { v: pick(r, lang), s: 'wrap' }));
  push();
  push({ v: pick(README.sheets, lang), s: 'label' });
  const hyperlinks = [];
  TEMPLATE_SHEETS.forEach((spec, i) => {
    push({ v: sheetNames[i], s: 'link' }, { v: pick(spec.description, lang), s: 'wrap' });
    hyperlinks.push({ ref: `A${rows.length}`, sheet: sheetNames[i], display: sheetNames[i] });
  });
  const reference = [
    ['Scenarios', store.list('scenarios').map((s) => `${s.code} = ${s.name}`)],
    ['Units', store.list('units').map((u) => `${u.code} = ${u.name}`)],
    ['Dimensions', store.list('dimensions').map((d) => `${d.code} = ${d.name}`)],
  ].filter(([, list]) => list.length);
  if (reference.length) {
    push();
    push({ v: pick(README.reference, lang), s: 'label' });
    for (const [name, list] of reference) push({ v: name, s: 'label' }, { v: list.join('; '), s: 'wrap' });
  }
  return { name: 'README', rows, widths: [16, 110], hyperlinks, gridLines: false, tabColor: null };
}

/** Whether two codes name the same record (the same rule references use). */
export function sameCode(a, b) {
  return referenceKey(a) === referenceKey(b);
}

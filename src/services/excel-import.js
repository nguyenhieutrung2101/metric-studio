/**
 * Reading a filled template back into the catalogue.
 *
 * Three steps, each pure and testable on its own:
 *
 *   readTemplateWorkbook(workbook)      sheets → rows keyed by column
 *   planExcelImport(read, store)        rows → a full snapshot plus a plan:
 *                                       what is created, updated, unchanged,
 *                                       and every row that cannot be applied
 *   applyExcelImport(plan, backup)      the change set the plan implies, each
 *                                       record carrying the token it had when
 *                                       the file was previewed
 *
 * Codes are the keys and the current catalogue is the base: an Excel import
 * is an upsert by code, never a wipe. That is why it writes a change set and
 * not a snapshot. The whole-snapshot replace a JSON backup uses is right
 * when the file IS the catalogue; here the file is about some of the records
 * and says nothing about the rest, so replacing would delete whatever
 * another tab added while this one was reading the preview, and a token
 * nobody checked would overwrite what another tab edited. The plan is still
 * built as a whole snapshot, and still passes the same schema boundary; only
 * the difference between that snapshot and the catalogue it was planned on
 * is written. A row that cannot be resolved (unknown
 * parent, unknown scenario, an invalid status) is an error naming the sheet
 * and the row, and nothing is imported until the file is fixed — the same
 * stance the JSON boundary takes, with the row number the person needs.
 */

import { COLLECTIONS } from '../core/collections.js';
import { tokenOf } from '../repositories/repository.js';
import { createUnit } from '../core/models/unit.js';
import { createScenario, isValidScenarioCode } from '../core/models/scenario.js';
import { createStructureNode, createMetricStructure } from '../core/models/structure.js';
import { createReport, createMetricReport, ReportKind } from '../core/models/report.js';
import { createMetric, METRIC_STATUSES } from '../core/models/metric.js';
import { createBinding, BINDING_TYPES, BINDING_STATUSES, FORMULA_MODES, BindingType } from '../core/models/binding.js';
import { createDimension, createDimensionMember, createMetricDimension } from '../core/models/dimension.js';
import { parseSnapshot } from './snapshot-schema.js';
import { readWorkbook, isCellError } from './xlsx.js';
import { TEMPLATE_SHEETS, SKIP_COLUMN, normalizeHeader } from './excel-template.js';
import { referenceKey, splitList } from '../utils/text.js';
import { nowIso } from '../utils/time.js';
import { Store } from '../core/store/store.js';
import { createSelectors } from '../core/store/selectors.js';
import { resolveFormula } from './binding-service.js';

/** Writing this in a cell clears the field of an existing record. */
export const CLEAR = '-';
const FREQUENCIES = ['', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly'];

// ------------------------------------------------------------------ reading rows
/**
 * @param {{ sheets: Array<{ name, rows }> }} workbook from readWorkbook
 * @returns {{ sheets: Record<string, { rows: Array<{ row: number, values: object }>, headerRow: number, missingColumns: string[], unknownColumns: string[] }>, unknownSheets: string[] }}
 */
export function readTemplateWorkbook(workbook) {
  const specByName = new Map(TEMPLATE_SHEETS.map((s) => [normalizeHeader(s.name), s]));
  const sheets = {};
  const unknownSheets = [];
  for (const sheet of workbook.sheets || []) {
    const spec = specByName.get(normalizeHeader(sheet.name));
    if (!spec) {
      if (normalizeHeader(sheet.name) !== 'readme') unknownSheets.push(sheet.name);
      continue;
    }
    if (sheets[spec.key]) continue; // the first sheet of a kind wins; a second one is a copy someone left in
    sheets[spec.key] = readSheet(spec, sheet.rows || []);
  }
  return { sheets, unknownSheets };
}

function readSheet(spec, grid) {
  // Whether the sheet holds anything at all decides what "no header" means:
  // an emptied sheet is nothing to say, a sheet full of rows under headings
  // nobody recognises is a file that will not do what its author expects.
  const hasContent = grid.some((row) => (row || []).some((cell) => cell != null && String(cell).trim() !== ''));
  const keys = new Map(spec.columns.map((c) => [normalizeHeader(c.key), c.key]));
  keys.set(normalizeHeader(SKIP_COLUMN), SKIP_COLUMN);
  // The header is the first row that names at least two known columns — so
  // a title row someone added above it does no harm.
  let headerAt = -1;
  let map = null;
  for (let r = 0; r < Math.min(grid.length, 25); r += 1) {
    const m = [];
    let hits = 0;
    (grid[r] || []).forEach((cell, c) => {
      const key = keys.get(normalizeHeader(cell));
      if (key && !m.includes(key)) {
        m[c] = key;
        hits += 1;
      }
    });
    if (hits >= Math.min(2, spec.columns.length)) {
      headerAt = r;
      map = m;
      break;
    }
  }
  if (headerAt < 0) return { rows: [], headerRow: 0, missingColumns: spec.columns.filter((c) => c.required).map((c) => c.key), unknownColumns: [], cellErrors: [], noHeader: true, hasContent };
  const present = new Set(map.filter(Boolean));
  const missingColumns = spec.columns.filter((c) => c.required && !present.has(c.key)).map((c) => c.key);
  const unknownColumns = (grid[headerAt] || []).map((cell, c) => (!map[c] && cell != null && String(cell).trim() !== '' ? String(cell).trim() : null)).filter(Boolean);
  const rows = [];
  const cellErrors = [];
  for (let r = headerAt + 1; r < grid.length; r += 1) {
    const values = {};
    const broken = [];
    let any = false;
    (grid[r] || []).forEach((cell, c) => {
      const key = map[c];
      if (!key) return;
      if (isCellError(cell)) {
        // Content, so the row is not mistaken for an empty one, but never a
        // value: the planner refuses the file before anything is applied.
        broken.push({ row: r + 1, column: key, code: cell.code });
        if (key !== SKIP_COLUMN) any = true;
        return;
      }
      const v = cellValue(cell);
      if (v === undefined) return;
      values[key] = v;
      if (key !== SKIP_COLUMN) any = true;
    });
    if (!any) continue;
    if (values[SKIP_COLUMN] !== undefined) continue;
    cellErrors.push(...broken);
    rows.push({ row: r + 1, values });
  }
  return { rows, headerRow: headerAt + 1, missingColumns, unknownColumns, cellErrors, noHeader: false, hasContent };
}

function cellValue(cell) {
  if (cell == null) return undefined;
  if (typeof cell === 'string') {
    const s = cell.trim();
    return s === '' ? undefined : s;
  }
  if (typeof cell === 'boolean') return cell ? 'yes' : 'no';
  return cell;
}

// ------------------------------------------------------------------ planning
/**
 * @param {ReturnType<typeof readTemplateWorkbook>} read
 * @param {object} store the current catalogue
 * @returns {{ ok, errors, warnings, changes, snapshot, parsed, rowsRead, sheetsFound }}
 */
export function planExcelImport(read, store, { now = nowIso() } = {}) {
  const errors = [];
  const warnings = [];
  const snapshot = {};
  // The catalogue as it was when the file was read, by id: what the plan is
  // built on, what the plan is diffed against, and where every expected
  // token comes from.
  const before = {};
  for (const c of COLLECTIONS) {
    snapshot[c] = store.list(c).map((r) => JSON.parse(JSON.stringify(r)));
    before[c] = new Map(store.list(c).map((r) => [r.id, r]));
  }
  // What happened to each record, by id, so a record two sheets both touch
  // is counted once; `removed` counts links a replaced list no longer has.
  const state = {};
  const removed = {};
  for (const c of COLLECTIONS) {
    state[c] = new Map();
    removed[c] = 0;
  }
  const mark = (collection, id, what) => {
    const cur = state[collection].get(id);
    if (what === 'created') state[collection].set(id, 'created');
    else if (what === 'updated') { if (cur !== 'created') state[collection].set(id, 'updated'); }
    else if (!cur) state[collection].set(id, 'unchanged');
  };
  const summarize = () => {
    const out = {};
    for (const c of COLLECTIONS) {
      const counts = { created: 0, updated: 0, unchanged: 0, removed: removed[c] };
      for (const what of state[c].values()) counts[what] += 1;
      out[c] = counts;
    }
    return out;
  };
  const rowsRead = {};
  const sheetsFound = Object.keys(read.sheets);
  for (const name of read.unknownSheets || []) warnings.push({ code: 'UNKNOWN_SHEET', sheet: name, message: `Sheet "${name}" is not part of the template and was ignored` });
  for (const spec of TEMPLATE_SHEETS) {
    const sheet = read.sheets[spec.key];
    if (!sheet) continue;
    rowsRead[spec.key] = sheet.rows.length;
    for (const col of sheet.unknownColumns) warnings.push({ code: 'UNKNOWN_COLUMN', sheet: spec.name, message: `Column "${col}" on ${spec.name} is not part of the template and was ignored` });
    if (sheet.rows.length && sheet.missingColumns.length) {
      errors.push({ sheet: spec.name, row: sheet.headerRow, message: `Required column(s) missing: ${sheet.missingColumns.join(', ')}` });
    }
    // A sheet whose headings were renamed reads as a sheet with no rows. It
    // would import nothing and say nothing, which looks exactly like success.
    if (sheet.noHeader && sheet.hasContent) {
      errors.push({ sheet: spec.name, row: 1, message: `No header row recognised on ${spec.name}, so none of its rows were read. Row 1 must hold the column keys: ${spec.columns.map((c) => c.key).join(', ')}` });
    }
    // An Excel error is the author's own lookup that did not resolve. Reading
    // it as a blank would quietly keep the old value on that one field.
    for (const e of sheet.cellErrors || []) {
      errors.push({ sheet: spec.name, row: e.row, message: `Column ${e.column} holds the Excel error ${e.code}. Fix the formula in the workbook, or clear the cell to keep the current value` });
    }
  }
  if (!sheetsFound.length) {
    errors.push({ sheet: '', row: 0, message: `No template sheet found. Expected one or more of: ${TEMPLATE_SHEETS.map((s) => s.name).join(', ')}` });
    return { ok: false, errors, warnings, changes: summarize(), snapshot: null, parsed: null, rowsRead, sheetsFound };
  }
  if (errors.length) return { ok: false, errors, warnings, changes: summarize(), snapshot: null, parsed: null, rowsRead, sheetsFound };

  const factories = { units: createUnit, scenarios: createScenario, metrics: createMetric, structureNodes: createStructureNode, metricStructures: createMetricStructure, bindings: createBinding, dimensions: createDimension, dimensionMembers: createDimensionMember, metricDimensions: createMetricDimension, reports: createReport, metricReports: createMetricReport };
  const err = (spec, row, message) => errors.push({ sheet: spec.name, row, message });
  const rowsOf = (key) => (read.sheets[key] ? read.sheets[key].rows : []);

  /** Apply a patch (undefined = keep) to an existing record, or create one. */
  const upsert = (collection, existing, patch) => {
    if (!existing) {
      const rec = factories[collection]({ ...patch });
      rec.createdAt = now;
      rec.updatedAt = now;
      rec.version = 0;
      snapshot[collection].push(rec);
      mark(collection, rec.id, 'created');
      return rec;
    }
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (JSON.stringify(existing[k]) !== JSON.stringify(v)) {
        existing[k] = v;
        changed = true;
      }
    }
    if (changed) touch(existing, collection);
    else mark(collection, existing.id, 'unchanged');
    return existing;
  };

  /** A code index that reports duplicates instead of picking one. */
  const indexBy = (list, keyOf) => {
    const map = new Map();
    for (const rec of list) {
      const key = keyOf(rec);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(rec);
    }
    return map;
  };
  const codeKey = (v) => referenceKey(v);
  const lookup = (map, code, spec, row, what) => {
    const hits = map.get(codeKey(code)) || [];
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) err(spec, row, `${what} code "${code}" matches ${hits.length} existing records; make their codes unique first`);
    return null;
  };
  const remember = (map, rec, key) => {
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).includes(rec)) map.get(key).push(rec);
  };

  const units = indexBy(snapshot.units, (u) => codeKey(u.code));
  const scenarios = indexBy(snapshot.scenarios, (s) => codeKey(s.code));
  const nodes = indexBy(snapshot.structureNodes, (n) => codeKey(n.code));
  const dims = indexBy(snapshot.dimensions, (d) => codeKey(d.code));
  const metrics = indexBy(snapshot.metrics, (m) => codeKey(m.code));
  const members = indexBy(snapshot.dimensionMembers, (m) => `${m.dimensionId}|${codeKey(m.code)}`);
  const bindingsByPair = new Map(snapshot.bindings.map((b) => [`${b.metricId}|${b.scenarioId}`, b]));
  const toResolve = new Set();
  const linksByPair = new Map(snapshot.metricDimensions.map((l) => [`${l.metricId}|${l.dimensionId}`, l]));
  const reportsIdx = indexBy(snapshot.reports, (r) => codeKey(r.code));
  // Which row of the Reports sheet claimed which item, so a kind the file's
  // own contents contradict is reported on the row that asked for it.
  const reportRows = new Map();
  const reportLinksByPair = new Map(snapshot.metricReports.map((l) => [`${l.metricId}|${l.reportId}`, l]));

  const seenInFile = (spec) => {
    const seen = new Map();
    return (key, row) => {
      if (seen.has(key)) {
        err(spec, row, `Duplicate of row ${seen.get(key)} (same code)`);
        return true;
      }
      seen.set(key, row);
      return false;
    };
  };

  // ---- units
  {
    const spec = specOf('units');
    const dup = seenInFile(spec);
    for (const { row, values } of rowsOf('units')) {
      const code = text(values.Code);
      if (!code) { err(spec, row, 'Code is required'); continue; }
      if (dup(codeKey(code), row)) continue;
      const existing = lookup(units, code, spec, row, 'Unit');
      const name = text(values.Name);
      if (!existing && !name) { err(spec, row, 'Name is required for a new unit'); continue; }
      const rec = upsert('units', existing, { code, name });
      remember(units, rec, codeKey(code));
    }
  }
  // ---- scenarios
  {
    const spec = specOf('scenarios');
    const dup = seenInFile(spec);
    for (const { row, values } of rowsOf('scenarios')) {
      const code = text(values.Code) ? String(values.Code).trim().toUpperCase() : '';
      if (!code) { err(spec, row, 'Code is required'); continue; }
      if (!isValidScenarioCode(code)) { err(spec, row, `Scenario code "${code}" is not valid: a letter, then up to 7 letters, digits or underscores`); continue; }
      if (dup(codeKey(code), row)) continue;
      const existing = lookup(scenarios, code, spec, row, 'Scenario');
      const name = text(values.Name);
      if (!existing && !name) { err(spec, row, 'Name is required for a new scenario'); continue; }
      const sortOrder = number(values.Sort_Order, spec, row, 'Sort_Order');
      const rec = upsert('scenarios', existing, { code, name, description: text(values.Description), sortOrder });
      remember(scenarios, rec, codeKey(code));
    }
  }
  // ---- structure (parents in a second pass, so order in the sheet does not matter)
  {
    const spec = specOf('structure');
    const dup = seenInFile(spec);
    const pending = [];
    for (const { row, values } of rowsOf('structure')) {
      const code = text(values.Code);
      if (!code) { err(spec, row, 'Code is required'); continue; }
      if (dup(codeKey(code), row)) continue;
      const existing = lookup(nodes, code, spec, row, 'Structure');
      const name = text(values.Name);
      if (!existing && !name) { err(spec, row, 'Name is required for a new group'); continue; }
      const sortOrder = number(values.Sort_Order, spec, row, 'Sort_Order');
      const rec = upsert('structureNodes', existing, { code, name, owner: text(values.Owner), description: text(values.Description), sortOrder });
      remember(nodes, rec, codeKey(code));
      if (values.Parent_Code !== undefined) pending.push({ rec, existing, row, parentCode: String(values.Parent_Code).trim() });
    }
    for (const { rec, existing, row, parentCode } of pending) {
      let parentId = null;
      if (parentCode !== CLEAR) {
        const parent = lookup(nodes, parentCode, spec, row, 'Structure');
        if (!parent) { if (!errors.some((e) => e.sheet === spec.name && e.row === row)) err(spec, row, `Parent_Code "${parentCode}" does not match any group`); continue; }
        if (parent.id === rec.id) { err(spec, row, 'A group cannot be its own parent'); continue; }
        parentId = parent.id;
      }
      if (rec.parentId !== parentId) {
        rec.parentId = parentId;
        if (existing) touch(rec, 'structureNodes');
      }
    }
  }
  // ---- reports (folders and reports; parents in a second pass, like the structure)
  {
    const spec = specOf('reports');
    const dup = seenInFile(spec);
    const pending = [];
    for (const { row, values } of rowsOf('reports')) {
      const code = text(values.Code);
      if (!code) { err(spec, row, 'Code is required'); continue; }
      if (dup(codeKey(code), row)) continue;
      const existing = lookup(reportsIdx, code, spec, row, 'Report');
      const name = text(values.Name);
      if (!existing && !name) { err(spec, row, 'Name is required for a new report or folder'); continue; }
      const kindChoice = choice(values.Kind, ['folder', 'report'], spec, row, 'Kind');
      if (kindChoice === false) continue;
      const kind = kindChoice === '' ? ReportKind.REPORT : kindChoice;
      const sortOrder = number(values.Sort_Order, spec, row, 'Sort_Order');
      if (sortOrder === false) continue;
      const rec = upsert('reports', existing, { code, name, kind, owner: text(values.Owner), description: text(values.Description), sortOrder });
      remember(reportsIdx, rec, codeKey(code));
      reportRows.set(rec.id, row);
      if (values.Parent_Code !== undefined) pending.push({ rec, existing, row, parentCode: String(values.Parent_Code).trim() });
    }
    for (const { rec, existing, row, parentCode } of pending) {
      let parentId = null;
      if (parentCode !== CLEAR) {
        const parent = lookup(reportsIdx, parentCode, spec, row, 'Report');
        if (!parent) { if (!errors.some((e) => e.sheet === spec.name && e.row === row)) err(spec, row, `Parent_Code "${parentCode}" does not match any report folder`); continue; }
        if (parent.id === rec.id) { err(spec, row, 'An item cannot be its own parent'); continue; }
        if (parent.kind !== ReportKind.FOLDER) { err(spec, row, `Parent_Code "${parentCode}" is a report; only a folder can hold items`); continue; }
        parentId = parent.id;
      }
      if (rec.parentId !== parentId) {
        rec.parentId = parentId;
        if (existing) touch(rec, 'reports');
      }
    }
  }
  // ---- dimensions
  {
    const spec = specOf('dimensions');
    const dup = seenInFile(spec);
    for (const { row, values } of rowsOf('dimensions')) {
      const code = text(values.Code);
      if (!code) { err(spec, row, 'Code is required'); continue; }
      if (dup(codeKey(code), row)) continue;
      const existing = lookup(dims, code, spec, row, 'Dimension');
      const name = text(values.Name);
      if (!existing && !name) { err(spec, row, 'Name is required for a new dimension'); continue; }
      const sortOrder = number(values.Sort_Order, spec, row, 'Sort_Order');
      const rec = upsert('dimensions', existing, { code, name, description: text(values.Description), sortOrder });
      remember(dims, rec, codeKey(code));
    }
  }
  // ---- members
  {
    const spec = specOf('members');
    const dup = seenInFile(spec);
    const pending = [];
    for (const { row, values } of rowsOf('members')) {
      const dimCode = text(values.Dimension_Code);
      const code = text(values.Code);
      if (!dimCode || !code) { err(spec, row, 'Dimension_Code and Code are required'); continue; }
      const dim = lookup(dims, dimCode, spec, row, 'Dimension');
      if (!dim) { if (!errors.some((e) => e.sheet === spec.name && e.row === row)) err(spec, row, `Dimension_Code "${dimCode}" does not match any dimension`); continue; }
      const key = `${dim.id}|${codeKey(code)}`;
      if (dup(key, row)) continue;
      const existing = lookup(members, key, spec, row, 'Member');
      const name = text(values.Name);
      if (!existing && !name) { err(spec, row, 'Name is required for a new member'); continue; }
      const sortOrder = number(values.Sort_Order, spec, row, 'Sort_Order');
      const rec = upsert('dimensionMembers', existing, { dimensionId: dim.id, code, name, aliases: list(values.Aliases), sortOrder });
      remember(members, rec, key);
      if (values.Parent_Code !== undefined) pending.push({ rec, existing, row, dim, parentCode: String(values.Parent_Code).trim() });
    }
    for (const { rec, existing, row, dim, parentCode } of pending) {
      let parentId = null;
      if (parentCode !== CLEAR) {
        const parent = lookup(members, `${dim.id}|${codeKey(parentCode)}`, spec, row, 'Member');
        if (!parent) { if (!errors.some((e) => e.sheet === spec.name && e.row === row)) err(spec, row, `Parent_Code "${parentCode}" does not match any member of ${dim.code}`); continue; }
        if (parent.id === rec.id) { err(spec, row, 'A member cannot be its own parent'); continue; }
        parentId = parent.id;
      }
      if (rec.parentId !== parentId) {
        rec.parentId = parentId;
        if (existing) touch(rec, 'dimensionMembers');
      }
    }
    relevel(snapshot.dimensionMembers);
  }
  // ---- metrics, with their placements and dimension links
  {
    const spec = specOf('metrics');
    const dup = seenInFile(spec);
    for (const { row, values } of rowsOf('metrics')) {
      const code = text(values.Code);
      if (!code) { err(spec, row, 'Code is required'); continue; }
      if (dup(codeKey(code), row)) continue;
      const existing = lookup(metrics, code, spec, row, 'Metric');
      const name = text(values.Name);
      if (!existing && !name) { err(spec, row, 'Name is required for a new metric'); continue; }
      let unitId;
      if (values.Unit_Code !== undefined) {
        const unitCode = String(values.Unit_Code).trim();
        if (unitCode === CLEAR) unitId = null;
        else {
          const unit = lookup(units, unitCode, spec, row, 'Unit');
          if (!unit) { err(spec, row, `Unit_Code "${unitCode}" does not match any unit`); continue; }
          unitId = unit.id;
        }
      }
      const status = choice(values.Status, METRIC_STATUSES, spec, row, 'Status');
      if (status === false) continue;
      const rec = upsert('metrics', existing, { code, name, aliases: list(values.Aliases), unitId, status, owners: list(values.Owners), tags: list(values.Tags), definition: text(values.Definition) });
      remember(metrics, rec, codeKey(code));

      if (values.Structure_Codes !== undefined) {
        const codes = String(values.Structure_Codes).trim() === CLEAR ? [] : splitList(values.Structure_Codes);
        const targets = [];
        let bad = false;
        for (const c of codes) {
          const node = lookup(nodes, c, spec, row, 'Structure');
          if (!node) { err(spec, row, `Structure_Codes: "${c}" does not match any group`); bad = true; break; }
          if (!targets.includes(node)) targets.push(node);
        }
        if (!bad) replaceLinks('metricStructures', rec.id, targets, (node, i) => ({ metricId: rec.id, structureNodeId: node.id, isPrimary: i === 0 }), (l) => l.structureNodeId);
      }
      if (values.Dimension_Codes !== undefined) {
        const codes = String(values.Dimension_Codes).trim() === CLEAR ? [] : splitList(values.Dimension_Codes);
        const targets = [];
        let bad = false;
        for (const c of codes) {
          const dim = lookup(dims, c, spec, row, 'Dimension');
          if (!dim) { err(spec, row, `Dimension_Codes: "${c}" does not match any dimension`); bad = true; break; }
          if (!targets.includes(dim)) targets.push(dim);
        }
        if (!bad) replaceLinks('metricDimensions', rec.id, targets, (dim) => ({ metricId: rec.id, dimensionId: dim.id }), (l) => l.dimensionId);
      }
      if (values.Report_Codes !== undefined) {
        const codes = String(values.Report_Codes).trim() === CLEAR ? [] : splitList(values.Report_Codes);
        const targets = [];
        let bad = false;
        for (const c of codes) {
          const report = lookup(reportsIdx, c, spec, row, 'Report');
          if (!report) { err(spec, row, `Report_Codes: "${c}" does not match any report`); bad = true; break; }
          if (report.kind !== ReportKind.REPORT) { err(spec, row, `Report_Codes: "${c}" is a folder; metrics are linked to reports`); bad = true; break; }
          if (!targets.includes(report)) targets.push(report);
        }
        if (!bad) replaceLinks('metricReports', rec.id, targets, (report) => ({ metricId: rec.id, reportId: report.id }), (l) => l.reportId);
      }
    }
  }
  // ---- bindings
  {
    const spec = specOf('bindings');
    const dup = seenInFile(spec);
    for (const { row, values } of rowsOf('bindings')) {
      const metricCode = text(values.Metric_Code);
      const scenarioCode = text(values.Scenario_Code);
      if (!metricCode || !scenarioCode) { err(spec, row, 'Metric_Code and Scenario_Code are required'); continue; }
      const metric = lookup(metrics, metricCode, spec, row, 'Metric');
      if (!metric) { if (!errors.some((e) => e.sheet === spec.name && e.row === row)) err(spec, row, `Metric_Code "${metricCode}" does not match any metric`); continue; }
      const scenario = lookup(scenarios, scenarioCode, spec, row, 'Scenario');
      if (!scenario) { if (!errors.some((e) => e.sheet === spec.name && e.row === row)) err(spec, row, `Scenario_Code "${scenarioCode}" does not match any scenario`); continue; }
      const pair = `${metric.id}|${scenario.id}`;
      if (dup(pair, row)) continue;
      const existing = bindingsByPair.get(pair) || null;
      const type = choice(values.Type, BINDING_TYPES, spec, row, 'Type');
      if (type === false) continue;
      if (!existing && !type) { err(spec, row, 'Type is required for a new binding'); continue; }
      const effectiveType = type || existing.type;
      const status = choice(values.Status, BINDING_STATUSES, spec, row, 'Status');
      if (status === false) continue;
      const patch = { metricId: metric.id, scenarioId: scenario.id, type, status, legacyCode: text(values.Legacy_Code), note: text(values.Note) };
      if (effectiveType === BindingType.FORMULA) {
        const formulaText = text(values.Formula);
        if (formulaText === undefined && !(existing && existing.formulaText)) { err(spec, row, 'Formula is required for type formula'); continue; }
        const mode = choice(values.Formula_Mode, FORMULA_MODES, spec, row, 'Formula_Mode');
        if (mode === false) continue;
        patch.formulaText = formulaText;
        patch.formulaMode = mode;
        const textChanged = !existing || existing.type !== BindingType.FORMULA || (formulaText !== undefined && formulaText !== existing.formulaText) || (mode !== undefined && mode !== existing.formulaMode);
        if (textChanged) toResolve.add(pair);
      } else if (effectiveType === BindingType.SOURCE) {
        const frequency = choice(values.Source_Frequency, FREQUENCIES, spec, row, 'Source_Frequency');
        if (frequency === false) continue;
        const source = { ...(existing ? existing.source : {}), ...defined({ system: text(values.Source_System), dataset: text(values.Source_Dataset), field: text(values.Source_Field), owner: text(values.Source_Owner), frequency }) };
        if (!source.system && !source.dataset && !source.field) warnings.push({ code: 'SOURCE_EMPTY', sheet: spec.name, row, message: `Row ${row}: source binding of ${metricCode} · ${scenario.code} has no system, dataset or field` });
        patch.source = source;
      } else if (effectiveType === BindingType.ASSUMPTION) {
        patch.assumption = { ...(existing ? existing.assumption : {}), ...defined({ value: text(values.Assumption_Value), basis: text(values.Assumption_Basis), validFrom: text(values.Valid_From), validTo: text(values.Valid_To) }) };
      }
      const rec = upsert('bindings', existing, patch);
      bindingsByPair.set(pair, rec);
    }
  }
  // ---- metric × dimension detail
  {
    const spec = specOf('metricDimensions');
    const dup = seenInFile(spec);
    for (const { row, values } of rowsOf('metricDimensions')) {
      const metricCode = text(values.Metric_Code);
      const dimCode = text(values.Dimension_Code);
      if (!metricCode || !dimCode) { err(spec, row, 'Metric_Code and Dimension_Code are required'); continue; }
      const metric = lookup(metrics, metricCode, spec, row, 'Metric');
      if (!metric) { if (!errors.some((e) => e.sheet === spec.name && e.row === row)) err(spec, row, `Metric_Code "${metricCode}" does not match any metric`); continue; }
      const dim = lookup(dims, dimCode, spec, row, 'Dimension');
      if (!dim) { if (!errors.some((e) => e.sheet === spec.name && e.row === row)) err(spec, row, `Dimension_Code "${dimCode}" does not match any dimension`); continue; }
      const pair = `${metric.id}|${dim.id}`;
      if (dup(pair, row)) continue;
      const existing = linksByPair.get(pair) || null;
      const required = choice(values.Required, ['yes', 'no'], spec, row, 'Required');
      if (required === false) continue;
      let maxLevel;
      if (values.Max_Level !== undefined) {
        if (String(values.Max_Level).trim() === CLEAR) maxLevel = null;
        else {
          maxLevel = number(values.Max_Level, spec, row, 'Max_Level');
          if (maxLevel === false) continue;
          if (!Number.isInteger(maxLevel) || maxLevel < 1) { err(spec, row, 'Max_Level must be a whole number of 1 or more'); continue; }
        }
      }
      let allowedMemberIds;
      if (values.Allowed_Member_Codes !== undefined) {
        if (String(values.Allowed_Member_Codes).trim() === CLEAR) allowedMemberIds = null;
        else {
          allowedMemberIds = [];
          let bad = false;
          for (const c of splitList(values.Allowed_Member_Codes)) {
            const member = lookup(members, `${dim.id}|${codeKey(c)}`, spec, row, 'Member');
            if (!member) { err(spec, row, `Allowed_Member_Codes: "${c}" is not a member of ${dim.code}`); bad = true; break; }
            allowedMemberIds.push(member.id);
          }
          if (bad) continue;
        }
      }
      const rec = upsert('metricDimensions', existing, { metricId: metric.id, dimensionId: dim.id, required: required === undefined ? undefined : required === 'yes', maxLevel, allowedMemberIds });
      linksByPair.set(pair, rec);
    }
  }
  // ---- report contents: one row per metric shown in a report
  {
    const spec = specOf('reportMetrics');
    const dup = seenInFile(spec);
    for (const { row, values } of rowsOf('reportMetrics')) {
      const reportCode = text(values.Report_Code);
      const metricCode = text(values.Metric_Code);
      if (!reportCode || !metricCode) { err(spec, row, 'Report_Code and Metric_Code are required'); continue; }
      const report = lookup(reportsIdx, reportCode, spec, row, 'Report');
      if (!report) { if (!errors.some((e) => e.sheet === spec.name && e.row === row)) err(spec, row, `Report_Code "${reportCode}" does not match any report`); continue; }
      if (report.kind !== ReportKind.REPORT) { err(spec, row, `Report_Code "${reportCode}" is a folder; metrics are linked to reports`); continue; }
      const metric = lookup(metrics, metricCode, spec, row, 'Metric');
      if (!metric) { if (!errors.some((e) => e.sheet === spec.name && e.row === row)) err(spec, row, `Metric_Code "${metricCode}" does not match any metric`); continue; }
      const pair = `${metric.id}|${report.id}`;
      if (dup(pair, row)) continue;
      const sortOrder = number(values.Sort_Order, spec, row, 'Sort_Order');
      if (sortOrder === false) continue;
      const existing = reportLinksByPair.get(pair) || null;
      const rec = upsert('metricReports', existing, { metricId: metric.id, reportId: report.id, sortOrder, note: text(values.Note) });
      reportLinksByPair.set(pair, rec);
    }
  }

  // ---- what an item holds decides what it may be
  // The sheets are read one after another, so a row that turns a report into
  // a folder is only wrong once the whole file is known: the metrics may be
  // linked by an earlier sheet, by a later one, or already be in the
  // catalogue. The rule the UI and the service enforce is therefore checked
  // here on the state the plan would produce, and reported on the row that
  // asked for the kind.
  {
    const spec = specOf('reports');
    const children = new Map();
    for (const r of snapshot.reports) if (r.parentId) children.set(r.parentId, (children.get(r.parentId) || 0) + 1);
    const links = new Map();
    for (const l of snapshot.metricReports) links.set(l.reportId, (links.get(l.reportId) || 0) + 1);
    for (const r of snapshot.reports) {
      const row = reportRows.get(r.id);
      // An item this file never mentions is the catalogue's business, not
      // this import's: a pre-existing problem must not refuse the file.
      if (row === undefined) continue;
      const label = r.code || r.name;
      if (r.kind === ReportKind.FOLDER && links.get(r.id)) err(spec, row, `"${label}" still shows ${links.get(r.id)} metric(s); a folder cannot show metrics`);
      if (r.kind === ReportKind.REPORT && children.get(r.id)) err(spec, row, `"${label}" still holds ${children.get(r.id)} sub-item(s); a report cannot hold sub-items`);
    }
  }

  if (errors.length) return { ok: false, errors, warnings, changes: summarize(), snapshot: null, parsed: null, rowsRead, sheetsFound };
  // A formula that arrived or changed is resolved against the catalogue the
  // file produces, so its cache is right from the start and the boundary
  // has nothing to repair.
  if (toResolve.size) {
    const planStore = new Store();
    planStore.hydrate(snapshot);
    const planSelectors = createSelectors(planStore);
    for (const b of snapshot.bindings) {
      if (!toResolve.has(`${b.metricId}|${b.scenarioId}`) || b.type !== BindingType.FORMULA) continue;
      const res = resolveFormula(b.formulaText, b.scenarioId, planSelectors, planStore, { mode: b.formulaMode });
      b.parsedReferences = res.references.map(({ raw, token, scenarioCode, dimensionContext, metricId, scenarioId, status }) => ({ raw, token, scenarioCode, dimensionContext, metricId, scenarioId, status }));
      b.formulaErrors = res.errors.map((e) => ({ message: e.message, position: e.position }));
    }
  }
  // The same boundary a JSON backup passes: the plan only builds the file.
  const parsed = parseSnapshot(snapshot);
  if (!parsed.ok) for (const e of parsed.errors) errors.push({ sheet: '', row: 0, message: e });
  const writes = parsed.ok ? changeSet(before, parsed.data) : [];
  return { ok: parsed.ok, errors, warnings, changes: summarize(), snapshot, parsed, writes, rowsRead, sheetsFound };

  // ---------------------------------------------------------------- helpers bound to this plan
  function touch(rec, collection) {
    if (state[collection].get(rec.id) !== 'updated' && state[collection].get(rec.id) !== 'created') {
      rec.updatedAt = now;
      rec.version = (rec.version || 0) + 1;
    }
    mark(collection, rec.id, 'updated');
  }

  /** Make a metric's placements or links exactly `targets`, keeping the records that already point at one of them. */
  function replaceLinks(collection, metricId, targets, build, targetIdOf) {
    const current = snapshot[collection].filter((l) => l.metricId === metricId);
    const keep = new Map();
    for (const l of current) keep.set(targetIdOf(l), l);
    const next = [];
    targets.forEach((target, i) => {
      const existing = keep.get(target.id);
      const fields = build(target, i);
      if (existing) {
        keep.delete(target.id);
        let changed = false;
        for (const [k, v] of Object.entries(fields)) {
          if (JSON.stringify(existing[k]) !== JSON.stringify(v)) { existing[k] = v; changed = true; }
        }
        if (changed) touch(existing, collection);
        else mark(collection, existing.id, 'unchanged');
      } else {
        const rec = factories[collection](fields);
        rec.createdAt = now;
        rec.updatedAt = now;
        rec.version = 0;
        next.push(rec);
        mark(collection, rec.id, 'created');
      }
    });
    // Kept records stay where they were; only what the list no longer names
    // goes, and only what is new is appended.
    const dropped = new Set([...keep.values()].map((l) => l.id));
    removed[collection] += dropped.size;
    for (const id of dropped) state[collection].delete(id);
    snapshot[collection] = snapshot[collection].filter((l) => !dropped.has(l.id)).concat(next);
    if (collection === 'metricDimensions') {
      for (const l of next) linksByPair.set(`${l.metricId}|${l.dimensionId}`, l);
      for (const l of keep.values()) linksByPair.delete(`${l.metricId}|${l.dimensionId}`);
    }
    if (collection === 'metricReports') {
      for (const l of next) reportLinksByPair.set(`${l.metricId}|${l.reportId}`, l);
      for (const l of keep.values()) reportLinksByPair.delete(`${l.metricId}|${l.reportId}`);
    }
  }

  function number(value, spec, row, column) {
    if (value === undefined) return undefined;
    if (String(value).trim() === CLEAR) return 0;
    const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
    if (!Number.isFinite(n)) { err(spec, row, `${column} must be a number`); return false; }
    return n;
  }

  function choice(value, allowed, spec, row, column) {
    if (value === undefined) return undefined;
    const v = String(value).trim().toLowerCase();
    if (v === CLEAR) return '';
    if (!allowed.includes(v)) { err(spec, row, `${column} must be one of: ${allowed.filter(Boolean).join(', ')}`); return false; }
    return v;
  }
}

function specOf(key) {
  return TEMPLATE_SHEETS.find((s) => s.key === key);
}

/** Fields the repository owns, which say nothing about whether a record changed. */
const NOT_CONTENT = new Set(['concurrencyToken']);

/**
 * A record as it is worth comparing: keys sorted, so two objects that hold
 * the same values compare equal whichever order they were built in, and the
 * repository's own bookkeeping left out.
 */
function fingerprint(record) {
  const keys = Object.keys(record).filter((k) => !NOT_CONTENT.has(k)).sort();
  return JSON.stringify(keys.map((k) => [k, record[k]]));
}

/**
 * The difference between the catalogue the plan was built on and the
 * catalogue the plan describes, as operations the unit of work can apply.
 *
 * Every write carries the token its record had at planning time, so a record
 * another tab has touched since fails the batch instead of being overwritten,
 * and a record this file never mentions is not in the set at all.
 *
 * Removals come first, and in reverse collection order: an id whose record
 * is replaced rather than updated has to release its unique key before the
 * new one takes it.
 */
function changeSet(before, data) {
  const saves = [];
  const removes = [];
  for (const c of COLLECTIONS) {
    const kept = new Set();
    for (const record of data[c]) {
      kept.add(record.id);
      const prev = before[c].get(record.id);
      if (!prev) saves.push({ op: 'save', collection: c, record, expectedToken: null });
      else if (fingerprint(prev) !== fingerprint(record)) saves.push({ op: 'save', collection: c, record, expectedToken: tokenOf(prev) });
    }
    for (const [id, prev] of before[c]) if (!kept.has(id)) removes.push({ op: 'remove', collection: c, id, expectedToken: tokenOf(prev) });
  }
  removes.reverse();
  return [...removes, ...saves];
}

/** A text field: undefined when the cell was blank (keep), '' when it said CLEAR. */
function text(value) {
  if (value === undefined) return undefined;
  const s = String(value).trim();
  return s === CLEAR ? '' : s;
}

function list(value) {
  if (value === undefined) return undefined;
  const s = String(value).trim();
  return s === CLEAR ? [] : splitList(s);
}

function defined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/** Levels follow depth; a cycle (repaired later by the boundary) counts as depth 1. */
function relevel(memberList) {
  const byId = new Map(memberList.map((m) => [m.id, m]));
  for (const m of memberList) {
    let depth = 1;
    const guard = new Set([m.id]);
    let cur = m.parentId ? byId.get(m.parentId) : null;
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      depth += 1;
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    m.level = depth;
  }
}

// ------------------------------------------------------------------ end to end
/** Read an .xlsx and plan its import against the current catalogue. */
export async function previewExcelImport(bytes, store) {
  const workbook = await readWorkbook(bytes);
  const read = readTemplateWorkbook(workbook);
  return { workbook, read, plan: planExcelImport(read, store) };
}

/**
 * The change set the plan built, through the backup service.
 *
 * The plan has already passed the schema boundary; what is written here is
 * the difference it makes, record by record, against the tokens it was
 * planned on. A catalogue that moved underneath fails the whole batch.
 */
export async function applyExcelImport(plan, backup, { label = 'Before Excel import' } = {}) {
  if (!plan || !plan.ok || !plan.writes) throw new Error('The Excel import plan has errors; nothing was imported');
  const result = await backup.applyChanges(plan.writes, { label });
  return { ...result, counts: plan.parsed.counts, repairs: plan.parsed.repairs };
}

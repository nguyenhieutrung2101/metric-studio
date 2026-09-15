import { BindingType, FormulaMode } from '../core/models/binding.js';
import { MetricStatus } from '../core/models/metric.js';
import { nodeKey } from '../core/models/binding.js';
import { referenceKey } from '../utils/text.js';
import { referenceIdentity } from './formula-parser.js';
import { ReportKind } from '../core/models/report.js';

/**
 * ValidationService — pure rule engine.
 *
 * validateAll({ store, selectors, dependencies }) → Issue[]
 *
 * Issue {
 *   id, severity: 'error'|'warning'|'info', code, message, params,
 *   entity: { type, id },   // 'metric' | 'binding' | 'structure' | 'dimension' | 'member' | 'metricDimension' | 'metricStructure' | 'report' | 'metricReport'
 *   metricId?, scenarioId?, dimensionId?, structureNodeId?, reportId?
 * }
 *
 * Messages are English defaults; the UI maps `code` + `params` to the active
 * language. Nothing here touches the DOM or the repository.
 */

export const Severity = Object.freeze({ ERROR: 'error', WARNING: 'warning', INFO: 'info' });

export function validateAll({ store, selectors, dependencies }) {
  const issues = [];
  const add = (severity, code, entity, message, extra = {}) => {
    issues.push({ id: `${code}:${entity.type}:${entity.id}${extra.scenarioId ? ':' + extra.scenarioId : ''}${extra.suffix ? ':' + extra.suffix : ''}`, severity, code, message, entity, params: extra.params || {}, ...extra });
  };

  validateMetrics(store, selectors, add);
  validateStructure(store, selectors, add);
  validateBindings(store, selectors, add);
  validateDimensions(store, selectors, add);
  validateReports(store, selectors, add);
  validateDependencies(store, selectors, dependencies, add);
  return issues;
}

function validateMetrics(store, selectors, add) {
  const codes = new Map();
  for (const m of store.list('metrics')) {
    const key = referenceKey(m.code);
    if (key) {
      if (!codes.has(key)) codes.set(key, []);
      codes.get(key).push(m);
    }
  }
  const unplaced = selectors.unplacedMetricIds();
  for (const m of store.list('metrics')) {
    const entity = { type: 'metric', id: m.id };
    const params = { code: m.code, name: m.name };
    if (!m.name) add(Severity.ERROR, 'METRIC_MISSING_NAME', entity, `Metric ${m.code || m.id} has no name`, { metricId: m.id, params });
    if (!m.code) add(Severity.WARNING, 'METRIC_MISSING_CODE', entity, `Metric "${m.name}" has no code`, { metricId: m.id, params });
    const dup = codes.get(referenceKey(m.code));
    if (dup && dup.length > 1) add(Severity.ERROR, 'METRIC_DUPLICATE_CODE', entity, `Duplicate metric code "${m.code}" (${dup.length} metrics)`, { metricId: m.id, params: { ...params, count: dup.length } });
    if (m.unitId && !store.has('units', m.unitId)) add(Severity.WARNING, 'METRIC_UNIT_MISSING', entity, `Metric "${m.name}" references a unit that no longer exists`, { metricId: m.id, params });
    if (unplaced.has(m.id)) {
      if (m.status === MetricStatus.APPROVED) add(Severity.WARNING, 'METRIC_APPROVED_UNPLACED', entity, `Approved metric "${m.name}" has no structural placement`, { metricId: m.id, params });
      else if (m.status === MetricStatus.DRAFT) add(Severity.INFO, 'METRIC_UNPLACED', entity, `Draft metric "${m.name}" has no structural placement`, { metricId: m.id, params });
    }
    if (m.status === MetricStatus.APPROVED) {
      const cov = selectors.coverageOf(m.id);
      if (!Object.values(cov).some(Boolean)) add(Severity.INFO, 'METRIC_APPROVED_UNBOUND', entity, `Approved metric "${m.name}" has no scenario binding`, { metricId: m.id, params });
    }
  }
  for (const ms of store.list('metricStructures')) {
    if (!store.has('metrics', ms.metricId) || !store.has('structureNodes', ms.structureNodeId)) {
      add(Severity.ERROR, 'PLACEMENT_ORPHAN', { type: 'metricStructure', id: ms.id }, 'Structural placement references a missing metric or node', { metricId: store.has('metrics', ms.metricId) ? ms.metricId : null, structureNodeId: store.has('structureNodes', ms.structureNodeId) ? ms.structureNodeId : null, params: {} });
    }
  }
}

function validateStructure(store, selectors, add) {
  const { byId } = selectors.structureTree();
  const codes = new Map();
  for (const n of store.list('structureNodes')) {
    const key = referenceKey(n.code);
    if (key) {
      if (!codes.has(key)) codes.set(key, []);
      codes.get(key).push(n);
    }
  }
  for (const n of store.list('structureNodes')) {
    const entity = { type: 'structure', id: n.id };
    const params = { name: n.name, code: n.code };
    const entry = byId.get(n.id);
    if (entry && entry.orphanCycle) add(Severity.ERROR, 'STRUCTURE_CYCLE', entity, `Structure node "${n.name}" is part of a parent cycle`, { structureNodeId: n.id, params });
    if (n.parentId && !store.has('structureNodes', n.parentId)) add(Severity.ERROR, 'STRUCTURE_ORPHAN', entity, `Structure node "${n.name}" references a missing parent`, { structureNodeId: n.id, params });
    if (!n.name) add(Severity.WARNING, 'STRUCTURE_MISSING_NAME', entity, 'Structure node has no name', { structureNodeId: n.id, params });
    const dup = codes.get(referenceKey(n.code));
    if (dup && dup.length > 1) add(Severity.WARNING, 'STRUCTURE_DUPLICATE_CODE', entity, `Duplicate structure code "${n.code}"`, { structureNodeId: n.id, params });
  }
}

function validateBindings(store, selectors, add) {
  const pairs = new Map();
  for (const b of store.list('bindings')) {
    const k = nodeKey(b.metricId, b.scenarioId);
    if (!pairs.has(k)) pairs.set(k, []);
    pairs.get(k).push(b);
  }
  for (const b of store.list('bindings')) {
    const metric = store.get('metrics', b.metricId);
    const scenario = store.get('scenarios', b.scenarioId);
    const entity = { type: 'binding', id: b.id };
    const base = { metricId: metric ? b.metricId : null, scenarioId: scenario ? b.scenarioId : null };
    const label = `${metric ? metric.name : b.metricId} · ${scenario ? scenario.code : '?'}`;
    const params = { metric: metric ? metric.name : b.metricId, code: metric ? metric.code : '', scenario: scenario ? scenario.code : '?' };

    if (!metric || !scenario) {
      add(Severity.ERROR, 'BINDING_ORPHAN', entity, `Binding ${b.id} references a missing metric or scenario`, { ...base, params });
      continue;
    }
    const dup = pairs.get(nodeKey(b.metricId, b.scenarioId));
    if (dup.length > 1) add(Severity.ERROR, 'BINDING_DUPLICATE', entity, `Metric "${metric.name}" has ${dup.length} bindings for ${scenario.code}`, { ...base, params: { ...params, count: dup.length } });

    if (b.type === BindingType.FORMULA) {
      if (!b.formulaText) {
        add(Severity.ERROR, 'BINDING_FORMULA_EMPTY', entity, `${label}: formula binding without a formula`, { ...base, params });
        continue;
      }
      if (b.formulaMode === FormulaMode.TEXT) {
        // A description in words is allowed, never executable and never
        // silent: the warning is how the rare case stays rare and findable.
        const declared = distinctReferenceCount(b.parsedReferences || []);
        add(Severity.WARNING, 'BINDING_FORMULA_FREE_TEXT', entity, declared
          ? `${label}: free-text formula (${declared} declared reference${declared === 1 ? '' : 's'}) — not checked, not executable`
          : `${label}: free-text formula that declares no metric reference — write its inputs in brackets so its dependencies are known`,
        { ...base, params: { ...params, count: declared } });
      } else {
        for (const e of b.formulaErrors || []) {
          add(Severity.ERROR, 'BINDING_FORMULA_SYNTAX', entity, `${label}: ${e.message}`, { ...base, params: { ...params, detail: e.message }, suffix: String(e.position) });
        }
      }
      const seen = new Set();
      for (const r of b.parsedReferences || []) {
        const refKey = referenceIdentity(r);
        if (seen.has(refKey)) continue;
        seen.add(refKey);
        const refParams = { ...params, ref: r.raw || r.token, token: r.token };
        let targetScenario = scenario;
        if (r.scenarioCode) {
          targetScenario = selectors.scenarioByCode(r.scenarioCode);
          if (!targetScenario) {
            add(Severity.ERROR, 'BINDING_REF_UNKNOWN_SCENARIO', entity, `${label}: reference ${r.raw} uses unknown scenario "${r.scenarioCode}"`, { ...base, params: refParams, suffix: refKey });
            continue;
          }
        }
        let targetId = r.metricId && store.has('metrics', r.metricId) ? r.metricId : null;
        if (!targetId) {
          const res = selectors.resolveReference(r.token);
          if (res.status === 'ambiguous') {
            add(Severity.ERROR, 'BINDING_REF_AMBIGUOUS', entity, `${label}: reference ${r.raw} matches ${res.candidates.length} metrics`, { ...base, params: { ...refParams, count: res.candidates.length }, suffix: refKey });
            continue;
          }
          if (res.status !== 'resolved') {
            add(Severity.ERROR, 'BINDING_REF_MISSING', entity, `${label}: reference ${r.raw} does not match any metric`, { ...base, params: refParams, suffix: refKey });
            continue;
          }
          targetId = res.metricId;
        }
        const targetBinding = selectors.bindingFor(targetId, targetScenario.id);
        const targetMetric = store.get('metrics', targetId);
        if (!targetBinding || targetBinding.type === BindingType.NONE) {
          add(Severity.WARNING, 'BINDING_REF_TARGET_UNBOUND', entity, `${label}: "${targetMetric.name}" has no ${targetScenario.code} binding`, { ...base, params: { ...refParams, target: targetMetric.name, targetScenario: targetScenario.code }, suffix: refKey });
        }
        if (targetScenario.id !== scenario.id) {
          add(Severity.INFO, 'BINDING_CROSS_SCENARIO', entity, `${label}: explicit cross-scenario reference ${r.raw}`, { ...base, params: { ...refParams, targetScenario: targetScenario.code }, suffix: refKey });
        }
      }
    } else if (b.type === BindingType.SOURCE) {
      const s = b.source || {};
      if (!s.system && !s.dataset && !s.field) add(Severity.WARNING, 'BINDING_SOURCE_MISSING_INFO', entity, `${label}: source binding without source information`, { ...base, params });
    } else if (b.type === BindingType.ASSUMPTION) {
      const a = b.assumption || {};
      if (!a.value) add(Severity.WARNING, 'BINDING_ASSUMPTION_MISSING_VALUE', entity, `${label}: assumption without a value`, { ...base, params });
      if (!a.basis) add(Severity.WARNING, 'BINDING_ASSUMPTION_MISSING_BASIS', entity, `${label}: assumption without a basis / rationale`, { ...base, params });
    }
  }
}

function validateDimensions(store, selectors, add) {
  const codes = new Map();
  for (const d of store.list('dimensions')) {
    const key = referenceKey(d.code);
    if (key) {
      if (!codes.has(key)) codes.set(key, []);
      codes.get(key).push(d);
    }
  }
  for (const d of store.list('dimensions')) {
    const entity = { type: 'dimension', id: d.id };
    const params = { name: d.name, code: d.code };
    if (!d.name) add(Severity.ERROR, 'DIMENSION_MISSING_NAME', entity, `Dimension ${d.code || d.id} has no name`, { dimensionId: d.id, params });
    const dup = codes.get(referenceKey(d.code));
    if (dup && dup.length > 1) add(Severity.ERROR, 'DIMENSION_DUPLICATE_CODE', entity, `Duplicate dimension code "${d.code}"`, { dimensionId: d.id, params });
  }

  const memberCodes = new Map();
  for (const m of store.list('dimensionMembers')) {
    const key = `${m.dimensionId}:${referenceKey(m.code)}`;
    if (!referenceKey(m.code)) continue;
    if (!memberCodes.has(key)) memberCodes.set(key, []);
    memberCodes.get(key).push(m);
  }
  for (const m of store.list('dimensionMembers')) {
    const entity = { type: 'member', id: m.id };
    const params = { name: m.name, code: m.code };
    if (!store.has('dimensions', m.dimensionId)) {
      add(Severity.ERROR, 'MEMBER_ORPHAN', entity, `Dimension member "${m.name}" belongs to a missing dimension`, { params });
      continue;
    }
    const tree = selectors.memberTree(m.dimensionId);
    const entry = tree.byId.get(m.id);
    if (m.parentId) {
      const parent = store.get('dimensionMembers', m.parentId);
      if (!parent || parent.dimensionId !== m.dimensionId) add(Severity.ERROR, 'MEMBER_INVALID_PARENT', entity, `Dimension member "${m.name}" has an invalid parent`, { dimensionId: m.dimensionId, params });
    }
    if (entry && entry.orphanCycle) add(Severity.ERROR, 'MEMBER_CYCLE', entity, `Dimension member "${m.name}" is part of a cyclic hierarchy`, { dimensionId: m.dimensionId, params });
    const dup = memberCodes.get(`${m.dimensionId}:${referenceKey(m.code)}`);
    if (dup && dup.length > 1) add(Severity.WARNING, 'MEMBER_DUPLICATE_CODE', entity, `Duplicate member code "${m.code}" in dimension`, { dimensionId: m.dimensionId, params });
  }

  const linkPairs = new Map();
  for (const l of store.list('metricDimensions')) {
    const k = `${l.metricId}:${l.dimensionId}`;
    linkPairs.set(k, (linkPairs.get(k) || 0) + 1);
  }
  for (const l of store.list('metricDimensions')) {
    const entity = { type: 'metricDimension', id: l.id };
    const metric = store.get('metrics', l.metricId);
    const dim = store.get('dimensions', l.dimensionId);
    const params = { metric: metric ? metric.name : l.metricId, dimension: dim ? dim.name : l.dimensionId };
    if (!metric || !dim) {
      add(Severity.ERROR, 'METRIC_DIMENSION_ORPHAN', entity, `Metric ↔ dimension link references a missing ${metric ? 'dimension' : 'metric'}`, { metricId: metric ? l.metricId : null, dimensionId: dim ? l.dimensionId : null, params });
      continue;
    }
    if (linkPairs.get(`${l.metricId}:${l.dimensionId}`) > 1) add(Severity.WARNING, 'METRIC_DIMENSION_DUPLICATE', entity, `"${metric.name}" is linked to "${dim.name}" more than once`, { metricId: l.metricId, dimensionId: l.dimensionId, params });
    if (Number.isInteger(l.maxLevel)) {
      const depth = selectors.memberTree(l.dimensionId).depth;
      if (l.maxLevel > Math.max(depth, 1)) add(Severity.WARNING, 'METRIC_DIMENSION_MAXLEVEL', entity, `"${metric.name}" × "${dim.name}": maxLevel ${l.maxLevel} exceeds hierarchy depth ${depth}`, { metricId: l.metricId, dimensionId: l.dimensionId, params: { ...params, maxLevel: l.maxLevel, depth } });
    }
    if (Array.isArray(l.allowedMemberIds)) {
      const missing = l.allowedMemberIds.filter((id) => {
        const mem = store.get('dimensionMembers', id);
        return !mem || mem.dimensionId !== l.dimensionId;
      });
      if (missing.length) add(Severity.WARNING, 'METRIC_DIMENSION_ALLOWED_MISSING', entity, `"${metric.name}" × "${dim.name}": ${missing.length} allowed member(s) no longer exist`, { metricId: l.metricId, dimensionId: l.dimensionId, params: { ...params, count: missing.length } });
    }
  }
}

function validateReports(store, selectors, add) {
  const { byId } = selectors.reportTree();
  const codes = new Map();
  for (const r of store.list('reports')) {
    const key = referenceKey(r.code);
    if (key) {
      if (!codes.has(key)) codes.set(key, []);
      codes.get(key).push(r);
    }
  }
  for (const r of store.list('reports')) {
    const entity = { type: 'report', id: r.id };
    const params = { name: r.name, code: r.code };
    const entry = byId.get(r.id);
    if (entry && entry.orphanCycle) add(Severity.ERROR, 'REPORT_CYCLE', entity, `Report item "${r.name}" is part of a parent cycle`, { reportId: r.id, params });
    if (r.parentId && !store.has('reports', r.parentId)) add(Severity.ERROR, 'REPORT_ORPHAN', entity, `Report item "${r.name}" references a missing parent`, { reportId: r.id, params });
    else if (r.parentId) {
      const parent = store.get('reports', r.parentId);
      if (parent.kind !== ReportKind.FOLDER) add(Severity.WARNING, 'REPORT_PARENT_NOT_FOLDER', entity, `"${r.name}" sits under "${parent.name}", which is a report, not a folder`, { reportId: r.id, params: { ...params, parent: parent.name } });
    }
    if (!r.name) add(Severity.WARNING, 'REPORT_MISSING_NAME', entity, 'A report item has no name', { reportId: r.id, params });
    const dup = codes.get(referenceKey(r.code));
    if (dup && dup.length > 1) add(Severity.WARNING, 'REPORT_DUPLICATE_CODE', entity, `Duplicate report code "${r.code}"`, { reportId: r.id, params });
    if (r.kind === ReportKind.REPORT && selectors.metricIdsInReport(r.id).size === 0) add(Severity.INFO, 'REPORT_EMPTY', entity, `Report "${r.name}" shows no metric yet`, { reportId: r.id, params });
  }
  const pairs = new Map();
  for (const l of store.list('metricReports')) {
    const k = `${l.metricId}:${l.reportId}`;
    pairs.set(k, (pairs.get(k) || 0) + 1);
  }
  for (const l of store.list('metricReports')) {
    const entity = { type: 'metricReport', id: l.id };
    const metric = store.get('metrics', l.metricId);
    const report = store.get('reports', l.reportId);
    const params = { metric: metric ? metric.name : l.metricId, report: report ? report.name : l.reportId };
    if (!metric || !report) {
      add(Severity.ERROR, 'REPORT_LINK_ORPHAN', entity, `Metric ↔ report link references a missing ${metric ? 'report' : 'metric'}`, { metricId: metric ? l.metricId : null, reportId: report ? l.reportId : null, params });
      continue;
    }
    if (report.kind !== ReportKind.REPORT) add(Severity.WARNING, 'REPORT_LINK_TO_FOLDER', entity, `"${metric.name}" is linked to "${report.name}", which is a folder`, { metricId: l.metricId, reportId: l.reportId, params });
    if (pairs.get(`${l.metricId}:${l.reportId}`) > 1) add(Severity.WARNING, 'REPORT_LINK_DUPLICATE', entity, `"${metric.name}" is linked to "${report.name}" more than once`, { metricId: l.metricId, reportId: l.reportId, params });
  }
}

function validateDependencies(store, selectors, dependencies, add) {
  if (!dependencies) return;
  // A formula the graph could not process is a finding on that binding, and
  // the rest of the run carries on.
  for (const e of (dependencies.graphErrors ? dependencies.graphErrors() : [])) {
    const metric = store.get('metrics', e.metricId);
    const scenario = store.get('scenarios', e.scenarioId);
    add(Severity.ERROR, 'BINDING_FORMULA_UNPROCESSABLE', { type: 'binding', id: e.bindingId }, `${metric ? metric.name : e.metricId} · ${scenario ? scenario.code : '?'}: formula could not be processed — ${e.message}`, { metricId: e.metricId, scenarioId: e.scenarioId, params: { metric: metric ? metric.name : e.metricId, scenario: scenario ? scenario.code : '?', detail: e.message } });
  }
  let cycles;
  try {
    cycles = dependencies.findCycles();
  } catch (err) {
    add(Severity.ERROR, 'DEPENDENCY_GRAPH_FAILED', { type: 'metric', id: '*' }, `Dependency analysis failed: ${err && err.message ? err.message : err}`, { params: { detail: err && err.message ? err.message : String(err) } });
    return;
  }
  for (const cycle of cycles) {
    const first = cycle[0];
    const info = dependencies.nodeInfo(first);
    const names = cycle.map((k) => {
      const n = dependencies.nodeInfo(k);
      return n.metric ? `${n.metric.name} [${n.scenario ? n.scenario.code : '?'}]` : k;
    });
    const entity = info.binding ? { type: 'binding', id: info.binding.id } : { type: 'metric', id: info.metricId };
    add(Severity.ERROR, 'DEPENDENCY_CYCLE', entity, `Circular dependency: ${names.join(' → ')} → ${names[0]}`, { metricId: info.metricId, scenarioId: info.scenarioId, params: { path: names.join(' → '), count: cycle.length }, cycle, suffix: cycle.join(',') });
  }
}

function distinctReferenceCount(references) {
  const seen = new Set();
  for (const r of references) seen.add(referenceIdentity(r));
  return seen.size;
}

/** Group issues for quick lookups in the UI. */
export function indexIssues(issues) {
  const byMetric = new Map();
  const byEntity = new Map();
  const bySeverity = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) {
    bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
    if (issue.metricId) {
      if (!byMetric.has(issue.metricId)) byMetric.set(issue.metricId, []);
      byMetric.get(issue.metricId).push(issue);
    }
    const ek = `${issue.entity.type}:${issue.entity.id}`;
    if (!byEntity.has(ek)) byEntity.set(ek, []);
    byEntity.get(ek).push(issue);
  }
  return { issues, byMetric, byEntity, bySeverity };
}

export function worstSeverity(list) {
  if (!list || list.length === 0) return null;
  if (list.some((i) => i.severity === Severity.ERROR)) return Severity.ERROR;
  if (list.some((i) => i.severity === Severity.WARNING)) return Severity.WARNING;
  return Severity.INFO;
}

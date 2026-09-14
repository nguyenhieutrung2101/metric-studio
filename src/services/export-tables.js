/**
 * Flat tables for people and systems outside the app.
 *
 * Two layers, exported side by side and never merged:
 *
 *   Bindings         one row per metric × scenario, with the formula text —
 *                    the logic as its author wrote it.
 *   Dependency_Edges one row per reference inside a formula — what a pipeline
 *                    needs to build lineage, execution order or impact
 *                    analysis without parsing formulas itself.
 *
 * Keeping both is the point: the formula text is the source of truth and the
 * edge table is derived from it, so a consumer can always check one against
 * the other.
 */

export const BINDING_COLUMNS = [
  ['Metric_ID', (r) => r.metricId],
  ['Metric_Code', (r) => r.metricCode],
  ['Metric_Name', (r) => r.metricName],
  ['Scenario', (r) => r.scenario],
  ['Binding_ID', (r) => r.bindingId],
  ['Binding_Type', (r) => r.type],
  ['Status', (r) => r.status],
  ['Formula_Text', (r) => r.formulaText],
  ['Source_System', (r) => r.sourceSystem],
  ['Source_Dataset', (r) => r.sourceDataset],
  ['Source_Field', (r) => r.sourceField],
  ['Assumption_Value', (r) => r.assumptionValue],
  ['Legacy_Code', (r) => r.legacyCode],
  ['Note', (r) => r.note],
];

export const EDGE_COLUMNS = [
  ['Target_Metric_ID', (r) => r.targetMetricId],
  ['Target_Code', (r) => r.targetCode],
  ['Target_Name', (r) => r.targetName],
  ['Target_Scenario', (r) => r.targetScenario],
  ['Formula_ID', (r) => r.bindingId],
  ['Source_Metric_ID', (r) => r.sourceMetricId || ''],
  ['Source_Code', (r) => r.sourceCode],
  ['Source_Name', (r) => r.sourceName],
  ['Source_Scenario', (r) => r.sourceScenario],
  ['Sequence', (r) => r.sequence],
  ['Reference_Type', (r) => r.referenceType],
  ['Dimension_Context', (r) => r.dimensionContext],
  ['Time_Context', () => ''],
  ['Operator_Function', (r) => r.operator],
  ['Resolved', (r) => (r.resolved ? 'yes' : 'no')],
  ['Formula_Text', (r) => r.formulaText],
];

/** One row per binding, metrics and scenarios resolved to codes and names. */
export function bindingRows(store) {
  const rows = [];
  for (const b of store.list('bindings')) {
    const m = store.get('metrics', b.metricId);
    const s = store.get('scenarios', b.scenarioId);
    rows.push({
      metricId: b.metricId,
      metricCode: m ? m.code : '',
      metricName: m ? m.name : '',
      scenario: s ? s.code : '',
      bindingId: b.id,
      type: b.type,
      status: b.status,
      formulaText: b.type === 'formula' ? b.formulaText : '',
      sourceSystem: b.source ? b.source.system : '',
      sourceDataset: b.source ? b.source.dataset : '',
      sourceField: b.source ? b.source.field : '',
      assumptionValue: b.assumption ? b.assumption.value : '',
      legacyCode: b.legacyCode || '',
      note: b.note || '',
    });
  }
  rows.sort((a, b) => a.metricCode.localeCompare(b.metricCode) || a.scenario.localeCompare(b.scenario));
  return rows;
}

/**
 * RFC 4180 CSV with a BOM so spreadsheets open it as UTF-8. Every cell is
 * quoted: the formula text alone can hold commas, quotes and line breaks.
 */
export function toCsv(rows, columns) {
  const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [columns.map(([name]) => cell(name)).join(',')];
  for (const r of rows) lines.push(columns.map(([, pick]) => cell(pick(r))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

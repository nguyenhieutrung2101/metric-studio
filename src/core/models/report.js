import { newId } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';
import { trimOrEmpty } from '../../utils/text.js';

/**
 * Reports: what a metric is *for*. A business partner builds the reports the
 * organisation actually reads (the monthly BOD pack, the weekly operations
 * review), groups them in folders, and links metrics into them. The
 * governance hierarchy says where a metric belongs; a report says where it
 * is shown. One metric can sit in many reports.
 *
 * A folder holds folders and reports; a report holds metrics. Nothing else.
 */
export const ReportKind = Object.freeze({ FOLDER: 'folder', REPORT: 'report' });
export const REPORT_KINDS = Object.freeze(Object.values(ReportKind));

export function isFolder(report) {
  return !!report && report.kind === ReportKind.FOLDER;
}

export function createReport(input = {}) {
  const ts = nowIso();
  return {
    id: input.id || newId(),
    parentId: input.parentId || null,
    kind: REPORT_KINDS.includes(input.kind) ? input.kind : ReportKind.REPORT,
    code: trimOrEmpty(input.code),
    name: trimOrEmpty(input.name),
    description: trimOrEmpty(input.description),
    owner: trimOrEmpty(input.owner),
    sortOrder: Number.isFinite(input.sortOrder) ? input.sortOrder : 0,
    createdAt: input.createdAt || ts,
    updatedAt: input.updatedAt || ts,
    version: Number.isInteger(input.version) ? input.version : 0,
  };
}

/** Link: metric ↔ report. Unique per (metricId, reportId). */
export function createMetricReport(input = {}) {
  const ts = nowIso();
  return {
    id: input.id || newId(),
    metricId: input.metricId,
    reportId: input.reportId,
    sortOrder: Number.isFinite(input.sortOrder) ? input.sortOrder : 0,
    note: trimOrEmpty(input.note),
    createdAt: input.createdAt || ts,
    updatedAt: input.updatedAt || ts,
    version: Number.isInteger(input.version) ? input.version : 0,
  };
}

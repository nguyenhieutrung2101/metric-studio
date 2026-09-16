import { ReportKind } from '../core/models/report.js';
import { ValidationFailure } from './errors.js';

/**
 * The rules the catalogue holds to, stated once.
 *
 * Each of these used to be written three times over: once in the service
 * that performs an edit, once in the planner that previews an import, once
 * in the guard that re-checks it inside the transaction. Three copies of a
 * rule is three chances to fix one and leave the others, which is exactly
 * what kept happening — the service learned to re-read a move's target while
 * the import planner did not, the guard learned what a folder may hold while
 * the change set did not. One statement, three callers.
 */

/** Fields that name another record, by collection. */
export const REFERENCES = Object.freeze({
  metrics: [['unitId', 'units']],
  structureNodes: [['parentId', 'structureNodes']],
  metricStructures: [['metricId', 'metrics'], ['structureNodeId', 'structureNodes']],
  bindings: [['metricId', 'metrics'], ['scenarioId', 'scenarios']],
  dimensionMembers: [['dimensionId', 'dimensions'], ['parentId', 'dimensionMembers']],
  metricDimensions: [['metricId', 'metrics'], ['dimensionId', 'dimensions']],
  reports: [['parentId', 'reports']],
  metricReports: [['metricId', 'metrics'], ['reportId', 'reports']],
});

/**
 * What an item holds decides what it may be: a folder holds folders and
 * reports, a report holds metrics, and neither holds the other's.
 */
export function reportKindFits(kind, childCount, linkCount) {
  if (kind === ReportKind.REPORT && childCount) return false;
  if (kind === ReportKind.FOLDER && linkCount) return false;
  return true;
}

/** The same rule as a refusal, for a caller with nothing to add to the message. */
export function assertReportKindFits(kind, children, links) {
  if (kind === ReportKind.REPORT && children.length) throw new ValidationFailure('A folder that holds sub-items cannot become a report', 'kind');
  if (kind === ReportKind.FOLDER && links.length) throw new ValidationFailure('A report that shows metrics cannot become a folder', 'kind');
}

/** Only a folder holds sub-items. */
export function assertParentIsFolder(parent) {
  if (parent && parent.kind !== ReportKind.FOLDER) throw new ValidationFailure('Only a folder can hold reports', 'parentId');
}

/** Metrics hang off reports, never off folders. */
export function assertLinkTarget(report) {
  if (report && report.kind !== ReportKind.REPORT) throw new ValidationFailure('Metrics are linked to reports, not to folders', 'reportId');
}

/**
 * A link this change is reasoning about must still be the link it planned
 * for: same record, same metric, same target.
 *
 * `require` answers "is there still a record with this id", which is a
 * different question. A link keeps its id when it is moved, so a target link
 * that has since been moved elsewhere passes a requirement and defeats the
 * intention: the source link is dropped because the metric is "already
 * there", and it is not there any more.
 */
export function guardLinkStillPoints(work, collection, link, targetField) {
  const { id, metricId } = link;
  const target = link[targetField];
  work.guard(collection, (stored) => {
    const current = stored.find((l) => l.id === id);
    if (!current || current.metricId !== metricId || current[targetField] !== target) {
      throw new ValidationFailure('That metric is no longer where this change assumed it was, so nothing was changed. Try again from what is there now.');
    }
  });
}

/** A key for one record, safe for ids that hold any character but a null byte. */
const keyOf = (collection, id) => `${collection}::${id}`;

/**
 * Every record a set of writes points at must exist where the data lives.
 *
 * A token says a record has not changed; it says nothing about the records
 * that record names. What the batch creates itself is excluded: it is not in
 * the database yet, and requiring it would refuse the very file bringing it.
 */
export function requireReferences(work, saves) {
  const created = new Set();
  for (const op of saves) if (op.expectedToken == null) created.add(keyOf(op.collection, op.record.id));
  const needed = new Map();
  for (const op of saves) {
    for (const [field, target] of REFERENCES[op.collection] || []) {
      const id = op.record[field];
      if (!id) continue;
      const key = keyOf(target, id);
      if (created.has(key) || needed.has(key)) continue;
      needed.set(key, { collection: target, id });
    }
  }
  for (const { collection, id } of needed.values()) work.require(collection, id);
  return work;
}

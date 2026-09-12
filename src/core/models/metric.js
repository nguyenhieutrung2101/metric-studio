import { newId } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';
import { splitList, trimOrEmpty } from '../../utils/text.js';

export const MetricStatus = Object.freeze({
  DRAFT: 'draft',
  APPROVED: 'approved',
  DEPRECATED: 'deprecated',
});

export const MetricRole = Object.freeze({
  METRIC: 'metric',
  KPI: 'kpi',
  INDICATOR: 'indicator',
  INDEX: 'index',
});

export const METRIC_STATUSES = Object.values(MetricStatus);
export const METRIC_ROLES = Object.values(MetricRole);

/**
 * Canonical metric record. Identity is `id` (immutable). `code` is a
 * human identifier and must never encode hierarchy, dimension or scenario.
 */
export function createMetric(input = {}) {
  const ts = nowIso();
  return {
    id: input.id || newId(),
    code: trimOrEmpty(input.code),
    name: trimOrEmpty(input.name),
    aliases: splitList(input.aliases),
    definition: trimOrEmpty(input.definition),
    unitId: input.unitId || null,
    owner: trimOrEmpty(input.owner),
    role: METRIC_ROLES.includes(input.role) ? input.role : '',
    status: METRIC_STATUSES.includes(input.status) ? input.status : MetricStatus.DRAFT,
    tags: splitList(input.tags),
    createdAt: input.createdAt || ts,
    updatedAt: input.updatedAt || ts,
    version: Number.isInteger(input.version) ? input.version : 0,
  };
}

/** Shape validation only (business rules live in ValidationService). */
export function checkMetricShape(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return ['metric must be an object'];
  if (!m.id) errors.push('id is required');
  if (!m.name) errors.push('name is required');
  if (!METRIC_STATUSES.includes(m.status)) errors.push(`invalid status "${m.status}"`);
  return errors;
}

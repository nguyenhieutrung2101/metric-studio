import { newId } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';
import { splitList, trimOrEmpty } from '../../utils/text.js';

export function createDimension(input = {}) {
  const ts = nowIso();
  return {
    id: input.id || newId(),
    code: trimOrEmpty(input.code),
    name: trimOrEmpty(input.name),
    description: trimOrEmpty(input.description),
    sortOrder: Number.isFinite(input.sortOrder) ? input.sortOrder : 0,
    createdAt: input.createdAt || ts,
    updatedAt: input.updatedAt || ts,
    version: Number.isInteger(input.version) ? input.version : 0,
  };
}

export function createDimensionMember(input = {}) {
  const ts = nowIso();
  return {
    id: input.id || newId(),
    dimensionId: input.dimensionId,
    parentId: input.parentId || null,
    code: trimOrEmpty(input.code),
    name: trimOrEmpty(input.name),
    level: Number.isInteger(input.level) ? input.level : 1,
    aliases: splitList(input.aliases),
    sortOrder: Number.isFinite(input.sortOrder) ? input.sortOrder : 0,
    createdAt: input.createdAt || ts,
    updatedAt: input.updatedAt || ts,
    version: Number.isInteger(input.version) ? input.version : 0,
  };
}

/**
 * Metric ↔ Dimension link. Describes which axes a metric can be sliced by.
 * It never creates metrics; a slice is a logical context.
 */
export function createMetricDimension(input = {}) {
  const ts = nowIso();
  return {
    id: input.id || newId(),
    metricId: input.metricId,
    dimensionId: input.dimensionId,
    required: !!input.required,
    maxLevel: Number.isInteger(input.maxLevel) ? input.maxLevel : null,
    allowedMemberIds: Array.isArray(input.allowedMemberIds) ? [...input.allowedMemberIds] : null,
    scenarioOverride: input.scenarioOverride && typeof input.scenarioOverride === 'object' ? { ...input.scenarioOverride } : null,
    createdAt: input.createdAt || ts,
    updatedAt: input.updatedAt || ts,
    version: Number.isInteger(input.version) ? input.version : 0,
  };
}

import { newId } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';
import { trimOrEmpty } from '../../utils/text.js';

/** A folder in the governance hierarchy. Not a metric. */
export function createStructureNode(input = {}) {
  const ts = nowIso();
  return {
    id: input.id || newId(),
    parentId: input.parentId || null,
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

/** Placement link: metric ↔ structure node. */
export function createMetricStructure(input = {}) {
  const ts = nowIso();
  return {
    id: input.id || newId(),
    metricId: input.metricId,
    structureNodeId: input.structureNodeId,
    isPrimary: input.isPrimary !== false,
    sortOrder: Number.isFinite(input.sortOrder) ? input.sortOrder : 0,
    createdAt: input.createdAt || ts,
    updatedAt: input.updatedAt || ts,
    version: Number.isInteger(input.version) ? input.version : 0,
  };
}

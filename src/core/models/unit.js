import { newId } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';
import { trimOrEmpty } from '../../utils/text.js';

export function createUnit(input = {}) {
  const ts = nowIso();
  return {
    id: input.id || newId(),
    code: trimOrEmpty(input.code),
    name: trimOrEmpty(input.name),
    createdAt: input.createdAt || ts,
    updatedAt: input.updatedAt || ts,
    version: Number.isInteger(input.version) ? input.version : 0,
  };
}

import { newId } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';
import { trimOrEmpty } from '../../utils/text.js';

/**
 * The one grammar for a scenario code, shared by the model, the master-data
 * form, the import boundary and the formula parser: a letter, then up to
 * seven letters, digits or underscores. `[2026:REVENUE]` would otherwise be
 * accepted by the form and read by the parser as a metric named
 * "2026:REVENUE".
 */
export const SCENARIO_CODE = /^[A-Z][A-Z0-9_]{0,7}$/;

export function isValidScenarioCode(code) {
  return SCENARIO_CODE.test(String(code || '').trim().toUpperCase());
}

export function createScenario(input = {}) {
  const ts = nowIso();
  return {
    id: input.id || newId(),
    code: trimOrEmpty(input.code).toUpperCase(),
    name: trimOrEmpty(input.name),
    description: trimOrEmpty(input.description),
    sortOrder: Number.isFinite(input.sortOrder) ? input.sortOrder : 0,
    createdAt: input.createdAt || ts,
    updatedAt: input.updatedAt || ts,
    version: Number.isInteger(input.version) ? input.version : 0,
  };
}

/** Stable ids so demo data, tests and later imports can refer to them. */
export const SCENARIO_TT_ID = 'scn-tt';
export const SCENARIO_GD_ID = 'scn-gd';

export function defaultScenarios() {
  return [
    createScenario({ id: SCENARIO_TT_ID, code: 'TT', name: 'Thực tế / Actual', sortOrder: 1 }),
    createScenario({ id: SCENARIO_GD_ID, code: 'GD', name: 'Giả định / Planning', sortOrder: 2 }),
  ];
}

/**
 * One serializer for workspace state that lives in the URL.
 *
 * Two intents share it:
 *   Resume        — a top-bar link brings the person back to the workspace
 *                   as they left it: the route remembered for the page
 *                   carries context, filters, query and selection.
 *   Drill-through — a tile, a stat or an issue elsewhere opens the
 *                   workspace with an explicit context and filter, which
 *                   replace whatever was remembered.
 *
 * Both are the same URL contract, so a bookmark, Back/Forward and a refresh
 * mean the same thing as the links inside the app.
 *
 * Filters are written as plain params; a toggle is `1` or absent; the search
 * box is `q`. A view reads them back with readFilters and applies them
 * through its filter bar, which keeps the chips in step.
 */
export function writeFilters(router, values, spec) {
  const patch = {};
  for (const [key, def] of Object.entries(spec)) {
    const v = values[key];
    const param = def.param || key;
    patch[param] = def.type === 'toggle' ? (v ? '1' : null) : (v == null || v === '' ? null : String(v));
  }
  router.setParams(patch);
}

export function readFilters(params, spec) {
  const out = {};
  for (const [key, def] of Object.entries(spec)) {
    const param = def.param || key;
    const raw = params[param];
    out[key] = def.type === 'toggle' ? raw === '1' || raw === 'true' : (raw == null ? '' : String(raw));
  }
  return out;
}

/** Whether applying `wanted` would change `current` for the keys in `spec`. */
export function filtersDiffer(current, wanted, spec) {
  for (const key of Object.keys(spec)) {
    const a = current[key] == null ? '' : current[key];
    const b = wanted[key] == null ? '' : wanted[key];
    if (String(a) !== String(b)) return true;
  }
  return false;
}

/**
 * Coverage over the scenarios in context: with fewer than two there is no
 * "partial", so that filter goes back to "all" rather than silently hiding
 * every row.
 */
export function normalizeCoverage(coverage, scenarioCount) {
  if (coverage === 'partial' && scenarioCount < 2) return '';
  return coverage;
}

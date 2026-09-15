import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFilters, readFilters, filtersDiffer, normalizeCoverage } from '../src/ui/workspace/route-state.js';
import { resolvePage, groupOf, NAV_GROUPS, UTILITY_PAGES } from '../src/ui/nav/registry.js';
import { scopedRouter } from '../src/ui/router.js';

/** A router double that records what setParams was asked to do. */
function fakeRouter() {
  const calls = [];
  return { calls, setParams: (patch) => calls.push(patch) };
}

test('U06: filters round-trip through the URL: toggles as 1/absent, selects as strings, empties dropped', () => {
  const spec = { status: {}, unitId: { param: 'unit' }, warningsOnly: { type: 'toggle', param: 'warn' }, direct: { type: 'toggle' } };
  const router = fakeRouter();
  writeFilters(router, { status: 'draft', unitId: '', warningsOnly: true, direct: false }, spec);
  assert.deepEqual(router.calls[0], { status: 'draft', unit: null, warn: '1', direct: null });
  const back = readFilters({ status: 'draft', warn: '1' }, spec);
  assert.deepEqual(back, { status: 'draft', unitId: '', warningsOnly: true, direct: false });
  assert.equal(filtersDiffer({ status: 'draft', unitId: '', warningsOnly: true, direct: false }, back, spec), false);
  assert.equal(filtersDiffer({ status: '', unitId: '', warningsOnly: true, direct: false }, back, spec), true);
});

test('U05: "partial" coverage cannot survive a one-scenario context', () => {
  assert.equal(normalizeCoverage('partial', 1), '');
  assert.equal(normalizeCoverage('partial', 2), 'partial');
  assert.equal(normalizeCoverage('complete', 1), 'complete');
  assert.equal(normalizeCoverage('missing', 0), 'missing');
});

test('U01: the navigation registry resolves pages, aliases and groups', () => {
  assert.equal(resolvePage('warnings'), 'quality');
  assert.equal(resolvePage('nope'), null);
  assert.equal(resolvePage('master-data'), 'master-data');
  assert.equal(groupOf('dependencies').id, 'logic');
  assert.equal(groupOf('backup'), null);
  const all = NAV_GROUPS.flatMap((g) => g.pages).concat(UTILITY_PAGES);
  assert.equal(new Set(all).size, all.length, 'no page is listed twice');
});

/**
 * A view keeps its subscriptions while it is hidden, so a change elsewhere
 * can move its selection at any time. What it may not do is say so in the
 * URL of the page someone else is looking at.
 */
test('a view writes the route only while its own page is the current one', () => {
  const written = [];
  const router = {
    current: { path: 'bindings', params: { selected: 'm-volume' } },
    setParams: (patch) => written.push(patch),
    navigate: () => { throw new Error('not called'); },
  };
  const metricMaster = scopedRouter(router, 'metrics');

  // Metric Master is mounted but hidden: its selected row stopped matching a
  // filter, so it clears its selection.
  metricMaster.setParams({ selected: null });
  assert.deepEqual(written, [], 'the route of the page on screen is untouched');

  // The user comes back to it, and now the same write is its own business.
  router.current = { path: 'metrics', params: {} };
  metricMaster.setParams({ selected: 'm-revenue' });
  assert.deepEqual(written, [{ selected: 'm-revenue' }]);

  // Everything else is the router itself: navigating is something a person asked for.
  assert.equal(metricMaster.navigate, router.navigate);
  assert.deepEqual(metricMaster.current, router.current);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createContext, TT, GD } from './_setup.mjs';
import { MemoryRepository, UniquenessError } from '../src/repositories/memory-repository.js';
import { ConflictError, tokenOf } from '../src/repositories/repository.js';
import { Store } from '../src/core/store/store.js';
import { createSelectors } from '../src/core/store/selectors.js';
import { DependencyService, unknownScenarioId, SUBGRAPH_NODE_LIMIT } from '../src/services/dependency-service.js';
import { createBinding } from '../src/core/models/binding.js';
import { createMetric } from '../src/core/models/metric.js';
import { createStructureNode, createMetricStructure } from '../src/core/models/structure.js';
import { createDimension, createDimensionMember } from '../src/core/models/dimension.js';
import { parseSnapshot } from '../src/services/snapshot-schema.js';
import { validateAll } from '../src/services/validation-service.js';
import { servablePath, createStaticServer } from '../scripts/serve.mjs';

/**
 * Regressions.
 *
 * One test per bug found in the third code review, each written so that it
 * fails on the code as it was. They are grouped by the layer the bug lived
 * in, not by the review's numbering, so the file stays readable as the
 * codebase moves on.
 */

// ------------------------------------------------------------ concurrency

test('two writes racing on the same record cannot both win', async () => {
  const repo = new MemoryRepository();
  await repo.init();
  const saved = await repo.save('metrics', createMetric({ name: 'Doanh thu', code: 'M.000001' }));
  const token = tokenOf(saved);

  // Both callers read the same token, then write without awaiting each other.
  const results = await Promise.allSettled([
    repo.save('metrics', { ...saved, name: 'A' }, token),
    repo.save('metrics', { ...saved, name: 'B' }, token),
  ]);
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(rejected.length, 1, 'exactly one write is refused');
  assert.ok(rejected[0].reason instanceof ConflictError);
  const current = await repo.get('metrics', saved.id);
  assert.equal(current.version, saved.version + 1, 'only one version was consumed');
});

test('two writes racing on the same unique relationship cannot both land', async () => {
  const repo = new MemoryRepository();
  await repo.init();
  const link = () => createMetricStructure({ metricId: 'm-1', structureNodeId: 's-1' });
  const results = await Promise.allSettled([
    repo.save('metricStructures', link()),
    repo.save('metricStructures', link()),
  ]);
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof UniquenessError);
  assert.equal((await repo.list('metricStructures')).length, 1, 'the relationship exists once');
});

test('a batch reports records that were already gone so the mirror can drop them', async () => {
  const repo = new MemoryRepository();
  await repo.init();
  const node = await repo.save('structureNodes', createStructureNode({ name: 'Nhóm' }));
  const link = await repo.save('metricStructures', createMetricStructure({ metricId: 'm-1', structureNodeId: node.id }));
  // Someone else removed the placement between our read and our write.
  await repo.remove('metricStructures', link.id, tokenOf(link));

  const result = await repo.applyBatch([
    { op: 'remove', collection: 'metricStructures', id: link.id, expectedToken: tokenOf(link), optional: true },
    { op: 'remove', collection: 'structureNodes', id: node.id, expectedToken: tokenOf(node) },
  ]);
  assert.deepEqual(result.alreadyGone, [{ collection: 'metricStructures', id: link.id }]);
  assert.ok(result.removed.some((r) => r.id === link.id), 'the vanished record is still reported as removed');
});

// ------------------------------------------------------------ model boundary

test('a binding sanitises whatever an import put in parsedReferences', () => {
  const b = createBinding({
    metricId: 'm-1',
    scenarioId: TT,
    type: 'formula',
    formulaText: '[A] + [B]',
    parsedReferences: [
      null,
      'a bare string',
      { token: '' },
      { token: 'A', scenarioCode: 'tt', status: 'nonsense', metricId: 42, dimensionContext: 'not an array' },
      { token: 'B', dimensionContext: [{ dimension: 'Product', member: 'HRC' }, { member: 'orphan' }] },
    ],
    formulaErrors: [null, 'x', { message: 'bad' }],
  });
  assert.equal(b.parsedReferences.length, 2, 'unusable entries are dropped');
  const [a, bb] = b.parsedReferences;
  assert.equal(a.scenarioCode, 'TT');
  assert.equal(a.status, 'missing', 'an unknown status falls back to missing');
  assert.equal(a.metricId, null, 'a non-string id is not kept');
  assert.equal(a.dimensionContext, null);
  assert.deepEqual(bb.dimensionContext, [{ dimension: 'Product', member: 'HRC' }]);
  assert.ok(b.formulaErrors.every((e) => e && typeof e === 'object'));
});

test('an import with malformed references is repaired, not crashed on', async () => {
  const ctx = await createContext();
  const snapshot = JSON.parse(JSON.stringify(ctx.backup.exportSnapshot()));
  const formula = snapshot.data.bindings.find((b) => b.type === 'formula');
  formula.parsedReferences = [null, { token: '' }, 'junk', ...formula.parsedReferences];

  const parsed = parseSnapshot(snapshot);
  assert.equal(parsed.ok, true, 'the file is still usable');
  assert.ok(parsed.repairs.some((r) => r.code === 'REFERENCE_DROPPED'), 'the repair is reported');

  await ctx.backup.importSnapshot(snapshot);
  // Validation walks every reference; it used to throw on a null entry.
  const issues = validateAll({ store: ctx.store, selectors: ctx.selectors, dependencies: ctx.dependencies });
  assert.ok(Array.isArray(issues));
});

// ------------------------------------------------------------ traversals

test('a cyclic structure hierarchy renders instead of overflowing the stack', async () => {
  const ctx = await createContext({ seed: false });
  const a = createStructureNode({ id: 's-a', name: 'A' });
  const b = createStructureNode({ id: 's-b', name: 'B', parentId: 's-a' });
  a.parentId = 's-b'; // the cycle an interrupted move can leave behind
  ctx.store.hydrate({ structureNodes: [a, b] });

  assert.deepEqual(ctx.selectors.nodeCounts('s-a'), { direct: 0, total: 0 });
  const issues = validateAll({ store: ctx.store, selectors: ctx.selectors, dependencies: ctx.dependencies });
  assert.equal(issues.filter((i) => i.code === 'STRUCTURE_CYCLE').length, 1, 'reported as a finding');
});

test('dimension members are deleted children first', async () => {
  const ctx = await createContext({ seed: false });
  const dim = createDimension({ id: 'd-1', name: 'Sản phẩm', code: 'DIM01' });
  const tree = [];
  let parentId = null;
  for (let level = 0; level < 4; level += 1) {
    const m = createDimensionMember({ id: `dm-${level}`, dimensionId: 'd-1', name: `L${level}`, parentId, level });
    tree.push(m);
    parentId = m.id;
  }
  ctx.store.hydrate(await ctx.repo.replaceAll({ dimensions: [dim], dimensionMembers: tree }));

  const order = [];
  const realBatch = ctx.repo._applyBatchNow.bind(ctx.repo);
  ctx.repo._applyBatchNow = (ops) => {
    for (const op of ops) if (op.op === 'remove' && op.collection === 'dimensionMembers') order.push(op.id);
    return realBatch(ops);
  };
  await ctx.dimensions.deleteDimension('d-1');
  assert.deepEqual(order, ['dm-3', 'dm-2', 'dm-1', 'dm-0'], 'deepest member first');
});

// ------------------------------------------------------------ dependency graph

test('a reference to a scenario that does not exist gets its own node', async () => {
  const ctx = await createContext();
  await ctx.bindings.setBinding('m-margin', TT, { type: 'formula', formulaText: '[XX:REVENUE] * 1' });
  const out = ctx.dependencies.edgesFrom(`m-margin|${TT}`);
  assert.equal(out.length, 1);
  const [edge] = out;
  assert.equal(edge.resolved, false, 'an unknown scenario is not a resolved dependency');
  assert.equal(edge.scenarioResolved, false);
  assert.equal(edge.targetScenarioId, unknownScenarioId('XX'));
  assert.notEqual(edge.to, `m-revenue|${TT}`, 'it must not collapse onto the real TT node');

  // The real node keeps only the dependents it actually has.
  assert.equal(ctx.dependencies.edgesTo(`m-revenue|${TT}`).some((e) => e.from === `m-margin|${TT}`), false);

  const info = ctx.dependencies.nodeInfo(edge.to);
  assert.equal(info.unknownScenario, true);
  assert.equal(info.scenarioCode, 'XX');
  assert.equal(info.binding, null, 'no binding is claimed for a scenario that does not exist');

  // And the node is a leaf: nothing is expanded through it.
  const g = ctx.dependencies.subgraph({ metricId: 'm-margin', scenarioId: TT, depthDown: 3, depthUp: 0 });
  assert.ok(g.nodes.has(edge.to));
  assert.equal(g.nodes.get(edge.to).hasMoreDown, false);
});

test('a hub metric does not lay out the whole catalogue', async () => {
  const { store, selectors } = fanIn(1200);
  const dep = new DependencyService(store, selectors);

  const g = dep.subgraph({ metricId: 'm-hub', scenarioId: TT, depthDown: 0, depthUp: 1 });
  assert.equal(g.truncated, true);
  assert.equal(g.nodes.size, SUBGRAPH_NODE_LIMIT);
  assert.equal(g.nodeLimit, SUBGRAPH_NODE_LIMIT);
  assert.equal(g.nodes.get(`m-hub|${TT}`).hasMoreUp, true, 'the fringe is still marked');
  // Every drawn edge has both endpoints, or the layout would place a ghost.
  for (const e of g.edges) {
    assert.ok(g.nodes.has(e.from), `edge source ${e.from} is present`);
    assert.ok(g.nodes.has(e.to), `edge target ${e.to} is present`);
  }

  const small = dep.subgraph({ metricId: 'm-hub', scenarioId: TT, depthDown: 0, depthUp: 1, maxNodes: 10 });
  assert.equal(small.nodes.size, 10);
  assert.equal(small.truncated, true);
});

test('cycle detection stays linear in the number of edges', async () => {
  const { store, selectors } = fanOut(5000);
  const dep = new DependencyService(store, selectors);
  const started = Date.now();
  assert.equal(dep.findCycles().length, 0);
  const elapsed = Date.now() - started;
  // Before the fix the successor list of a node was rebuilt on every step of
  // the walk over that same list: one node with 5,000 dependencies cost
  // 25,000,000 operations, ~750 ms. A generous ceiling still catches a
  // return to quadratic behaviour.
  assert.ok(elapsed < 250, `findCycles took ${elapsed}ms`);
});

const SCENARIOS = [
  { id: TT, code: 'TT', name: 'Thực tế', sortOrder: 0, version: 0 },
  { id: GD, code: 'GD', name: 'Giả định', sortOrder: 1, version: 0 },
];

/** A store where `n` metrics all depend on one hub metric, in TT. */
function fanIn(n) {
  const store = new Store();
  const selectors = createSelectors(store);
  const metrics = [createMetric({ id: 'm-hub', name: 'Hub', code: 'M.000000' })];
  const bindings = [];
  for (let i = 0; i < n; i += 1) {
    const id = `m-${i}`;
    metrics.push(createMetric({ id, name: `Metric ${i}`, code: `M.${String(i + 1).padStart(6, '0')}` }));
    bindings.push(createBinding({
      id: `b-${i}`,
      metricId: id,
      scenarioId: TT,
      type: 'formula',
      formulaText: '[Hub]',
      parsedReferences: [{ raw: '[Hub]', token: 'Hub', metricId: 'm-hub', scenarioId: TT, status: 'resolved' }],
    }));
  }
  store.hydrate({ metrics, bindings, scenarios: SCENARIOS });
  return { store, selectors };
}

/** A store where one hub metric depends on `n` metrics, in TT. */
function fanOut(n) {
  const store = new Store();
  const selectors = createSelectors(store);
  const metrics = [createMetric({ id: 'm-hub', name: 'Hub', code: 'M.000000' })];
  const references = [];
  for (let i = 0; i < n; i += 1) {
    const id = `m-${i}`;
    metrics.push(createMetric({ id, name: `Metric ${i}`, code: `M.${String(i + 1).padStart(6, '0')}` }));
    references.push({ raw: `[Metric ${i}]`, token: `Metric ${i}`, metricId: id, scenarioId: TT, status: 'resolved' });
  }
  const bindings = [createBinding({
    id: 'b-hub',
    metricId: 'm-hub',
    scenarioId: TT,
    type: 'formula',
    formulaText: references.map((r) => r.raw).join(' + '),
    parsedReferences: references,
  })];
  store.hydrate({ metrics, bindings, scenarios: SCENARIOS });
  return { store, selectors };
}

// ------------------------------------------------------------ dev server

test('the dev server serves the published site and nothing else', async () => {
  for (const path of ['/', '/index.html', '/css/app.css', '/src/app.js']) {
    assert.ok(servablePath(path), `${path} is served`);
  }
  for (const path of ['/package.json', '/tests/_setup.mjs', '/docs/ARCHITECTURE.md', '/scripts/serve.mjs', '/.git/config', '/.env', '/node_modules/anything', '/src/../package.json', '/css/../.git/config']) {
    assert.equal(servablePath(path), null, `${path} is refused`);
  }

  const server = createStaticServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/index.html`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-security-policy') || '', /script-src 'self'/);
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    const denied = await fetch(`${base}/package.json`);
    assert.equal(denied.status, 404);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

// ------------------------------------------------------- wave 2: cross-record invariants

test('two opposing moves cannot both succeed and make a cycle', async () => {
  const ctx = await createContext({ seed: false });
  const a = createStructureNode({ id: 's-a', name: 'A' });
  const b = createStructureNode({ id: 's-b', name: 'B' });
  ctx.store.hydrate(await ctx.repo.replaceAll({ structureNodes: [a, b] }));

  const results = await Promise.allSettled([
    ctx.structure.moveNode('s-a', 's-b'),
    ctx.structure.moveNode('s-b', 's-a'),
  ]);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1, 'one move is refused');
  const pa = ctx.store.get('structureNodes', 's-a').parentId;
  const pb = ctx.store.get('structureNodes', 's-b').parentId;
  assert.ok(!(pa === 's-b' && pb === 's-a'), `A→${pa} and B→${pb} is a cycle`);
});

test('a cascade sees records created after the store was last mirrored', async () => {
  const ctx = await createContext();
  const metric = await ctx.metrics.create({ name: 'Chỉ tiêu mới' });
  // A binding lands in the repository without the store hearing about it,
  // which is what a second tab or a lost notification looks like.
  await ctx.repo.save('bindings', createBinding({ id: 'b-unseen', metricId: metric.id, scenarioId: GD, type: 'source' }), null);
  assert.equal(ctx.store.has('bindings', 'b-unseen'), false, 'the store does not know about it');

  await ctx.metrics.remove(metric.id);
  const left = (await ctx.repo.list('bindings')).filter((b) => b.metricId === metric.id);
  assert.deepEqual(left, [], 'no binding outlives the metric it belongs to');
});

test('concurrent creates never share a canonical code', async () => {
  const ctx = await createContext({ seed: false });
  const metrics = await Promise.all([1, 2, 3, 4, 5].map((n) => ctx.metrics.create({ name: `Metric ${n}` })));
  const codes = metrics.map((m) => m.code);
  assert.equal(new Set(codes).size, codes.length, `duplicate codes: ${codes.join(' ')}`);

  const dims = await Promise.all([1, 2, 3].map((n) => ctx.dimensions.createDimension({ name: `Dim ${n}` })));
  const dimCodes = dims.map((d) => d.code);
  assert.equal(new Set(dimCodes).size, dimCodes.length, `duplicate dimension codes: ${dimCodes.join(' ')}`);
});

test('an optimistic write is re-checked against the durable store, not the mirror', async () => {
  // A repository whose durable store can be changed by someone else, which is
  // what a second tab on the same IndexedDB is. The mirror check passes; only
  // a check inside the commit can catch it.
  const shared = new Map();
  class SharedRepo extends MemoryRepository {
    describe() { return { persistent: true, kind: 'shared', atomicBatch: true, restorePoints: false }; }
    async _commit(plan) {
      for (const p of plan.puts || []) {
        if (p.expected === undefined) continue;
        const stored = shared.get(p.record.id) || null;
        const actual = stored ? tokenOf(stored) : null;
        if (actual !== p.expected) throw new ConflictError(p.collection, p.record.id, p.expected, stored);
      }
      for (const p of plan.puts || []) shared.set(p.record.id, p.record);
      for (const d of plan.deletes || []) shared.delete(d.id);
    }
  }
  const repo = new SharedRepo();
  await repo.init();
  const saved = await repo.save('metrics', createMetric({ id: 'm-1', name: 'Doanh thu', code: 'M.000001' }));

  // Someone else advances the durable record. Our mirror still shows v1.
  shared.set('m-1', { ...saved, version: 2, concurrencyToken: '2', name: 'theirs' });

  await assert.rejects(
    () => repo.save('metrics', { ...saved, name: 'mine' }, tokenOf(saved)),
    (err) => err instanceof ConflictError,
    'a stale token is refused by the store that actually holds the record',
  );
  assert.equal(shared.get('m-1').name, 'theirs', 'their write survives');
});

// ------------------------------------------------------- wave 2: import fidelity

test('a damaged reference cache is rebuilt from the formula text', async () => {
  const ctx = await createContext();
  const before = ctx.dependencies.edgesFrom(`m-revenue|${TT}`).map((e) => e.token).sort();
  assert.deepEqual(before, ['PRICE', 'VOLUME']);

  const snapshot = JSON.parse(JSON.stringify(ctx.backup.exportSnapshot()));
  const b = snapshot.data.bindings.find((x) => x.metricId === 'm-revenue' && x.scenarioId === TT);
  b.parsedReferences = [null, null]; // the cache is rubbish; the formula is not

  const parsed = parseSnapshot(snapshot);
  assert.ok(parsed.repairs.some((r) => r.code === 'REFERENCE_REPARSED'));
  await ctx.backup.importSnapshot(snapshot);

  const after = ctx.dependencies.edgesFrom(`m-revenue|${TT}`).map((e) => e.token).sort();
  assert.deepEqual(after, ['PRICE', 'VOLUME'], 'the dependencies the formula states are back');
});

test('a reference cache that disagrees with the formula loses', async () => {
  const ctx = await createContext();
  const snapshot = JSON.parse(JSON.stringify(ctx.backup.exportSnapshot()));
  const b = snapshot.data.bindings.find((x) => x.metricId === 'm-revenue' && x.scenarioId === TT);
  // Right number of references, wrong references: a count check would pass.
  b.parsedReferences = [
    { raw: '[OPEX]', token: 'OPEX', metricId: 'm-opex', scenarioId: TT, status: 'resolved' },
    { raw: '[PRICE]', token: 'PRICE', metricId: 'm-price', scenarioId: TT, status: 'resolved' },
  ];
  const parsed = parseSnapshot(snapshot);
  const out = parsed.data.bindings.find((x) => x.id === b.id);
  assert.deepEqual(out.parsedReferences.map((r) => r.token).sort(), ['PRICE', 'VOLUME']);
  assert.ok(parsed.repairs.some((r) => r.code === 'REFERENCE_REPARSED'));
});

test('a dimension context of the wrong type is rebuilt, not dropped', async () => {
  const ctx = await createContext();
  const snapshot = JSON.parse(JSON.stringify(ctx.backup.exportSnapshot()));
  const b = snapshot.data.bindings.find((x) => x.metricId === 'm-revenue' && x.scenarioId === TT);
  b.formulaText = '[VOLUME | Product=HRC] * [PRICE]';
  b.parsedReferences = [{ token: 'VOLUME', dimensionContext: 'not an array' }, { token: 'PRICE' }];
  const out = parseSnapshot(snapshot).data.bindings.find((x) => x.id === b.id);
  const volume = out.parsedReferences.find((r) => r.token === 'VOLUME');
  assert.deepEqual(volume.dimensionContext, [{ dimension: 'Product', member: 'HRC' }]);
});

test('a binding that is not a formula keeps no formula references', async () => {
  const ctx = await createContext();
  const snapshot = JSON.parse(JSON.stringify(ctx.backup.exportSnapshot()));
  const b = snapshot.data.bindings.find((x) => x.type === 'source');
  b.parsedReferences = [{ token: 'REVENUE', metricId: 'm-revenue', status: 'resolved' }];
  const parsed = parseSnapshot(snapshot);
  assert.equal(parsed.data.bindings.find((x) => x.id === b.id).parsedReferences.length, 0);
  assert.ok(parsed.repairs.some((r) => r.code === 'REFERENCE_DROPPED'));
});

test('parsing a snapshot grows with the file, not with its square', async () => {
  const { buildLargeSnapshot } = await import('../src/data/seed.js');
  const work = (n) => {
    const data = buildLargeSnapshot({ metrics: n, dimensions: 10 });
    const started = process.hrtime.bigint();
    const r = parseSnapshot({ app: 'metric-studio', schemaVersion: 1, data });
    assert.equal(r.ok, true);
    return { ms: Number(process.hrtime.bigint() - started) / 1e6, bindings: data.bindings.length };
  };
  work(500); // warm the JIT so the first real sample is not the outlier
  const small = work(2000);
  const large = work(8000);
  const dataRatio = large.bindings / small.bindings;
  const timeRatio = large.ms / Math.max(small.ms, 1);
  // Quadratic would be ~16x for 4x the data. Linear is ~4x; allow generous
  // headroom for a noisy machine while still failing on a square.
  assert.ok(timeRatio < dataRatio * 2.5, `x${dataRatio.toFixed(1)} data took x${timeRatio.toFixed(1)} time (${small.ms.toFixed(0)}ms → ${large.ms.toFixed(0)}ms)`);
});

// ------------------------------------------------------- wave 2: graph and editor

test('a dense subgraph is bounded by edges, not only by nodes', async () => {
  const { store, selectors } = complete(200);
  const dep = new DependencyService(store, selectors);
  const g = dep.subgraph({ metricId: 'm-199', scenarioId: TT, depthDown: 5, depthUp: 1 });
  assert.equal(g.truncated, true);
  assert.ok(g.edges.length <= g.edgeLimit, `${g.edges.length} edges over a budget of ${g.edgeLimit}`);
  assert.ok(g.nodes.size <= g.nodeLimit);
  for (const e of g.edges) {
    assert.ok(g.nodes.has(e.from) && g.nodes.has(e.to), 'every drawn edge has both ends');
  }
  const tight = dep.subgraph({ metricId: 'm-199', scenarioId: TT, depthDown: 5, depthUp: 1, maxEdges: 25 });
  assert.ok(tight.edges.length <= 25);
});

/** `n` metrics where each depends on every earlier one: n(n-1)/2 edges. */
function complete(n) {
  const store = new Store();
  const selectors = createSelectors(store);
  const metrics = [];
  const bindings = [];
  for (let i = 0; i < n; i += 1) metrics.push(createMetric({ id: `m-${i}`, name: `M${i}`, code: `M.${String(i).padStart(6, '0')}` }));
  for (let i = 1; i < n; i += 1) {
    const refs = [];
    for (let j = 0; j < i; j += 1) refs.push({ raw: `[M${j}]`, token: `M${j}`, metricId: `m-${j}`, scenarioId: TT, status: 'resolved' });
    bindings.push(createBinding({ id: `b-${i}`, metricId: `m-${i}`, scenarioId: TT, type: 'formula', formulaText: refs.map((r) => r.raw).join(' + '), parsedReferences: refs }));
  }
  store.hydrate({ metrics, bindings, scenarios: SCENARIOS });
  return { store, selectors };
}

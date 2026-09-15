import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, TT, GD } from './_setup.mjs';
import { DB_VERSION } from '../src/repositories/local-repository.js';
import { freshFactory, freshDbName, openRepo, openTab, reload, rawOpen, rawDone, rawAll } from './_idb.mjs';
import { MemoryRepository } from '../src/repositories/memory-repository.js';
import { PartialBatchError, StorageUnavailableError, COLLECTIONS, tokenOf } from '../src/repositories/repository.js';
import { commit, UnitOfWork } from '../src/services/unit-of-work.js';
import { validateAll } from '../src/services/validation-service.js';
import { parseFormula, FORMULA_LIMITS } from '../src/services/formula-parser.js';
import { toCsv, EDGE_COLUMNS, needsSpreadsheetGuard } from '../src/services/export-tables.js';
import { createBinding } from '../src/core/models/binding.js';

/**
 * Production-hardening regressions from the handover review (D01–D08).
 * Each test reproduces the reported failure first, then asserts the fix.
 */

// ------------------------------------------------------------ D01 partial batch on a non-atomic backend

/** A backend that applies operations one by one and gives up at the N-th. */
class HalfwayRepository extends MemoryRepository {
  constructor(failAt) {
    super();
    this.failAt = failAt;
  }

  describe() {
    return { ...super.describe(), atomicBatch: false };
  }

  async _commit(plan) {
    if (this.failAt == null || !plan.ops) return;
    const done = [];
    for (let i = 0; i < plan.ops.length; i += 1) {
      const op = plan.ops[i];
      if (i === this.failAt) {
        // Everything before this point is already durable on a backend
        // without rollback; the mirror must learn that.
        for (const d of done) {
          if (d.kind === 'put') this._data[d.collection].set(d.record.id, d.record);
          else this._data[d.collection].delete(d.id);
        }
        throw new PartialBatchError({
          completed: done.map((d) => ({ op: d.kind, collection: d.collection, id: d.kind === 'put' ? d.record.id : d.id })),
          failed: [{ op: op.kind, collection: op.collection, id: op.kind === 'put' ? op.record.id : op.id }],
          unknown: plan.ops.slice(i + 1).map((o) => ({ op: o.kind, collection: o.collection, id: o.kind === 'put' ? o.record.id : o.id })),
        });
      }
      done.push(op);
    }
  }
}

test('D01: a batch that stops halfway reconciles the store from the backend, and a retry from the store succeeds', async () => {
  const repo = new HalfwayRepository(null);
  const ctx = await createContext({ seed: false });
  ctx.repo = repo;
  const { store } = ctx;
  const a = { id: 'm-a', name: 'A', code: 'M.000001', aliases: [], tags: [], owners: [] };
  const b = { id: 'm-b', name: 'B', code: 'M.000002', aliases: [], tags: [], owners: [] };
  const c = { id: 'm-c', name: 'C', code: 'M.000003', aliases: [], tags: [], owners: [] };
  store.hydrate(await repo.replaceAll({ metrics: [a, b, c] }));
  const before = { a: tokenOf(store.get('metrics', 'm-a')), b: tokenOf(store.get('metrics', 'm-b')), c: tokenOf(store.get('metrics', 'm-c')) };

  repo.failAt = 2; // A and B land, C fails
  const work = new UnitOfWork()
    .save('metrics', { ...store.get('metrics', 'm-a'), name: 'A2' }, before.a)
    .save('metrics', { ...store.get('metrics', 'm-b'), name: 'B2' }, before.b)
    .save('metrics', { ...store.get('metrics', 'm-c'), name: 'C2' }, before.c);
  const err = await commit(repo, store, work).catch((e) => e);
  assert.ok(err instanceof PartialBatchError, 'the partial state is reported as such');
  assert.equal(err.reconciled, true, 'the touched records were re-read from the backend');
  assert.equal(store.get('metrics', 'm-a').name, 'A2', 'the store shows what the backend holds for A');
  assert.equal(store.get('metrics', 'm-b').name, 'B2');
  assert.equal(store.get('metrics', 'm-c').name, 'C', 'C did not land and the store says so');
  assert.notEqual(tokenOf(store.get('metrics', 'm-a')), before.a, 'the token moved with the backend');
  assert.equal(store.sync.ok, true);

  // The retry is built from the store — fresh tokens — not from the old batch.
  repo.failAt = null;
  const retry = new UnitOfWork().save('metrics', { ...store.get('metrics', 'm-c'), name: 'C2' }, tokenOf(store.get('metrics', 'm-c')));
  await commit(repo, store, retry);
  assert.equal(store.get('metrics', 'm-c').name, 'C2');
  assert.deepEqual([...store.list('metrics')].map((m) => m.name).sort(), ['A2', 'B2', 'C2']);
});

test('D01: when the reconciling read itself fails, the store marks the collections unsynced instead of guessing', async () => {
  const repo = new HalfwayRepository(1);
  const ctx = await createContext({ seed: false });
  const { store } = ctx;
  store.hydrate(await repo.replaceAll({ metrics: [{ id: 'm-a', name: 'A', code: 'M.000001' }, { id: 'm-b', name: 'B', code: 'M.000002' }] }));
  repo.get = async () => { throw new Error('backend unreachable'); };
  const events = [];
  store.events.on('sync', (s) => events.push(s));
  const work = new UnitOfWork()
    .save('metrics', { ...store.get('metrics', 'm-a'), name: 'A2' }, tokenOf(store.get('metrics', 'm-a')))
    .save('metrics', { ...store.get('metrics', 'm-b'), name: 'B2' }, tokenOf(store.get('metrics', 'm-b')));
  const err = await commit(repo, store, work).catch((e) => e);
  assert.ok(err instanceof PartialBatchError);
  assert.equal(err.reconciled, false);
  assert.equal(store.sync.ok, false);
  assert.deepEqual(store.sync.collections, ['metrics']);
  assert.equal(events.length, 1);
  // A hydrate from the backend clears the flag.
  repo.get = MemoryRepository.prototype.get;
  store.hydrate(await repo.loadAll());
  assert.equal(store.sync.ok, true);
});

// ------------------------------------------------------------ D02 superseded connection

test('D02: a repository whose database was taken over by a newer tab refuses writes instead of acknowledging them', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const tab = await openTab(factory, dbName, { seed: true });
  const statuses = [];
  tab.repo.onStatusChange((info) => statuses.push(info));
  // A newer release opens the database at a higher version; our connection
  // steps aside on versionchange.
  const newer = await rawOpen(factory, dbName, 99, () => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tab.repo.describe().reason, 'superseded');
  assert.equal(tab.repo.describe().writable, false);
  assert.equal(statuses.length, 1, 'the status change was announced');

  const m = tab.store.list('metrics')[0];
  const err = await tab.metrics.update(m.id, { name: 'Ghi đè' }, tokenOf(m)).catch((e) => e);
  assert.ok(err instanceof StorageUnavailableError, `writes fail closed: ${err && err.name}`);
  assert.equal(tab.store.get('metrics', m.id).name, m.name, 'the store did not mirror a write that never landed');
  const allocErr = await tab.repo.allocateCode('metrics', { prefix: 'M.', width: 6, pattern: /^M\.(\d+)$/ }).catch((e) => e);
  assert.ok(allocErr instanceof StorageUnavailableError, 'code allocation fails closed too');
  const rpErr = await tab.repo.createRestorePoint('x').catch((e) => e);
  assert.ok(rpErr instanceof StorageUnavailableError, 'restore points fail closed too');
  newer.close();
});

test('D02: a session that never had IndexedDB still writes to memory, and says so', async () => {
  const { LocalRepository } = await import('../src/repositories/local-repository.js');
  const repo = new LocalRepository({ indexedDB: null });
  await repo.init();
  assert.equal(repo.describe().persistent, false);
  assert.equal(repo.describe().writable, true);
  await repo.save('metrics', { id: 'm-1', name: 'x', code: 'M.000001' }, null);
  assert.equal((await repo.get('metrics', 'm-1')).name, 'x');
});

// ------------------------------------------------------------ D03 owner → owners migration

test('D03: a v3 database with a legacy owner opens with owners and keeps the owner through an unrelated edit', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const db = await rawOpen(factory, dbName, 3, (d) => {
    for (const c of COLLECTIONS) d.createObjectStore(c, { keyPath: 'id' });
    d.createObjectStore('_restorePoints', { keyPath: 'id' });
    d.createObjectStore('_sequences', { keyPath: 'id' });
  });
  const tx = db.transaction(['metrics'], 'readwrite');
  tx.objectStore('metrics').put({ id: 'm-1', name: 'Doanh thu', code: 'M.000001', owner: 'Alice, Bob', version: 4, concurrencyToken: '4', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-06-01T00:00:00.000Z', aliases: [], tags: [] });
  tx.objectStore('metrics').put({ id: 'm-2', name: 'Đã có owners', code: 'M.000002', owners: ['Carol'], owner: 'Dave', version: 1 });
  await rawDone(tx);
  db.close();

  const tab = await openTab(factory, dbName);
  const info = tab.repo.describe();
  assert.equal(info.persistent, true, info.detail);
  assert.equal(info.migration.ownersMigrated, 2);
  const m1 = tab.store.get('metrics', 'm-1');
  assert.deepEqual(m1.owners, ['Alice', 'Bob'], 'the legacy owner became owners');
  assert.equal('owner' in m1, false);
  assert.equal(m1.version, 4, 'version untouched');
  assert.equal(tokenOf(m1), '4', 'token untouched');
  assert.equal(m1.updatedAt, '2025-06-01T00:00:00.000Z', 'timestamps untouched');
  assert.deepEqual(tab.store.get('metrics', 'm-2').owners, ['Carol'], 'an existing owners list is never replaced by the legacy field');

  // The reported repro: edit only the name, save, reopen.
  await tab.metrics.update('m-1', { name: 'Doanh thu thuần' }, tokenOf(m1));
  const stored = await rawAll(await rawOpen(factory, dbName, DB_VERSION), 'metrics');
  assert.deepEqual(stored.find((m) => m.id === 'm-1').owners, ['Alice', 'Bob'], 'the owner survived the unrelated edit');
  tab.repo.close();
});

// ------------------------------------------------------------ D04 long formulas

test('D04: a 6,000-reference formula never takes the graph, validation or start-up down', async () => {
  const ctx = await createContext();
  const { store, dependencies, selectors } = ctx;
  const price = selectors.resolveReference('PRICE');
  assert.equal(price.status, 'resolved');
  const long = Array.from({ length: 6000 }, () => '[PRICE]').join(' + ');
  const target = store.list('metrics').find((m) => m.code === 'M.000010');
  // Imported data does not go through the save budget; it lands as-is.
  const parsed = parseFormula(long);
  assert.equal(parsed.ok, true, 'the parser copes with a long flat formula');
  const b = createBinding({ id: 'b-long', metricId: target.id, scenarioId: TT, type: 'formula', formulaText: long, parsedReferences: parsed.references.slice(0, 1).map((r) => ({ ...r, metricId: price.metricId, scenarioId: TT, status: 'resolved' })) });
  store.upsert('bindings', b);
  assert.doesNotThrow(() => dependencies.edges(), 'graph build survives');
  assert.doesNotThrow(() => dependencies.edgeRows());
  assert.doesNotThrow(() => dependencies.referenceRows());
  const issues = validateAll({ store, selectors, dependencies });
  assert.ok(Array.isArray(issues), 'validation survives');
  // The formula is beyond the budget by length: reported on that binding, everything else still validated.
  assert.ok(long.length > FORMULA_LIMITS.maxLength);
  assert.ok(dependencies.graphErrors().some((e) => e.bindingId === 'b-long'), 'the unprocessable binding is reported');
  assert.ok(issues.some((i) => i.code === 'BINDING_FORMULA_UNPROCESSABLE' && i.entity.id === 'b-long'));
  assert.ok(issues.some((i) => i.code !== 'BINDING_FORMULA_UNPROCESSABLE'), 'other rules still ran');
  assert.equal(store.get('bindings', 'b-long').formulaText, long, 'the text is kept for the user to fix');
});

test('D04: nesting beyond the budget is a formula error, not a RangeError', () => {
  const deep = '('.repeat(5000) + '[PRICE]' + ')'.repeat(5000);
  let out;
  assert.doesNotThrow(() => { out = parseFormula(deep); });
  assert.equal(out.ok, false);
  assert.ok(out.errors[0].message.includes('nested'));
  const signs = '-'.repeat(20000) + '[PRICE]';
  assert.doesNotThrow(() => parseFormula(signs));
});

test('D04: saving a formula over the budget is refused with a clear message', async () => {
  const ctx = await createContext();
  const target = ctx.store.list('metrics').find((m) => m.code === 'M.000010');
  const long = Array.from({ length: 6000 }, () => '[PRICE]').join(' + ');
  await assert.rejects(() => ctx.bindings.setBinding(target.id, TT, { type: 'formula', formulaText: long }), (e) => e.name === 'ValidationFailure' && /too long/.test(e.message));
});

// ------------------------------------------------------------ D05 FK and hierarchy checks on dimension paths

test('D05: creating a member for a dimension another tab deleted is refused where the data lives', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName, { seed: true });
  const b = await openTab(factory, dbName);
  const dim = a.store.list('dimensions')[0];
  await b.dimensions.deleteDimension(dim.id);
  await assert.rejects(() => a.dimensions.createMember({ dimensionId: dim.id, name: 'Orphan' }), (e) => e.name === 'NotFoundError');
  const stored = await rawAll(await rawOpen(factory, dbName, DB_VERSION), 'dimensionMembers');
  assert.equal(stored.some((m) => m.dimensionId === dim.id), false, 'no orphan member on disk');
  a.repo.close(); b.repo.close();
});

test('D05: a stale dimension delete does not leave a member another tab just added as an orphan', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName, { seed: true });
  const b = await openTab(factory, dbName);
  const dim = a.store.list('dimensions')[0];
  const added = await b.dimensions.createMember({ dimensionId: dim.id, name: 'Mới thêm' });
  // Tab A does not know about the new member; the guard does.
  await a.dimensions.deleteDimension(dim.id);
  const stored = await rawAll(await rawOpen(factory, dbName, DB_VERSION), 'dimensionMembers');
  assert.equal(stored.some((m) => m.id === added.id), false, 'the retry collected the member the plan had missed');
  assert.equal(stored.some((m) => m.dimensionId === dim.id), false);
  a.repo.close(); b.repo.close();
});

test('D05: a stale structure-node delete re-homes the sub-node another tab just added', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName, { seed: true });
  const b = await openTab(factory, dbName);
  const root = a.selectors.structureTree().roots[0].node;
  const child = a.selectors.structureTree().roots[0].children[0].node;
  const fresh = await b.structure.createNode({ parentId: child.id, name: 'Nhóm mới từ tab B' });
  await a.structure.deleteNode(child.id, { strategy: 'moveToParent' });
  const nodes = await rawAll(await rawOpen(factory, dbName, DB_VERSION), 'structureNodes');
  const moved = nodes.find((n) => n.id === fresh.id);
  assert.ok(moved, 'the new node still exists');
  assert.equal(moved.parentId, root.id, 'and now hangs from the deleted node\'s parent, not from a node that is gone');
  a.repo.close(); b.repo.close();
});

test('D05: opposing member moves in two tabs cannot form a cycle', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName, { seed: true });
  const b = await openTab(factory, dbName);
  const dim = a.store.list('dimensions')[0];
  const x = await a.dimensions.createMember({ dimensionId: dim.id, name: 'X' });
  const y = await a.dimensions.createMember({ dimensionId: dim.id, name: 'Y' });
  await reload(b);
  await a.dimensions.moveMember(x.id, y.id); // X under Y
  // Tab B still thinks both are roots: moving Y under X looks fine to it.
  await assert.rejects(() => b.dimensions.moveMember(y.id, x.id), (e) => e.name === 'ValidationFailure' || e.name === 'StaleCascadeError');
  const members = await rawAll(await rawOpen(factory, dbName, DB_VERSION), 'dimensionMembers');
  const byId = new Map(members.map((m) => [m.id, m]));
  let cur = byId.get(x.id);
  const seen = new Set();
  while (cur && cur.parentId) { assert.ok(!seen.has(cur.id), 'no cycle on disk'); seen.add(cur.id); cur = byId.get(cur.parentId); }
  a.repo.close(); b.repo.close();
});

test('D05: deleting a member re-homes a child another tab added meanwhile', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName, { seed: true });
  const b = await openTab(factory, dbName);
  const dim = a.store.list('dimensions')[0];
  const parent = await a.dimensions.createMember({ dimensionId: dim.id, name: 'Cha' });
  await reload(b);
  const child = await b.dimensions.createMember({ dimensionId: dim.id, parentId: parent.id, name: 'Con từ tab B' });
  await a.dimensions.deleteMember(parent.id, { strategy: 'moveToParent' });
  const members = await rawAll(await rawOpen(factory, dbName, DB_VERSION), 'dimensionMembers');
  const kid = members.find((m) => m.id === child.id);
  assert.ok(kid, 'the child survives');
  assert.equal(kid.parentId, null, 'and moved up to the deleted member\'s parent (root)');
  assert.equal(kid.level, 1);
  a.repo.close(); b.repo.close();
});

// ------------------------------------------------------------ D06 manual codes across tabs

test('D06: two tabs creating a metric with the same manual code: the second is refused by the database', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName, { seed: true });
  const b = await openTab(factory, dbName);
  await a.metrics.create({ name: 'Một', code: 'KPI.001' });
  await assert.rejects(() => b.metrics.create({ name: 'Hai', code: 'kpi.001' }), (e) => e.name === 'ValidationFailure' && e.field === 'code');
  const stored = await rawAll(await rawOpen(factory, dbName, DB_VERSION), 'metrics');
  assert.equal(stored.filter((m) => m.code.toUpperCase() === 'KPI.001').length, 1);
  a.repo.close(); b.repo.close();
});

test('D06: a rename onto a code another tab just took is refused; an unrelated edit of a legacy duplicate is not', async () => {
  const factory = freshFactory();
  const dbName = freshDbName();
  const a = await openTab(factory, dbName, { seed: true });
  const b = await openTab(factory, dbName);
  const [m1, m2] = a.store.list('metrics');
  await a.metrics.update(m1.id, { code: 'X.1' }, tokenOf(m1));
  const m2b = b.store.get('metrics', m2.id);
  await assert.rejects(() => b.metrics.update(m2.id, { code: 'X.1' }, tokenOf(m2b)), (e) => e.name === 'ValidationFailure' && e.field === 'code');
  // Legacy duplicates already on disk (from an import) stay editable.
  const dupA = { id: 'dup-a', name: 'A', code: 'DUP', aliases: [], tags: [], owners: [] };
  const dupB = { id: 'dup-b', name: 'B', code: 'DUP', aliases: [], tags: [], owners: [] };
  await a.repo.saveMany('metrics', [dupA, dupB]);
  await reload(a);
  const stored = a.store.get('metrics', 'dup-a');
  await a.metrics.update('dup-a', { name: 'A renamed' }, tokenOf(stored));
  assert.equal(a.store.get('metrics', 'dup-a').name, 'A renamed');
  a.repo.close(); b.repo.close();
});

// ------------------------------------------------------------ D07 / D08 export

test('D07: spreadsheet-safe CSV neutralises OWASP injection prefixes and the default stays byte-faithful', () => {
  const rows = [{ v: '=1+1' }, { v: '+SUM(A1)' }, { v: '-2' }, { v: '@cmd' }, { v: '\tx' }, { v: 'plain, "quoted"' }];
  const cols = [['V', (r) => r.v]];
  const safe = toCsv(rows, cols, { spreadsheetSafe: true });
  assert.ok(safe.includes('"\'=1+1"'));
  assert.ok(safe.includes('"\'+SUM(A1)"'));
  assert.ok(safe.includes('"\'-2"'));
  assert.ok(safe.includes('"\'@cmd"'));
  assert.ok(safe.includes('"\'\tx"'));
  assert.ok(safe.includes('"plain, ""quoted"""'));
  const raw = toCsv(rows, cols);
  assert.ok(raw.includes('"=1+1"') && !raw.includes("'="));
  assert.equal(needsSpreadsheetGuard('=x'), true);
  assert.equal(needsSpreadsheetGuard('x=1'), false);
});

test('D08: the edge table keeps every reference occurrence, the graph keeps one edge per metric pair', async () => {
  const ctx = await createContext();
  const { store, dependencies } = ctx;
  const target = store.list('metrics').find((m) => m.code === 'M.000010');
  await ctx.bindings.setBinding(target.id, TT, { type: 'formula', formulaText: '[REVENUE | Product=A] - [REVENUE | Product=B] + SUM([PRICE], [REVENUE])' });
  const edges = dependencies.edgesFrom(`${target.id}|${TT}`);
  const revenueEdges = edges.filter((e) => e.token === 'REVENUE');
  assert.equal(revenueEdges.length, 1, 'the graph aggregates the three REVENUE slices into one edge');
  const rows = dependencies.referenceRows().filter((r) => r.targetMetricId === target.id && r.targetScenarioId === TT);
  assert.equal(rows.length, 4, 'one row per occurrence');
  assert.deepEqual(rows.map((r) => r.sequence), [1, 2, 3, 4]);
  assert.deepEqual(rows.map((r) => r.dimensionContext), ['Product=A', 'Product=B', '', '']);
  assert.deepEqual(rows.map((r) => r.operator), ['-', '-', 'SUM', 'SUM']);
  assert.ok(rows[3].astPath.endsWith('SUM:arg2'), rows[3].astPath);
  assert.equal(new Set(rows.filter((r) => r.token === 'REVENUE').map((r) => r.edgeId)).size, 1, 'occurrences link back to their single graph edge');
  const csv = toCsv(rows, EDGE_COLUMNS);
  assert.equal(csv.split('\r\n').filter(Boolean).length, 5, 'header + 4 rows');
  assert.ok(csv.includes('AST_Path'));
});

test('D08: an occurrence whose formula no longer parses still appears, from the cache, without placement', async () => {
  const ctx = await createContext();
  const { store, dependencies } = ctx;
  const target = store.list('metrics').find((m) => m.code === 'M.000010');
  const b = createBinding({ id: 'b-broken', metricId: target.id, scenarioId: GD, type: 'formula', formulaText: '[PRICE] +', parsedReferences: [{ raw: '[PRICE]', token: 'PRICE', scenarioCode: null, dimensionContext: null, metricId: null, scenarioId: null, status: 'missing' }] });
  store.upsert('bindings', b);
  const rows = dependencies.referenceRows().filter((r) => r.bindingId === 'b-broken');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operator, '');
});

// ------------------------------------------------------------ D09 scenario code grammar

test('D09: one grammar for scenario codes across model, import and parser', async () => {
  const { isValidScenarioCode } = await import('../src/core/models/scenario.js');
  const { parseSnapshot } = await import('../src/services/snapshot-schema.js');
  const { parseReferenceBody } = await import('../src/services/formula-parser.js');
  const { buildDemoSnapshot } = await import('../src/data/seed.js');
  assert.equal(isValidScenarioCode('TT'), true);
  assert.equal(isValidScenarioCode('gd_2026'), true);
  assert.equal(isValidScenarioCode('2026'), false, 'a code the parser would read as part of a metric token is refused');
  assert.equal(isValidScenarioCode('TOOLONGCODE'), false);
  const snap = buildDemoSnapshot();
  snap.scenarios.push({ id: 'scn-2026', code: '2026', name: 'Numeric', sortOrder: 3 });
  const parsed = parseSnapshot(snap);
  assert.equal(parsed.ok, false, 'the import boundary refuses what the form refuses');
  assert.ok(parsed.errors.some((e) => e.includes('"2026"')));
  // Every accepted code round-trips through the reference grammar.
  for (const code of ['TT', 'GD', 'FY26', 'PLAN_V2']) {
    const ref = parseReferenceBody(`${code}:REVENUE`);
    assert.equal(ref.scenarioCode, code.toUpperCase(), code);
    assert.equal(ref.token, 'REVENUE');
  }
});

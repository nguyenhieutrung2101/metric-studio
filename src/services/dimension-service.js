import { createDimension, createDimensionMember, createMetricDimension } from '../core/models/dimension.js';
import { NotFoundError, tokenOf } from '../repositories/repository.js';
import { referenceKey } from '../utils/text.js';
import { ValidationFailure, StaleCascadeError } from './metric-service.js';
import { UnitOfWork, commit, commitExclusive } from './unit-of-work.js';

const DIMENSION_CODE = /^DIM(\d+)$/i;

/** DimensionService — dimensions, their member hierarchy and Metric ↔ Dimension links. */
export class DimensionService {
  constructor({ store, selectors, repo }) {
    this.store = store;
    this.selectors = selectors;
    this.repo = repo;
  }

  /** Preview only; the real code is allocated by the repository at save time. */
  nextCode() {
    let max = 0;
    for (const d of this.store.list('dimensions')) {
      const m = DIMENSION_CODE.exec(d.code || '');
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `DIM${String(max + 1).padStart(2, '0')}`;
  }

  async createDimension({ code = '', name, description = '' }) {
    const label = String(name || '').trim();
    if (!label) throw new ValidationFailure('Name is required', 'name');
    const finalCode = String(code || '').trim()
      || await this.repo.allocateCode('dimensions', { prefix: 'DIM', width: 2, pattern: DIMENSION_CODE });
    if (this.store.list('dimensions').some((d) => referenceKey(d.code) === referenceKey(finalCode))) throw new ValidationFailure(`Dimension code "${finalCode}" is already used`, 'code');
    const sortOrder = this.store.count('dimensions') + 1;
    const dimension = createDimension({ code: finalCode, name: label, description, sortOrder });
    const work = new UnitOfWork().save('dimensions', dimension, null).guard('dimensions', codeGuard(finalCode, dimension.id));
    const result = await commit(this.repo, this.store, work);
    return result.saved.find((x) => x.collection === 'dimensions').record;
  }

  async updateDimension(id, patch, expectedToken) {
    const existing = this.store.get('dimensions', id);
    if (!existing) throw new NotFoundError('dimensions', id);
    const merged = createDimension({ ...existing, ...patch, id, createdAt: existing.createdAt, version: existing.version });
    if (!merged.name) throw new ValidationFailure('Name is required', 'name');
    const codeChanged = referenceKey(merged.code) !== referenceKey(existing.code);
    if (codeChanged && this.store.list('dimensions').some((d) => d.id !== id && referenceKey(d.code) === referenceKey(merged.code))) throw new ValidationFailure(`Dimension code "${merged.code}" is already used`, 'code');
    const work = new UnitOfWork().save('dimensions', merged, expectedToken == null ? tokenOf(existing) : expectedToken);
    if (codeChanged) work.guard('dimensions', codeGuard(merged.code, id));
    const result = await commit(this.repo, this.store, work);
    return result.saved.find((x) => x.collection === 'dimensions').record;
  }

  /**
   * The dimension, its members and its metric links go together, members
   * first. What depends on the dimension is collected inside the
   * repository's critical section and the batch carries a guard for each
   * dependent collection: a member or link another tab added since is
   * refused with StaleCascadeError, the mirror learns the stored records,
   * and the one retry plans against them.
   */
  async deleteDimension(id, expectedToken) {
    if (!this.store.has('dimensions', id)) throw new NotFoundError('dimensions', id);
    return this._retryStale(() => commitExclusive(this.repo, this.store, (tx) => {
      const existing = tx.get('dimensions', id);
      if (!existing) throw new NotFoundError('dimensions', id);
      const work = new UnitOfWork();
      const removing = new Set();
      for (const m of membersDeepestFirst(tx.list('dimensionMembers').filter((x) => x.dimensionId === id))) {
        work.remove('dimensionMembers', m.id, tokenOf(m), { optional: true });
        removing.add(m.id);
      }
      for (const l of tx.list('metricDimensions')) {
        if (l.dimensionId !== id) continue;
        work.remove('metricDimensions', l.id, tokenOf(l), { optional: true });
        removing.add(l.id);
      }
      for (const collection of ['dimensionMembers', 'metricDimensions']) {
        work.guard(collection, (stored) => {
          for (const r of stored) if (r.dimensionId === id && !removing.has(r.id)) throw new StaleCascadeError(collection, r.id);
        });
      }
      work.remove('dimensions', id, expectedToken == null ? tokenOf(existing) : expectedToken);
      return work;
    }));
  }

  /** Run a cascade once more when the database held a dependent the plan missed. */
  async _retryStale(fn) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fn();
        return true;
      } catch (err) {
        if (err instanceof StaleCascadeError && attempt === 0) continue;
        throw err;
      }
    }
  }

  _membersDeepestFirst(dimensionId) {
    return membersDeepestFirst(this.selectors.membersByDimension(dimensionId));
  }

  // ------------------------------------------------------------ members
  _memberSiblings(dimensionId, parentId, exceptId = null) {
    return this.selectors.membersByDimension(dimensionId).filter((m) => (m.parentId || null) === (parentId || null) && m.id !== exceptId).sort((a, b) => a.sortOrder - b.sortOrder);
  }

  isMemberDescendant(memberId, ancestorId) {
    let cur = this.store.get('dimensionMembers', memberId);
    const seen = new Set();
    while (cur && cur.parentId) {
      if (cur.parentId === ancestorId) return true;
      if (seen.has(cur.id)) return false;
      seen.add(cur.id);
      cur = this.store.get('dimensionMembers', cur.parentId);
    }
    return false;
  }

  /**
   * The dimension and the parent must still exist where the data lives, and
   * the parent must still sit at the level this plan read — another tab may
   * have moved it. A stale level is refused and planned again once.
   */
  async createMember({ dimensionId, parentId = null, code = '', name, aliases = [] }) {
    if (!this.store.has('dimensions', dimensionId)) throw new NotFoundError('dimensions', dimensionId);
    const label = String(name || '').trim();
    if (!label) throw new ValidationFailure('Name is required', 'name');
    let saved = null;
    await this._retryStale(() => commitExclusive(this.repo, this.store, (tx) => {
      if (!tx.get('dimensions', dimensionId)) throw new NotFoundError('dimensions', dimensionId);
      const members = tx.list('dimensionMembers').filter((m) => m.dimensionId === dimensionId);
      let level = 1;
      let parent = null;
      if (parentId) {
        parent = members.find((m) => m.id === parentId) || null;
        if (!parent) throw new ValidationFailure('Parent must belong to the same dimension', 'parentId');
        level = parent.level + 1;
      }
      const siblings = members.filter((m) => (m.parentId || null) === (parentId || null)).sort((a, b) => a.sortOrder - b.sortOrder);
      const sortOrder = siblings.length ? siblings[siblings.length - 1].sortOrder + 1 : 1;
      const member = createDimensionMember({ dimensionId, parentId, code: code || label, name: label, aliases, level, sortOrder });
      saved = member;
      const work = new UnitOfWork().save('dimensionMembers', member, null).require('dimensions', dimensionId).require('dimensionMembers', parentId);
      if (parent) {
        work.guard('dimensionMembers', (stored) => {
          const p = stored.find((m) => m.id === parentId);
          if (!p) throw new NotFoundError('dimensionMembers', parentId);
          if (p.dimensionId !== dimensionId) throw new ValidationFailure('Parent must belong to the same dimension', 'parentId');
          if (p.level !== parent.level) throw new StaleCascadeError('dimensionMembers', parentId);
        });
      }
      return work;
    }));
    return this.store.get('dimensionMembers', saved.id);
  }

  async updateMember(id, patch, expectedToken) {
    const existing = this.store.get('dimensionMembers', id);
    if (!existing) throw new NotFoundError('dimensionMembers', id);
    const merged = createDimensionMember({ ...existing, ...patch, id, dimensionId: existing.dimensionId, parentId: existing.parentId, level: existing.level, createdAt: existing.createdAt, version: existing.version });
    if (!merged.name) throw new ValidationFailure('Name is required', 'name');
    const saved = await this.repo.saveDimensionMember(merged, expectedToken == null ? tokenOf(existing) : expectedToken);
    this.store.upsert('dimensionMembers', saved);
    return saved;
  }

  /**
   * Re-parenting also re-levels the whole subtree, in the same transaction.
   *
   * "Does this move create a cycle?" is a question about the whole
   * hierarchy: two tabs can each move one member under the other and each
   * see an acyclic tree. The plan is built inside the repository's critical
   * section and the batch carries a guard that asks the question again
   * against the stored members at the moment of writing.
   */
  async moveMember(id, newParentId) {
    if (!this.store.has('dimensionMembers', id)) throw new NotFoundError('dimensionMembers', id);
    const parentId = newParentId || null;
    if (parentId === id) throw new ValidationFailure('Cannot move a member into its own subtree');
    await this._retryStale(() => commitExclusive(this.repo, this.store, (tx) => {
      const all = tx.list('dimensionMembers');
      const member = all.find((m) => m.id === id);
      if (!member) throw new NotFoundError('dimensionMembers', id);
      const members = all.filter((m) => m.dimensionId === member.dimensionId);
      const byId = new Map(members.map((m) => [m.id, m]));
      let level = 1;
      let parent = null;
      if (parentId) {
        parent = byId.get(parentId) || null;
        if (!parent) throw new ValidationFailure('Parent must belong to the same dimension', 'parentId');
        if (isDescendantIn(byId, parentId, id)) throw new ValidationFailure('Cannot move a member into its own subtree');
        level = parent.level + 1;
      }
      const siblings = members.filter((m) => (m.parentId || null) === parentId && m.id !== id).sort((a, b) => a.sortOrder - b.sortOrder);
      const sortOrder = siblings.length ? siblings[siblings.length - 1].sortOrder + 1 : 1;
      const work = new UnitOfWork().save('dimensionMembers', { ...member, parentId, level, sortOrder }, tokenOf(member));
      queueRelevel(work, members, id, level);
      if (parentId) {
        work.require('dimensionMembers', parentId);
        work.guard('dimensionMembers', (stored) => {
          const live = new Map(stored.filter((m) => m.dimensionId === member.dimensionId).map((m) => [m.id, m]));
          const p = live.get(parentId);
          if (!p) throw new NotFoundError('dimensionMembers', parentId);
          live.set(id, { ...(live.get(id) || member), parentId });
          if (isDescendantIn(live, parentId, id) || hasCycleAt(live, id)) throw new ValidationFailure('Cannot move a member into its own subtree');
          if (p.level !== parent.level) throw new StaleCascadeError('dimensionMembers', parentId);
        });
      }
      return work;
    }));
    return this.store.get('dimensionMembers', id);
  }

  /**
   * A child another tab added since this plan was made must not be left
   * pointing at a member that is gone: the guard refuses the batch and the
   * retry plans with the stored children.
   */
  async deleteMember(id, { strategy = 'refuse', expectedToken = null } = {}) {
    if (!this.store.has('dimensionMembers', id)) throw new NotFoundError('dimensionMembers', id);
    return this._retryStale(() => commitExclusive(this.repo, this.store, (tx) => {
      const all = tx.list('dimensionMembers');
      const member = all.find((m) => m.id === id);
      if (!member) throw new NotFoundError('dimensionMembers', id);
      const members = all.filter((m) => m.dimensionId === member.dimensionId);
      const children = members.filter((m) => m.parentId === id).sort((a, b) => a.sortOrder - b.sortOrder);
      if (children.length && strategy !== 'moveToParent') throw new ValidationFailure(`Member "${member.name}" still has ${children.length} child member(s)`);
      const work = new UnitOfWork();
      const parentLevel = member.parentId ? (members.find((m) => m.id === member.parentId) || { level: 0 }).level : 0;
      const rehomed = new Set();
      for (const child of children) {
        work.save('dimensionMembers', { ...child, parentId: member.parentId, level: parentLevel + 1 }, tokenOf(child));
        rehomed.add(child.id);
        queueRelevel(work, members, child.id, parentLevel + 1);
      }
      work.guard('dimensionMembers', (stored) => {
        for (const m of stored) if (m.parentId === id && !rehomed.has(m.id)) throw new StaleCascadeError('dimensionMembers', m.id);
      });
      if (member.parentId) work.require('dimensionMembers', member.parentId);
      work.remove('dimensionMembers', id, expectedToken == null ? tokenOf(member) : expectedToken);
      return work;
    }));
  }

  // ------------------------------------------------------------ metric links
  async linkMetric(metricId, dimensionId, options = {}) {
    if (!this.store.has('metrics', metricId)) throw new NotFoundError('metrics', metricId);
    if (!this.store.has('dimensions', dimensionId)) throw new NotFoundError('dimensions', dimensionId);
    const dup = this.selectors.metricDimensions(metricId).find((l) => l.dimensionId === dimensionId);
    if (dup) return dup;
    const link = createMetricDimension({ metricId, dimensionId, ...options });
    const work = new UnitOfWork().save('metricDimensions', link, null).require('metrics', metricId).require('dimensions', dimensionId);
    const result = await commit(this.repo, this.store, work);
    return result.saved.find((s) => s.record.id === link.id).record;
  }

  async updateLink(linkId, patch, expectedToken) {
    const existing = this.store.get('metricDimensions', linkId);
    if (!existing) throw new NotFoundError('metricDimensions', linkId);
    const merged = createMetricDimension({ ...existing, ...patch, id: linkId, metricId: existing.metricId, dimensionId: existing.dimensionId, createdAt: existing.createdAt, version: existing.version });
    const saved = await this.repo.saveMetricDimension(merged, expectedToken == null ? tokenOf(existing) : expectedToken);
    this.store.upsert('metricDimensions', saved);
    return saved;
  }

  async unlink(linkId) {
    const existing = this.store.get('metricDimensions', linkId);
    if (!existing) throw new NotFoundError('metricDimensions', linkId);
    await this.repo.deleteMetricDimension(linkId, tokenOf(existing));
    this.store.remove('metricDimensions', linkId);
    return true;
  }
}

/** A guard that refuses a dimension code another tab already stored. */
function codeGuard(code, exceptId) {
  const key = referenceKey(code);
  return (stored) => {
    for (const d of stored) if (d.id !== exceptId && referenceKey(d.code) === key) throw new ValidationFailure(`Dimension code "${code}" is already used`, 'code');
  };
}

/**
 * Children before their parents. On a backend that cannot commit atomically,
 * stopping halfway then leaves a parent with fewer children rather than
 * orphan members whose parent is gone.
 */
function membersDeepestFirst(members) {
  const depth = new Map();
  const byId = new Map(members.map((m) => [m.id, m]));
  for (const m of members) {
    let d = 0;
    let cur = m;
    const seen = new Set();
    while (cur && cur.parentId && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parentId);
      d += 1;
    }
    depth.set(m.id, d);
  }
  return [...members].sort((a, b) => depth.get(b.id) - depth.get(a.id));
}

/** Queue the new level of every descendant of `rootId`, from a snapshot of the members. */
function queueRelevel(work, members, rootId, rootLevel) {
  const stack = [{ id: rootId, level: rootLevel }];
  const seen = new Set([rootId]);
  while (stack.length) {
    const cur = stack.pop();
    for (const child of members.filter((m) => m.parentId === cur.id).sort((a, b) => a.sortOrder - b.sortOrder)) {
      if (seen.has(child.id)) continue; // cyclic parent links cannot spin here
      seen.add(child.id);
      const level = cur.level + 1;
      if (child.level !== level) work.save('dimensionMembers', { ...child, level }, tokenOf(child));
      stack.push({ id: child.id, level });
    }
  }
}

function isDescendantIn(byId, nodeId, ancestorId) {
  let cur = byId.get(nodeId);
  const seen = new Set();
  while (cur && cur.parentId) {
    if (cur.parentId === ancestorId) return true;
    if (seen.has(cur.id)) return false;
    seen.add(cur.id);
    cur = byId.get(cur.parentId);
  }
  return false;
}

function hasCycleAt(byId, startId) {
  const seen = new Set();
  let cur = byId.get(startId);
  while (cur && cur.parentId) {
    if (seen.has(cur.id)) return true;
    seen.add(cur.id);
    cur = byId.get(cur.parentId);
    if (cur && cur.id === startId) return true;
  }
  return false;
}

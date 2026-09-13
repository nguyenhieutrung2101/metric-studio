import { createDimension, createDimensionMember, createMetricDimension } from '../core/models/dimension.js';
import { NotFoundError, tokenOf } from '../repositories/repository.js';
import { referenceKey } from '../utils/text.js';
import { ValidationFailure } from './metric-service.js';
import { UnitOfWork, commit } from './unit-of-work.js';

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
    const saved = await this.repo.saveDimension(createDimension({ code: finalCode, name: label, description, sortOrder }), null);
    this.store.upsert('dimensions', saved);
    return saved;
  }

  async updateDimension(id, patch, expectedToken) {
    const existing = this.store.get('dimensions', id);
    if (!existing) throw new NotFoundError('dimensions', id);
    const merged = createDimension({ ...existing, ...patch, id, createdAt: existing.createdAt, version: existing.version });
    if (!merged.name) throw new ValidationFailure('Name is required', 'name');
    if (this.store.list('dimensions').some((d) => d.id !== id && referenceKey(d.code) === referenceKey(merged.code))) throw new ValidationFailure(`Dimension code "${merged.code}" is already used`, 'code');
    const saved = await this.repo.saveDimension(merged, expectedToken == null ? tokenOf(existing) : expectedToken);
    this.store.upsert('dimensions', saved);
    return saved;
  }

  /** The dimension, its members and its metric links go together, members first. */
  async deleteDimension(id, expectedToken) {
    const existing = this.store.get('dimensions', id);
    if (!existing) throw new NotFoundError('dimensions', id);
    const work = new UnitOfWork();
    for (const m of this._membersDeepestFirst(id)) work.remove('dimensionMembers', m.id, tokenOf(m), { optional: true });
    for (const l of this.selectors.linksByDimension(id)) work.remove('metricDimensions', l.id, tokenOf(l), { optional: true });
    work.remove('dimensions', id, expectedToken == null ? tokenOf(existing) : expectedToken);
    await commit(this.repo, this.store, work);
    return true;
  }

  /**
   * Children before their parents. On a backend that cannot commit
   * atomically, stopping halfway then leaves a parent with fewer children
   * rather than orphan members whose parent is gone.
   */
  _membersDeepestFirst(dimensionId) {
    const members = this.selectors.membersByDimension(dimensionId);
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

  async createMember({ dimensionId, parentId = null, code = '', name, aliases = [] }) {
    if (!this.store.has('dimensions', dimensionId)) throw new NotFoundError('dimensions', dimensionId);
    const label = String(name || '').trim();
    if (!label) throw new ValidationFailure('Name is required', 'name');
    let level = 1;
    if (parentId) {
      const parent = this.store.get('dimensionMembers', parentId);
      if (!parent || parent.dimensionId !== dimensionId) throw new ValidationFailure('Parent must belong to the same dimension', 'parentId');
      level = parent.level + 1;
    }
    const siblings = this._memberSiblings(dimensionId, parentId);
    const sortOrder = siblings.length ? siblings[siblings.length - 1].sortOrder + 1 : 1;
    const member = createDimensionMember({ dimensionId, parentId, code: code || label, name: label, aliases, level, sortOrder });
    const saved = await this.repo.saveDimensionMember(member, null);
    this.store.upsert('dimensionMembers', saved);
    return saved;
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

  /** Re-parenting also re-levels the whole subtree, in the same transaction. */
  async moveMember(id, newParentId) {
    const member = this.store.get('dimensionMembers', id);
    if (!member) throw new NotFoundError('dimensionMembers', id);
    const parentId = newParentId || null;
    if (parentId === id || (parentId && this.isMemberDescendant(parentId, id))) throw new ValidationFailure('Cannot move a member into its own subtree');
    let level = 1;
    if (parentId) {
      const parent = this.store.get('dimensionMembers', parentId);
      if (!parent || parent.dimensionId !== member.dimensionId) throw new ValidationFailure('Parent must belong to the same dimension', 'parentId');
      level = parent.level + 1;
    }
    const siblings = this._memberSiblings(member.dimensionId, parentId, id);
    const sortOrder = siblings.length ? siblings[siblings.length - 1].sortOrder + 1 : 1;
    const work = new UnitOfWork().save('dimensionMembers', { ...member, parentId, level, sortOrder }, tokenOf(member));
    this._queueRelevel(work, id, level);
    await commit(this.repo, this.store, work);
    return this.store.get('dimensionMembers', id);
  }

  _queueRelevel(work, rootId, rootLevel) {
    const root = this.store.get('dimensionMembers', rootId);
    if (!root) return;
    const stack = [{ id: rootId, level: rootLevel }];
    const seen = new Set([rootId]);
    while (stack.length) {
      const cur = stack.pop();
      for (const child of this._memberSiblings(root.dimensionId, cur.id)) {
        if (seen.has(child.id)) continue; // cyclic parent links cannot spin here
        seen.add(child.id);
        const level = cur.level + 1;
        if (child.level !== level) work.save('dimensionMembers', { ...child, level }, tokenOf(child));
        stack.push({ id: child.id, level });
      }
    }
  }

  async deleteMember(id, { strategy = 'refuse', expectedToken = null } = {}) {
    const member = this.store.get('dimensionMembers', id);
    if (!member) throw new NotFoundError('dimensionMembers', id);
    const children = this._memberSiblings(member.dimensionId, id);
    if (children.length && strategy !== 'moveToParent') throw new ValidationFailure(`Member "${member.name}" still has ${children.length} child member(s)`);
    const work = new UnitOfWork();
    const parentLevel = member.parentId ? (this.store.get('dimensionMembers', member.parentId) || { level: 0 }).level : 0;
    for (const child of children) {
      work.save('dimensionMembers', { ...child, parentId: member.parentId, level: parentLevel + 1 }, tokenOf(child));
      this._queueRelevel(work, child.id, parentLevel + 1);
    }
    work.remove('dimensionMembers', id, expectedToken == null ? tokenOf(member) : expectedToken);
    await commit(this.repo, this.store, work);
    return true;
  }

  // ------------------------------------------------------------ metric links
  async linkMetric(metricId, dimensionId, options = {}) {
    if (!this.store.has('metrics', metricId)) throw new NotFoundError('metrics', metricId);
    if (!this.store.has('dimensions', dimensionId)) throw new NotFoundError('dimensions', dimensionId);
    const dup = this.selectors.metricDimensions(metricId).find((l) => l.dimensionId === dimensionId);
    if (dup) return dup;
    const saved = await this.repo.saveMetricDimension(createMetricDimension({ metricId, dimensionId, ...options }), null);
    this.store.upsert('metricDimensions', saved);
    return saved;
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

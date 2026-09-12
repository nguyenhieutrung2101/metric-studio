import { createDimension, createDimensionMember, createMetricDimension } from '../core/models/dimension.js';
import { NotFoundError } from '../repositories/repository.js';
import { referenceKey } from '../utils/text.js';
import { ValidationFailure } from './metric-service.js';

/** DimensionService — dimensions, their member hierarchy and Metric ↔ Dimension links. */
export class DimensionService {
  constructor({ store, selectors, repo }) {
    this.store = store;
    this.selectors = selectors;
    this.repo = repo;
  }

  nextCode() {
    let max = 0;
    for (const d of this.store.list('dimensions')) {
      const m = /^DIM(\d+)$/i.exec(d.code || '');
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `DIM${String(max + 1).padStart(2, '0')}`;
  }

  async createDimension({ code = '', name, description = '' }) {
    const label = String(name || '').trim();
    if (!label) throw new ValidationFailure('Name is required', 'name');
    const finalCode = String(code || '').trim() || this.nextCode();
    if (this.store.list('dimensions').some((d) => referenceKey(d.code) === referenceKey(finalCode))) throw new ValidationFailure(`Dimension code "${finalCode}" is already used`, 'code');
    const sortOrder = this.store.count('dimensions') + 1;
    const saved = await this.repo.saveDimension(createDimension({ code: finalCode, name: label, description, sortOrder }), null);
    this.store.upsert('dimensions', saved);
    return saved;
  }

  async updateDimension(id, patch, expectedVersion) {
    const existing = this.store.get('dimensions', id);
    if (!existing) throw new NotFoundError('dimensions', id);
    const merged = createDimension({ ...existing, ...patch, id, createdAt: existing.createdAt, version: existing.version });
    if (!merged.name) throw new ValidationFailure('Name is required', 'name');
    if (this.store.list('dimensions').some((d) => d.id !== id && referenceKey(d.code) === referenceKey(merged.code))) throw new ValidationFailure(`Dimension code "${merged.code}" is already used`, 'code');
    const saved = await this.repo.saveDimension(merged, expectedVersion == null ? existing.version : expectedVersion);
    this.store.upsert('dimensions', saved);
    return saved;
  }

  async deleteDimension(id, expectedVersion) {
    const existing = this.store.get('dimensions', id);
    if (!existing) throw new NotFoundError('dimensions', id);
    await this.repo.deleteDimension(id, expectedVersion == null ? existing.version : expectedVersion);
    this.store.remove('dimensions', id);
    const members = this.store.list('dimensionMembers').filter((m) => m.dimensionId === id);
    const links = this.store.list('metricDimensions').filter((l) => l.dimensionId === id);
    for (const m of members) await this.repo.deleteDimensionMember(m.id, null).catch(() => {});
    for (const l of links) await this.repo.deleteMetricDimension(l.id, null).catch(() => {});
    this.store.removeMany('dimensionMembers', members.map((m) => m.id));
    this.store.removeMany('metricDimensions', links.map((l) => l.id));
    return true;
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

  async updateMember(id, patch, expectedVersion) {
    const existing = this.store.get('dimensionMembers', id);
    if (!existing) throw new NotFoundError('dimensionMembers', id);
    const merged = createDimensionMember({ ...existing, ...patch, id, dimensionId: existing.dimensionId, parentId: existing.parentId, level: existing.level, createdAt: existing.createdAt, version: existing.version });
    if (!merged.name) throw new ValidationFailure('Name is required', 'name');
    const saved = await this.repo.saveDimensionMember(merged, expectedVersion == null ? existing.version : expectedVersion);
    this.store.upsert('dimensionMembers', saved);
    return saved;
  }

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
    const saved = await this.repo.saveDimensionMember({ ...member, parentId, level, sortOrder }, member.version);
    this.store.upsert('dimensionMembers', saved);
    await this._relevel(id);
    return saved;
  }

  async _relevel(rootId) {
    const root = this.store.get('dimensionMembers', rootId);
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      for (const child of this._memberSiblings(cur.dimensionId, cur.id)) {
        if (child.level !== cur.level + 1) {
          const saved = await this.repo.saveDimensionMember({ ...child, level: cur.level + 1 }, child.version);
          this.store.upsert('dimensionMembers', saved);
          stack.push(saved);
        } else stack.push(child);
      }
    }
  }

  async deleteMember(id, { strategy = 'refuse', expectedVersion = null } = {}) {
    const member = this.store.get('dimensionMembers', id);
    if (!member) throw new NotFoundError('dimensionMembers', id);
    const children = this._memberSiblings(member.dimensionId, id);
    if (children.length && strategy !== 'moveToParent') throw new ValidationFailure(`Member "${member.name}" still has ${children.length} child member(s)`);
    for (const c of children) await this.moveMember(c.id, member.parentId);
    await this.repo.deleteDimensionMember(id, expectedVersion == null ? member.version : expectedVersion);
    this.store.remove('dimensionMembers', id);
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

  async updateLink(linkId, patch, expectedVersion) {
    const existing = this.store.get('metricDimensions', linkId);
    if (!existing) throw new NotFoundError('metricDimensions', linkId);
    const merged = createMetricDimension({ ...existing, ...patch, id: linkId, metricId: existing.metricId, dimensionId: existing.dimensionId, createdAt: existing.createdAt, version: existing.version });
    const saved = await this.repo.saveMetricDimension(merged, expectedVersion == null ? existing.version : expectedVersion);
    this.store.upsert('metricDimensions', saved);
    return saved;
  }

  async unlink(linkId) {
    const existing = this.store.get('metricDimensions', linkId);
    if (!existing) throw new NotFoundError('metricDimensions', linkId);
    await this.repo.deleteMetricDimension(linkId, existing.version);
    this.store.remove('metricDimensions', linkId);
    return true;
  }
}

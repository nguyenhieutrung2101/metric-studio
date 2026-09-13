import { createStructureNode, createMetricStructure } from '../core/models/structure.js';
import { NotFoundError, tokenOf } from '../repositories/repository.js';
import { ValidationFailure } from './metric-service.js';
import { UnitOfWork, commit, commitExclusive } from './unit-of-work.js';

/**
 * StructureService — the governance hierarchy and metric placements.
 *
 * Nothing here reads or writes bindings: moving a metric changes only its
 * MetricStructure link. Operations that touch several records (reordering
 * siblings, deleting a node and re-homing its contents) go through one unit
 * of work, so the tree can never be left half-moved.
 */
export class StructureService {
  constructor({ store, selectors, repo }) {
    this.store = store;
    this.selectors = selectors;
    this.repo = repo;
  }

  _siblings(parentId, exceptId = null) {
    return this.store
      .list('structureNodes')
      .filter((n) => (n.parentId || null) === (parentId || null) && n.id !== exceptId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  isDescendant(nodeId, ancestorId) {
    let cur = this.store.get('structureNodes', nodeId);
    const seen = new Set();
    while (cur && cur.parentId) {
      if (cur.parentId === ancestorId) return true;
      if (seen.has(cur.id)) return false;
      seen.add(cur.id);
      cur = this.store.get('structureNodes', cur.parentId);
    }
    return false;
  }

  async createNode({ parentId = null, name, code = '', description = '', owner = '' }) {
    const label = String(name || '').trim();
    if (!label) throw new ValidationFailure('Name is required', 'name');
    if (parentId && !this.store.has('structureNodes', parentId)) throw new NotFoundError('structureNodes', parentId);
    const siblings = this._siblings(parentId);
    const sortOrder = siblings.length ? siblings[siblings.length - 1].sortOrder + 1 : 1;
    const node = createStructureNode({ parentId, name: label, code, description, owner, sortOrder });
    const saved = await this.repo.saveStructure(node, null);
    this.store.upsert('structureNodes', saved);
    return saved;
  }

  async updateNode(id, patch, expectedToken) {
    const existing = this.store.get('structureNodes', id);
    if (!existing) throw new NotFoundError('structureNodes', id);
    const merged = createStructureNode({ ...existing, ...patch, id, createdAt: existing.createdAt, parentId: existing.parentId, version: existing.version });
    if (!merged.name) throw new ValidationFailure('Name is required', 'name');
    const saved = await this.repo.saveStructure(merged, expectedToken == null ? tokenOf(existing) : expectedToken);
    this.store.upsert('structureNodes', saved);
    return saved;
  }

  renameNode(id, name, expectedToken) {
    return this.updateNode(id, { name }, expectedToken);
  }

  /** Move a node under a new parent, optionally at a position among siblings. */
  /**
   * Move a node under a new parent.
   *
   * "Does this move create a cycle?" is a question about the whole hierarchy,
   * so asking it against the store and writing afterwards is not enough: two
   * moves can each see an acyclic tree, each be allowed, and together make
   * A the parent of B and B the parent of A. The check therefore runs inside
   * the repository's critical section, against the records the repository
   * itself holds.
   */
  async moveNode(id, newParentId, index = null) {
    const parentId = newParentId || null;
    if (parentId === id) throw new ValidationFailure('Cannot move a node into its own subtree');
    await commitExclusive(this.repo, this.store, (tx) => {
      const nodes = tx.list('structureNodes');
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const node = byId.get(id);
      if (!node) throw new NotFoundError('structureNodes', id);
      if (parentId && !byId.has(parentId)) throw new NotFoundError('structureNodes', parentId);
      if (parentId && isDescendantIn(byId, parentId, id)) throw new ValidationFailure('Cannot move a node into its own subtree');

      const siblings = nodes
        .filter((n) => (n.parentId || null) === parentId && n.id !== id)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const at = index == null ? siblings.length : Math.max(0, Math.min(index, siblings.length));
      siblings.splice(at, 0, node);
      const work = new UnitOfWork();
      let order = 1;
      for (const s of siblings) {
        const current = byId.get(s.id);
        if (!current) continue;
        const next = { ...current, sortOrder: order, parentId: s.id === id ? parentId : current.parentId };
        order += 1;
        if (next.sortOrder !== current.sortOrder || next.parentId !== current.parentId) {
          work.save('structureNodes', next, tokenOf(current));
        }
      }
      // The critical section covers this instance. Another tab has its own,
      // and its own mirror, so the question is asked again against the stored
      // hierarchy at the moment of writing.
      if (parentId) {
        work.guard('structureNodes', (stored) => {
          const live = new Map(stored.map((n) => [n.id, n]));
          live.set(id, { ...(live.get(id) || node), parentId });
          if (isDescendantIn(live, parentId, id) || hasCycleAt(live, id)) {
            throw new ValidationFailure('Cannot move a node into its own subtree');
          }
        });
      }
      return work;
    });
    return this.store.get('structureNodes', id);
  }

  /** Move `id` so that it sits just before/after `siblingId`. */
  async moveNodeRelative(id, siblingId, position = 'before') {
    const sibling = this.store.get('structureNodes', siblingId);
    if (!sibling) throw new NotFoundError('structureNodes', siblingId);
    const siblings = this._siblings(sibling.parentId, id);
    let idx = siblings.findIndex((n) => n.id === siblingId);
    if (position === 'after') idx += 1;
    return this.moveNode(id, sibling.parentId, idx);
  }

  async reorderNode(id, direction) {
    const node = this.store.get('structureNodes', id);
    if (!node) throw new NotFoundError('structureNodes', id);
    const siblings = this._siblings(node.parentId);
    const idx = siblings.findIndex((n) => n.id === id);
    const target = direction === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= siblings.length) return node;
    return this.moveNode(id, node.parentId, target);
  }

  /** Queue the sort order (and new parent for the moved node) of one sibling list. */
  _resequence(work, orderedSiblings, movedId, parentId) {
    let order = 1;
    for (const s of orderedSiblings) {
      const current = this.store.get('structureNodes', s.id);
      if (!current) continue;
      const next = { ...current, sortOrder: order, parentId: s.id === movedId ? parentId : current.parentId };
      order += 1;
      if (next.sortOrder !== current.sortOrder || next.parentId !== current.parentId) {
        work.save('structureNodes', next, tokenOf(current));
      }
    }
  }

  /**
   * Delete a node. Refused while it still holds anything, unless the caller
   * asks for its contents to move to the parent. Either way the whole
   * operation is one transaction.
   */
  async deleteNode(id, { strategy = 'refuse', expectedToken = null } = {}) {
    const node = this.store.get('structureNodes', id);
    if (!node) throw new NotFoundError('structureNodes', id);
    const children = this._siblings(id);
    const placements = this.store.list('metricStructures').filter((l) => l.structureNodeId === id);
    if ((children.length || placements.length) && strategy !== 'moveToParent') {
      throw new ValidationFailure(`Node "${node.name}" still contains ${children.length} sub-node(s) and ${placements.length} metric(s)`);
    }

    const work = new UnitOfWork();
    if (children.length) {
      const targetSiblings = this._siblings(node.parentId, id).concat(children);
      let order = 1;
      for (const s of targetSiblings) {
        const current = this.store.get('structureNodes', s.id);
        if (!current) continue;
        const movedHere = children.some((c) => c.id === s.id);
        const next = { ...current, sortOrder: order, parentId: movedHere ? node.parentId : current.parentId };
        order += 1;
        if (next.sortOrder !== current.sortOrder || next.parentId !== current.parentId) work.save('structureNodes', next, tokenOf(current));
      }
    }
    for (const link of placements) {
      if (node.parentId) {
        const alreadyThere = this.store.list('metricStructures').some((l) => l.metricId === link.metricId && l.structureNodeId === node.parentId);
        if (alreadyThere) work.remove('metricStructures', link.id, tokenOf(link), { optional: true });
        else work.save('metricStructures', { ...link, structureNodeId: node.parentId }, tokenOf(link));
      } else {
        work.remove('metricStructures', link.id, tokenOf(link), { optional: true });
      }
    }
    work.remove('structureNodes', id, expectedToken == null ? tokenOf(node) : expectedToken);
    await commit(this.repo, this.store, work);
    return true;
  }

  // ------------------------------------------------------------ placements
  async placeMetric(metricId, structureNodeId, { isPrimary = null } = {}) {
    if (!this.store.has('metrics', metricId)) throw new NotFoundError('metrics', metricId);
    if (!this.store.has('structureNodes', structureNodeId)) throw new NotFoundError('structureNodes', structureNodeId);
    const existing = this.selectors.placementsByMetric(metricId);
    const dup = existing.find((l) => l.structureNodeId === structureNodeId);
    if (dup) return dup;
    const primary = isPrimary == null ? existing.length === 0 : isPrimary;
    const link = createMetricStructure({ metricId, structureNodeId, isPrimary: primary });
    const work = new UnitOfWork();
    if (primary) for (const l of existing) if (l.isPrimary) work.save('metricStructures', { ...l, isPrimary: false }, tokenOf(l));
    work.save('metricStructures', link, null);
    const result = await commit(this.repo, this.store, work);
    return result.saved.find((s) => s.record.id === link.id).record;
  }

  async setPrimary(linkId) {
    const link = this.store.get('metricStructures', linkId);
    if (!link) throw new NotFoundError('metricStructures', linkId);
    const work = new UnitOfWork();
    for (const l of this.selectors.placementsByMetric(link.metricId)) {
      if (l.id === linkId) continue;
      if (l.isPrimary) work.save('metricStructures', { ...l, isPrimary: false }, tokenOf(l));
    }
    work.save('metricStructures', { ...link, isPrimary: true }, tokenOf(link));
    await commit(this.repo, this.store, work);
    return this.store.get('metricStructures', linkId);
  }

  async removePlacement(linkId) {
    const link = this.store.get('metricStructures', linkId);
    if (!link) throw new NotFoundError('metricStructures', linkId);
    const rest = this.selectors.placementsByMetric(link.metricId).filter((l) => l.id !== linkId);
    const work = new UnitOfWork().remove('metricStructures', linkId, tokenOf(link));
    // A metric keeps a primary placement as long as it has any placement left.
    if (link.isPrimary && rest.length) work.save('metricStructures', { ...rest[0], isPrimary: true }, tokenOf(rest[0]));
    await commit(this.repo, this.store, work);
    return true;
  }

  /** Move a metric from one node to another: one link record changes, nothing else. */
  async moveMetric(metricId, fromNodeId, toNodeId) {
    if (!this.store.has('structureNodes', toNodeId)) throw new NotFoundError('structureNodes', toNodeId);
    const links = this.selectors.placementsByMetric(metricId);
    const link = links.find((l) => l.structureNodeId === fromNodeId);
    if (!link) return this.placeMetric(metricId, toNodeId);
    const existingAtTarget = links.find((l) => l.structureNodeId === toNodeId);
    if (existingAtTarget) {
      await this.removePlacement(link.id);
      return this.store.get('metricStructures', existingAtTarget.id);
    }
    const saved = await this.repo.saveMetricStructure({ ...link, structureNodeId: toNodeId }, tokenOf(link));
    this.store.upsert('metricStructures', saved);
    return saved;
  }
}

/**
 * Walk parent links in a snapshot of the hierarchy. Carries a guard so a
 * hierarchy that is already cyclic answers instead of looping.
 */
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

/** Does following parents from `startId` come back to where it started? */
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

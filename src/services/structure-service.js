import { createStructureNode, createMetricStructure } from '../core/models/structure.js';
import { NotFoundError } from '../repositories/repository.js';
import { ValidationFailure } from './metric-service.js';

/**
 * StructureService — the governance hierarchy and metric placements.
 * Nothing here reads or writes bindings: moving a metric changes only its
 * MetricStructure link (invariant tested in tests/invariants.test.mjs).
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

  async updateNode(id, patch, expectedVersion) {
    const existing = this.store.get('structureNodes', id);
    if (!existing) throw new NotFoundError('structureNodes', id);
    const merged = createStructureNode({ ...existing, ...patch, id, createdAt: existing.createdAt, parentId: existing.parentId, version: existing.version });
    if (!merged.name) throw new ValidationFailure('Name is required', 'name');
    const saved = await this.repo.saveStructure(merged, expectedVersion == null ? existing.version : expectedVersion);
    this.store.upsert('structureNodes', saved);
    return saved;
  }

  renameNode(id, name, expectedVersion) {
    return this.updateNode(id, { name }, expectedVersion);
  }

  /** Move a node under a new parent, optionally at a position among siblings. */
  async moveNode(id, newParentId, index = null) {
    const node = this.store.get('structureNodes', id);
    if (!node) throw new NotFoundError('structureNodes', id);
    const parentId = newParentId || null;
    if (parentId === id || (parentId && this.isDescendant(parentId, id))) throw new ValidationFailure('Cannot move a node into its own subtree');
    if (parentId && !this.store.has('structureNodes', parentId)) throw new NotFoundError('structureNodes', parentId);
    const siblings = this._siblings(parentId, id);
    const at = index == null ? siblings.length : Math.max(0, Math.min(index, siblings.length));
    siblings.splice(at, 0, { ...node, parentId });
    await this._resequence(siblings, id, parentId);
    return this.store.get('structureNodes', id);
  }

  /** Move `id` so that it sits just before/after `siblingId` in the same parent as the sibling. */
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

  async _resequence(orderedSiblings, movedId, parentId) {
    let order = 1;
    for (const s of orderedSiblings) {
      const current = this.store.get('structureNodes', s.id);
      const next = { ...current, sortOrder: order, parentId: s.id === movedId ? parentId : current.parentId };
      order += 1;
      if (next.sortOrder !== current.sortOrder || next.parentId !== current.parentId) {
        const saved = await this.repo.saveStructure(next, current.version);
        this.store.upsert('structureNodes', saved);
      }
    }
  }

  /**
   * Delete a node. Refuses when it still has children or metrics unless
   * strategy = 'moveToParent', in which case its children and placements are
   * re-attached to the parent (or become roots / unplaced).
   */
  async deleteNode(id, { strategy = 'refuse', expectedVersion = null } = {}) {
    const node = this.store.get('structureNodes', id);
    if (!node) throw new NotFoundError('structureNodes', id);
    const children = this._siblings(id);
    const placements = this.store.list('metricStructures').filter((l) => l.structureNodeId === id);
    if ((children.length || placements.length) && strategy !== 'moveToParent') {
      throw new ValidationFailure(`Node "${node.name}" still contains ${children.length} sub-node(s) and ${placements.length} metric(s)`);
    }
    for (const child of children) await this.moveNode(child.id, node.parentId);
    for (const link of placements) {
      if (node.parentId) {
        const exists = this.store.list('metricStructures').some((l) => l.metricId === link.metricId && l.structureNodeId === node.parentId);
        if (exists) {
          await this.repo.deleteMetricStructure(link.id, null);
          this.store.remove('metricStructures', link.id);
        } else {
          const saved = await this.repo.saveMetricStructure({ ...link, structureNodeId: node.parentId }, link.version);
          this.store.upsert('metricStructures', saved);
        }
      } else {
        await this.repo.deleteMetricStructure(link.id, null);
        this.store.remove('metricStructures', link.id);
      }
    }
    await this.repo.deleteStructure(id, expectedVersion == null ? node.version : expectedVersion);
    this.store.remove('structureNodes', id);
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
    if (primary) await this._clearPrimary(metricId);
    const link = createMetricStructure({ metricId, structureNodeId, isPrimary: primary });
    const saved = await this.repo.saveMetricStructure(link, null);
    this.store.upsert('metricStructures', saved);
    return saved;
  }

  async _clearPrimary(metricId, exceptId = null) {
    for (const l of this.selectors.placementsByMetric(metricId)) {
      if (l.isPrimary && l.id !== exceptId) {
        const saved = await this.repo.saveMetricStructure({ ...l, isPrimary: false }, l.version);
        this.store.upsert('metricStructures', saved);
      }
    }
  }

  async setPrimary(linkId) {
    const link = this.store.get('metricStructures', linkId);
    if (!link) throw new NotFoundError('metricStructures', linkId);
    await this._clearPrimary(link.metricId, linkId);
    const current = this.store.get('metricStructures', linkId);
    const saved = await this.repo.saveMetricStructure({ ...current, isPrimary: true }, current.version);
    this.store.upsert('metricStructures', saved);
    return saved;
  }

  async removePlacement(linkId) {
    const link = this.store.get('metricStructures', linkId);
    if (!link) throw new NotFoundError('metricStructures', linkId);
    await this.repo.deleteMetricStructure(linkId, link.version);
    this.store.remove('metricStructures', linkId);
    // Promote another placement to primary so the metric keeps a home.
    if (link.isPrimary) {
      const rest = this.selectors.placementsByMetric(link.metricId);
      if (rest.length) await this.setPrimary(rest[0].id);
    }
    return true;
  }

  /** Move a metric from one node to another: one link record changes, nothing else. */
  async moveMetric(metricId, fromNodeId, toNodeId) {
    if (!this.store.has('structureNodes', toNodeId)) throw new NotFoundError('structureNodes', toNodeId);
    const links = this.selectors.placementsByMetric(metricId);
    const link = links.find((l) => l.structureNodeId === fromNodeId);
    if (!link) return this.placeMetric(metricId, toNodeId);
    if (links.some((l) => l.structureNodeId === toNodeId)) {
      await this.removePlacement(link.id);
      return links.find((l) => l.structureNodeId === toNodeId);
    }
    const saved = await this.repo.saveMetricStructure({ ...link, structureNodeId: toNodeId }, link.version);
    this.store.upsert('metricStructures', saved);
    return saved;
  }
}

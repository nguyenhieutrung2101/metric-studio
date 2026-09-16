import { createReport, createMetricReport, ReportKind } from '../core/models/report.js';
import { NotFoundError, tokenOf } from '../repositories/repository.js';
import { ValidationFailure, StaleCascadeError } from './metric-service.js';
import { UnitOfWork, commit, commitExclusive } from './unit-of-work.js';
import { padNumber } from '../utils/text.js';

/** As for a group: a report a file cannot name is a report a file cannot carry. */
const CODE_PREFIX = 'R.';
const CODE_WIDTH = 4;
const CODE_PATTERN = /^R\.(\d+)$/;

/**
 * ReportService — report folders, reports, and which metrics each report shows.
 *
 * The same discipline as the governance hierarchy: every operation that
 * touches several records (re-sequencing siblings, deleting a folder and
 * re-homing what it held) is one unit of work, planned inside the
 * repository's critical section and guarded where the data lives.
 *
 * Two rules the hierarchy does not have: only a folder can hold sub-items,
 * and only a report can hold metrics. Both are checked here and re-checked
 * against the stored records when the write lands.
 */
export class ReportService {
  constructor({ store, selectors, repo }) {
    this.store = store;
    this.selectors = selectors;
    this.repo = repo;
  }

  _siblings(parentId, exceptId = null) {
    return this.store
      .list('reports')
      .filter((r) => (r.parentId || null) === (parentId || null) && r.id !== exceptId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /** Preview of the next generated code, for a placeholder. */
  nextCode() {
    let max = 0;
    for (const r of this.store.list('reports')) {
      const m = CODE_PATTERN.exec(r.code || '');
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `${CODE_PREFIX}${padNumber(max + 1, CODE_WIDTH)}`;
  }

  isDescendant(id, ancestorId) {
    return isDescendantIn(new Map(this.store.list('reports').map((r) => [r.id, r])), id, ancestorId);
  }

  async create({ parentId = null, kind = ReportKind.REPORT, name, code = '', description = '', owner = '' }) {
    const label = String(name || '').trim();
    if (!label) throw new ValidationFailure('Name is required', 'name');
    const parent = parentId ? this.store.get('reports', parentId) : null;
    if (parentId && !parent) throw new NotFoundError('reports', parentId);
    if (parent && parent.kind !== ReportKind.FOLDER) throw new ValidationFailure('Only a folder can hold reports', 'parentId');
    const siblings = this._siblings(parentId);
    const sortOrder = siblings.length ? siblings[siblings.length - 1].sortOrder + 1 : 1;
    const assigned = String(code || '').trim() || await this.repo.allocateCode('reports', { prefix: CODE_PREFIX, width: CODE_WIDTH, pattern: CODE_PATTERN });
    const report = createReport({ parentId, kind, name: label, code: assigned, description, owner, sortOrder });
    const work = new UnitOfWork().save('reports', report, null);
    if (parentId) {
      work.require('reports', parentId);
      work.guard('reports', (stored) => {
        const p = stored.find((r) => r.id === parentId);
        if (p && p.kind !== ReportKind.FOLDER) throw new ValidationFailure('Only a folder can hold reports', 'parentId');
      });
    }
    const result = await commit(this.repo, this.store, work);
    return result.saved.find((s) => s.record.id === report.id).record;
  }

  async update(id, patch, expectedToken) {
    const existing = this.store.get('reports', id);
    if (!existing) throw new NotFoundError('reports', id);
    const merged = createReport({ ...existing, ...patch, id, createdAt: existing.createdAt, parentId: existing.parentId, version: existing.version });
    if (!merged.name) throw new ValidationFailure('Name is required', 'name');
    if (merged.kind === existing.kind) {
      const saved = await this.repo.saveReport(merged, expectedToken == null ? tokenOf(existing) : expectedToken);
      this.store.upsert('reports', saved);
      return saved;
    }
    // A folder that holds anything stays a folder; a report that shows
    // anything stays a report. What an item holds is not part of its own
    // token — another tab adds a child or a link without the item changing
    // at all — so this question cannot be answered from a mirror. It is
    // asked again where the data lives, inside the transaction that writes
    // the new kind, and refused there.
    assertKindFits(merged.kind, this._siblings(id), this.selectors.reportLinks(id));
    await commitExclusive(this.repo, this.store, (tx) => {
      const current = tx.get('reports', id);
      if (!current) throw new NotFoundError('reports', id);
      assertKindFits(merged.kind, tx.list('reports').filter((r) => r.parentId === id), tx.list('metricReports').filter((l) => l.reportId === id));
      const work = new UnitOfWork().save('reports', merged, expectedToken == null ? tokenOf(current) : expectedToken);
      work.guard('reports', (stored) => assertKindFits(merged.kind, stored.filter((r) => r.parentId === id), []));
      work.guard('metricReports', (stored) => assertKindFits(merged.kind, [], stored.filter((l) => l.reportId === id)));
      return work;
    });
    return this.store.get('reports', id);
  }

  rename(id, name, expectedToken) {
    return this.update(id, { name }, expectedToken);
  }

  /** Move under a new parent (a folder, or the root), optionally at an index among siblings. */
  async move(id, newParentId, index = null) {
    const parentId = newParentId || null;
    if (parentId === id) throw new ValidationFailure('Cannot move an item into its own subtree');
    await commitExclusive(this.repo, this.store, (tx) => {
      const all = tx.list('reports');
      const byId = new Map(all.map((r) => [r.id, r]));
      const item = byId.get(id);
      if (!item) throw new NotFoundError('reports', id);
      const parent = parentId ? byId.get(parentId) : null;
      if (parentId && !parent) throw new NotFoundError('reports', parentId);
      if (parent && parent.kind !== ReportKind.FOLDER) throw new ValidationFailure('Only a folder can hold reports', 'parentId');
      if (parentId && isDescendantIn(byId, parentId, id)) throw new ValidationFailure('Cannot move an item into its own subtree');

      const siblings = all.filter((r) => (r.parentId || null) === parentId && r.id !== id).sort((a, b) => a.sortOrder - b.sortOrder);
      const at = index == null ? siblings.length : Math.max(0, Math.min(index, siblings.length));
      siblings.splice(at, 0, item);
      const work = new UnitOfWork();
      let order = 1;
      for (const s of siblings) {
        const current = byId.get(s.id);
        if (!current) continue;
        const next = { ...current, sortOrder: order, parentId: s.id === id ? parentId : current.parentId };
        order += 1;
        if (next.sortOrder !== current.sortOrder || next.parentId !== current.parentId) work.save('reports', next, tokenOf(current));
      }
      if (parentId) {
        work.require('reports', parentId);
        work.guard('reports', (stored) => {
          const live = new Map(stored.map((r) => [r.id, r]));
          const p = live.get(parentId);
          if (p && p.kind !== ReportKind.FOLDER) throw new ValidationFailure('Only a folder can hold reports', 'parentId');
          live.set(id, { ...(live.get(id) || item), parentId });
          if (isDescendantIn(live, parentId, id) || hasCycleAt(live, id)) throw new ValidationFailure('Cannot move an item into its own subtree');
        });
      }
      return work;
    });
    return this.store.get('reports', id);
  }

  async moveRelative(id, siblingId, position = 'before') {
    const sibling = this.store.get('reports', siblingId);
    if (!sibling) throw new NotFoundError('reports', siblingId);
    const siblings = this._siblings(sibling.parentId, id);
    let idx = siblings.findIndex((r) => r.id === siblingId);
    if (position === 'after') idx += 1;
    return this.move(id, sibling.parentId, idx);
  }

  async reorder(id, direction) {
    const item = this.store.get('reports', id);
    if (!item) throw new NotFoundError('reports', id);
    const siblings = this._siblings(item.parentId);
    const idx = siblings.findIndex((r) => r.id === id);
    const target = direction === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= siblings.length) return item;
    return this.move(id, item.parentId, target);
  }

  /**
   * Delete a folder or report. Refused while it holds anything, unless the
   * caller asks for a cascade: sub-items move up to the parent, and the
   * metric links of a report are removed (a folder cannot show metrics, so
   * they have nowhere to go). One transaction, guarded against what another
   * tab may have added since it was planned.
   */
  async delete(id, { strategy = 'refuse', expectedToken = null } = {}) {
    if (!this.store.has('reports', id)) throw new NotFoundError('reports', id);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await commitExclusive(this.repo, this.store, (tx) => {
          const all = tx.list('reports');
          const item = all.find((r) => r.id === id);
          if (!item) throw new NotFoundError('reports', id);
          const links = tx.list('metricReports').filter((l) => l.reportId === id);
          const children = all.filter((r) => r.parentId === id).sort((a, b) => a.sortOrder - b.sortOrder);
          if ((children.length || links.length) && strategy !== 'moveToParent') {
            throw new ValidationFailure(`"${item.name}" still holds ${children.length} sub-item(s) and ${links.length} metric(s)`);
          }
          const work = new UnitOfWork();
          const handled = new Set();
          if (children.length) {
            const targetSiblings = all.filter((r) => (r.parentId || null) === (item.parentId || null) && r.id !== id).sort((a, b) => a.sortOrder - b.sortOrder).concat(children);
            let order = 1;
            for (const s of targetSiblings) {
              const movedHere = children.some((c) => c.id === s.id);
              const next = { ...s, sortOrder: order, parentId: movedHere ? item.parentId : s.parentId };
              order += 1;
              if (movedHere) handled.add(s.id);
              if (next.sortOrder !== s.sortOrder || next.parentId !== s.parentId) work.save('reports', next, tokenOf(s));
            }
          }
          for (const link of links) {
            handled.add(link.id);
            work.remove('metricReports', link.id, tokenOf(link), { optional: true });
          }
          work.guard('reports', (stored) => {
            for (const r of stored) if (r.parentId === id && !handled.has(r.id)) throw new StaleCascadeError('reports', r.id);
          });
          work.guard('metricReports', (stored) => {
            for (const l of stored) if (l.reportId === id && !handled.has(l.id)) throw new StaleCascadeError('metricReports', l.id);
          });
          if (item.parentId) work.require('reports', item.parentId);
          work.remove('reports', id, expectedToken == null ? tokenOf(item) : expectedToken);
          return work;
        });
        return true;
      } catch (err) {
        if (err instanceof StaleCascadeError && attempt === 0) continue;
        throw err;
      }
    }
  }

  // ------------------------------------------------------------ metric links
  /** Show a metric in a report. A folder is refused; an existing link is returned as is. */
  async linkMetric(metricId, reportId, { note = '' } = {}) {
    if (!this.store.has('metrics', metricId)) throw new NotFoundError('metrics', metricId);
    const report = this.store.get('reports', reportId);
    if (!report) throw new NotFoundError('reports', reportId);
    if (report.kind !== ReportKind.REPORT) throw new ValidationFailure('Metrics are linked to reports, not to folders', 'reportId');
    const existing = this.selectors.reportLinks(reportId);
    const dup = existing.find((l) => l.metricId === metricId);
    if (dup) return dup;
    const sortOrder = existing.length ? existing[existing.length - 1].sortOrder + 1 : 1;
    const link = createMetricReport({ metricId, reportId, sortOrder, note });
    const work = new UnitOfWork().require('metrics', metricId).require('reports', reportId).save('metricReports', link, null);
    work.guard('reports', (stored) => {
      const r = stored.find((x) => x.id === reportId);
      if (r && r.kind !== ReportKind.REPORT) throw new ValidationFailure('Metrics are linked to reports, not to folders', 'reportId');
    });
    const result = await commit(this.repo, this.store, work);
    return result.saved.find((s) => s.record.id === link.id).record;
  }

  async unlinkMetric(linkId) {
    const link = this.store.get('metricReports', linkId);
    if (!link) throw new NotFoundError('metricReports', linkId);
    await commit(this.repo, this.store, new UnitOfWork().remove('metricReports', linkId, tokenOf(link)));
    return true;
  }

  async updateLink(linkId, patch, expectedToken) {
    const link = this.store.get('metricReports', linkId);
    if (!link) throw new NotFoundError('metricReports', linkId);
    const merged = createMetricReport({ ...link, ...patch, id: link.id, metricId: link.metricId, reportId: link.reportId, createdAt: link.createdAt, version: link.version });
    const saved = await this.repo.saveMetricReport(merged, expectedToken == null ? tokenOf(link) : expectedToken);
    this.store.upsert('metricReports', saved);
    return saved;
  }

  /**
   * Move a metric's link from one report to another: one record changes.
   *
   * The link's own token says nothing about the report it is being moved to,
   * so the target is re-read and re-checked inside the transaction. The
   * merging case earns the same care: dropping the source link because the
   * target already shows the metric is only safe while that target link is
   * still there, otherwise the metric ends up in neither report.
   */
  async moveLink(metricId, fromReportId, toReportId) {
    let movedId = null;
    await commitExclusive(this.repo, this.store, (tx) => {
      const target = tx.get('reports', toReportId);
      if (!target) throw new NotFoundError('reports', toReportId);
      if (target.kind !== ReportKind.REPORT) throw new ValidationFailure('Metrics are linked to reports, not to folders', 'reportId');
      if (!tx.get('metrics', metricId)) throw new NotFoundError('metrics', metricId);
      const links = tx.list('metricReports').filter((l) => l.metricId === metricId);
      const source = links.find((l) => l.reportId === fromReportId) || null;
      const already = links.find((l) => l.reportId === toReportId) || null;
      const work = new UnitOfWork().require('reports', toReportId);
      work.guard('reports', (stored) => {
        const r = stored.find((x) => x.id === toReportId);
        if (r && r.kind !== ReportKind.REPORT) throw new ValidationFailure('Metrics are linked to reports, not to folders', 'reportId');
      });
      if (already) {
        movedId = already.id;
        // The metric is already shown there; the move is the removal of the
        // source link, and only while the target link still exists.
        if (source) {
          work.require('metricReports', already.id);
          work.remove('metricReports', source.id, tokenOf(source));
        }
        return work;
      }
      if (!source) {
        const order = tx.list('metricReports').filter((l) => l.reportId === toReportId);
        const link = createMetricReport({ metricId, reportId: toReportId, sortOrder: order.length ? Math.max(...order.map((l) => l.sortOrder)) + 1 : 1 });
        movedId = link.id;
        work.require('metrics', metricId).save('metricReports', link, null);
        return work;
      }
      const order = tx.list('metricReports').filter((l) => l.reportId === toReportId);
      movedId = source.id;
      work.save('metricReports', { ...source, reportId: toReportId, sortOrder: order.length ? Math.max(...order.map((l) => l.sortOrder)) + 1 : 1 }, tokenOf(source));
      return work;
    });
    return this.store.get('metricReports', movedId);
  }
}

/** What an item holds decides what it may be. Thrown from a guard as well as from the planner. */
function assertKindFits(kind, children, links) {
  if (kind === ReportKind.REPORT && children.length) throw new ValidationFailure('A folder that holds sub-items cannot become a report', 'kind');
  if (kind === ReportKind.FOLDER && links.length) throw new ValidationFailure('A report that shows metrics cannot become a folder', 'kind');
}

function isDescendantIn(byId, id, ancestorId) {
  let cur = byId.get(id);
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

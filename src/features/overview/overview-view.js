import { h, btn, icon, formatNumber } from '../../ui/dom.js';
import { t, getLanguage } from '../../ui/i18n.js';
import { statusChip, severityDot } from '../../ui/components/chip.js';
import { METRIC_STATUSES } from '../../core/models/metric.js';
import { debounce } from '../../utils/debounce.js';
import { formatDateTime } from '../../utils/time.js';
import { pageHeader } from '../../ui/workspace/page-header.js';

/**
 * Overview — the landing page of the catalogue.
 *
 * Built last on purpose: every number on it is a door into a workspace
 * that already exists. Counts open the catalogue, coverage opens the
 * bindings matrix filtered the same way, an issue opens Quality, a recent
 * metric opens Metric Master with it selected. Nothing here is edited.
 */
export function mountOverviewView(container, ctx) {
  const { store, selectors, services } = ctx;
  const go = (path, params = {}) => ctx.router.navigate(path, params);

  const header = pageHeader({
    title: t('nav.overview'),
    subtitle: t('overview.subtitle'),
    meta: h('span', { class: 'muted small', text: `${t('overview.storage')}: ${ctx.storage.label()}` }),
    actions: [btn(t('overview.action.newMetric'), { kind: 'primary', size: 'sm', icon: 'plus', on: { click: () => go('metrics', { new: 1 }) } })],
  });
  const grid = h('div', { class: 'ov-grid' });
  const scroll = h('div', { class: 'ov-scroll' }, grid);
  const el = h('div', { class: 'ws overview-ws' }, header.el, scroll);
  container.appendChild(el);

  function card(title, { link = null, className = '' } = {}, ...children) {
    return h('section', { class: ['ov-card', className] },
      h('div', { class: 'ov-card-head' }, h('h2', { class: 'ov-card-title', text: title }), link && h('button', { type: 'button', class: 'link ov-card-link', on: { click: link.onClick } }, link.label)),
      ...children);
  }

  function tile(value, caption, { className = '', onClick = null } = {}) {
    return h(onClick ? 'button' : 'div', { type: onClick ? 'button' : undefined, class: ['kpi', className, !onClick && 'static'], on: onClick ? { click: onClick } : undefined },
      h('span', { class: 'kpi-value', text: formatNumber(value) }), h('span', { class: 'kpi-caption', text: caption }));
  }

  function catalogueCard() {
    const metrics = store.count('metrics');
    const byStatus = {};
    for (const s of METRIC_STATUSES) byStatus[s] = 0;
    for (const m of store.list('metrics')) byStatus[m.status] = (byStatus[m.status] || 0) + 1;
    return card(t('overview.catalogue'), { link: { label: t('nav.metrics'), onClick: () => go('metrics') }, className: 'two' },
      h('div', { class: 'ov-tiles' },
        tile(metrics, t('overview.metrics'), { onClick: () => go('metrics') }),
        tile(store.count('structureNodes'), t('overview.groups'), { onClick: () => go('structure') }),
        tile(store.count('dimensions'), t('overview.dimensions'), { onClick: () => go('dimensions') }),
        tile(store.count('scenarios'), t('overview.scenarios'), { onClick: () => go('master-data') }),
        tile(store.list('bindings').filter((b) => b.type !== 'none').length, t('overview.bindings'), { onClick: () => go('bindings') }),
      ),
      h('div', { class: 'ov-status' }, ...METRIC_STATUSES.map((s) => h('span', { class: 'chip chip-status', text: `${t(`metric.status.${s}`)} · ${formatNumber(byStatus[s] || 0)}` }))),
    );
  }

  function coverageCard() {
    const counts = { complete: 0, partial: 0, missing: 0 };
    for (const m of store.list('metrics')) counts[selectors.coverageLevel(m.id)] += 1;
    const total = store.count('metrics') || 1;
    const pct = (n) => `${(n / total) * 100}%`;
    return card(t('overview.coverage'), { link: { label: t('nav.bindings'), onClick: () => go('bindings') } },
      h('div', { class: 'ov-bar', role: 'img', 'aria-label': t('overview.coverageHint', { complete: counts.complete, total: store.count('metrics') }) },
        h('span', { class: 'complete', style: { width: pct(counts.complete) } }), h('span', { class: 'partial', style: { width: pct(counts.partial) } }), h('span', { class: 'missing', style: { width: pct(counts.missing) } })),
      h('div', { class: 'ov-tiles' },
        tile(counts.complete, t('overview.complete'), { className: 'kpi-ok', onClick: () => go('bindings', { coverage: 'complete' }) }),
        tile(counts.partial, t('overview.partial'), { className: 'kpi-warning', onClick: () => go('bindings', { coverage: 'partial' }) }),
        tile(counts.missing, t('overview.missing'), { className: 'kpi-error', onClick: () => go('bindings', { coverage: 'missing' }) }),
      ),
      h('p', { class: 'muted small', text: t('overview.coverageHint', { complete: formatNumber(counts.complete), total: formatNumber(store.count('metrics')) }) }),
    );
  }

  function attentionCard() {
    const index = ctx.validation.index;
    const errors = index.bySeverity.error || 0;
    const warnings = index.bySeverity.warning || 0;
    const unplaced = selectors.unplacedMetricIds().size;
    const missing = store.list('metrics').filter((m) => selectors.coverageLevel(m.id) === 'missing').length;
    const drafts = store.list('metrics').filter((m) => m.status === 'draft').length;
    const items = [];
    if (errors) items.push(h('button', { type: 'button', class: 'ov-item', on: { click: () => go('quality', { severity: 'error' }) } }, severityDot('error'), h('span', { class: 'ellipsis', text: t('overview.errors', { n: formatNumber(errors) }) }), icon('chevronRight', { size: 14 })));
    if (warnings) items.push(h('button', { type: 'button', class: 'ov-item', on: { click: () => go('quality', { severity: 'warning' }) } }, severityDot('warning'), h('span', { class: 'ellipsis', text: t('overview.warnings', { n: formatNumber(warnings) }) }), icon('chevronRight', { size: 14 })));
    if (missing) items.push(h('button', { type: 'button', class: 'ov-item', on: { click: () => go('bindings', { coverage: 'missing' }) } }, icon('link', { size: 14 }), h('span', { class: 'ellipsis', text: t('overview.missingCoverage', { n: formatNumber(missing) }) }), icon('chevronRight', { size: 14 })));
    if (unplaced) items.push(h('button', { type: 'button', class: 'ov-item', on: { click: () => go('metrics', { node: 'unplaced' }) } }, icon('folder', { size: 14 }), h('span', { class: 'ellipsis', text: t('overview.unplaced', { n: formatNumber(unplaced) }) }), icon('chevronRight', { size: 14 })));
    if (drafts) items.push(h('button', { type: 'button', class: 'ov-item', on: { click: () => go('metrics') } }, icon('edit', { size: 14 }), h('span', { class: 'ellipsis', text: t('overview.drafts', { n: formatNumber(drafts) }) }), icon('chevronRight', { size: 14 })));
    const top = index.issues.filter((i) => i.severity !== 'info').slice(0, 5);
    return card(t('overview.attention'), { link: { label: t('overview.openQuality'), onClick: () => go('quality') } },
      items.length ? h('ul', { class: 'ov-list' }, items.map((b) => h('li', null, b))) : h('p', { class: ['insight-para', 'insight-ok'], text: t('overview.allClear') }),
      top.length ? h('div', null, h('div', { class: 'insight-heading', text: t('overview.topIssues') }), h('ul', { class: 'ov-list' }, top.map((i) => h('li', null, h('button', { type: 'button', class: 'ov-item', title: ctx.describeIssue(i), on: { click: () => go('quality', { severity: i.severity }) } }, severityDot(i.severity), h('span', { class: 'ellipsis', text: ctx.describeIssue(i) })))))) : null,
    );
  }

  function recentCard() {
    const recent = [...store.list('metrics')].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 8);
    return card(t('overview.recent'), { link: { label: t('nav.metrics'), onClick: () => go('metrics') } },
      recent.length
        ? h('ul', { class: 'ov-list' }, recent.map((m) => h('li', null, h('button', { type: 'button', class: 'ov-item', on: { click: () => go('metrics', { selected: m.id }) } },
          h('span', { class: 'mono muted', text: m.code }), h('span', { class: 'ellipsis', text: m.name, title: m.name }), statusChip(m.status), h('span', { class: 'when', text: formatDateTime(m.updatedAt, getLanguage()) })))))
        : h('p', { class: 'muted', text: t('overview.noRecent') }),
    );
  }

  function actionsCard() {
    return card(t('overview.actions'), { className: 'wide' },
      h('div', { class: 'ov-actions' },
        btn(t('overview.action.newMetric'), { size: 'sm', icon: 'plus', on: { click: () => go('metrics', { new: 1 }) } }),
        btn(t('overview.action.structure'), { size: 'sm', icon: 'folder', on: { click: () => go('structure') } }),
        btn(t('overview.action.bindings'), { size: 'sm', icon: 'link', on: { click: () => go('bindings') } }),
        btn(t('overview.action.dependencies'), { size: 'sm', icon: 'graph', on: { click: () => go('dependencies') } }),
        btn(t('overview.action.backup'), { size: 'sm', icon: 'download', on: { click: () => go('backup') } }),
        btn(t('overview.action.revalidate'), { size: 'sm', icon: 'check', on: { click: () => ctx.validation.run() } }),
      ),
    );
  }

  function render() {
    grid.replaceChildren(catalogueCard(), coverageCard(), attentionCard(), recentCard(), actionsCard());
  }

  const schedule = debounce(render, 60);
  const offStore = store.events.on('change', () => schedule());
  const offValidation = ctx.validation.onChange(() => schedule());
  const offStorage = ctx.storage.onChange(() => { header.setMeta(h('span', { class: 'muted small', text: `${t('overview.storage')}: ${ctx.storage.label()}` })); });
  render();

  return {
    update() {},
    onShow() { schedule(); },
    onDrawerClosed() {},
    onMetricOpened() {},
    destroy() { offStore(); offValidation(); offStorage(); schedule.cancel(); el.remove(); },
  };
}

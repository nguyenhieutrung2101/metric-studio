import { h, btn, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { statusChip, bindingChip, severityDot } from '../../ui/components/chip.js';
import { insightRow, insightSection, insightStat } from '../../ui/workspace/insights-panel.js';
import { worstSeverity } from '../../services/validation-service.js';

/**
 * What the Insights panel shows for a metric: a read-mostly summary that
 * answers "what is this?" without opening the editor. Everything the user
 * might act on is one button — Edit, open dependencies — and nothing here is
 * a form.
 *
 * renderMetricInsights(ctx, metricId, { onEdit, onDependencies, onStructure }) → Node
 */
export function renderMetricInsights(ctx, metricId, { onEdit, onDependencies = null, onStructure = null } = {}) {
  const { store, selectors, services } = ctx;
  const m = store.get('metrics', metricId);
  if (!m) return null;
  const unit = m.unitId ? store.get('units', m.unitId) : null;
  const scenarios = selectors.scenarios();
  const cov = selectors.coverageOf(m.id);
  const bindings = selectors.bindingsByMetric(m.id);
  const placements = selectors.placementsByMetric(m.id).filter((p) => store.has('structureNodes', p.structureNodeId));
  const dims = selectors.metricDimensions(m.id).map((l) => store.get('dimensions', l.dimensionId)).filter(Boolean);
  const issues = ctx.validation.issuesForMetric(m.id);
  const sev = worstSeverity(issues);
  const dep = services.dependencies;
  let usedBy = 0;
  let dependsOn = 0;
  for (const s of scenarios) {
    usedBy += dep.edgesTo(`${m.id}|${s.id}`).length;
    dependsOn += dep.edgesFrom(`${m.id}|${s.id}`).length;
  }

  const head = h('div', { class: 'insight-head' },
    h('div', { class: 'insight-title', text: m.name }),
    h('div', { class: 'insight-sub' }, h('span', { class: 'mono', text: m.code }), statusChip(m.status), unit && h('span', { class: 'tag', text: unit.code })),
  );

  const definition = insightSection(t('metric.field.definition'),
    m.definition ? h('p', { class: 'insight-para', text: m.definition }) : h('p', { class: 'insight-para muted', text: t('insights.noDefinition') }),
    (m.aliases || []).length ? insightRow(t('metric.field.aliases'), h('span', { class: 'mono small', text: m.aliases.join(' · ') })) : null,
    (m.owners || []).length ? insightRow(t('metric.field.owners'), m.owners.join(', ')) : null,
  );

  const structure = insightSection(t('drawer.section.structure'),
    placements.length
      ? h('ul', { class: 'insight-list' }, placements.map((p) => h('li', null,
        h('button', { type: 'button', class: 'link ellipsis', on: { click: () => onStructure && onStructure(p.structureNodeId) } }, selectors.nodePathLabel(p.structureNodeId, ' › ')),
        p.isPrimary && placements.length > 1 && h('span', { class: 'tag', text: t('drawer.primary') }))))
      : h('p', { class: 'insight-para muted', text: t('mm.unplaced') }),
  );

  const coverage = insightSection(t('insights.coverage'),
    h('ul', { class: 'insight-list' }, scenarios.map((s) => {
      const b = bindings.get(s.id);
      const detail = b && cov[s.id] ? (b.type === 'formula' ? b.formulaText : b.type === 'source' ? [b.source.system, b.source.dataset].filter(Boolean).join(' / ') : b.assumption.value) : '';
      return h('li', null, bindingChip(s.code, cov[s.id], { compact: true }), detail && h('span', { class: 'mono small muted ellipsis', text: detail, title: detail }));
    })),
  );

  const dimensions = insightSection(t('drawer.section.dimensions'),
    dims.length ? h('p', { class: 'insight-para', text: dims.map((d) => d.name).join(' · ') }) : h('p', { class: 'insight-para muted', text: t('insights.noDimensions') }),
  );

  const lineage = insightSection(t('insights.lineage'),
    h('div', { class: 'insight-stats' },
      insightStat(formatNumber(usedBy), t('insights.usedBy'), { onClick: onDependencies && (() => onDependencies('up')) }),
      insightStat(formatNumber(dependsOn), t('insights.dependsOn'), { onClick: onDependencies && (() => onDependencies('down')) }),
    ),
  );

  const quality = insightSection(t('group.quality'),
    issues.length
      ? h('ul', { class: 'insight-list' }, issues.slice(0, 5).map((i) => h('li', null, severityDot(i.severity), h('span', { class: 'ellipsis', text: ctx.describeIssue(i), title: ctx.describeIssue(i) }))), issues.length > 5 && h('li', { class: 'muted', text: t('drawer.warningsMore', { n: issues.length - 5 }) }))
      : h('p', { class: ['insight-para', 'insight-ok'], text: t('insights.noIssues') }),
  );

  const actions = h('div', { class: 'insight-actions' },
    btn(t('insights.editMetric'), { kind: 'primary', size: 'sm', icon: 'edit', on: { click: onEdit } }),
    onDependencies && btn(t('dep.openMetric').replace(/.*/, t('drawer.menu.openDependencies')), { size: 'sm', icon: 'graph', on: { click: () => onDependencies('down') } }),
  );

  return h('div', { class: ['insight', sev && `insight-sev-${sev}`] }, head, definition, structure, coverage, dimensions, lineage, quality, actions);
}

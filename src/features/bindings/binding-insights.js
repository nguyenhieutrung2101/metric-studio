import { h, btn, formatNumber } from '../../ui/dom.js';
import { t, getLanguage } from '../../ui/i18n.js';
import { bindingChip, severityDot } from '../../ui/components/chip.js';
import { insightRow, insightSection, insightStat } from '../../ui/workspace/insights-panel.js';
import { nodeKey } from '../../core/models/binding.js';
import { worstSeverity } from '../../services/validation-service.js';
import { formatDateTime } from '../../utils/time.js';

/**
 * What the Insights panel shows for one cell of the bindings matrix: the
 * binding of one metric in one scenario. Read-mostly — the formula with its
 * references marked, the source or assumption fields, lineage counts and
 * issues — with Edit as the one way into the form.
 *
 * renderBindingInsights(ctx, metricId, scenarioId, { onEdit, onDependencies, onReference }) → Node
 */
export function renderBindingInsights(ctx, metricId, scenarioId, { onEdit, onDependencies = null, onReference = null } = {}) {
  const { store, selectors, services } = ctx;
  const m = store.get('metrics', metricId);
  const s = store.get('scenarios', scenarioId);
  if (!m || !s) return null;
  const b = selectors.bindingFor(m.id, s.id);
  const type = b && b.type !== 'none' ? b.type : null;
  const issues = ctx.validation.issuesForMetric(m.id).filter((i) => i.scenarioId === s.id || (b && i.entity.type === 'binding' && i.entity.id === b.id));
  const sev = worstSeverity(issues);
  const key = nodeKey(m.id, s.id);
  const usedBy = services.dependencies.edgesTo(key).length;
  const dependsOn = services.dependencies.edgesFrom(key).length;

  const head = h('div', { class: 'insight-head' },
    h('div', { class: 'insight-title', text: m.name }),
    h('div', { class: 'insight-sub' }, h('span', { class: 'mono', text: m.code }), bindingChip(s.code, type), type && b.status && h('span', { class: 'tag', text: t(`binding.status.${b.status}`) }), type === 'formula' && b.formulaMode === 'text' && h('span', { class: 'tag tag-freetext', text: t('binding.freeText') })),
  );

  let body;
  if (!type) {
    body = insightSection(t('drawer.section.bindings'), h('p', { class: 'insight-para muted', text: t('bindings.noBinding', { scenario: s.name || s.code }) }));
  } else if (type === 'formula') {
    body = insightSection(t('binding.formula'),
      b.formulaMode === 'text' && h('p', { class: 'insight-para insight-warn', text: t('binding.freeTextInsight') }),
      formulaView(b, onReference),
      b.formulaErrors && b.formulaErrors.length ? h('ul', { class: 'insight-list' }, b.formulaErrors.slice(0, 3).map((e) => h('li', null, severityDot('error'), h('span', { class: 'ellipsis', text: e.message || String(e), title: e.message || String(e) })))) : null,
      referencesList(ctx, b, onReference),
    );
  } else if (type === 'source') {
    body = insightSection(t('binding.type.source'),
      insightRow(t('binding.source.system'), b.source.system || '—'),
      insightRow(t('binding.source.dataset'), b.source.dataset || '—'),
      b.source.field && insightRow(t('binding.source.field'), h('span', { class: 'mono', text: b.source.field })),
      b.source.frequency && insightRow(t('binding.source.frequency'), b.source.frequency),
      b.source.owner && insightRow(t('binding.source.owner'), b.source.owner),
      b.source.note && h('p', { class: 'insight-para muted', text: b.source.note }),
    );
  } else {
    body = insightSection(t('binding.type.assumption'),
      insightRow(t('binding.assumption.value'), h('span', { class: 'mono', text: b.assumption.value || '—' })),
      (b.assumption.validFrom || b.assumption.validTo) && insightRow(t('binding.assumption.validity'), `${b.assumption.validFrom || '…'} → ${b.assumption.validTo || '…'}`),
      b.assumption.basis && insightRow(t('binding.assumption.basis'), b.assumption.basis),
      b.assumption.note && h('p', { class: 'insight-para muted', text: b.assumption.note }),
    );
  }

  const meta = b && type ? insightSection(t('drawer.section.bindings'),
    b.legacyCode && insightRow(t('binding.legacyCode'), h('span', { class: 'mono', text: b.legacyCode })),
    b.note && insightRow(t('binding.note'), b.note),
    insightRow(t('bindings.updated'), formatDateTime(b.updatedAt, getLanguage())),
  ) : null;

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
    btn(type ? t('bindings.editBinding') : t('bindings.addBinding'), { kind: 'primary', size: 'sm', icon: type ? 'edit' : 'plus', on: { click: onEdit } }),
    onDependencies && type === 'formula' && btn(t('drawer.menu.openDependencies'), { size: 'sm', icon: 'graph', on: { click: () => onDependencies('down') } }),
  );

  return h('div', { class: ['insight', sev && `insight-sev-${sev}`] }, head, body, meta, lineage, quality, actions);
}

const REF_LABEL = { resolved: 'binding.legendResolved', missing: 'binding.legendMissing', ambiguous: 'binding.legendAmbiguous', 'unknown-scenario': 'binding.legendUnknownScenario' };

/** The formula text with each reference wrapped so its status shows and a resolved one is a link to its own cell. */
function formulaView(b, onReference) {
  const text = b.formulaText || '';
  const refs = b.parsedReferences || [];
  const out = [];
  let cursor = 0;
  for (const r of refs) {
    const at = r.raw ? text.indexOf(r.raw, cursor) : -1;
    if (at < 0) continue;
    if (at > cursor) out.push(text.slice(cursor, at));
    const resolved = r.status === 'resolved' && r.metricId && r.scenarioId;
    out.push(h(resolved && onReference ? 'button' : 'span', {
      type: resolved && onReference ? 'button' : undefined,
      class: ['ref-view', `ref-${r.status}`],
      title: REF_LABEL[r.status] ? t(REF_LABEL[r.status]) : r.status,
      on: resolved && onReference ? { click: () => onReference(r.metricId, r.scenarioId) } : undefined,
    }, r.raw));
    cursor = at + r.raw.length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return h('pre', { class: 'formula-view' }, out.length ? out : text);
}

function referencesList(ctx, b, onReference) {
  const refs = (b.parsedReferences || []).filter((r) => r.status === 'resolved' && r.metricId);
  if (!refs.length) return null;
  const seen = new Set();
  const items = [];
  for (const r of refs) {
    const k = `${r.metricId}|${r.scenarioId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const m = ctx.store.get('metrics', r.metricId);
    const s = r.scenarioId ? ctx.store.get('scenarios', r.scenarioId) : null;
    if (!m) continue;
    items.push(h('li', null,
      h('span', { class: 'mono muted', text: m.code }),
      h('button', { type: 'button', class: 'link ellipsis', title: m.name, on: { click: () => onReference && onReference(r.metricId, r.scenarioId) } }, m.name),
      s && h('span', { class: 'tag', text: s.code }),
    ));
  }
  return h('div', null, h('div', { class: 'insight-heading', text: t('bindings.references') }), h('ul', { class: 'insight-list' }, items));
}

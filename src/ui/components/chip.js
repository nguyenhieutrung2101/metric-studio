import { h } from '../dom.js';
import { t } from '../i18n.js';

/** Binding-type chip: `TT · Formula`. type null/none → dash. */
export function bindingChip(scenarioCode, type, { compact = false } = {}) {
  const kind = type && type !== 'none' ? type : 'none';
  return h('span', { class: `chip chip-binding chip-${kind}`, title: `${scenarioCode}: ${t(`binding.type.${kind}`)}` },
    h('span', { class: 'chip-scn', text: scenarioCode }),
    h('span', { class: 'chip-val', text: kind === 'none' ? '—' : (compact ? t(`binding.type.${kind}.short`) : t(`binding.type.${kind}`)) }),
  );
}

export function statusChip(status) {
  return h('span', { class: `chip chip-status chip-status-${status}`, text: t(`metric.status.${status}`) });
}

export function severityDot(severity, count) {
  if (!severity) return null;
  return h('span', { class: `sev-dot sev-${severity}`, title: t(`severity.${severity}`) + (count ? ` · ${count}` : '') });
}

export function tag(text, className = '') {
  return h('span', { class: `tag ${className}`.trim(), text });
}

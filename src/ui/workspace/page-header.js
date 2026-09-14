import { h } from '../dom.js';

/**
 * The first row of a workspace: what this page is, and its primary actions.
 *
 * pageHeader({ title, subtitle?, actions?: Node[], meta?: Node }) → { el, setTitle, setSubtitle, setMeta }
 *
 * Nothing that scopes or filters belongs here — that is the context bar and
 * the filter bar. This row is stable; those change with the work.
 */
export function pageHeader({ title, subtitle = '', actions = [], meta = null } = {}) {
  const titleEl = h('h1', { class: 'page-title', text: title });
  const subtitleEl = h('span', { class: 'page-subtitle', text: subtitle, hidden: !subtitle });
  const metaEl = h('div', { class: 'page-meta' }, meta);
  const actionsEl = h('div', { class: 'page-actions' }, ...actions);
  const el = h('header', { class: 'page-header' }, h('div', { class: 'page-heading' }, titleEl, subtitleEl), metaEl, actionsEl);
  return {
    el,
    setTitle: (v) => { titleEl.textContent = v; },
    setSubtitle: (v) => { subtitleEl.textContent = v || ''; subtitleEl.hidden = !v; },
    setMeta: (node) => { metaEl.replaceChildren(node || ''); },
  };
}

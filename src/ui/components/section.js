import { h, icon } from '../dom.js';

/**
 * Collapsible section used in the drawer and side panels.
 * section({ title, open, badge, actions }) → { el, body, setOpen, setBadge }
 */
export function section({ title, open = true, badge = null, actions = null, className = '' }) {
  const badgeEl = h('span', { class: 'section-badge', text: badge == null ? '' : String(badge) });
  const chevron = icon('chevronDown', { className: 'section-chevron' });
  const body = h('div', { class: 'section-body' });
  const head = h('button', { type: 'button', class: 'section-head', 'aria-expanded': String(open) }, chevron, h('span', { class: 'section-title', text: title }), badgeEl);
  const actionsEl = h('div', { class: 'section-actions' }, actions);
  const el = h('section', { class: ['section', !open && 'collapsed', className] }, h('div', { class: 'section-headrow' }, head, actionsEl), body);
  const setOpen = (v) => {
    el.classList.toggle('collapsed', !v);
    head.setAttribute('aria-expanded', String(v));
  };
  head.addEventListener('click', () => setOpen(el.classList.contains('collapsed')));
  return {
    el,
    body,
    setOpen,
    isOpen: () => !el.classList.contains('collapsed'),
    setBadge: (v) => { badgeEl.textContent = v == null || v === '' ? '' : String(v); },
  };
}

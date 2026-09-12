import { h, icon } from '../dom.js';

/** Non-blocking feedback at the bottom of the screen. */
export function createToast(host) {
  let timer = null;
  const el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  host.appendChild(el);

  function show(message, { kind = 'info', duration = 3200, action = null } = {}) {
    if (timer) clearTimeout(timer);
    el.className = `toast toast-${kind}`;
    el.replaceChildren(icon(kind === 'error' ? 'warning' : kind === 'success' ? 'check' : 'info'), h('span', { class: 'toast-text', text: message }));
    if (action) el.appendChild(h('button', { type: 'button', class: 'toast-action', text: action.label, on: { click: () => { hide(); action.onClick(); } } }));
    requestAnimationFrame(() => el.classList.add('show'));
    timer = setTimeout(hide, duration);
  }

  function hide() {
    el.classList.remove('show');
    timer = null;
  }

  return {
    show,
    info: (m, o) => show(m, { ...o, kind: 'info' }),
    success: (m, o) => show(m, { ...o, kind: 'success' }),
    error: (m, o) => show(m, { ...o, kind: 'error', duration: 5000 }),
    hide,
  };
}

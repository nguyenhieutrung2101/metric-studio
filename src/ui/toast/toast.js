import { h, icon } from '../dom.js';

/** Non-blocking feedback at the bottom of the screen. */
export function createToast(host) {
  let timer = null;
  const el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  host.appendChild(el);

  /**
   * @param {object} [opts]
   * @param {{label: string, onClick: Function}} [opts.action] single action
   * @param {Array<{label: string, onClick: Function, kind?: string}>} [opts.actions]
   *   several, for a message that refuses something and should offer the ways
   *   out rather than only the refusal.
   */
  function show(message, { kind = 'info', duration = 3200, action = null, actions = null } = {}) {
    if (timer) clearTimeout(timer);
    el.className = `toast toast-${kind}`;
    el.replaceChildren(icon(kind === 'error' ? 'warning' : kind === 'success' ? 'check' : 'info'), h('span', { class: 'toast-text', text: message }));
    const list = actions && actions.length ? actions : action ? [action] : [];
    for (const a of list) {
      if (!a) continue;
      el.appendChild(h('button', { type: 'button', class: ['toast-action', a.kind && `toast-action-${a.kind}`], text: a.label, on: { click: () => { hide(); a.onClick(); } } }));
    }
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

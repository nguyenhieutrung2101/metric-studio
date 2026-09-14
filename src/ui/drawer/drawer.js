import { h, btn, clear } from '../dom.js';
import { t } from '../i18n.js';

/**
 * Right-side contextual drawer. One instance per app; content is provided by
 * features. Esc closes (unless a popover consumed it), Ctrl/Cmd+S triggers
 * the registered save handler.
 */
export function createDrawer(host) {
  const title = h('div', { class: 'drawer-title' });
  const actions = h('div', { class: 'drawer-actions' });
  const closeBtn = btn('', { icon: 'close', title: t('common.close'), on: { click: () => close() } });
  const body = h('div', { class: 'drawer-body' });
  const el = h('aside', { class: 'drawer', role: 'complementary', 'aria-hidden': 'true' }, h('div', { class: 'drawer-head' }, title, actions, closeBtn), body);
  host.appendChild(el);

  let state = { open: false, onClose: null, onSave: null, canClose: null };

  async function close({ force = false } = {}) {
    if (!state.open) return true;
    if (!force && state.canClose) {
      const ok = await state.canClose();
      if (!ok) return false;
    }
    state.open = false;
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('drawer-open');
    const cb = state.onClose;
    state = { open: false, onClose: null, onSave: null, canClose: null };
    setTimeout(() => {
      if (!state.open) clear(body);
    }, 220);
    if (cb) cb();
    return true;
  }

  function open({ titleNode, actionNodes = [], content, onClose = null, onSave = null, canClose = null }) {
    state = { open: true, onClose, onSave, canClose };
    title.replaceChildren(titleNode);
    actions.replaceChildren(...actionNodes);
    body.replaceChildren(content);
    body.scrollTop = 0;
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('drawer-open');
  }

  function setTitle(node) {
    title.replaceChildren(node);
  }

  function setActions(nodes) {
    actions.replaceChildren(...nodes);
  }

  document.addEventListener('keydown', (e) => {
    if (!state.open) return;
    if (e.key === 'Escape' && !e.defaultPrevented) {
      const tag = document.activeElement && document.activeElement.tagName;
      if (document.querySelector('dialog[open]') || document.querySelector('.menu') || document.querySelector('.combo.open')) return;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        document.activeElement.blur();
        return;
      }
      // Closing may open the "unsaved changes" dialog synchronously; without
      // this, the same Escape's default action would cancel that dialog
      // before anyone saw it.
      e.preventDefault();
      close();
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      if (state.onSave) {
        e.preventDefault();
        state.onSave();
      }
    }
  });

  return { el, body, open, close, setTitle, setActions, isOpen: () => state.open };
}

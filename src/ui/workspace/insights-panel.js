import { h, btn, icon, clear } from '../dom.js';
import { t } from '../i18n.js';
import { getPreference, setPreference } from '../../utils/preferences.js';

const MIN_W = 240;
const MAX_W = 560;

/**
 * The contextual inspector that sits to the right of a worksheet.
 *
 * It answers "what is this?" for whatever is selected, so the user can scan
 * ten rows without opening and closing an editor ten times. It is read-mostly:
 * a summary, a few counts, one or two actions that lead to the editor. It
 * can be collapsed to a thin rail and resized by dragging its edge; both are
 * remembered per workspace.
 *
 * createInsightsPanel({ preferenceKey, title, emptyText }) →
 *   { el, body, setTitle(node|string), setContent(node|null), open(), close(), toggle(), isOpen() }
 */
export function createInsightsPanel({ preferenceKey, title = t('insights.title'), emptyText = t('insights.empty'), width = null } = {}) {
  const prefs = getPreference(`insights.${preferenceKey}`, {}) || {};
  let open = prefs.open !== false;
  let w = clamp(prefs.width || width || 320);

  const titleEl = h('span', { class: 'insights-title', text: title });
  const collapseBtn = btn('', { icon: 'chevronRight', size: 'sm', className: 'btn-ghost', title: t('insights.collapse'), on: { click: () => toggle(false, { focus: true }) } });
  const head = h('div', { class: 'insights-head' }, titleEl, h('span', { class: 'spacer' }), collapseBtn);
  const body = h('div', { class: 'insights-body' });
  const empty = h('div', { class: 'insights-empty' }, icon('info', { size: 20 }), h('p', { text: emptyText }));
  const handle = h('div', { class: 'insights-handle', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': t('insights.resize'), 'aria-valuemin': String(MIN_W), 'aria-valuemax': String(MAX_W), tabindex: '0', title: t('insights.resize') });
  const rail = h('button', { type: 'button', class: 'insights-rail', title: t('insights.expand'), 'aria-label': t('insights.expand'), 'aria-expanded': 'false', on: { click: () => toggle(true, { focus: true }) } }, icon('chevronDown', { size: 14, className: 'rail-icon' }), h('span', { class: 'rail-label', text: title }));
  const panel = h('div', { class: 'insights-panel' }, head, body);
  const el = h('aside', { class: 'insights', 'aria-label': title }, handle, panel, rail);

  // `w` is what the person asked for and what is remembered. What the panel
  // actually takes is decided against the space the workspace has: the main
  // pane keeps a readable minimum, and when even the narrowest panel would
  // not fit beside it the panel becomes an overlay that opens over the main
  // pane from its rail. Neither adjustment touches the stored preference.
  const MAIN_MIN = 480;
  let overlay = false;
  let effective = w;
  // What the person chose on a wide screen. Opening or closing the overlay
  // on a narrow one is a transient choice and is not written over it.
  let desktopOpen = open;

  function remember() {
    setPreference(`insights.${preferenceKey}`, { open: desktopOpen, width: w });
  }

  function measure() {
    const host = el.parentElement;
    if (!host) return;
    const side = host.querySelector(':scope > .pane.tree-pane:not(.rail-only)');
    const sideW = side && host.classList.contains('narrow') ? 0 : side ? side.offsetWidth : 0;
    const railW = host.classList.contains('narrow') ? 34 : 0;
    const room = host.clientWidth - sideW - railW - MAIN_MIN;
    const nextOverlay = room < MIN_W;
    effective = nextOverlay ? w : Math.max(MIN_W, Math.min(w, room));
    if (nextOverlay !== overlay) {
      overlay = nextOverlay;
      el.classList.toggle('overlay', overlay);
      // Entering the overlay closes it (the rail stays); leaving it restores
      // what the wide screen had.
      open = overlay ? false : desktopOpen;
      el.classList.toggle('collapsed', !open);
      el.setAttribute('aria-expanded', String(open));
      rail.setAttribute('aria-expanded', String(open));
    }
    el.style.setProperty('--insights-w', `${effective}px`);
  }

  function apply() {
    el.classList.toggle('collapsed', !open);
    el.setAttribute('aria-expanded', String(open));
    rail.setAttribute('aria-expanded', String(open));
    collapseBtn.title = overlay && open ? t('common.close') : t('insights.collapse');
    handle.setAttribute('aria-valuenow', String(w));
    measure();
  }

  function toggle(force, { focus = false } = {}) {
    open = force == null ? !open : !!force;
    if (!overlay) desktopOpen = open;
    apply();
    remember();
    if (focus) (open ? collapseBtn : rail).focus();
  }

  function setContent(node) {
    clear(body);
    body.appendChild(node || empty);
  }

  function setTitle(value) {
    if (typeof value === 'string') titleEl.textContent = value;
    else titleEl.replaceChildren(value);
  }

  // Drag the left edge to resize. Pointer capture keeps the drag alive when
  // the pointer leaves the thin handle; a cancelled or lost capture ends the
  // drag the same way a release does.
  handle.addEventListener('pointerdown', (e) => {
    if (!open) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = w;
    el.classList.add('resizing');
    const move = (ev) => {
      w = clamp(startW + (startX - ev.clientX));
      measure();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.removeEventListener('lostpointercapture', up);
      el.classList.remove('resizing');
      handle.setAttribute('aria-valuenow', String(w));
      remember();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    handle.addEventListener('lostpointercapture', up);
  });
  handle.addEventListener('dblclick', () => { w = clamp(width || 320); apply(); remember(); });
  // The same resize from the keyboard: 16px per arrow, Home/End to the limits.
  handle.addEventListener('keydown', (e) => {
    if (!open) return;
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') w = clamp(w + step);
    else if (e.key === 'ArrowRight') w = clamp(w - step);
    else if (e.key === 'Home') w = MAX_W;
    else if (e.key === 'End') w = MIN_W;
    else return;
    e.preventDefault();
    apply();
    remember();
  });
  // In overlay mode Escape closes the panel and hands focus back to the rail.
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && open && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      toggle(false, { focus: true });
    }
  });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : null;
  const observeHost = () => {
    if (!el.parentElement) return;
    if (ro) ro.observe(el.parentElement);
    el.parentElement.addEventListener('layout-change', () => measure());
    measure();
  };
  // The host is not known until the layout mounts the panel.
  setTimeout(observeHost, 0);

  setContent(null);
  apply();
  return { el, body, setTitle, setContent, open: () => toggle(true), close: () => toggle(false), toggle, isOpen: () => open, measure, destroy: () => { if (ro) ro.disconnect(); } };
}

function clamp(v) {
  return Math.max(MIN_W, Math.min(MAX_W, Math.round(v)));
}

/** A labelled row inside an inspector: `label` on the left, `value` on the right. */
export function insightRow(label, value, { className = '' } = {}) {
  return h('div', { class: ['insight-row', className] }, h('span', { class: 'insight-label', text: label }), h('span', { class: 'insight-value' }, typeof value === 'string' ? h('span', { text: value }) : value));
}

/** A titled block inside an inspector. */
export function insightSection(title, ...children) {
  return h('section', { class: 'insight-section' }, h('h3', { class: 'insight-heading', text: title }), ...children);
}

/** A number with a caption — "14 · Used by". */
export function insightStat(value, caption, { onClick = null, className = '' } = {}) {
  const el = h(onClick ? 'button' : 'div', { type: onClick ? 'button' : undefined, class: ['insight-stat', onClick && 'clickable', className], on: onClick ? { click: onClick } : {} },
    h('span', { class: 'insight-stat-value', text: String(value) }),
    h('span', { class: 'insight-stat-caption', text: caption }));
  return el;
}

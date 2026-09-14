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
  const collapseBtn = btn('', { icon: 'chevronRight', size: 'sm', className: 'btn-ghost', title: t('insights.collapse'), on: { click: () => toggle() } });
  const head = h('div', { class: 'insights-head' }, titleEl, h('span', { class: 'spacer' }), collapseBtn);
  const body = h('div', { class: 'insights-body' });
  const empty = h('div', { class: 'insights-empty' }, icon('info', { size: 20 }), h('p', { text: emptyText }));
  const handle = h('div', { class: 'insights-handle', role: 'separator', 'aria-orientation': 'vertical', title: t('insights.resize') });
  const rail = h('button', { type: 'button', class: 'insights-rail', title: t('insights.expand'), on: { click: () => toggle() } }, icon('chevronDown', { size: 14, className: 'rail-icon' }), h('span', { class: 'rail-label', text: title }));
  const el = h('aside', { class: 'insights', 'aria-label': title }, handle, head, body, rail);

  function remember() {
    setPreference(`insights.${preferenceKey}`, { open, width: w });
  }

  function apply() {
    el.classList.toggle('collapsed', !open);
    el.style.setProperty('--insights-w', `${w}px`);
    el.setAttribute('aria-expanded', String(open));
  }

  function toggle(force) {
    open = force == null ? !open : !!force;
    apply();
    remember();
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
  // the pointer leaves the thin handle.
  handle.addEventListener('pointerdown', (e) => {
    if (!open) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = w;
    el.classList.add('resizing');
    const move = (ev) => {
      w = clamp(startW + (startX - ev.clientX));
      el.style.setProperty('--insights-w', `${w}px`);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      el.classList.remove('resizing');
      remember();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('dblclick', () => { w = clamp(width || 320); apply(); remember(); });

  setContent(null);
  apply();
  return { el, body, setTitle, setContent, open: () => toggle(true), close: () => toggle(false), toggle, isOpen: () => open };
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

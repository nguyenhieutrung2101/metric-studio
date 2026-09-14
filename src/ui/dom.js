/**
 * Safe DOM helpers. User-provided strings only ever go through textContent
 * or attribute setters — never innerHTML.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

export function svg(tag, props = null, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function applyProps(el, props) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    switch (k) {
      case 'class':
      case 'className':
        el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
        break;
      case 'text':
        el.textContent = v;
        break;
      case 'dataset':
        for (const [dk, dv] of Object.entries(v)) if (dv != null) el.dataset[dk] = String(dv);
        break;
      case 'style':
        if (typeof v === 'string') el.style.cssText = v;
        else Object.assign(el.style, v);
        break;
      case 'attrs':
        for (const [ak, av] of Object.entries(v)) if (av != null && av !== false) el.setAttribute(ak, av === true ? '' : String(av));
        break;
      case 'on':
        for (const [ev, fn] of Object.entries(v)) if (fn) el.addEventListener(ev, fn);
        break;
      case 'ref':
        v(el);
        break;
      default:
        if (k in el && typeof v !== 'object') el[k] = v;
        else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function setChildren(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

export function on(el, event, handler, options) {
  el.addEventListener(event, handler, options);
  return () => el.removeEventListener(event, handler, options);
}

/** Small inline icon set (stroke icons, currentColor). */
const ICONS = {
  search: 'M11 4a7 7 0 1 0 4.2 12.6l3.6 3.6 1.4-1.4-3.6-3.6A7 7 0 0 0 11 4zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
  close: 'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z',
  chevronRight: 'M9 6l6 6-6 6-1.4-1.4L12.2 12 7.6 7.4z',
  chevronDown: 'M6 9l6 6 6-6-1.4-1.4L12 12.2 7.4 7.6z',
  folder: 'M3 5h6l2 2h10v12H3z',
  warning: 'M12 3 2 21h20zm0 6v6m0 2v2',
  check: 'M5 12.5 9.5 17 19 7.5l-1.4-1.4-8.1 8.1-3.1-3.1z',
  more: 'M6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
  drag: 'M9 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm9 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM9 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm9 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM9 19a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm9 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
  graph: 'M4 6h5v4H4zm11 0h5v4h-5zm-5 8h5v4h-5zM9 8h6M12 10v4',
  external: 'M14 4h6v6m0-6L10 14M20 14v6H4V4h6',
  trash: 'M5 7h14M9 7V4h6v3m-7 3v8m4-8v8M7 7l1 13h8l1-13',
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  zoomIn: 'M12 5v14M5 12h14',
  zoomOut: 'M5 12h14',
  arrowLeft: 'M20 12H5m0 0 6-6m-6 6 6 6',
  arrowRight: 'M4 12h15m0 0-6-6m6 6-6 6',
  layers: 'M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 17l10 5 10-5',
  star: 'm12 3 2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.4l-5.7 3.1 1.2-6.4L2.8 9.7l6.4-.8z',
  link: 'M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1.5 1.5M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1.5-1.5',
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 19h14',
  upload: 'M12 15V4m0 0-4 4m4-4 4 4M5 19h14',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 7v6m0-9v1',
  filter: 'M4 5h16l-6 8v6l-4-2v-4z',
  edit: 'm4 20 4-1L19 8l-3-3L5 16zM14 6l3 3',
  up: 'M12 19V6m0 0-6 6m6-6 6 6',
  down: 'M12 5v13m0 0 6-6m-6 6-6-6',
};

export function icon(name, { size = 16, className = '' } = {}) {
  const d = ICONS[name] || ICONS.info;
  const filled = name === 'more' || name === 'drag' || name === 'star';
  return svg(
    'svg',
    { class: `icon icon-${name} ${className}`.trim(), width: size, height: size, viewBox: '0 0 24 24', fill: filled ? 'currentColor' : 'none', stroke: filled ? 'none' : 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    svg('path', { d }),
  );
}

/** Button helper: `btn('Save', { kind: 'primary', icon: 'check', on: { click } })` */
export function btn(label, { kind = '', icon: iconName = null, title = '', on: handlers = {}, disabled = false, className = '', type = 'button', size = '' } = {}) {
  return h('button', { type, class: ['btn', kind && `btn-${kind}`, size && `btn-${size}`, !label && 'btn-icon', className], title: title || (label ? undefined : iconName), disabled, on: handlers, 'aria-label': label ? undefined : title || iconName }, iconName && icon(iconName), label && h('span', { class: 'btn-label', text: label }));
}

export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Escape-key + outside-click helper for popovers. */
/**
 * Close a floating element on Escape or on a pointer down outside it.
 * `onDismiss(reason)` says which: 'escape' — the person expects focus back
 * on what opened it — or 'outside'.
 */
export function dismissOn(el, onDismiss, { outside = true } = {}) {
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      onDismiss('escape');
    }
  };
  const onDown = (e) => {
    if (outside && !el.contains(e.target)) onDismiss('outside');
  };
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  return () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
  };
}

/**
 * Keep a popover on screen: flip it above its anchor when there is more room
 * there than below, and cap its height to the room it has. Works for an
 * absolutely positioned popover under a `position: relative` anchor; the
 * optional `within` is the scroll container that would clip it (a drawer
 * body), otherwise the viewport.
 */
export function placePopover(pop, anchor, { within = null, margin = 8 } = {}) {
  const a = anchor.getBoundingClientRect();
  const boundsTop = within ? within.getBoundingClientRect().top : 0;
  const boundsBottom = within ? within.getBoundingClientRect().bottom : window.innerHeight;
  const below = boundsBottom - a.bottom - margin;
  const above = a.top - boundsTop - margin;
  const wanted = pop.scrollHeight || pop.offsetHeight;
  const up = wanted > below && above > below;
  pop.classList.toggle('up', up);
  pop.style.setProperty('--pop-max', `${Math.max(120, Math.floor(up ? above : below))}px`);
  return up;
}

export function formatNumber(n) {
  try {
    return new Intl.NumberFormat().format(n);
  } catch {
    return String(n);
  }
}

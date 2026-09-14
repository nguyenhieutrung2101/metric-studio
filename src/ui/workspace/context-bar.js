import { h, icon, dismissOn } from '../dom.js';

/**
 * Context selectors: "which slice of the world am I working in?"
 *
 * A context changes the meaning of the workspace — the structure node whose
 * metrics the grid shows, the scenario a coverage matrix is about. A filter
 * only hides rows. Keeping the two on separate rows keeps that difference
 * visible: contexts are few and prominent, filters are many and quiet.
 *
 * contextBar() → { el, add(label, control), clear() }
 * contextSelect({ label, value, options, onChange, renderValue? }) → a
 *   "Label: Value ▾" control that opens a list.
 */
export function contextBar(...children) {
  const el = h('div', { class: 'context-bar' }, ...children);
  return {
    el,
    add(node) { el.appendChild(node); return node; },
    clear() { el.replaceChildren(); },
  };
}

/**
 * A context control: a label, the current value, a chevron. Clicking opens a
 * simple list; `options` may be a function so it is read fresh each time.
 * For the structure context, which is a whole tree, the caller passes a
 * `renderPicker(close)` instead of options.
 */
export function contextSelect({ label, value = '', options = null, onChange = null, renderPicker = null, icon: iconName = null, className = '' }) {
  const valueEl = h('span', { class: 'ctx-value', text: value });
  const button = h('button', { type: 'button', class: ['ctx-select', className], 'aria-haspopup': 'listbox' },
    iconName && icon(iconName, { size: 14, className: 'ctx-icon' }),
    h('span', { class: 'ctx-label', text: label }),
    valueEl,
    icon('chevronDown', { size: 12, className: 'ctx-chevron' }));
  const el = h('div', { class: 'ctx' }, button);
  let pop = null;
  let stop = null;

  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    if (stop) stop();
    stop = null;
    button.classList.remove('open');
  }

  function open() {
    if (pop) { close(); return; }
    const list = h('div', { class: 'ctx-pop', role: 'listbox' });
    if (renderPicker) list.appendChild(renderPicker(close));
    else {
      const items = typeof options === 'function' ? options() : options || [];
      for (const o of items) {
        list.appendChild(h('button', { type: 'button', role: 'option', class: ['ctx-option', o.value === current && 'active'], 'aria-selected': String(o.value === current), on: { click: () => { close(); setValue(o.value, o.label); if (onChange) onChange(o.value); } } },
          h('span', { text: o.label }), o.sub && h('span', { class: 'ctx-option-sub', text: o.sub })));
      }
    }
    pop = list;
    el.appendChild(list);
    button.classList.add('open');
    stop = dismissOn(el, close);
  }

  let current = null;
  function setValue(v, text) {
    current = v;
    valueEl.textContent = text == null ? String(v ?? '') : text;
  }

  button.addEventListener('click', open);
  return { el, button, setValue, close, get value() { return current; } };
}

import { h, icon, dismissOn, placePopover } from '../dom.js';
import { t } from '../i18n.js';

/**
 * Searchable single-select. Keyboard: ↑ ↓ Enter Esc.
 * combobox({ placeholder, search(query) → items[{ id, label, sub, meta }], onSelect(item), renderItem?, minChars })
 */
export function combobox({ placeholder = '', search, onSelect, minChars = 0, autofocus = false, value = '', className = '', emptyText = null, allowCreate = null }) {
  const listId = `combo-list-${Math.random().toString(36).slice(2, 8)}`;
  const input = h('input', { type: 'text', class: 'input combo-input', placeholder, autocomplete: 'off', spellcheck: false, value, role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId });
  const list = h('div', { class: 'combo-list', role: 'listbox', id: listId });
  const el = h('div', { class: `combo ${className}`.trim() }, icon('search', { className: 'combo-icon' }), input, list);
  let items = [];
  let active = -1;
  let open = false;
  let stop = null;

  function render() {
    list.replaceChildren();
    if (!items.length) {
      if (allowCreate && input.value.trim()) {
        list.appendChild(h('button', { type: 'button', class: 'combo-item combo-create', on: { click: () => choose({ create: true, query: input.value.trim() }) } }, icon('plus'), h('span', { text: allowCreate(input.value.trim()) })));
      } else list.appendChild(h('div', { class: 'combo-empty', text: emptyText || t('common.noResults') }));
      return;
    }
    items.forEach((item, i) => {
      list.appendChild(h('button', { type: 'button', role: 'option', class: ['combo-item', i === active && 'active'], 'aria-selected': String(i === active), on: { click: () => choose(item), mousemove: () => { if (active !== i) { active = i; markActive(); } } } },
        h('span', { class: 'combo-label', text: item.label }),
        item.sub && h('span', { class: 'combo-sub', text: item.sub }),
        item.meta && h('span', { class: 'combo-meta', text: item.meta }),
      ));
    });
    if (allowCreate && input.value.trim()) {
      list.appendChild(h('button', { type: 'button', class: 'combo-item combo-create', on: { click: () => choose({ create: true, query: input.value.trim() }) } }, icon('plus'), h('span', { text: allowCreate(input.value.trim()) })));
    }
  }

  function markActive() {
    [...list.children].forEach((c, i) => {
      c.classList.toggle('active', i === active);
      c.setAttribute('aria-selected', String(i === active));
      if (!c.id) c.id = `${listId}-${i}`;
    });
    const a = list.children[active];
    if (a) input.setAttribute('aria-activedescendant', a.id);
    else input.removeAttribute('aria-activedescendant');
    if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
  }

  function update() {
    const q = input.value.trim();
    if (q.length < minChars) {
      items = [];
      hide();
      return;
    }
    items = search(q) || [];
    active = items.length ? 0 : -1;
    render();
    show();
  }

  function show() {
    if (open) return;
    open = true;
    el.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
    placePopover(list, input);
    markActive();
    stop = dismissOn(el, hide);
  }

  function hide() {
    if (!open) return;
    open = false;
    el.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    if (stop) stop();
    stop = null;
  }

  function choose(item) {
    hide();
    onSelect(item, { clear: () => { input.value = ''; }, input });
  }

  input.addEventListener('input', update);
  input.addEventListener('focus', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) update(); else if (items.length) { active = (active + 1) % items.length; markActive(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { active = (active - 1 + items.length) % items.length; markActive(); } }
    else if (e.key === 'Enter') {
      if (open) {
        e.preventDefault();
        if (active >= 0 && items[active]) choose(items[active]);
        else if (allowCreate && input.value.trim()) choose({ create: true, query: input.value.trim() });
      }
    } else if (e.key === 'Escape') { if (open) { e.stopPropagation(); hide(); } }
  });
  if (autofocus) setTimeout(() => input.focus(), 0);
  return { el, input, hide, focus: () => input.focus() };
}

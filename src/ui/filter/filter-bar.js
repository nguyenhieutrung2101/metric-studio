import { h, btn, icon, dismissOn, placePopover } from '../dom.js';
import { t } from '../i18n.js';
import { filterChip } from './filter-chip.js';

/**
 * The filter row: a search box, a "+ Filters" menu, and the filters that are
 * on, shown as chips that remove themselves.
 *
 * The row scales with how many filters are *active*, not with how many
 * exist: eight scenarios add eight options to one menu, not eight selects
 * to the toolbar. Filters never change what the workspace means — that is
 * the context bar's job — they only hide rows.
 *
 * filterBar({
 *   search: { placeholder, onChange(query) },
 *   filters: [{ key, label, type: 'select'|'toggle', options: [{value,label}] | () => [...] }],
 *   onChange(values),          // { key: value } of every filter that is set
 *   primary: Node | null,      // e.g. the "+ New metric" button, right-aligned
 * }) → { el, searchInput, values, set(key, value), reset(), refreshOptions() }
 */
export function filterBar({ search = null, filters = [], onChange = () => {}, primary = null, extra = [] } = {}) {
  const values = {};
  const searchInput = search ? h('input', { class: 'input search-input', type: 'search', placeholder: search.placeholder || '', 'aria-label': search.placeholder || 'Search' }) : null;
  const chips = h('div', { class: 'filter-chips' });
  const menuId = `filter-menu-${Math.random().toString(36).slice(2, 8)}`;
  const menuBtn = btn(t('filters.add'), { size: 'sm', icon: 'filter', on: { click: () => openMenu() } });
  menuBtn.setAttribute('aria-haspopup', 'dialog');
  menuBtn.setAttribute('aria-expanded', 'false');
  menuBtn.setAttribute('aria-controls', menuId);
  const menuHost = h('div', { class: 'filter-menu-host' }, menuBtn);
  const el = h('div', { class: 'filter-bar' },
    searchInput && h('div', { class: 'search' }, icon('search', { className: 'search-icon' }), searchInput),
    menuHost,
    chips,
    ...extra,
    h('span', { class: 'spacer' }),
    primary);

  if (searchInput && search.onChange) {
    let timer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => search.onChange(searchInput.value), 160);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { searchInput.value = ''; search.onChange(''); searchInput.blur(); }
      if (e.key === 'Enter' && search.onEnter) search.onEnter();
    });
  }

  function optionsOf(f) {
    return typeof f.options === 'function' ? f.options() : f.options || [];
  }

  function labelOf(f, v) {
    if (f.type === 'toggle') return f.label;
    const o = optionsOf(f).find((x) => x.value === v);
    return `${f.label}: ${o ? o.label : v}`;
  }

  function renderChips() {
    chips.replaceChildren();
    for (const f of filters) {
      const v = values[f.key];
      if (v == null || v === '' || v === false) continue;
      chips.appendChild(filterChip(labelOf(f, v), () => set(f.key, f.type === 'toggle' ? false : '')));
    }
    const any = filters.some((f) => values[f.key] != null && values[f.key] !== '' && values[f.key] !== false);
    if (any) chips.appendChild(h('button', { type: 'button', class: 'filter-clear link', text: t('filters.clear'), on: { click: reset } }));
    menuBtn.classList.toggle('active', any);
  }

  function set(key, value) {
    values[key] = value;
    renderChips();
    onChange({ ...values });
  }

  function reset() {
    for (const f of filters) values[f.key] = f.type === 'toggle' ? false : '';
    if (searchInput) { searchInput.value = ''; if (search.onChange) search.onChange(''); }
    renderChips();
    onChange({ ...values });
  }

  /** Apply several values at once (from a route), one onChange. */
  function setMany(next) {
    for (const f of filters) if (Object.prototype.hasOwnProperty.call(next, f.key)) values[f.key] = f.type === 'toggle' ? !!next[f.key] : (next[f.key] == null ? '' : next[f.key]);
    renderChips();
    onChange({ ...values });
  }

  /** Set the search box (from a route) and tell the view. */
  function setSearch(q) {
    if (!searchInput) return;
    const v = q == null ? '' : String(q);
    if (searchInput.value === v) return;
    searchInput.value = v;
    if (search.onChange) search.onChange(v);
  }

  let pop = null;
  let stop = null;
  function closeMenu(reason = null) {
    if (!pop) return;
    pop.remove();
    pop = null;
    if (stop) stop();
    stop = null;
    menuBtn.setAttribute('aria-expanded', 'false');
    if (reason === 'escape') menuBtn.focus();
  }
  function openMenu() {
    if (pop) { closeMenu(); return; }
    pop = h('div', { class: 'filter-menu', role: 'dialog', id: menuId, 'aria-label': t('filters.add') });
    for (const f of filters) {
      if (f.type === 'toggle') {
        const cb = h('input', { type: 'checkbox', checked: !!values[f.key], on: { change: () => set(f.key, cb.checked) } });
        pop.appendChild(h('label', { class: 'filter-menu-row check-inline' }, cb, h('span', { text: f.label })));
        continue;
      }
      const sel = h('select', { class: 'input input-sm', on: { change: () => set(f.key, sel.value) } },
        h('option', { value: '', text: f.anyLabel || t('filters.any', { label: f.label }) }),
        ...optionsOf(f).map((o) => h('option', { value: o.value, text: o.label, selected: o.value === values[f.key] })));
      pop.appendChild(h('label', { class: 'filter-menu-row' }, h('span', { class: 'filter-menu-label', text: f.label }), sel));
    }
    pop.appendChild(h('div', { class: 'filter-menu-foot' }, btn(t('filters.clear'), { size: 'sm', on: { click: () => { reset(); closeMenu(); } } })));
    menuHost.appendChild(pop);
    menuBtn.setAttribute('aria-expanded', 'true');
    placePopover(pop, menuBtn);
    stop = dismissOn(menuHost, closeMenu);
    const first = pop.querySelector('select, input');
    if (first) first.focus();
  }

  for (const f of filters) values[f.key] = f.type === 'toggle' ? false : '';
  return { el, searchInput, values, set, setMany, setSearch, reset, renderChips, close: closeMenu };
}

import { h, placePopover } from '../dom.js';
import { t } from '../i18n.js';

/**
 * The popover that lets a formula author pick a metric instead of typing its
 * name from memory. It floats under the formula box, filters as the user
 * types after `[`, and inserts the chosen reference as a token.
 *
 * refPicker({ host, search(query) → [{ id, label, sub, meta }], onPick(item) })
 *   .open(query)  .filter(query)  .close()  .isOpen()  .handleKey(event) → handled
 */
export function refPicker({ host, search, onPick }) {
  const list = h('div', { class: 'ref-picker-list', role: 'listbox' });
  const hint = h('div', { class: 'ref-picker-hint', text: t('binding.pickerHint') });
  const el = h('div', { class: 'ref-picker', hidden: true }, list, hint);
  host.appendChild(el);
  let items = [];
  let active = 0;
  let open = false;

  function render() {
    list.replaceChildren();
    if (!items.length) {
      list.appendChild(h('div', { class: 'ref-picker-empty', text: t('common.noResults') }));
      return;
    }
    items.forEach((item, i) => {
      list.appendChild(h('button', {
        type: 'button',
        role: 'option',
        class: ['ref-picker-item', i === active && 'active'],
        'aria-selected': String(i === active),
        // mousedown, not click: the textarea must keep focus and its caret.
        on: { mousedown: (e) => { e.preventDefault(); choose(item); }, mousemove: () => { if (active !== i) { active = i; mark(); } } },
      },
      h('span', { class: 'ref-picker-label', text: item.label }),
      h('span', { class: 'ref-picker-sub mono', text: item.sub || '' }),
      item.meta ? h('span', { class: 'ref-picker-meta', text: item.meta }) : null));
    });
  }

  function mark() {
    [...list.children].forEach((c, i) => c.classList.toggle('active', i === active));
    const a = list.children[active];
    if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
  }

  function filter(query) {
    items = search(query || '') || [];
    active = 0;
    render();
  }

  function show(query) {
    open = true;
    el.hidden = false;
    filter(query);
    // Near the bottom of the drawer the list opens upward instead of being clipped.
    placePopover(el, host, { within: host.closest('.drawer-body') });
  }

  function close() {
    open = false;
    el.hidden = true;
  }

  function choose(item) {
    close();
    onPick(item);
  }

  /** Returns true if the key was consumed by the picker. */
  function handleKey(e) {
    if (!open) return false;
    if (e.key === 'ArrowDown') { active = items.length ? (active + 1) % items.length : 0; mark(); return true; }
    if (e.key === 'ArrowUp') { active = items.length ? (active - 1 + items.length) % items.length : 0; mark(); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { if (items[active]) { choose(items[active]); return true; } close(); return false; }
    if (e.key === 'Escape') { close(); return true; }
    return false;
  }

  return { el, open: show, filter, close, isOpen: () => open, handleKey };
}

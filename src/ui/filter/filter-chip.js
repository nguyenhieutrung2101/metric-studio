import { h, icon } from '../dom.js';

/** One active filter: its label and an × that removes it. */
export function filterChip(label, onRemove) {
  return h('span', { class: 'filter-chip' },
    h('span', { text: label }),
    h('button', { type: 'button', class: 'filter-chip-remove', 'aria-label': `remove ${label}`, on: { click: onRemove } }, icon('close', { size: 11 })));
}

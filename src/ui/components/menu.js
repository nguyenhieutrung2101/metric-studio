import { h, dismissOn, icon } from '../dom.js';

/**
 * Dropdown menu anchored to a trigger element.
 * openMenu(anchor, [{ label, icon, onClick, danger, disabled, separator }])
 */
export function openMenu(anchor, items, { align = 'end' } = {}) {
  closeAll();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      menu.appendChild(h('div', { class: 'menu-sep' }));
      continue;
    }
    if (item.heading) {
      menu.appendChild(h('div', { class: 'menu-heading', text: item.heading }));
      continue;
    }
    menu.appendChild(h('button', {
      type: 'button',
      role: 'menuitem',
      class: ['menu-item', item.danger && 'danger', item.active && 'active'],
      disabled: !!item.disabled,
      on: { click: () => { close(); item.onClick && item.onClick(); } },
    }, item.icon && icon(item.icon), h('span', { text: item.label }), item.shortcut && h('kbd', { text: item.shortcut })));
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = align === 'end' ? r.right - mw : r.left;
  let top = r.bottom + 4;
  if (left < 8) left = 8;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  requestAnimationFrame(() => menu.classList.add('open'));
  const first = menu.querySelector('.menu-item:not([disabled])');
  if (first) first.focus();
  const stop = dismissOn(menu, close);
  if (anchor && anchor.setAttribute) anchor.setAttribute('aria-expanded', 'true');
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('.menu-item:not([disabled])')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
  });
  function close(reason = null) {
    stop();
    menu.remove();
    openMenus.delete(close);
    if (anchor && anchor.setAttribute) anchor.setAttribute('aria-expanded', 'false');
    // Escape returns focus to what opened the menu; choosing an item or
    // clicking away does not.
    if (reason === 'escape' && anchor && typeof anchor.focus === 'function') anchor.focus();
  }
  openMenus.add(close);
  return close;
}

const openMenus = new Set();
export function closeAll() {
  for (const c of [...openMenus]) c();
}

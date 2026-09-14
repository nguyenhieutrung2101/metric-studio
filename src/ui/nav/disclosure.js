import { h, icon } from '../dom.js';

/**
 * Disclosure navigation (W3C APG pattern): a button that shows a list of
 * links. The trigger is a button with aria-expanded/aria-controls; the
 * destinations are real anchors with real hrefs, so middle-click and
 * Ctrl/Cmd-click open a new tab and the current page is marked with
 * aria-current="page" from the router, never from the text on screen.
 *
 * Keyboard: Enter/Space open (native button); ArrowDown opens and moves
 * into the list; ArrowUp/ArrowDown move between links; Escape closes and
 * returns focus to the trigger; Tab past the list closes it. One disclosure
 * is open at a time.
 *
 * disclosureNav({ label, id, className, items(), onSelect(path), icon })
 *   → { el, button, setLabel(text), setCaption(text), open(), close(), isOpen() }
 *
 * items() → [{ path, href, label, current?, heading? }]
 */
export function disclosureNav({ label, id, className = '', items, onSelect, icon: iconName = null }) {
  const labelEl = h('span', { class: 'nav-seg-label', text: label });
  const captionEl = h('span', { class: 'nav-seg-caption', hidden: true });
  const button = h('button', { type: 'button', class: ['nav-seg', className], 'aria-expanded': 'false', 'aria-controls': id, 'aria-haspopup': 'true' },
    iconName && icon(iconName, { size: 14, className: 'nav-seg-icon' }),
    captionEl, labelEl, icon('chevronDown', { size: 12, className: 'nav-seg-caret' }));
  const list = h('ul', { class: 'nav-pop', id, role: 'list', hidden: true });
  const el = h('div', { class: 'nav-disclosure' }, button, list);
  let open = false;
  let stop = null;

  function render() {
    list.replaceChildren();
    for (const it of items()) {
      if (it.heading) {
        list.appendChild(h('li', { class: 'nav-pop-heading', text: it.heading }));
        continue;
      }
      const a = h('a', { class: ['nav-pop-link', it.current && 'current', it.indent && 'indent'], href: it.href, text: it.label, on: {
        click: (e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          close({ focusTrigger: false });
          onSelect(it.path);
        },
      } });
      if (it.current) a.setAttribute('aria-current', 'page');
      list.appendChild(h('li', null, a));
    }
  }

  function links() {
    return [...list.querySelectorAll('a')];
  }

  function show(focusFirst = false) {
    if (open) return;
    closeAll();
    render();
    open = true;
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    el.classList.add('open');
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close({ focusTrigger: true }); }
    };
    const onDown = (e) => { if (!el.contains(e.target)) close({ focusTrigger: false }); };
    const onFocusOut = (e) => { if (!e.relatedTarget || !el.contains(e.relatedTarget)) close({ focusTrigger: false }); };
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
    el.addEventListener('focusout', onFocusOut);
    stop = () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('focusout', onFocusOut);
    };
    openNavs.add(close);
    if (focusFirst) {
      const first = links()[0];
      if (first) first.focus();
    }
  }

  function close({ focusTrigger = false } = {}) {
    if (!open) return;
    open = false;
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    el.classList.remove('open');
    if (stop) stop();
    stop = null;
    openNavs.delete(close);
    if (focusTrigger) button.focus();
  }

  button.addEventListener('click', () => (open ? close({ focusTrigger: true }) : show(false)));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); show(true); if (open) { const f = links()[0]; if (f) f.focus(); } }
  });
  list.addEventListener('keydown', (e) => {
    const all = links();
    const i = all.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (all[i + 1] || all[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (all[i - 1] || all[all.length - 1]).focus(); }
    else if (e.key === 'Home') { e.preventDefault(); all[0] && all[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); all[all.length - 1] && all[all.length - 1].focus(); }
  });

  return {
    el,
    button,
    setLabel: (text) => { labelEl.textContent = text; },
    setCaption: (text) => { captionEl.textContent = text || ''; captionEl.hidden = !text; },
    open: () => show(false),
    close: () => close(),
    isOpen: () => open,
  };
}

const openNavs = new Set();
export function closeAll() {
  for (const c of [...openNavs]) c();
}

import { h, icon } from '../dom.js';

/**
 * A list of short values edited as chips: type, press Enter or comma to add,
 * Backspace on an empty input removes the last one, × removes any.
 *
 * chipInput({ values, onChange(values), placeholder, suggest?(query) → string[] })
 */
export function chipInput({ values = [], onChange, placeholder = '', suggest = null }) {
  let items = [...values];
  const input = h('input', { type: 'text', class: 'chip-input-field', placeholder, autocomplete: 'off', spellcheck: false });
  const list = h('div', { class: 'chip-suggest', hidden: true });
  const el = h('div', { class: 'chip-input', on: { click: (e) => { if (e.target === el) input.focus(); } } });

  function commit(next) {
    items = next;
    onChange([...items]);
    render();
  }

  function add(raw) {
    const value = String(raw || '').trim();
    if (!value) return;
    if (items.some((v) => v.toLowerCase() === value.toLowerCase())) {
      input.value = '';
      return;
    }
    input.value = '';
    commit([...items, value]);
  }

  function removeAt(i) {
    commit(items.filter((_, k) => k !== i));
  }

  function renderSuggestions() {
    list.replaceChildren();
    if (!suggest) return;
    const q = input.value.trim();
    const options = (suggest(q) || []).filter((s) => !items.some((v) => v.toLowerCase() === s.toLowerCase())).slice(0, 6);
    list.hidden = options.length === 0;
    for (const s of options) {
      list.appendChild(h('button', { type: 'button', class: 'chip-suggest-item', on: { mousedown: (e) => { e.preventDefault(); add(s); renderSuggestions(); } } }, s));
    }
  }

  function render() {
    const chips = items.map((v, i) => h('span', { class: 'chip-item' },
      h('span', { text: v }),
      h('button', { type: 'button', class: 'chip-remove', 'aria-label': `remove ${v}`, on: { click: () => removeAt(i) } }, icon('close', { size: 12 })),
    ));
    el.replaceChildren(...chips, input, list);
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault();
      add(input.value);
      renderSuggestions();
    } else if (e.key === 'Backspace' && !input.value && items.length) {
      removeAt(items.length - 1);
      input.focus();
    } else if (e.key === 'Escape') {
      list.hidden = true;
    }
  });
  input.addEventListener('input', renderSuggestions);
  input.addEventListener('focus', renderSuggestions);
  input.addEventListener('blur', () => {
    // Whatever was typed but not confirmed still counts: people tab away.
    add(input.value);
    setTimeout(() => { list.hidden = true; }, 120);
  });

  render();
  return { el, input, get values() { return [...items]; } };
}

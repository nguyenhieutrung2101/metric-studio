import { h, btn } from '../dom.js';
import { t } from '../i18n.js';

/**
 * Confirmation dialog for destructive actions only. Uses <dialog>.
 * confirm({ title, message, confirmLabel, danger }) → Promise<boolean>
 */
export function confirmDialog({ title, message, confirmLabel = t('common.confirm'), cancelLabel = t('common.cancel'), danger = true, options = null }) {
  return new Promise((resolve) => {
    let choice = null;
    const optionEls = options
      ? options.map((o) => h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'confirm-opt', value: o.value, checked: o.value === options[0].value, on: { change: () => { choice = o.value; } } }), h('span', { text: o.label })))
      : null;
    if (options) choice = options[0].value;
    const dlg = h('dialog', { class: 'dialog' },
      h('form', { method: 'dialog', class: 'dialog-body' },
        h('h3', { class: 'dialog-title', text: title }),
        message && h('p', { class: 'dialog-msg', text: message }),
        optionEls && h('div', { class: 'dialog-options' }, optionEls),
        h('div', { class: 'dialog-actions' },
          btn(cancelLabel, { on: { click: () => dlg.close('cancel') } }),
          btn(confirmLabel, { kind: danger ? 'danger' : 'primary', on: { click: () => dlg.close('ok') } }),
        ),
      ),
    );
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      dlg.remove();
      resolve(ok ? (options ? choice : true) : false);
    });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      dlg.close('cancel');
    });
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

/** Simple text prompt (used for quick rename / new node). */
export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = t('common.save'), fields = null }) {
  return new Promise((resolve) => {
    const inputs = {};
    const fieldDefs = fields || [{ name: 'value', label, value, placeholder }];
    const dlg = h('dialog', { class: 'dialog' },
      h('form', { method: 'dialog', class: 'dialog-body', on: { submit: (e) => { e.preventDefault(); dlg.close('ok'); } } },
        h('h3', { class: 'dialog-title', text: title }),
        fieldDefs.map((f) => h('label', { class: 'field' }, h('span', { class: 'field-label', text: f.label }), f.type === 'select'
          ? h('select', { class: 'input', ref: (el) => { inputs[f.name] = el; } }, (f.options || []).map((o) => h('option', { value: o.value, text: o.label, selected: o.value === f.value })))
          : h('input', { class: 'input', type: 'text', value: f.value || '', placeholder: f.placeholder || '', ref: (el) => { inputs[f.name] = el; } }))),
        h('div', { class: 'dialog-actions' },
          btn(t('common.cancel'), { on: { click: () => dlg.close('cancel') } }),
          btn(confirmLabel, { kind: 'primary', type: 'submit' }),
        ),
      ),
    );
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      const out = {};
      for (const [k, el] of Object.entries(inputs)) out[k] = el.value.trim();
      dlg.remove();
      resolve(ok ? (fields ? out : out.value) : null);
    });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      dlg.close('cancel');
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    const first = Object.values(inputs)[0];
    if (first) {
      first.focus();
      if (first.select) first.select();
    }
  });
}

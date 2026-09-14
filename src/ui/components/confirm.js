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

/**
 * A small form in a dialog.
 *
 * With `submit(values) → Promise<result>` the dialog owns the whole
 * lifecycle: it stays open with the values as typed while the save runs,
 * shows the error inline (on the field it names, when it names one) if the
 * save fails, and closes only after success — so a failed create never
 * throws away what the person typed. Without `submit` it resolves with the
 * values on OK, as before. Resolves null on cancel.
 *
 * fields: [{ name, label, value, placeholder, type: 'text'|'select', options, required }]
 */
export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = t('common.save'), fields = null, submit = null }) {
  return new Promise((resolve) => {
    const inputs = {};
    const fieldErrors = {};
    const fieldDefs = fields || [{ name: 'value', label, value, placeholder }];
    const generalError = h('p', { class: 'dialog-error', role: 'alert', hidden: true });
    const cancelBtn = btn(t('common.cancel'), { on: { click: () => { if (!busy) dlg.close('cancel'); } } });
    const okBtn = btn(confirmLabel, { kind: 'primary', type: 'submit' });
    let busy = false;
    let result = null;

    const read = () => {
      const out = {};
      for (const [k, el] of Object.entries(inputs)) out[k] = el.value.trim();
      return out;
    };
    const clearErrors = () => {
      generalError.hidden = true;
      generalError.textContent = '';
      for (const [name, el] of Object.entries(fieldErrors)) {
        el.hidden = true;
        el.textContent = '';
        if (inputs[name]) inputs[name].removeAttribute('aria-invalid');
      }
    };
    const showError = (message, field = null) => {
      if (field && fieldErrors[field]) {
        fieldErrors[field].textContent = message;
        fieldErrors[field].hidden = false;
        inputs[field].setAttribute('aria-invalid', 'true');
        inputs[field].focus();
      } else {
        generalError.textContent = message;
        generalError.hidden = false;
      }
    };
    const setBusy = (on) => {
      busy = on;
      okBtn.disabled = on;
      okBtn.setAttribute('aria-busy', String(on));
      cancelBtn.disabled = on;
      dlg.classList.toggle('busy', on);
    };

    const onSubmit = async (e) => {
      e.preventDefault();
      if (busy) return;
      clearErrors();
      const values = read();
      for (const f of fieldDefs) {
        if (f.required && !values[f.name]) { showError(t('dialog.required'), f.name); return; }
      }
      if (!submit) {
        result = fields ? values : values.value;
        dlg.close('ok');
        return;
      }
      setBusy(true);
      try {
        const out = await submit(values);
        result = out === undefined ? (fields ? values : values.value) : out;
        dlg.close('ok');
      } catch (err) {
        showError(err && err.message ? err.message : String(err), err && err.field && inputs[err.field] ? err.field : null);
      } finally {
        setBusy(false);
      }
    };

    const dlg = h('dialog', { class: 'dialog' },
      h('form', { method: 'dialog', class: 'dialog-body', novalidate: true, on: { submit: onSubmit } },
        h('h3', { class: 'dialog-title', text: title }),
        fieldDefs.map((f) => h('label', { class: ['field', f.required && 'required'] },
          h('span', { class: 'field-label', text: f.label }),
          f.type === 'select'
            ? h('select', { class: 'input', ref: (el) => { inputs[f.name] = el; } }, (f.options || []).map((o) => h('option', { value: o.value, text: o.label, selected: o.value === f.value })))
            : h('input', { class: 'input', type: 'text', value: f.value || '', placeholder: f.placeholder || '', ref: (el) => { inputs[f.name] = el; } }),
          h('span', { class: 'field-error', hidden: true, ref: (el) => { fieldErrors[f.name] = el; } }),
        )),
        generalError,
        h('div', { class: 'dialog-actions' }, cancelBtn, okBtn),
      ),
    );
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      dlg.remove();
      resolve(ok ? result : null);
    });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (!busy) dlg.close('cancel');
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

/**
 * A choice that has to be made, kept on screen until it is. Each action is
 * `{ value, label, kind? }`; Escape and the backdrop resolve `cancelValue`.
 * Used where a toast that disappears on its own would let the choice
 * disappear with it: leaving an editor with unsaved changes.
 *
 * decisionDialog({ title, message, actions, cancelValue }) → Promise<value>
 */
export function decisionDialog({ title, message = '', actions, cancelValue = null }) {
  return new Promise((resolve) => {
    let choice = cancelValue;
    const dlg = h('dialog', { class: 'dialog dialog-decision' },
      h('div', { class: 'dialog-body' },
        h('h3', { class: 'dialog-title', text: title }),
        message && h('p', { class: 'dialog-msg', text: message }),
        h('div', { class: 'dialog-actions' }, actions.map((a) => btn(a.label, { kind: a.kind || '', on: { click: () => { choice = a.value; dlg.close('ok'); } } }))),
      ),
    );
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(choice);
    });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      choice = cancelValue;
      dlg.close('cancel');
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    const primary = dlg.querySelector('.btn-primary') || dlg.querySelector('.btn');
    if (primary) primary.focus();
  });
}

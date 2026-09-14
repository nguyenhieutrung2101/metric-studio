import { h, btn, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';

/**
 * Choose what goes into an Excel report: which datasets, and which fields
 * of each. Every dataset starts checked with every field; a dataset's field
 * list folds open on demand so the dialog stays one screen for the common
 * "everything" case and still lets a person trim a sheet down to the four
 * columns a meeting needs.
 *
 * excelExportDialog({ datasets: [{ key, label, description, fields: [{ key, label }], rows }], selection, cover })
 *   → Promise<{ selection: [{ key, fields }], cover } | null>
 */
export function excelExportDialog({ datasets, selection = null, cover = true }) {
  return new Promise((resolve) => {
    const chosen = new Map((selection || []).map((s) => [s.key, new Set(s.fields)]));
    const state = datasets.map((d) => ({
      dataset: d,
      on: selection ? chosen.has(d.key) : true,
      fields: new Set(selection && chosen.has(d.key) ? [...chosen.get(d.key)].filter((k) => d.fields.some((f) => f.key === k)) : d.fields.map((f) => f.key)),
    }));
    const error = h('p', { class: 'dialog-error', role: 'alert', hidden: true });
    const coverBox = h('input', { type: 'checkbox', checked: cover });
    const okBtn = btn(t('xl.download'), { kind: 'primary', type: 'submit', icon: 'download' });
    const cancelBtn = btn(t('common.cancel'), { on: { click: () => dlg.close('cancel') } });

    const blocks = state.map((entry) => {
      const { dataset } = entry;
      const onBox = h('input', { type: 'checkbox', checked: entry.on, on: { change: () => { entry.on = onBox.checked; block.classList.toggle('off', !entry.on); } } });
      const countEl = h('span', { class: 'xl-count muted small' });
      const fieldsEl = h('div', { class: 'xl-fields', hidden: true });
      const renderCount = () => { countEl.textContent = t('xl.fieldsCount', { n: entry.fields.size, total: dataset.fields.length }); };
      const boxes = dataset.fields.map((f) => {
        const cb = h('input', { type: 'checkbox', checked: entry.fields.has(f.key), on: { change: () => { if (cb.checked) entry.fields.add(f.key); else entry.fields.delete(f.key); renderCount(); } } });
        return h('label', { class: 'xl-field' }, cb, h('span', { text: f.label }));
      });
      const setAll = (on) => {
        for (const f of dataset.fields) { if (on) entry.fields.add(f.key); else entry.fields.delete(f.key); }
        boxes.forEach((label) => { label.querySelector('input').checked = on; });
        renderCount();
      };
      fieldsEl.append(
        h('div', { class: 'xl-fields-tools' },
          h('button', { type: 'button', class: 'link small', on: { click: () => setAll(true) } }, t('xl.selectAll')),
          h('button', { type: 'button', class: 'link small', on: { click: () => setAll(false) } }, t('xl.selectNone')),
        ),
        h('div', { class: 'xl-fields-grid' }, boxes),
      );
      const toggle = h('button', { type: 'button', class: 'xl-toggle link small', 'aria-expanded': 'false', on: { click: () => { fieldsEl.hidden = !fieldsEl.hidden; toggle.setAttribute('aria-expanded', String(!fieldsEl.hidden)); } } }, t('xl.fields'));
      renderCount();
      const block = h('div', { class: ['xl-dataset', !entry.on && 'off'] },
        h('div', { class: 'xl-dataset-head' },
          h('label', { class: 'xl-dataset-label' }, onBox, h('span', { class: 'xl-dataset-name', text: dataset.label })),
          h('span', { class: 'xl-rows muted small', text: t('xl.rows', { n: formatNumber(dataset.rows) }) }),
          h('span', { class: 'spacer' }),
          countEl,
          toggle,
        ),
        dataset.description && h('p', { class: 'xl-desc muted small', text: dataset.description }),
        fieldsEl,
      );
      return block;
    });

    let result = null;
    const onSubmit = (e) => {
      e.preventDefault();
      const out = state.filter((s) => s.on && s.fields.size).map((s) => ({ key: s.dataset.key, fields: s.dataset.fields.map((f) => f.key).filter((k) => s.fields.has(k)) }));
      if (!out.length) {
        error.textContent = t('xl.nothing');
        error.hidden = false;
        return;
      }
      result = { selection: out, cover: coverBox.checked };
      dlg.close('ok');
    };
    const dlg = h('dialog', { class: 'dialog dialog-export' },
      h('form', { method: 'dialog', class: 'dialog-body', novalidate: true, on: { submit: onSubmit } },
        h('h3', { class: 'dialog-title', text: t('xl.dialogTitle') }),
        h('p', { class: 'dialog-msg', text: t('xl.dialogHint') }),
        h('div', { class: 'xl-list' }, blocks),
        error,
        h('div', { class: 'dialog-actions' },
          h('label', { class: 'xl-cover' }, coverBox, h('span', { text: t('xl.cover') })),
          h('span', { class: 'spacer' }),
          cancelBtn,
          okBtn,
        ),
      ),
    );
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(dlg.returnValue === 'ok' ? result : null);
    });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      dlg.close('cancel');
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    okBtn.focus();
  });
}

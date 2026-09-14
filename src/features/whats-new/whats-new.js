import { h, btn, icon } from '../../ui/dom.js';
import { t, getLanguage } from '../../ui/i18n.js';
import { getPreference, setPreference } from '../../utils/preferences.js';
import { APP_VERSION, CHANGELOG } from '../../data/changelog.js';

const SEEN_KEY = 'whatsNew.seen';

/** Whether the current build has not been shown yet. */
export function hasUnseenChanges() {
  return getPreference(SEEN_KEY, null) !== APP_VERSION;
}

/**
 * The "What's new" dialog: the latest build in full, earlier ones folded.
 * Shown once per build on start-up (and any time from More ▾). Closing it
 * marks the build as seen.
 */
export function showWhatsNew() {
  const lang = getLanguage();
  const pick = (v) => (v && typeof v === 'object' ? v[lang] || v.en : v);
  const release = (r, open) => h('details', { class: 'wn-release', open },
    h('summary', { class: 'wn-summary' },
      h('span', { class: 'wn-version mono', text: `v${r.version}` }),
      h('span', { class: 'wn-title', text: pick(r.title) }),
      h('span', { class: 'wn-date muted', text: r.date }),
    ),
    h('ul', { class: 'wn-items' }, r.items.map((it) => h('li', null, icon('check', { size: 14 }), h('span', { text: pick(it) })))),
  );
  const closeBtn = btn(t('common.close'), { kind: 'primary', on: { click: () => dlg.close('ok') } });
  const dlg = h('dialog', { class: 'dialog dialog-whats-new', 'aria-labelledby': 'wn-title' },
    h('div', { class: 'dialog-body' },
      h('div', { class: 'wn-head' },
        icon('layers', { size: 22, className: 'wn-logo' }),
        h('div', null,
          h('h3', { class: 'dialog-title', id: 'wn-title', text: t('whatsNew.title') }),
          h('p', { class: 'dialog-msg', text: t('whatsNew.subtitle', { version: APP_VERSION }) }),
        ),
      ),
      h('div', { class: 'wn-body' }, CHANGELOG.map((r, i) => release(r, i === 0))),
      h('div', { class: 'dialog-actions' }, h('span', { class: 'muted small wn-foot', text: t('whatsNew.foot') }), closeBtn),
    ),
  );
  dlg.addEventListener('close', () => {
    setPreference(SEEN_KEY, APP_VERSION);
    dlg.remove();
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); dlg.close('cancel'); });
  document.body.appendChild(dlg);
  dlg.showModal();
  closeBtn.focus();
  return dlg;
}

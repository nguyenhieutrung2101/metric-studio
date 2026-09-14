import { h, icon } from '../dom.js';
import { t } from '../i18n.js';

/**
 * The frame every workspace is built on:
 *
 *   ┌ page header ──────────────────────────────────────────────┐
 *   ├ context bar ──────────────────────────────────────────────┤
 *   ├──────────┬────────────────────────────────┬───────────────┤
 *   │ side     │ main                           │ insights      │
 *   └──────────┴────────────────────────────────┴───────────────┘
 *
 * `side` and `insights` are optional. The insights column collapses to a
 * rail when its panel is closed; the grid reads the panel's own width
 * variable, so a resize needs no JavaScript here.
 *
 * workspaceLayout({ header?, context?, side?, main, insights? }) → { el, main, side }
 */
export function workspaceLayout({ header = null, context = null, side = null, main, insights = null, className = '' }) {
  // On a narrow workspace the side pane folds into a rail and opens over the
  // main pane; the main pane never shrinks below a usable width for it.
  const NARROW = 900;
  let sideOpen = false;
  const rail = side ? h('button', { type: 'button', class: 'side-rail', 'aria-expanded': 'false', 'aria-label': t('insights.expand'), title: t('insights.expand'), on: { click: () => setSideOpen(!sideOpen, true) } }, icon('chevronRight', { size: 14 })) : null;
  const body = h('div', { class: ['ws-body', side && 'has-side', insights && 'has-insights'] }, rail, side, main, insights);
  const el = h('div', { class: ['ws', className] }, header, context, body);

  function setSideOpen(next, focus = false) {
    sideOpen = next;
    body.classList.toggle('side-open', sideOpen);
    if (rail) rail.setAttribute('aria-expanded', String(sideOpen));
    if (focus) {
      if (sideOpen) { const f = side.querySelector('[tabindex="0"], button, a, input'); if (f) f.focus(); }
      else rail.focus();
    }
  }

  if (side) {
    side.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && body.classList.contains('narrow') && sideOpen && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); setSideOpen(false, true); }
    });
    // A choice made in the side pane (a node, a dimension) closes the overlay.
    side.addEventListener('click', (e) => { if (body.classList.contains('narrow') && sideOpen && e.target.closest('.tree-row')) setSideOpen(false); });
    const measure = () => {
      const narrow = body.clientWidth > 0 && body.clientWidth < NARROW;
      if (narrow !== body.classList.contains('narrow')) {
        body.classList.toggle('narrow', narrow);
        if (!narrow) setSideOpen(false);
        // The insights panel sizes itself against the room the side pane leaves.
        body.dispatchEvent(new Event('layout-change'));
      }
    };
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(body);
    setTimeout(measure, 0);
  }
  return { el, body, main, side, setSideOpen };
}

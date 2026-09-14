import { h } from '../dom.js';

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
  const body = h('div', { class: ['ws-body', side && 'has-side', insights && 'has-insights'] }, side, main, insights);
  const el = h('div', { class: ['ws', className] }, header, context, body);
  return { el, body, main, side };
}

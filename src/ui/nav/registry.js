import { t } from '../i18n.js';

/**
 * The one registry of where things are: groups, the pages in them, the
 * utility pages behind "More", and the routes that were renamed. Labels,
 * active state and remembered pages are all derived from this; nothing
 * reads them back out of the DOM.
 *
 * Navigation follows the work — overview, define, organise, connect,
 * validate — not the collections underneath.
 */
export const NAV_GROUPS = Object.freeze([
  { id: 'overview', pages: ['overview'] },
  { id: 'catalogue', pages: ['metrics'] },
  { id: 'structure', pages: ['structure', 'dimensions'] },
  { id: 'logic', pages: ['bindings', 'dependencies'] },
  { id: 'quality', pages: ['quality'] },
]);

/** Pages reached from the utilities menu, not from the group navigation. */
export const UTILITY_PAGES = Object.freeze(['master-data', 'backup']);

/** Old bookmarks keep working: a route that was renamed maps to its new page. */
export const ROUTE_ALIASES = Object.freeze({ warnings: 'quality' });

export const HOME_PAGE = 'overview';

export function groupOf(path) {
  return NAV_GROUPS.find((g) => g.pages.includes(path)) || null;
}

export function groupLabel(id) {
  return t(`group.${id}`);
}

export function pageLabel(path) {
  return t(`nav.${path}`);
}

export function isKnownPage(path) {
  return NAV_GROUPS.some((g) => g.pages.includes(path)) || UTILITY_PAGES.includes(path);
}

/** Resolve a requested route to the page that serves it, or null. */
export function resolvePage(path) {
  const p = ROUTE_ALIASES[path] || path;
  return isKnownPage(p) ? p : null;
}

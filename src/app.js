import { Store } from './core/store/store.js';
import { createSelectors } from './core/store/selectors.js';
import { LocalRepository } from './repositories/local-repository.js';
import { MetricService } from './services/metric-service.js';
import { StructureService } from './services/structure-service.js';
import { BindingService } from './services/binding-service.js';
import { DimensionService } from './services/dimension-service.js';
import { DependencyService } from './services/dependency-service.js';
import { BackupService } from './services/backup-service.js';
import { LocalPresenceService } from './services/presence-service.js';
import { validateAll, indexIssues } from './services/validation-service.js';
import { buildDemoSnapshot } from './data/seed.js';
import { parseSnapshot } from './services/snapshot-schema.js';
import { h, btn, icon, clear, formatNumber } from './ui/dom.js';
import { t, setLanguage, getLanguage, onLanguageChange, LANGUAGES } from './ui/i18n.js';
import { createRouter } from './ui/router.js';
import { createToast } from './ui/toast/toast.js';
import { createDrawer } from './ui/drawer/drawer.js';
import { openMenu } from './ui/components/menu.js';
import { debounce } from './utils/debounce.js';
import { DENSITIES, getDensity, setDensity, applyDensity } from './ui/density.js';
import { NAV_GROUPS, UTILITY_PAGES, HOME_PAGE, groupOf, groupLabel, pageLabel, resolvePage } from './ui/nav/registry.js';
import { disclosureNav, closeAll as closeNavs } from './ui/nav/disclosure.js';
import { showWhatsNew, hasUnseenChanges } from './features/whats-new/whats-new.js';
import { MetricDrawer } from './features/metric-master/metric-drawer.js';
import { mountMetricMasterView } from './features/metric-master/metric-master-view.js';
import { mountOverviewView } from './features/overview/overview-view.js';
import { mountBindingsView } from './features/bindings/bindings-view.js';
import { mountDependencyView } from './features/dependency/dependency-view.js';
import { mountDimensionsView } from './features/dimensions/dimensions-view.js';
import { mountStructureView } from './features/structure/structure-view.js';
import { mountMasterDataView } from './features/master-data/master-data-view.js';
import { mountImportExportView } from './features/import-export/import-export-view.js';
import { mountQualityView } from './features/quality/quality-view.js';

const VIEWS = {
  overview: mountOverviewView,
  metrics: mountMetricMasterView,
  bindings: mountBindingsView,
  dependencies: mountDependencyView,
  structure: mountStructureView,
  dimensions: mountDimensionsView,
  'master-data': mountMasterDataView,
  backup: mountImportExportView,
  quality: mountQualityView,
};

/**
 * Bootstrap: repository → store → services → validation → shell → router → view.
 * Swapping LocalRepository for SharePointRepository is the only change needed
 * to move persistence; nothing below the next line knows about storage.
 */
export async function start(rootEl) {
  applyDensity();
  const repo = new LocalRepository();
  await repo.init();
  const startupInfo = repo.describe();
  const store = new Store();
  const selectors = createSelectors(store);

  // A database that exists but could not be opened is not an empty one. The
  // user's data is on disk; seeding a demo over it would let them edit a
  // catalogue that is not theirs in a session that will never persist. Say
  // what happened and let them choose.
  if (!startupInfo.persistent && startupInfo.hasExistingData) {
    const proceed = await recoveryScreen(rootEl, startupInfo);
    if (!proceed) return null;
  }

  const snapshot = await repo.loadAll();
  const isEmpty = !Object.values(snapshot).some((arr) => arr.length > 0);
  if (isEmpty && !startupInfo.hasExistingData) {
    // The seed goes through the same schema boundary as any imported file.
    const parsed = parseSnapshot(buildDemoSnapshot());
    if (!parsed.ok) throw new Error(`Demo data is invalid: ${parsed.errors.join('; ')}`);
    const saved = await repo.replaceAll(parsed.data);
    store.hydrate(saved);
  } else store.hydrate(snapshot);

  const metrics = new MetricService({ store, selectors, repo });
  const structure = new StructureService({ store, selectors, repo });
  const bindings = new BindingService({ store, selectors, repo, metricService: metrics });
  const dimensions = new DimensionService({ store, selectors, repo });
  const dependencies = new DependencyService(store, selectors);
  const backup = new BackupService({ store, repo });
  const presence = new LocalPresenceService();
  const services = { metrics, structure, bindings, dimensions, dependencies, backup, presence };

  const validation = createValidationRunner({ store, selectors, dependencies });
  const router = createRouter({ defaultPath: 'overview' });
  const shell = buildShell(rootEl);
  const toast = createToast(shell.toastHost);
  const drawer = createDrawer(shell.drawerHost);
  // Where writes go, as of now — not as of start-up. Every page reads this.
  const storage = createStorageStatus(repo, store);

  const ctx = {
    store, selectors, repo, services, validation, router, toast, storage, repoInfo: repo.describe(),
    currentMetricId: null,
    /**
     * Open a metric in the drawer. Refused — with the ways out offered on a
     * toast — when the drawer holds unsaved changes for a different metric,
     * so a click in the table cannot silently discard typing.
     * @returns {boolean} whether the drawer moved now
     */
    openMetric(id, opts) {
      const go = () => {
        metricDrawer.open(id, opts);
        ctx.currentMetricId = id;
        if (active.view && active.view.onMetricOpened) active.view.onMetricOpened(id);
      };
      if (id !== ctx.currentMetricId && metricDrawer.isDirty()) return metricDrawer.guardThen(go);
      go();
      return true;
    },
    drawerClose: () => drawer.close({ force: true }),
    describeIssue: (issue) => describeIssue(issue),
  };
  const metricDrawer = new MetricDrawer(ctx, drawer);
  metricDrawer.onClose = () => {
    ctx.currentMetricId = null;
    if (active.view && active.view.onDrawerClosed) active.view.onDrawerClosed();
  };

  // ---------------------------------------------------------------- views
  // Views stay mounted once opened and are hidden rather than destroyed, so
  // the scroll position, the filters and the graph a user left behind are
  // still there when they come back. Switching away from an editor with
  // unsaved changes is refused the same way a metric switch is.
  const active = { path: null, view: null };
  const mounted = new Map();
  // The last route each view was on, so a top-bar link brings the user back
  // to the node, root metric or table they left rather than to a blank view.
  const lastRoute = new Map();
  // The page each group was last on, so choosing a group in the top bar
  // returns there rather than to the group's first page.
  const lastPage = new Map();
  function mount(route) {
    const requested = resolvePage(route.path);
    const path = requested && VIEWS[requested] ? requested : HOME_PAGE;
    if (path === requested) lastRoute.set(path, { ...route.params });
    const group = groupOf(path);
    if (group) lastPage.set(group.id, path);
    if (path !== active.path && active.path && metricDrawer.isDirty()) {
      router.revert();
      metricDrawer.guardThen(() => router.navigate(path, route.params));
      return;
    }
    if (path !== active.path) {
      let entry = mounted.get(path);
      if (!entry) {
        const host = h('div', { class: 'view-slot' });
        shell.viewHost.appendChild(host);
        entry = { host, view: VIEWS[path](host, ctx) };
        mounted.set(path, entry);
      }
      for (const [p, m] of mounted) {
        const hide = p !== path;
        if (hide && !m.host.hidden && m.view.onHide) m.view.onHide();
        m.host.hidden = hide;
      }
      active.path = path;
      active.view = entry.view;
      shell.setActive(path);
      if (entry.view.onShow) entry.view.onShow();
      if (!route.params.metric && drawer.isOpen()) drawer.close({ force: true });
    }
    active.view.update(route);
  }
  router.onChange(mount);
  // What a view does to its own route — a selection, a context, a filter —
  // is what "back to this page" should bring back, not only what the route
  // was when the page was first opened.
  router.onParams((route) => { if (VIEWS[route.path]) lastRoute.set(route.path, { ...route.params }); });
  // Views bake the scenario list into their columns and filters; when that
  // list changes, or the whole catalogue is replaced (import, restore,
  // reset), every view starts over — the active one included, or it would
  // keep the old scenario columns over the new data.
  store.events.on('change', (evt) => {
    if (evt.collection !== 'scenarios' && evt.collection !== '*') return;
    for (const [p, m] of mounted) {
      if (p === active.path) continue;
      m.view.destroy();
      m.host.remove();
      mounted.delete(p);
    }
    if (active.path) {
      const m = mounted.get(active.path);
      m.view.destroy();
      m.host.replaceChildren();
      m.view = VIEWS[active.path](m.host, ctx);
      active.view = m.view;
      m.view.update(router.current);
    }
  });

  // ---------------------------------------------------------------- shell wiring
  shell.nav(router, { params: (path) => lastRoute.get(path) || {}, pageOfGroup: (g) => lastPage.get(g.id) || g.pages[0] });
  shell.warningsBtn.addEventListener('click', () => router.navigate('quality', lastRoute.get('quality') || {}));
  shell.moreBtn.addEventListener('click', (e) => {
    openMenu(e.currentTarget, [
      ...UTILITY_PAGES.map((p) => ({ label: pageLabel(p), icon: p === 'backup' ? 'download' : 'edit', active: active.path === p, onClick: () => router.navigate(p, lastRoute.get(p) || {}) })),
      { separator: true },
      { heading: t('nav.density') },
      ...DENSITIES.map((d) => ({ label: t(`density.${d}`), active: getDensity() === d, onClick: () => setDensity(d) })),
      { separator: true },
      { heading: t('nav.language') },
      // Changing the language reloads the page: the same guard as any other
      // way of leaving an editor with unsaved changes.
      ...LANGUAGES.map((l) => ({ label: l.label, active: getLanguage() === l.code, onClick: () => metricDrawer.guardThen(() => setLanguage(l.code)) })),
      { separator: true },
      { label: t('nav.whatsNew'), icon: 'info', onClick: () => showWhatsNew() },
      { separator: true },
      { heading: storageLabel(storage.info) },
    ]);
  });
  validation.onChange((index) => shell.setWarnings(index.bySeverity));
  onLanguageChange(() => window.location.reload());
  if (ctx.repoInfo.migration && ctx.repoInfo.migration.deduplicated > 0) {
    setTimeout(() => toast.info(t('io.migrationDeduplicated', { n: ctx.repoInfo.migration.deduplicated }), { duration: 10000 }), 1400);
  }
  // The storage banner says, on every page, where writes are going right
  // now: memory only, refused because another tab took the database over,
  // or out of step with the backend after a partial write. Losing the durable
  // connection is announced the moment it happens, not on the next failed
  // save, and the Save buttons follow.
  const applyStorage = (info) => {
    shell.setStorage(info);
    metricDrawer.refreshWritable();
    if (info.reason === 'superseded') toast.error(t('io.storageSuperseded'), { sticky: true, action: { label: t('io.reload'), onClick: () => window.location.reload() } });
    else if (!info.sync.ok) toast.error(t('io.storageBanner.unsynced'), { sticky: true, action: { label: t('io.reload'), onClick: () => window.location.reload() } });
  };
  storage.onChange(applyStorage);
  shell.setStorage(storage.info);
  // Keyboard shortcuts go to the workspace on screen and nowhere else: a
  // hidden view never receives one, and nothing fires while typing, during
  // IME composition, or while a dialog, menu or navigation list is open.
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.defaultPrevented) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
    if (document.querySelector('dialog[open], .menu, .nav-pop:not([hidden]), .ctx-pop, .filter-menu')) return;
    if (active.view && active.view.onShortcut) active.view.onShortcut(e);
  });
  // The browser's own "leave this page?" prompt, while an editor holds a
  // draft or a save has not been acknowledged yet. Best effort: a killed
  // process gets no prompt, and nothing is auto-saved on the way out.
  window.addEventListener('beforeunload', (e) => {
    if (metricDrawer.isDirty() || metricDrawer.isSaving()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  validation.run();
  router.start();
  // Once per build: what changed, over a softly blurred workspace. Not on a
  // deep link into an editor, where the person came to do something.
  if (hasUnseenChanges() && !router.current.params.metric) setTimeout(() => showWhatsNew(), 350);
  globalThis.__metricStudio = { ...ctx, metricDrawer }; // debugging / automation hook, no behaviour depends on it
  return ctx;
}

/**
 * Shown instead of the app when the database exists but could not be opened.
 * Resolves true if the user chooses to continue in memory (with an empty
 * catalogue, never the demo), false if they retry, which reloads the page.
 */
function recoveryScreen(rootEl, info) {
  return new Promise((resolve) => {
    const reasonKey = { blocked: 'io.recovery.blocked', 'upgrade-failed': 'io.recovery.upgradeFailed', 'open-failed': 'io.recovery.openFailed', superseded: 'io.recovery.superseded' }[info.reason] || 'io.recovery.openFailed';
    const panel = h('div', { class: 'recovery' },
      h('div', { class: 'recovery-card' },
        icon('warning', { size: 28 }),
        h('h1', { text: t('io.recovery.title') }),
        h('p', { text: t(reasonKey) }),
        info.detail && h('p', { class: 'mono small muted', text: info.detail }),
        h('p', { class: 'small', text: t('io.recovery.dataSafe') }),
        h('div', { class: 'recovery-actions' },
          btn(t('io.recovery.retry'), { kind: 'primary', icon: 'external', on: { click: () => { resolve(false); window.location.reload(); } } }),
          btn(t('io.recovery.continue'), { on: { click: () => { panel.remove(); resolve(true); } } }),
        ),
      ),
    );
    rootEl.replaceChildren(panel);
  });
}

/** Debounced validation after every store change; views subscribe to the index. */
function createValidationRunner({ store, selectors, dependencies }) {
  const listeners = new Set();
  let index = indexIssues([]);
  const run = () => {
    index = indexIssues(validateAll({ store, selectors, dependencies }));
    for (const fn of [...listeners]) fn(index);
    return index;
  };
  const scheduled = debounce(run, 250);
  store.events.on('change', () => scheduled());
  return {
    get index() {
      return index;
    },
    run,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    issuesForMetric: (id) => index.byMetric.get(id) || [],
  };
}

/**
 * Observable storage status: what `repo.describe()` says, plus whether the
 * store is known to match the backend, refreshed whenever either changes.
 */
function createStorageStatus(repo, store) {
  const listeners = new Set();
  const snapshot = () => ({ ...repo.describe(), sync: store.sync });
  let info = snapshot();
  const notify = () => {
    info = snapshot();
    for (const fn of [...listeners]) fn(info);
  };
  repo.onStatusChange(notify);
  store.events.on('sync', notify);
  return {
    get info() { return info; },
    get writable() { return info.writable !== false && info.sync.ok; },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    label: () => storageLabel(info),
  };
}

/** One sentence on where the data is right now. */
function storageLabel(info) {
  if (info.reason === 'superseded') return t('io.storageSuperseded');
  if (info.sync && !info.sync.ok) return t('io.storageBanner.unsynced');
  if (info.persistent) return t('io.storagePersistent');
  return t(info.hasExistingData ? 'io.storageUnsaved' : 'io.storageMemory');
}

function describeIssue(issue) {
  const key = `issue.${issue.code}`;
  const text = t(key, issue.params);
  return text === issue.code || text === key.split('.').pop().replace(/[-_]/g, ' ') ? issue.message : text;
}

function buildShell(rootEl) {
  // One row. Brand · Group ▾ · Page ▾ (only when the group has several) ·
  // utilities on the right. Nothing above the workspace changes height when
  // the group changes, so the page header, the context bar and the drawer
  // start where they started.
  const brand = h('a', { class: 'brand', href: `#/${HOME_PAGE}`, title: t('nav.overview') }, icon('layers', { size: 18 }), h('span', { text: 'Metric Studio' }));
  let navigateTo = null;
  let pageOfGroup = (g) => g.pages[0];
  const current = { path: null, group: null };
  const groupNav = disclosureNav({
    id: 'nav-groups', label: '', className: 'nav-seg-group',
    items: () => NAV_GROUPS.map((g) => ({ path: pageOfGroup(g), href: `#/${pageOfGroup(g)}`, label: groupLabel(g.id), current: current.group && current.group.id === g.id })),
    onSelect: (p) => navigateTo && navigateTo(p),
  });
  const pageNav = disclosureNav({
    id: 'nav-pages', label: '', className: 'nav-seg-page',
    items: () => (current.group ? current.group.pages : []).map((p) => ({ path: p, href: `#/${p}`, label: pageLabel(p), current: p === current.path })),
    onSelect: (p) => navigateTo && navigateTo(p),
  });
  // Narrow screens: one button, the whole tree, no labels squeezed sideways.
  const compactNav = disclosureNav({
    id: 'nav-compact', label: t('nav.menu'), className: 'nav-compact', icon: 'more',
    items: () => NAV_GROUPS.flatMap((g) => (g.pages.length > 1
      ? [{ heading: groupLabel(g.id) }, ...g.pages.map((p) => ({ path: p, href: `#/${p}`, label: pageLabel(p), current: p === current.path, indent: true }))]
      : [{ path: g.pages[0], href: `#/${g.pages[0]}`, label: groupLabel(g.id), current: current.group && current.group.id === g.id }])),
    onSelect: (p) => navigateTo && navigateTo(p),
  });
  const navEl = h('nav', { class: 'primary-nav', 'aria-label': 'Primary' }, h('span', { class: 'nav-divider', 'aria-hidden': 'true' }), groupNav.el, h('span', { class: 'nav-divider nav-divider-page', 'aria-hidden': 'true' }), pageNav.el, compactNav.el);
  const warnCount = h('span', { class: 'badge', text: '0' });
  const warningsBtn = h('button', { type: 'button', class: 'topbar-btn warnings-btn', title: t('nav.warnings') }, icon('warning'), warnCount);
  const moreBtn = h('button', { type: 'button', class: 'topbar-btn', title: t('nav.more') }, h('span', { text: t('nav.more') }), icon('chevronDown', { size: 14 }));
  const topbar = h('header', { class: 'topbar' }, brand, navEl, h('div', { class: 'topbar-right' }, warningsBtn, moreBtn));
  const banner = h('div', { class: 'storage-banner', role: 'status', hidden: true });
  const viewHost = h('main', { class: 'view', id: 'view' });
  // The drawer lives inside the view, so its top edge is wherever the view
  // starts — after the top bar and any banner — with no offset kept by hand.
  const drawerHost = h('div', { class: 'drawer-host' });
  viewHost.appendChild(drawerHost);
  const toastHost = h('div', { class: 'toast-host' });
  rootEl.replaceChildren(topbar, banner, viewHost, toastHost);
  brand.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (navigateTo) navigateTo(HOME_PAGE);
  });
  return {
    viewHost, drawerHost, toastHost, warningsBtn, moreBtn,
    nav(router, { params, pageOfGroup: remembered }) {
      navigateTo = (p) => { closeNavs(); router.navigate(p, params(p)); };
      pageOfGroup = remembered;
    },
    setActive(path) {
      current.path = path;
      current.group = groupOf(path);
      const utility = UTILITY_PAGES.includes(path);
      groupNav.setLabel(current.group ? groupLabel(current.group.id) : utility ? t('nav.more') : '');
      groupNav.button.classList.toggle('active', !!current.group);
      const multi = !!current.group && current.group.pages.length > 1;
      pageNav.el.hidden = !multi && !utility;
      navEl.querySelector('.nav-divider-page').hidden = !multi && !utility;
      pageNav.setLabel(multi ? pageLabel(path) : utility ? pageLabel(path) : '');
      pageNav.button.disabled = utility; // a utility page is not one of a group's pages; the label only says where you are
      moreBtn.classList.toggle('active', utility);
      warningsBtn.classList.toggle('active', path === 'quality');
      document.title = `${current.group ? pageLabel(path) : pageLabel(path)} · Metric Studio`;
    },
    /** The storage banner: hidden when writes are durable and in sync. */
    setStorage(info) {
      const bad = info.reason === 'superseded' || (info.sync && !info.sync.ok);
      const memory = !info.persistent && !bad;
      banner.hidden = !bad && !memory;
      banner.className = ['storage-banner', bad && 'danger', memory && 'warn'].filter(Boolean).join(' ');
      banner.setAttribute('role', bad ? 'alert' : 'status');
      if (banner.hidden) { clear(banner); return; }
      banner.replaceChildren(
        icon('warning', { size: 14 }),
        h('span', { class: 'storage-banner-text', text: storageLabel(info) }),
        bad
          ? btn(t('io.reload'), { size: 'sm', on: { click: () => window.location.reload() } })
          : h('a', { class: 'link', href: '#/backup', text: t('nav.backup') }),
      );
    },
    setWarnings(by) {
      const n = (by.error || 0) + (by.warning || 0);
      warnCount.textContent = formatNumber(n);
      warningsBtn.classList.toggle('has-errors', (by.error || 0) > 0);
      warningsBtn.classList.toggle('has-warnings', (by.error || 0) === 0 && (by.warning || 0) > 0);
      warningsBtn.title = t('nav.warningsTitle', { errors: by.error || 0, warnings: by.warning || 0, info: by.info || 0 });
    },
  };
}

start(document.getElementById('app')).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  const el = document.getElementById('app');
  el.replaceChildren(h('div', { class: 'fatal' }, h('h1', { text: 'Metric Studio could not start' }), h('pre', { text: String(err && err.stack ? err.stack : err) })));
});

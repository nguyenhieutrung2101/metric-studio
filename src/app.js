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
import { MetricDrawer } from './features/metric-master/metric-drawer.js';
import { mountMetricMasterView } from './features/metric-master/metric-master-view.js';
import { mountBindingsView } from './features/bindings/bindings-view.js';
import { mountDependencyView } from './features/dependency/dependency-view.js';
import { mountDimensionsView } from './features/dimensions/dimensions-view.js';
import { mountStructureView } from './features/structure/structure-view.js';
import { mountMasterDataView } from './features/master-data/master-data-view.js';
import { mountImportExportView } from './features/import-export/import-export-view.js';
import { mountWarningsView } from './features/warnings/warnings-view.js';

/**
 * Navigation follows the work — define, organise, connect, validate — not
 * the collections underneath. Each group is one top-bar entry; a group with
 * several pages gets a second row of tabs under the top bar.
 */
const GROUPS = [
  { id: 'catalogue', pages: ['metrics'] },
  { id: 'structure', pages: ['structure', 'dimensions'] },
  { id: 'logic', pages: ['bindings', 'dependencies'] },
  { id: 'quality', pages: ['warnings'] },
];
const SECONDARY = ['master-data', 'backup'];
const VIEWS = {
  metrics: mountMetricMasterView,
  bindings: mountBindingsView,
  dependencies: mountDependencyView,
  structure: mountStructureView,
  dimensions: mountDimensionsView,
  'master-data': mountMasterDataView,
  backup: mountImportExportView,
  warnings: mountWarningsView,
};
const groupOf = (path) => GROUPS.find((g) => g.pages.includes(path)) || null;

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
  const router = createRouter({ defaultPath: 'metrics' });
  const shell = buildShell(rootEl);
  const toast = createToast(shell.toastHost);
  const drawer = createDrawer(shell.drawerHost);

  const ctx = {
    store, selectors, repo, services, validation, router, toast, repoInfo: repo.describe(),
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
  function mount(route) {
    const path = VIEWS[route.path] ? route.path : 'metrics';
    if (path === route.path) lastRoute.set(path, { ...route.params });
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
      for (const [p, m] of mounted) m.host.hidden = p !== path;
      active.path = path;
      active.view = entry.view;
      shell.setActive(path);
      if (entry.view.onShow) entry.view.onShow();
      if (!route.params.metric && drawer.isOpen()) drawer.close({ force: true });
    }
    active.view.update(route);
  }
  router.onChange(mount);
  // Views bake the scenario list into their columns and filters; when that
  // list changes (or the whole catalogue is replaced) they start over.
  store.events.on('change', (evt) => {
    if (evt.collection !== 'scenarios' && evt.collection !== '*') return;
    for (const [p, m] of mounted) {
      if (p === active.path) continue;
      m.view.destroy();
      m.host.remove();
      mounted.delete(p);
    }
    if (active.path && evt.collection === 'scenarios') {
      const m = mounted.get(active.path);
      m.view.destroy();
      m.host.replaceChildren();
      m.view = VIEWS[active.path](m.host, ctx);
      active.view = m.view;
      m.view.update(router.current);
    }
  });

  // ---------------------------------------------------------------- shell wiring
  shell.nav(router, (path) => lastRoute.get(path) || {});
  shell.warningsBtn.addEventListener('click', () => router.navigate('warnings'));
  shell.moreBtn.addEventListener('click', (e) => {
    openMenu(e.currentTarget, [
      ...SECONDARY.map((p) => ({ label: t(`nav.${p}`), icon: p === 'backup' ? 'download' : 'edit', active: active.path === p, onClick: () => router.navigate(p, lastRoute.get(p) || {}) })),
      { separator: true },
      { heading: t('nav.density') },
      ...DENSITIES.map((d) => ({ label: t(`density.${d}`), active: getDensity() === d, onClick: () => setDensity(d) })),
      { separator: true },
      { heading: t('nav.language') },
      ...LANGUAGES.map((l) => ({ label: l.label, active: getLanguage() === l.code, onClick: () => setLanguage(l.code) })),
      { separator: true },
      { heading: ctx.repoInfo.persistent ? t('io.storagePersistent') : t('io.storageMemory') },
    ]);
  });
  validation.onChange((index) => shell.setWarnings(index.bySeverity));
  onLanguageChange(() => window.location.reload());
  if (!ctx.repoInfo.persistent) setTimeout(() => toast.info(t(ctx.repoInfo.hasExistingData ? 'io.storageUnsaved' : 'io.storageMemory'), { duration: 8000 }), 800);
  if (ctx.repoInfo.migration && ctx.repoInfo.migration.deduplicated > 0) {
    setTimeout(() => toast.info(t('io.migrationDeduplicated', { n: ctx.repoInfo.migration.deduplicated }), { duration: 10000 }), 1400);
  }
  // A newer release in another tab took the database over; this tab can only
  // watch. Say so the moment it happens rather than on the next failed save.
  const watchSuperseded = setInterval(() => {
    const now = repo.describe();
    if (now.reason === 'superseded') {
      clearInterval(watchSuperseded);
      toast.error(t('io.storageSuperseded'), { duration: 60000, action: { label: t('io.reload'), onClick: () => window.location.reload() } });
    }
  }, 2000);

  validation.run();
  router.start();
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

function describeIssue(issue) {
  const key = `issue.${issue.code}`;
  const text = t(key, issue.params);
  return text === issue.code || text === key.split('.').pop().replace(/[-_]/g, ' ') ? issue.message : text;
}

function buildShell(rootEl) {
  const brand = h('div', { class: 'brand' }, icon('layers', { size: 18 }), h('span', { text: 'Metric Studio' }));
  const navEl = h('nav', { class: 'primary-nav', 'aria-label': 'Primary' });
  const subnav = h('nav', { class: 'subnav', 'aria-label': 'Section', hidden: true });
  const warnCount = h('span', { class: 'badge', text: '0' });
  const warningsBtn = h('button', { type: 'button', class: 'topbar-btn warnings-btn', title: t('nav.warnings') }, icon('warning'), warnCount);
  const moreBtn = h('button', { type: 'button', class: 'topbar-btn', title: t('nav.more') }, h('span', { text: t('nav.more') }), icon('chevronDown', { size: 14 }));
  const topbar = h('header', { class: 'topbar' }, brand, navEl, h('div', { class: 'topbar-right' }, warningsBtn, moreBtn));
  const viewHost = h('main', { class: 'view', id: 'view' });
  const drawerHost = h('div', { class: 'drawer-host' });
  const toastHost = h('div', { class: 'toast-host' });
  rootEl.replaceChildren(topbar, subnav, viewHost, drawerHost, toastHost);
  const links = new Map();
  let navigateTo = null;
  const go = (p) => (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (navigateTo) navigateTo(p);
  };
  return {
    viewHost, drawerHost, toastHost, warningsBtn, moreBtn,
    nav(router, rememberedParams) {
      navigateTo = (p) => router.navigate(p, rememberedParams(p));
      clear(navEl);
      for (const g of GROUPS) {
        const first = g.pages[0];
        const a = h('a', { class: 'nav-link', href: router.build(first), text: t(`group.${g.id}`), dataset: { group: g.id }, on: { click: go(first) } });
        links.set(g.id, a);
        navEl.appendChild(a);
      }
    },
    setActive(path) {
      const group = groupOf(path);
      for (const [id, a] of links) {
        const on = group && group.id === id;
        a.classList.toggle('active', on);
        if (on) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      // The second row exists only for groups with more than one page, and
      // remembers each page's last route like the top row does.
      clear(subnav);
      if (group && group.pages.length > 1) {
        for (const p of group.pages) subnav.appendChild(h('a', { class: ['subnav-link', p === path && 'active'], href: `#/${p}`, text: t(`nav.${p}`), on: { click: go(p) } }));
        subnav.hidden = false;
      } else subnav.hidden = true;
      rootEl.classList.toggle('has-subnav', !subnav.hidden);
      moreBtn.classList.toggle('active', SECONDARY.includes(path));
      warningsBtn.classList.toggle('active', path === 'warnings');
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

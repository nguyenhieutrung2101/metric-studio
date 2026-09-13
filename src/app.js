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
import { MetricDrawer } from './features/metric-master/metric-drawer.js';
import { mountMetricMasterView } from './features/metric-master/metric-master-view.js';
import { mountBindingsView } from './features/bindings/bindings-view.js';
import { mountDependencyView } from './features/dependency/dependency-view.js';
import { mountDimensionsView } from './features/dimensions/dimensions-view.js';
import { mountMasterDataView } from './features/master-data/master-data-view.js';
import { mountImportExportView } from './features/import-export/import-export-view.js';
import { mountWarningsView } from './features/warnings/warnings-view.js';

const PRIMARY = ['metrics', 'bindings', 'dependencies'];
const SECONDARY = ['dimensions', 'master-data', 'backup'];
const VIEWS = {
  metrics: mountMetricMasterView,
  bindings: mountBindingsView,
  dependencies: mountDependencyView,
  dimensions: mountDimensionsView,
  'master-data': mountMasterDataView,
  backup: mountImportExportView,
  warnings: mountWarningsView,
};

/**
 * Bootstrap: repository → store → services → validation → shell → router → view.
 * Swapping LocalRepository for SharePointRepository is the only change needed
 * to move persistence; nothing below the next line knows about storage.
 */
export async function start(rootEl) {
  const repo = new LocalRepository();
  await repo.init();
  const store = new Store();
  const selectors = createSelectors(store);
  const snapshot = await repo.loadAll();
  const isEmpty = !Object.values(snapshot).some((arr) => arr.length > 0);
  if (isEmpty) {
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
    openMetric(id, opts) {
      metricDrawer.open(id, opts);
      ctx.currentMetricId = id;
      if (active.view && active.view.onMetricOpened) active.view.onMetricOpened(id);
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
  const active = { path: null, view: null };
  function mount(route) {
    let path = VIEWS[route.path] ? route.path : 'metrics';
    if (path !== active.path) {
      if (active.view) active.view.destroy();
      clear(shell.viewHost);
      active.path = path;
      active.view = VIEWS[path](shell.viewHost, ctx);
      shell.setActive(path);
      if (!route.params.metric && drawer.isOpen()) drawer.close({ force: true });
    }
    active.view.update(route);
  }
  router.onChange(mount);

  // ---------------------------------------------------------------- shell wiring
  shell.nav(router, () => active.path);
  shell.warningsBtn.addEventListener('click', () => router.navigate('warnings'));
  shell.moreBtn.addEventListener('click', (e) => {
    openMenu(e.currentTarget, [
      ...SECONDARY.map((p) => ({ label: t(`nav.${p}`), icon: p === 'dimensions' ? 'layers' : p === 'backup' ? 'download' : 'edit', active: active.path === p, onClick: () => router.navigate(p) })),
      { separator: true },
      { heading: t('nav.language') },
      ...LANGUAGES.map((l) => ({ label: l.label, active: getLanguage() === l.code, onClick: () => setLanguage(l.code) })),
      { separator: true },
      { heading: ctx.repoInfo.persistent ? t('io.storagePersistent') : t('io.storageMemory') },
    ]);
  });
  validation.onChange((index) => shell.setWarnings(index.bySeverity));
  onLanguageChange(() => window.location.reload());
  if (!ctx.repoInfo.persistent) setTimeout(() => toast.info(t('io.storageMemory'), { duration: 6000 }), 800);

  validation.run();
  router.start();
  globalThis.__metricStudio = ctx; // debugging / automation hook, no behaviour depends on it
  return ctx;
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
  const warnCount = h('span', { class: 'badge', text: '0' });
  const warningsBtn = h('button', { type: 'button', class: 'topbar-btn warnings-btn', title: t('nav.warnings') }, icon('warning'), warnCount);
  const moreBtn = h('button', { type: 'button', class: 'topbar-btn', title: t('nav.more') }, h('span', { text: t('nav.more') }), icon('chevronDown', { size: 14 }));
  const topbar = h('header', { class: 'topbar' }, brand, navEl, h('div', { class: 'topbar-right' }, warningsBtn, moreBtn));
  const viewHost = h('main', { class: 'view', id: 'view' });
  const drawerHost = h('div', { class: 'drawer-host' });
  const toastHost = h('div', { class: 'toast-host' });
  rootEl.replaceChildren(topbar, viewHost, drawerHost, toastHost);
  const links = new Map();
  return {
    viewHost, drawerHost, toastHost, warningsBtn, moreBtn,
    nav(router) {
      clear(navEl);
      for (const p of PRIMARY) {
        const a = h('a', { class: 'nav-link', href: router.build(p), text: t(`nav.${p}`) });
        links.set(p, a);
        navEl.appendChild(a);
      }
    },
    setActive(path) {
      for (const [p, a] of links) {
        const on = p === path;
        a.classList.toggle('active', on);
        if (on) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
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

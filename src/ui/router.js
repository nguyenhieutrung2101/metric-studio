/**
 * Hash router: #/metrics?node=abc&metric=xyz
 * route = { path: 'metrics', params: { node: 'abc', metric: 'xyz' } }
 */
export function createRouter({ defaultPath = 'metrics' } = {}) {
  const handlers = new Set();
  const paramHandlers = new Set();
  let current = parse(location.hash, defaultPath);
  let previous = null;

  function parse(hash, fallback) {
    const raw = (hash || '').replace(/^#\/?/, '');
    const [pathPart, query = ''] = raw.split('?');
    const params = {};
    for (const [k, v] of new URLSearchParams(query)) params[k] = v;
    return { path: pathPart || fallback, params };
  }

  function build(path, params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
    const qs = q.toString();
    return `#/${path}${qs ? `?${qs}` : ''}`;
  }

  function notify() {
    for (const fn of [...handlers]) fn(current);
  }

  window.addEventListener('hashchange', () => {
    previous = current;
    current = parse(location.hash, defaultPath);
    notify();
  });

  return {
    get current() {
      return current;
    },
    build,
    navigate(path, params = {}, { replace = false } = {}) {
      const next = build(path, params);
      if (next === location.hash) return;
      if (replace) history.replaceState(null, '', next);
      else location.hash = next;
      if (replace) {
        current = parse(location.hash, defaultPath);
        notify();
      }
    },
    /**
     * Keep the URL in sync with view state without a history entry and
     * without notifying listeners (the view already knows what it did).
     */
    setParams(patch) {
      const params = { ...current.params };
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '') delete params[k];
        else params[k] = String(v);
      }
      const next = build(current.path, params);
      if (next === location.hash) return;
      history.replaceState(null, '', next);
      current = parse(location.hash, defaultPath);
      for (const fn of [...paramHandlers]) fn(current);
    },
    /** Called after setParams: what a view did to its own route, for whoever remembers routes. */
    onParams(fn) {
      paramHandlers.add(fn);
      return () => paramHandlers.delete(fn);
    },
    /**
     * Put the URL back where it was before the last change, without telling
     * listeners: the view they show is still the right one. Used when a
     * navigation is refused because an editor holds unsaved changes.
     */
    revert() {
      if (!previous) return;
      const back = build(previous.path, previous.params);
      history.replaceState(null, '', back);
      current = parse(location.hash, defaultPath);
      previous = null;
    },
    onChange(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    start() {
      if (!location.hash) history.replaceState(null, '', build(defaultPath));
      current = parse(location.hash, defaultPath);
      notify();
    },
  };
}

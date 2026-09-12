/**
 * UI-only preferences (language, expanded tree nodes, last route). This is the
 * single place that touches localStorage; domain data never goes here.
 */
const PREFIX = 'metric-studio:pref:';

export function getPreference(key, fallback = null) {
  try {
    const raw = globalThis.localStorage ? localStorage.getItem(PREFIX + key) : null;
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function setPreference(key, value) {
  try {
    if (!globalThis.localStorage) return;
    if (value == null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* ignore quota / privacy errors */
  }
}

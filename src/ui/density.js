import { getPreference, setPreference } from '../utils/preferences.js';

/**
 * Density: how much of the screen one row takes.
 *
 * "Comfortable" is the default. "Compact" is for the person who lives in a
 * 5,000-row grid: 32px rows, 28px controls. The choice is a data attribute
 * on the root element that every density token reads, plus one event so the
 * virtual lists re-measure their rows.
 */
export const DENSITIES = ['comfortable', 'compact'];

export function getDensity() {
  const v = getPreference('density', 'comfortable');
  return DENSITIES.includes(v) ? v : 'comfortable';
}

export function applyDensity(value = getDensity()) {
  document.documentElement.dataset.density = value;
  window.dispatchEvent(new CustomEvent('density-change', { detail: value }));
}

export function setDensity(value) {
  if (!DENSITIES.includes(value)) return;
  setPreference('density', value);
  applyDensity(value);
}

import { en } from './strings/en.js';
import { vi } from './strings/vi.js';
import { getPreference, setPreference } from '../utils/preferences.js';

const DICTS = { en, vi };
let lang = getPreference('lang', 'en');
if (!DICTS[lang]) lang = 'en';
const listeners = new Set();

/** t('metric.status.draft') / t('list.count', { n: 3 }) — missing keys fall back to English, then to a humanised key. */
export function t(key, params = null) {
  let s = DICTS[lang][key];
  if (s == null) s = DICTS.en[key];
  if (s == null) s = key.split('.').pop().replace(/[-_]/g, ' ');
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] == null ? '' : String(params[k])));
  return s;
}

export function getLanguage() {
  return lang;
}

export function setLanguage(next) {
  if (!DICTS[next] || next === lang) return;
  lang = next;
  setPreference('lang', next);
  document.documentElement.lang = next;
  for (const fn of [...listeners]) fn(next);
}

export function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'vi', label: 'Tiếng Việt' },
];

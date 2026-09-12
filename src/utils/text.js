/**
 * Text normalisation used for search and reference matching.
 * Vietnamese-aware: strips diacritics and maps đ → d so that "Doanh thu"
 * matches "doanh thu" and "Van hanh" matches "Vận hành".
 */
export function normalizeText(value) {
  if (value == null) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Loose key used to match formula references: case/diacritic/space-insensitive. */
export function referenceKey(value) {
  return normalizeText(value).replace(/[\s_]+/g, ' ');
}

export function trimOrEmpty(value) {
  return value == null ? '' : String(value).trim();
}

export function splitList(value) {
  if (Array.isArray(value)) return value.map(trimOrEmpty).filter(Boolean);
  return trimOrEmpty(value)
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function padNumber(n, width) {
  return String(n).padStart(width, '0');
}

export function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
}

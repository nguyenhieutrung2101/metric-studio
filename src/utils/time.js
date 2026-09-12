export function nowIso() {
  return new Date().toISOString();
}

export function formatDateTime(iso, locale) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try {
    return d.toLocaleString(locale || undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return d.toISOString();
  }
}

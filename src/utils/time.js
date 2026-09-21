export function nowIso() {
  return new Date().toISOString();
}

const pad = (n) => String(n).padStart(2, '0');

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A timestamp the way the people using this read one: 21/09/2026 14:05.
 *
 * Deliberately not the browser's own locale format. A column of timestamps
 * that changes shape with whoever opens it — month first here, a 12-hour
 * clock there — is a column nobody can scan, and the same file passed
 * between two colleagues would not even agree with itself.
 */
export function formatDateTime(value) {
  const d = toDate(value);
  if (!d) return value ? String(value) : '';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The same, without the time of day. */
export function formatDate(value) {
  const d = toDate(value);
  if (!d) return value ? String(value) : '';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

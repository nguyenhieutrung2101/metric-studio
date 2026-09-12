/**
 * Stable, immutable identifiers. UUID v4 when available, otherwise a
 * time-based fallback with enough entropy for a single workbook.
 */
export function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const rnd = () => Math.random().toString(16).slice(2, 10);
  return `${Date.now().toString(16)}-${rnd()}-${rnd()}-${rnd()}`;
}

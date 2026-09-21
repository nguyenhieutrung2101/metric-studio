import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDateTime, formatDate } from '../src/utils/time.js';

/**
 * Timestamps are read, compared and pasted into mail by people who write the
 * day first and read a 24-hour clock. The browser's own locale format would
 * make the same column look different to two colleagues.
 */
test('a timestamp reads day first on a 24-hour clock, whatever the machine thinks', () => {
  const at = new Date(2026, 8, 21, 14, 5);
  assert.equal(formatDateTime(at), '21/09/2026 14:05');
  assert.equal(formatDate(at), '21/09/2026');
  // Single digits keep their place, so a column stays a column.
  assert.equal(formatDateTime(new Date(2026, 0, 2, 9, 7)), '02/01/2026 09:07');
  // Midnight is 00:00 and noon is 12:00; neither is "12".
  assert.equal(formatDateTime(new Date(2026, 0, 2, 0, 0)), '02/01/2026 00:00');
  assert.equal(formatDateTime(new Date(2026, 0, 2, 12, 0)), '02/01/2026 12:00');
  assert.equal(formatDateTime(new Date(2026, 0, 2, 23, 59)), '02/01/2026 23:59');
});

test('an ISO string is read as an instant, and anything unreadable is handed back untouched', () => {
  const iso = new Date(2026, 8, 21, 14, 5).toISOString();
  assert.equal(formatDateTime(iso), '21/09/2026 14:05');
  assert.equal(formatDateTime(''), '');
  assert.equal(formatDateTime(null), '');
  assert.equal(formatDateTime(undefined), '');
  assert.equal(formatDateTime('not a date'), 'not a date');
  assert.equal(formatDate(''), '');
});

/**
 * PresenceService — "who is looking at / editing what". UX only: the real
 * protection against lost updates is the version check in the repository.
 *
 * Interface:
 *   setUser({ id, name })
 *   announce({ entityType, entityId, scenarioId, mode: 'viewing'|'editing' })
 *   clear()
 *   subscribe(handler) → unsubscribe   handler(presenceList)
 *   list() → [{ user, entityType, entityId, scenarioId, mode, since }]
 *
 * LocalPresenceService keeps the current user's own state only; a SharePoint
 * implementation would poll or subscribe to a presence list with a TTL.
 */
export class LocalPresenceService {
  constructor() {
    this.user = { id: 'local', name: '' };
    this._current = null;
    this._handlers = new Set();
  }

  setUser(user) {
    this.user = { ...this.user, ...user };
  }

  announce(target) {
    this._current = target ? { ...target, user: this.user, since: new Date().toISOString() } : null;
    this._notify();
  }

  clear() {
    this._current = null;
    this._notify();
  }

  list() {
    return this._current ? [this._current] : [];
  }

  subscribe(handler) {
    this._handlers.add(handler);
    return () => this._handlers.delete(handler);
  }

  _notify() {
    const list = this.list();
    for (const h of this._handlers) h(list);
  }
}

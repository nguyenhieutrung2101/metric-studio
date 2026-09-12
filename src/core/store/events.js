/** Minimal synchronous event bus. Handlers that throw do not stop the others. */
export class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  on(topic, handler) {
    if (!this._handlers.has(topic)) this._handlers.set(topic, new Set());
    this._handlers.get(topic).add(handler);
    return () => this.off(topic, handler);
  }

  once(topic, handler) {
    const off = this.on(topic, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off(topic, handler) {
    const set = this._handlers.get(topic);
    if (set) set.delete(handler);
  }

  emit(topic, payload) {
    const set = this._handlers.get(topic);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[events] handler for "${topic}" failed`, err);
      }
    }
  }
}

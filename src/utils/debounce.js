/** Trailing debounce. The returned function exposes cancel() and flush(). */
export function debounce(fn, wait = 150) {
  let timer = null;
  let lastArgs = null;
  const debounced = (...args) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = lastArgs;
      lastArgs = null;
      fn(...a);
    }, wait);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  debounced.flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    const a = lastArgs;
    lastArgs = null;
    fn(...a);
  };
  return debounced;
}

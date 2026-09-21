/**
 * Hand the browser a file to save.
 *
 * The object URL is revoked on a timer rather than immediately: the click
 * only starts the save, and revoking while it is still being read loses the
 * file in some browsers.
 */
export function downloadBlob(data, filename, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

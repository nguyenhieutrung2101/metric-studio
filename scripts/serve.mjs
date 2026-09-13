/**
 * Zero-dependency static server for local development.
 *   node scripts/serve.mjs [port]
 *
 * Binds to the loopback interface and serves only the files the published
 * site contains. A development server that hands out .git or node_modules to
 * anyone on the same network is a real leak, even if the deployed site is
 * configured correctly.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { argv, env } from 'node:process';

const root = resolve(new URL('..', import.meta.url).pathname);

/** Exactly what `.assetsignore` leaves in the published site. */
export const SERVABLE_ROOTS = new Set(['index.html', 'css', 'src']);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// The same headers the published site sends, so they are exercised in development.
export const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

/**
 * Resolve a request path to a file inside the published site, or null.
 * Exported so the allow-list itself is covered by a test rather than by a
 * manual sweep of URLs.
 */
export function servablePath(urlPath, base = root) {
  let path = normalize(decodeURIComponent(urlPath));
  if (path === '/' || path === sep) path = '/index.html';
  const segments = path.split(/[/\\]+/).filter(Boolean);
  if (!segments.length) return null;
  if (segments.some((s) => s.startsWith('.'))) return null; // .git, .env, dotfiles
  if (!SERVABLE_ROOTS.has(segments[0])) return null;
  const file = join(base, ...segments);
  return file.startsWith(base + sep) ? file : null;
}

export function createStaticServer() {
  return createServer(async (req, res) => {
    const send = (code, body, extra = {}) => {
      res.writeHead(code, { ...SECURITY_HEADERS, 'cache-control': 'no-cache', ...extra });
      res.end(body);
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const file = servablePath(url.pathname);
      if (!file) {
        send(404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
        return;
      }
      const s = await stat(file);
      if (s.isDirectory()) {
        send(404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
        return;
      }
      const data = await readFile(file);
      send(200, data, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    } catch {
      send(404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
    }
  });
}

if (resolve(argv[1] || '') === resolve(new URL(import.meta.url).pathname)) {
  const port = Number(argv[2] || env.PORT || 8080);
  const host = env.HOST || '127.0.0.1';
  createStaticServer().listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`Metric Studio → http://${host}:${port}`);
  });
}

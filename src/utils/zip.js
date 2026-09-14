/**
 * The ZIP container an .xlsx file is, and nothing more: local file headers,
 * a central directory, and an end-of-directory record. Entries are stored
 * or deflated; deflate goes through the platform's CompressionStream /
 * DecompressionStream, so no compression code lives here. A platform without
 * them writes stored entries (Excel reads those fine) and cannot read
 * deflated ones — which is reported, not guessed around.
 *
 * Limits are deliberate: no ZIP64, no encryption, no spanning. A workbook
 * this app writes or reads is a few megabytes at most.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

async function throughStream(bytes, Ctor, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new Ctor(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Raw deflate, or null when the platform cannot compress. */
export async function deflateRaw(bytes) {
  if (typeof globalThis.CompressionStream !== 'function') return null;
  try {
    return await throughStream(bytes, globalThis.CompressionStream, 'deflate-raw');
  } catch {
    return null;
  }
}

export async function inflateRaw(bytes) {
  if (typeof globalThis.DecompressionStream !== 'function') throw new Error('This browser cannot read compressed workbooks (DecompressionStream is unavailable)');
  return throughStream(bytes, globalThis.DecompressionStream, 'deflate-raw');
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date, time };
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * @param {Array<{ name: string, data: Uint8Array|string }>} entries
 * @returns {Promise<Uint8Array>}
 */
export async function zipWrite(entries, { compress = true, now = new Date() } = {}) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const { date, time } = dosDateTime(now);
  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const raw = typeof entry.data === 'string' ? enc.encode(entry.data) : entry.data;
    const crc = crc32(raw);
    let method = 0;
    let data = raw;
    if (compress && raw.length > 0) {
      const deflated = await deflateRaw(raw);
      if (deflated && deflated.length < raw.length) {
        method = 8;
        data = deflated;
      }
    }
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    parts.push(local, data);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);
  return concat([...parts, ...central, eocd]);
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Map<string, Uint8Array>>} entry name → contents
 */
export async function zipRead(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i -= 1) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (no end-of-directory record)');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  const dec = new TextDecoder();
  const out = new Map();
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    const lho = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (lho + 30 > bytes.length || v.getUint32(lho, true) !== 0x04034b50) throw new Error(`Corrupt ZIP entry "${name}"`);
    const lnlen = v.getUint16(lho + 26, true);
    const lxlen = v.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lxlen;
    if (start + csize > bytes.length) throw new Error(`Truncated ZIP entry "${name}"`);
    const data = bytes.subarray(start, start + csize);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, await inflateRaw(data));
    else throw new Error(`Unsupported compression method ${method} for "${name}"`);
  }
  return out;
}

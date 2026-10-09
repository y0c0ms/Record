// The HTTP plumbing every route shares: JSON replies, request bodies, and
// static files. Kept separate from routing so the routes read as a list of
// endpoints rather than a mix of concerns.

import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.json': 'application/json',
};

export function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': buf.length,
  });
  res.end(buf);
}

// Bodies larger than this are refused. Every legitimate request is a few
// hundred bytes of JSON; a body without a cap is a way to exhaust memory.
const MAX_BODY = 1 << 20;

// A malformed body is treated as an empty one rather than a 500: a client that
// sends garbage should get a clear "unknown field" error, not a crash.
//
// Only a JSON object counts as a body. `JSON.parse` happily returns `null`, a
// number or an array, and every route reads fields straight off the result —
// so a four-byte `null` body used to throw inside the handler and take the
// whole sidecar down.
export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Who may talk to the sidecar.
//
// It binds to loopback, but that alone does not keep websites out: any page the
// user has open can POST to http://127.0.0.1:4317 with a `text/plain` body,
// which needs no CORS preflight, and the handler runs even though the page
// cannot read the reply. A rebinding page can go further and read replies too,
// by pointing its own hostname at 127.0.0.1.
//
// So two things are checked. The Host header must name loopback, which defeats
// rebinding: the browser sends the attacker's hostname there. And a request a
// browser marks as cross-site must come from the sidecar's own origin. The
// desktop app and the CLI are not browsers and send no Origin header at all,
// so they are unaffected.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isTrustedRequest(req, port) {
  const host = String(req.headers.host || '');
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return [...LOOPBACK_HOSTS].some((h) => origin === `http://${h}:${port}`);
}

// Serves a file under `baseDir`, refusing anything that escapes it.
export function serveStatic(res, baseDir, relPath) {
  const safe = path.normalize(relPath).replace(/^([.]{2}[/\\])+/, '');
  const file = path.join(baseDir, safe);
  if (!file.startsWith(baseDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// The sidecar: an HTTP front end for recording, replaying and generating
// tests. Routing lives in routes/; this file owns the process — the server, the
// live recorder and replayer handles, and the SSE fan-out.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DATA_DIR, SESSIONS_DIR, loadStoredSessions } from '../src/store.js';
import { isTrustedRequest, json, serveStatic } from './http.js';
import { createSessionRoutes } from './routes/sessions.js';
import { createFolderRoutes } from './routes/folders.js';
import { createSubflowRoutes } from './routes/subflows.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4317);

// Live handles, keyed by session id.
const recorders = new Map();
const replayerBySession = new Map();

// SSE clients, per session id. The GUI subscribes per session to receive live
// step and replay events.
const listeners = new Map();

function subscribe(sessionId, res) {
  if (!listeners.has(sessionId)) listeners.set(sessionId, new Set());
  listeners.get(sessionId).add(res);
  res.on('close', () => listeners.get(sessionId)?.delete(res));
}

// A null id broadcasts to every stream: folder counts change for all viewers
// at once, so there is nothing sensible to send to only one session.
function broadcast(sessionId, event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  if (sessionId === null) {
    for (const set of listeners.values()) {
      for (const res of set) res.write(payload);
    }
    return;
  }
  const set = listeners.get(sessionId);
  if (!set) return;
  for (const res of set) res.write(payload);
}

// Sessions already wired to the broadcast. Attaching twice would register the
// handlers twice and deliver every event to every viewer of that session
// twice — and a session is made live by both recording and replaying, so it
// can be attached more than once.
const attached = new WeakSet();

function attach(session) {
  if (attached.has(session)) return;
  attached.add(session);
  session.on('status', (view) => broadcast(session.id, { type: 'status', session: view }));
  session.on('step', (payload) => broadcast(session.id, { type: 'step', ...payload }));
  session.on('replay', (payload) => broadcast(session.id, payload));
}

const handleSessions = createSessionRoutes({
  recorders,
  replayerBySession,
  subscribe,
  broadcast,
  attach,
  sessionsDir: SESSIONS_DIR,
});

const handleFolders = createFolderRoutes({ broadcast });
const handleSubflows = createSubflowRoutes({ broadcast });

// One request, end to end. Split out so the server can wrap it: a handler that
// throws used to be an unhandled rejection, which ended the whole process and
// every live recording with it.
async function route(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  if (parts[0] === 'api') {
    if (parts[1] === 'health') {
      return json(res, 200, {
        ok: true,
        browser: 'Microsoft Edge',
        channel: 'msedge',
        demoUrl: `http://localhost:${PORT}/demo`,
        dataDir: DATA_DIR,
      });
    }

    if (parts[1] === 'sessions') {
      if (await handleSessions(req, res, parts, method)) return;
      return json(res, 404, { error: 'not found' });
    }

    if (parts[1] === 'folders') {
      if (await handleFolders(req, res, parts, method)) return;
      return json(res, 404, { error: 'not found' });
    }

    if (parts[1] === 'subflows') {
      if (await handleSubflows(req, res, parts, method)) return;
      return json(res, 404, { error: 'not found' });
    }

    return json(res, 404, { error: 'not found' });
  }

  if (parts[0] === 'demo') {
    return serveStatic(res, path.join(ROOT, 'demo'), parts.slice(1).join('/') || 'index.html');
  }

  if (parts[0] === 'generated' && parts[1]) {
    return serveStatic(res, path.join(ROOT, 'generated'), parts.slice(1).join('/'));
  }

  // The browser UI, for anyone who would rather not have a native window.
  if (!parts.length) {
    return serveStatic(res, path.join(ROOT, 'web'), 'index.html');
  }

  res.writeHead(404);
  res.end('not found');
}

const server = http.createServer(async (req, res) => {
  if (!isTrustedRequest(req, PORT)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden');
  }
  try {
    await route(req, res);
  } catch (err) {
    process.stderr.write(`request failed: ${req.method} ${req.url}: ${err && err.stack ? err.stack : err}\n`);
    if (!res.headersSent) json(res, err && err.status ? err.status : 500, { error: String((err && err.message) || err) });
    else res.end();
  }
});

loadStoredSessions();

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`Record sidecar on http://127.0.0.1:${PORT}\n`);
});

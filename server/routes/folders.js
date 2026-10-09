// Folders: how recordings are organised. Created from the GUI, so the routes
// are a thin shell over src/store.js — the rules about what may be renamed or
// deleted live with the data.

import {
  createFolder,
  deleteFolder,
  getSession,
  listFolders,
  listSessions,
  moveSession,
  renameFolder,
} from '../../src/store.js';
import { json, readBody } from '../http.js';

export function createFolderRoutes({ broadcast }) {
  return async function handleFolders(req, res, parts, method) {
    // ---- list ----
    if (parts.length === 2 && method === 'GET') {
      return json(res, 200, { folders: listFolders() }), true;
    }

    // ---- create ----
    if (parts.length === 2 && method === 'POST') {
      const body = await readBody(req);
      try {
        return json(res, 200, { folder: createFolder(body.name, body.parent) }), true;
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) }), true;
      }
    }

    // ---- rename ----
    if (parts.length === 3 && method === 'PATCH') {
      const body = await readBody(req);
      try {
        return json(res, 200, { folder: renameFolder(parts[2], body.name) }), true;
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) }), true;
      }
    }

    // ---- delete ----
    if (parts.length === 3 && method === 'DELETE') {
      try {
        deleteFolder(parts[2]);
        // Counts on every folder just changed, so tell anyone watching.
        broadcastAll();
        return json(res, 200, { ok: true }), true;
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) }), true;
      }
    }

    // ---- move a recording into a folder ----
    if (parts[2] === 'move' && parts[3] && method === 'POST') {
      const body = await readBody(req);
      const session = getSession(parts[3]);
      if (!session) return json(res, 404, { error: 'session not found' }), true;
      try {
        moveSession(parts[3], body.folder || null);
        session.persist();
        broadcastAll();
        return json(res, 200, { session: session.publicView() }), true;
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) }), true;
      }
    }

    return false;

    // Folder membership is reflected in every folder's count and in the
    // sidebar, so one broadcast keeps all of it honest.
    function broadcastAll() {
      const folders = listFolders();
      const sessions = listSessions().map((s) => ({ id: s.id, folder: s.folder || null }));
      broadcast(null, { type: 'folders', folders, sessions });
    }
  };
}
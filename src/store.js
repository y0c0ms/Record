import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// RECORD_DATA_DIR points the whole app at another data folder: recordings,
// folders, subflows and the password key all live under it. It is how a demo
// or a screenshot runs on example data without touching real recordings.
export const DATA_DIR = process.env.RECORD_DATA_DIR ? path.resolve(process.env.RECORD_DATA_DIR) : path.join(ROOT, 'data');
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
export const GENERATED_DIR = path.join(ROOT, 'generated');
export const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json');

for (const dir of [DATA_DIR, SESSIONS_DIR, GENERATED_DIR]) fs.mkdirSync(dir, { recursive: true });

// Replaces `file` with `content` so a reader sees either the old file or the
// new one, never half of each.
//
// Writing in place truncates first and fills second, so a crash, a killed
// sidecar or a full disk between the two leaves a torn file. For a session
// that is the flow gone; for folders.json it is worse, because the reader
// treats an unparseable file as "no folders yet" and the next write saves that.
// Writing beside it and renaming is atomic on the same volume.
export function writeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// Sessions live in folders kept in one JSON file. Folders may nest one level:
// recordings are grouped by area, and the second level separates the cases
// within it. Deeper trees are rejected rather than supported, because a flow
// library is browsed by scanning, and a chain of empty folders is not.
const UNFILED = 'unfiled';

function readFolders() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FOLDERS_FILE, 'utf8'));
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {
    // Missing or corrupt file: fall through to the default below.
  }
  return [{ id: UNFILED, name: 'Unfiled', system: true }];
}

function writeFolders(folders) {
  writeFileAtomic(FOLDERS_FILE, JSON.stringify(folders, null, 2));
}

let folders = readFolders();

// Declared before the folder helpers below: they walk live sessions to keep
// counts accurate.
const sessions = new Map();

// Sessions a user can see: everything but the soft-deleted. Counts and lists
// both go through this, so a folder's number always matches what it shows.
const live = () => [...sessions.values()].filter((s) => s.status !== 'deleted');

// A folder's recordings, plus the folders nested under it. `count` counts only
// the recordings filed directly in that folder: the panel shows a folder's
// children as their own rows, so folding their total in here would count every
// nested recording twice.
function folderWithChildren(folder) {
  return {
    ...folder,
    count: live().filter((s) => folderOf(s) === folder.id).length,
    children: folders
      .filter((f) => f.parent === folder.id)
      .map((f) => ({
        ...f,
        count: live().filter((s) => folderOf(s) === f.id).length,
        children: [],
      })),
  };
}

export function listFolders() {
  return folders.filter((f) => !f.parent).map(folderWithChildren);
}

// Rejects a parent that is itself nested, so the tree stays one level deep
// whatever order folders arrive in or what is edited on disk.
function checkParent(parentId) {
  if (parentId === undefined || parentId === null || parentId === '') return null;
  const parent = folders.find((f) => f.id === parentId);
  if (!parent) throw new Error('parent folder not found');
  if (parent.parent) throw new Error('folders can only nest one level');
  if (parent.system) throw new Error('cannot nest under the built-in folder');
  return parentId;
}

export function createFolder(name, parentId) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('folder name is required');
  const parent = checkParent(parentId);
  const id = `f${Date.now().toString(36)}${(folders.length + 1).toString(36)}`;
  const folder = { id, name: trimmed, system: false };
  if (parent) folder.parent = parent;
  folders.push(folder);
  writeFolders(folders);
  return folderWithChildren(folder);
}

export function renameFolder(id, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('folder name is required');
  const folder = folders.find((f) => f.id === id);
  if (!folder) throw new Error('folder not found');
  if (folder.system) throw new Error('cannot rename the built-in folder');
  folder.name = trimmed;
  writeFolders(folders);
  return folder;
}

// Deleting a folder never destroys recordings: its sessions fall back to
// Unfiled, and its sub-folders are lifted to the top level rather than deleted
// with it. A folder holding others holds work, so removing the label must not
// remove what is filed under it.
export function deleteFolder(id) {
  const folder = folders.find((f) => f.id === id);
  if (!folder) throw new Error('folder not found');
  if (folder.system) throw new Error('cannot delete the built-in folder');
  for (const child of folders) {
    if (child.parent === id) delete child.parent;
  }
  folders = folders.filter((f) => f.id !== id);
  writeFolders(folders);
  for (const session of sessions.values()) {
    if (session.folder === id) {
      session.folder = UNFILED;
      session.persist();
    }
  }
  return { ok: true };
}

// Files a recording under a folder. `null` (or the Unfiled folder's own id)
// takes it out of every folder. Before, `null` was looked up as a folder id,
// found nothing, and threw — so a recording could be filed but never unfiled.
export function moveSession(sessionId, folderId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('session not found');
  if (folderId === null || folderId === UNFILED) {
    session.folder = null;
  } else if (!folders.some((f) => f.id === folderId)) {
    throw new Error('folder not found');
  } else {
    session.folder = folderId;
  }
  session.persist();
  return session;
}

function folderOf(session) {
  return session.folder || UNFILED;
}

let counter = 0;
const nextId = () => {
  counter += 1;
  return `s${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}`;
};

class Session extends EventEmitter {
  constructor(init) {
    super();
    this.setMaxListeners(0);
    Object.assign(this, init);
  }

  // Only the session's own fields are written. The object is an EventEmitter,
  // and spreading it copied the emitter's internals (`_events`, `_maxListeners`)
  // into every saved flow.
  persist() {
    const rest = {};
    for (const [key, value] of Object.entries(this)) {
      if (!key.startsWith('_')) rest[key] = value;
    }
    writeFileAtomic(path.join(SESSIONS_DIR, `${this.id}.json`), JSON.stringify(rest, null, 2));
  }

  publicView() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      channel: this.channel,
      folder: this.folder || UNFILED,
      startUrl: this.startUrl,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt,
      error: this.error,
      stepCount: this.steps.length,
      steps: this.steps.map((s) => ({
        id: s.id,
        index: s.index,
        type: s.type,
        offsetMs: s.offsetMs,
        title: s.title,
        detail: s.detail,
        // The fields the step editor reads: a locator target, the literal
        // value, and the dataset parameter that overrides it.
        label: s.label || null,
        value: s.value === undefined ? null : s.value,
        key: s.key === undefined ? null : s.key,
        ms: s.ms === undefined ? null : s.ms,
        valueParam: s.valueParam || null,
        match: s.match || null,
        optional: !!s.optional,
        edited: !!s.edited,
        locator: s.locator || null,
        candidates: s.candidates || [],
        url: s.url,
        status: s.status,
        error: s.error || null,
        // Which locator the last run used, how long it waited, and how it
        // failed. Without these a run that only ever passes on a fallback reads
        // exactly like one that used the primary on the first try.
        resolvedLocator: s.resolvedLocator || null,
        locatorWaitMs: s.locatorWaitMs ?? null,
        failureKind: s.failureKind || null,
        shot: s.shot || null,
        // A password step shows its mask; whether a real value is kept behind
        // it is all the GUI needs to know. The ciphertext never leaves here.
        secret: !!s.secret,
        secretStored: !!s.sealed,
        // What an upload step will hand the file chooser.
        file: s.file || null,
        // How a native alert/confirm/prompt raised by this step is answered.
        dialog: s.dialog || null,
        // Which page and frame the step acts in, for popups and iframes.
        page: s.page || 0,
        frame: s.frame || null,
      })),
      replay: this.replay,
      // Past runs of this flow, newest first. Kept out of the live `replay`
      // object so a new run never overwrites the history.
      runs: this.runs || [],
      folder: this.folder || null,
      spec: this.spec ? { path: this.spec.path, code: this.spec.code } : null,
    };
  }
}


export function createSession({ name, startUrl, channel, folder }) {
  const id = nextId();
  const now = Date.now();
  const session = new Session({
    id,
    folder: folder && folders.some((f) => f.id === folder) ? folder : UNFILED,
    name: name || `Flow ${id.slice(1, 6).toUpperCase()}`,
    status: 'created',
    channel: channel || 'msedge',
    startUrl: startUrl || 'about:blank',
    createdAt: now,
    finishedAt: null,
    error: null,
    steps: [],
    replay: null,
    spec: null,
    source: 'record',
  });
  sessions.set(id, session);
  session.persist();
  return session;
}

// Reads fall through to disk. The CLI records in its own process, so an
// in-memory-only map would hide those sessions from the sidecar and the GUI.
export function getSession(id) {
  const cached = sessions.get(id);
  if (cached) return cached;

  const file = path.join(SESSIONS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const session = new Session(raw);
    sessions.set(id, session);
    return session;
  } catch (err) {
    console.warn(`[record] unreadable session ${id}: ${err.message}`);
    return null;
  }
}

export function listSessions() {
  loadStoredSessions();
  // A deleted flow is kept on disk (the delete is soft) but must never come
  // back into a list: before this it reappeared after every sidecar restart.
  return live()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((s) => s.publicView());
}

export function shotDir(sessionId) {
  return path.join(SESSIONS_DIR, sessionId, 'shots');
}

export function sessionDir(sessionId) {
  return path.join(SESSIONS_DIR, sessionId);
}

// Loads any session file not already in memory. Must never overwrite a live
// entry: the sidecar's own sessions are authoritative while recording or
// replaying. A recording left open by a crash is marked interrupted rather
// than silently stuck on "recording".
export function loadStoredSessions() {
  for (const file of fs.readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const id = path.basename(file, '.json');
    if (sessions.has(id)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
      // A recording left open by a crash is marked interrupted rather than
      // resumed: its browser is gone, so nothing can continue it.
      if (raw.status === 'recording' || raw.status === 'paused' || raw.status === 'created') {
        raw.status = 'interrupted';
      }
      sessions.set(raw.id, new Session(raw));
    } catch (err) {
      console.warn(`[record] skipping unreadable session ${file}: ${err.message}`);
    }
  }
}

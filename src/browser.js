// Where each run keeps its browser profile.
//
// Every recording and every replay used to launch Edge with an empty profile
// path, which asks the browser for a throwaway profile. That is what makes two
// runs safe to have open at once: each is handed its own fresh directory, so
// there is no shared state and no shared focus, and keystrokes cannot cross
// between them — Playwright delivers input to the page it belongs to rather
// than to the OS cursor, so two browsers filling a username field at the same
// moment each type into their own field.
//
// What an empty path does *not* give you is persistence. A run cannot be logged
// in by a human beforehand, and nothing carries between runs. Where a session
// needs a stable identity — the same cookies on every replay, or a one-off login
// — it is given a directory of its own named after the session, so that state
// outlives the run without outliving the flow it belongs to.

import fs from 'node:fs';
import path from 'node:path';

/**
 * The profile directory for a session's browser.
 *
 * `headed` sessions get a directory named after the session so a login survives
 * between runs; headless runs get the browser's throwaway profile, which is
 * correct for them: there is nobody there to log in, and a stale headless
 * profile is state that can only ever be wrong.
 *
 * @param {string} sessionsDir root the per-session directories live under
 * @param {string} id the session id, which is unique and filesystem-safe
 * @param {boolean} headed whether the browser will be visible
 * @returns {string} a path to pass as `userDataDir`
 */
export function profileDir(sessionsDir, id, headed) {
  if (!headed) return '';
  // Sanitised rather than trusted: the id reaches here from the API, and a
  // directory built from a caller-supplied string has to not be able to point
  // anywhere outside the sessions directory.
  const safe = String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = path.join(sessionsDir, safe, 'profile');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Removes a session's kept profile. Called when the flow is deleted, so a
 * recording's cookies do not outlive the flow that asked for them.
 *
 * @param {string} sessionsDir root the per-session directories live under
 * @param {string} id the session id
 */
export function dropProfile(sessionsDir, id) {
  const safe = String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
  fs.rmSync(path.join(sessionsDir, safe, 'profile'), { recursive: true, force: true });
}
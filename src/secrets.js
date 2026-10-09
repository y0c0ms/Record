// Recorded secrets — passwords and anything typed into a password field.
//
// The recording used to keep only a mask, so every login replayed by typing
// eight bullets into the password field: the step "passed" and the flow then
// failed somewhere downstream, or worse, passed against a page that let it
// through. A secret has to be kept to be replayed, so it is kept encrypted:
// AES-256-GCM under a per-installation key that never leaves `data/`.
//
// What this protects against: session files copied, shared, attached to a bug
// report or committed by mistake. They carry ciphertext that is useless without
// the key file. What it does not protect against: someone with read access to
// the whole `data/` directory, who has both. That is the same boundary a
// browser's saved-password store has without an OS keychain.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, writeFileAtomic } from './store.js';

// What a secret looks like everywhere outside replay: the session list, the
// GUI, the run record, the generated spec.
export const MASK = '••••••••';

const KEY_FILE = path.join(DATA_DIR, 'secret.key');
const VERSION = 'v1';

let cachedKey = null;

// Created on first use rather than at install, so an installation that never
// records a password never has a key lying around.
function key() {
  if (cachedKey) return cachedKey;
  try {
    const raw = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
    if (raw.length === 32) {
      cachedKey = raw;
      return cachedKey;
    }
    // A key of the wrong size is not something to paper over by generating a
    // new one: that would silently orphan every secret encrypted under the old.
    throw new Error(`${KEY_FILE} is not a 32-byte key; refusing to replace it`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  cachedKey = crypto.randomBytes(32);
  writeFileAtomic(KEY_FILE, cachedKey.toString('base64'));
  try {
    fs.chmodSync(KEY_FILE, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file inherits the user profile's ACL.
  }
  return cachedKey;
}

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join(':');
}

export function decryptSecret(sealed) {
  const [version, iv, tag, body] = String(sealed || '').split(':');
  if (version !== VERSION || !iv || !tag || body === undefined) {
    throw new Error('stored secret is not in a format this version can read');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // GCM authentication failed: the ciphertext was edited, or the key file was
    // replaced since it was written. Either way the value is gone, and typing a
    // guess into the field would be worse than stopping.
    throw new Error('stored secret cannot be decrypted with this installation\'s key (data/secret.key changed?)');
  }
}

// Stores a new plaintext on a step, keeping only the mask in `value`.
export function sealStep(step, plain) {
  step.secret = true;
  step.sealed = encryptSecret(plain);
  step.value = MASK;
}

// The value a secret step should type at replay. A recording made before
// secrets were kept has a mask and nothing behind it; replaying that would type
// bullets into a password field and report the step green, so it fails here
// with what to do about it instead.
export function revealStep(step) {
  if (step.sealed) return decryptSecret(step.sealed);
  const err = new Error(
    `step ${step.index} is a password recorded before secrets were stored — ` +
      'enter the password again in the step editor, or supply it as a dataset value',
  );
  err.code = 'secret-missing';
  throw err;
}

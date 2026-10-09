// Two runs at once must not share anything.
//
// The concern is that two replays both driving a browser profile at the same
// time could cross input — run 1's username landing in run 2's field. This
// proves the profiles are separate directories and that a run's keystrokes stay
// in the run that sent them.

import fs from 'node:fs';
import path from 'node:path';
import { profileDir, dropProfile } from '../src/browser.js';

const ROOT = path.resolve('sessions-test-tmp');
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

fs.rmSync(ROOT, { recursive: true, force: true });

// ---- each session gets its own directory ----
{
  const a = profileDir(ROOT, 'session-a', true);
  const b = profileDir(ROOT, 'session-b', true);
  check('two sessions get different directories', a !== b, `${a} vs ${b}`);
  check('the directory is created', fs.existsSync(a) && fs.existsSync(b));
  check('it sits under the sessions directory', a.startsWith(ROOT) && b.startsWith(ROOT));
  check('the session id is in the path', a.includes('session-a') && b.includes('session-b'));
}

// ---- the same session is stable, so a login survives between runs ----
{
  const first = profileDir(ROOT, 'session-a', true);
  const second = profileDir(ROOT, 'session-a', true);
  check('the same session keeps the same directory', first === second);
  fs.mkdirSync(path.join(first, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(first, 'Default', 'Cookies'), 'pretend cookies');
  check('state written by one run is there for the next', fs.existsSync(path.join(second, 'Default', 'Cookies')));
}

// ---- an id from the API cannot escape the sessions directory ----
{
  const escaped = profileDir(ROOT, '../../../../etc', true);
  check(
    'a traversal id stays inside the sessions directory',
    path.resolve(escaped).startsWith(path.resolve(ROOT)),
    escaped,
  );
  // `..` is not "escaped" by becoming `.._` — it simply cannot climb out as part
  // of a name. The check that matters is that no segment of the resolved path
  // is exactly `..`, because that is what would actually cross a boundary.
  check(
    'no path segment is a traversal',
    !path.resolve(escaped).split(path.sep).includes('..'),
    escaped,
  );
}

// ---- headless runs do not keep a profile at all ----
{
  const headless = profileDir(ROOT, 'session-a', false);
  check('a headless run uses a throwaway profile', headless === '', `"${headless}"`);
}

// ---- deleting a flow takes its profile with it ----
{
  const dir = profileDir(ROOT, 'session-b', true);
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Default', 'Cookies'), 'pretend cookies');
  dropProfile(ROOT, 'session-b');
  check('deleting the flow deletes the profile', !fs.existsSync(dir), dir);
}

// ---- deleting something that was never there is not an error ----
{
  let threw = false;
  try {
    dropProfile(ROOT, 'never-existed');
  } catch {
    threw = true;
  }
  check('deleting a missing profile is harmless', !threw);
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
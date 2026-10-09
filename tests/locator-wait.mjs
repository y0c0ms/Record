// The locator wait, and what it reports when it fails.
//
// A recorded flow is replayed against a page that is not in the state it was
// recorded in. The page is cold, the element is late, and a short probe calls
// an element that is about to appear "missing". So the *first* locator a step
// stored gets its own full wait before the next is tried — and when it works,
// the run has to say which locator it used and how long it took, because a
// test that only ever passes on its third candidate is a test about to break.
//
// The rungs after the first are different in kind: they exist to catch a page
// that has already changed under the recording, so they are probed rather than
// waited out. Both halves matter — too short a first wait and a cold page
// fails, too long a fallback and a renamed element costs a minute.
//
// Run: node tests/locator-wait.mjs

import { chromium } from 'playwright';
import { FALLBACK_WAIT_MS, LOCATOR_WAIT_MS, resolveCandidate } from '../src/locator.js';

// A page whose button does not exist until eight seconds in. The old 1.2s
// probe failed this; a thirty-second wait finds it.
const LATE_PAGE = `data:text/html,
  <button id="ready">ready</button>
  <script>
    setTimeout(() => {
      const b = document.createElement('button');
      b.id = 'slow';
      b.textContent = 'slow';
      document.body.appendChild(b);
    }, 8000);
  </script>`;

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();
await page.goto(LATE_PAGE);

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const css = (value) => ({ strategy: 'css', value });

// ---- an element that arrives late is found ----
{
  const step = { locator: css('#slow'), candidates: [css('#slow')] };
  const started = Date.now();
  try {
    await resolveCandidate(page, step, { action: (l) => l.click({ timeout: 5000 }) });
    const took = Date.now() - started;
    check('late element resolves', true, `waited ${(took / 1000).toFixed(1)}s`);
    // 7.5s, not 8s: the element appears at 8000ms and is picked up on the next
    // 100ms poll, so the elapsed time can land just under the due time.
    check('it really waited', took >= 7500, `waited ${(took / 1000).toFixed(1)}s for an element due at 8s`);
  } catch (err) {
    check('late element resolves', false, err.message);
  }
}

// ---- each locator is tried in turn, and a dead one is not waited on twice ----
{
  const step = {
    locator: css('#ready'),
    candidates: [css('#never-exists'), css('#ready')],
  };
  const started = Date.now();
  try {
    const r = await resolveCandidate(page, step, { action: (l) => l.click({ timeout: 5000 }) });
    const took = Date.now() - started;
    check('falls through to the next locator', r.locator.value === '#ready', `used ${r.locator.value}`);
    // The first rung is the one that gets patience, so a dead first rung is
    // waited out in full before its fallback is considered.
    check(
      'dead first rung got the full wait',
      took >= LOCATOR_WAIT_MS,
      `waited ${(took / 1000).toFixed(1)}s, need >= ${LOCATOR_WAIT_MS / 1000}s`,
    );
    // The reported time covers the dead rung too. Reporting only the winning
    // locator's own time would make a thirty-second wait look instantaneous.
    check(
      'reported time covers the whole ladder',
      r.waited >= LOCATOR_WAIT_MS / 1000,
      `reported ${r.waited}s`,
    );
  } catch (err) {
    check('falls through to the next locator', false, err.message);
  }
}

// ---- a fallback rung is probed, not waited on as if it were the primary ----
//
// This is what stops a six-rung step from costing its length times thirty
// seconds. The primary still gets the full wait, so a cold page is still waited
// for; a rung that only exists to catch a renamed element is not. With every
// rung given the full wait this step would take 90s and end up at the same
// place.
{
  const step = {
    locator: css('#never-exists-either'),
    candidates: [css('#also-missing'), css('#ready')],
  };
  const started = Date.now();
  try {
    const r = await resolveCandidate(page, step, { action: (l) => l.click({ timeout: 5000 }) });
    const took = Date.now() - started;
    const ceiling = LOCATOR_WAIT_MS + FALLBACK_WAIT_MS * 1.5;
    check('a later rung can still win', r.locator.value === '#ready', `used ${r.locator.value}`);
    check(
      'the dead primary still got its full wait',
      took >= LOCATOR_WAIT_MS,
      `waited ${(took / 1000).toFixed(1)}s`,
    );
    check(
      'a dead fallback is probed rather than waited out',
      took < ceiling,
      `waited ${(took / 1000).toFixed(1)}s, full waits would be ${(3 * LOCATOR_WAIT_MS) / 1000}s`,
    );
  } catch (err) {
    check('a later rung can still win', false, err.message);
  }
}

// ---- a timeout is reported as a timeout, not as a failed action ----
{
  const step = { locator: css('#nope'), candidates: [css('#nope'), css('#also-nope')] };
  try {
    // A short wait stands in for the thirty-second default: what is under test
    // is how the failure is reported, not how long it takes to arrive.
    await resolveCandidate(page, step, { action: () => {}, timeout: 800 });
    check('all locators dead throws', false, 'resolved unexpectedly');
  } catch (err) {
    check('all locators dead throws', true);
    check('timeout is typed', err.code === 'locator-timeout', `code=${err.code}`);
    // 800ms for the first rung plus 800ms for the fallback: a caller-supplied
    // timeout shorter than the fallback budget caps it rather than raising it.
    check('timeout reports the wait', err.waitedMs === 1600, `waitedMs=${err.waitedMs}`);
    // The reported time is the one actually spent, so it has to be a real
    // duration and not a rounded-down zero.
    const spent = /no locator resolved after ([\d.]+)s/.exec(err.message);
    check(
      'failure says how long was spent',
      Boolean(spent) && Number(spent[1]) > 0,
      err.message.slice(0, 90),
    );
    check(
      'failure names every locator tried',
      /#nope/.test(err.message) && /#also-nope/.test(err.message),
    );
  }
}

// ---- an element that is there is found without spending the wait ----
{
  const step = { locator: css('#ready'), candidates: [css('#ready')] };
  const started = Date.now();
  try {
    await resolveCandidate(page, step, { action: (l) => l.click({ timeout: 5000 }) });
    const took = Date.now() - started;
    check(
      'a working locator is found immediately',
      took < 2000,
      `waited ${(took / 1000).toFixed(2)}s`,
    );
  } catch (err) {
    check('a working locator is found immediately', false, err.message);
  }
}

await browser.close();
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
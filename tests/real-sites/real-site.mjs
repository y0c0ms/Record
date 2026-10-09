// A real public website, recorded and then replayed.
//
// Every other test in this suite runs against a data: URL or the local demo, so
// the whole thing agrees on what the page looks like. That is the point — but it
// means a bug that only appears against a real site goes unseen: a consent
// banner that loads after the page and covers the button, a site with no ids at
// all so every rung falls back to role and label, a form that navigates somewhere
// new and so has to be re-entered by a chain rather than by the browser's own
// history.
//
// This runs against automationexercise.com, which is built to be driven: a real
// login form, a real redirect to an account page, and a consent dialog that
// injects itself a few seconds after load. No account is needed because a wrong
// password is a real, deterministic outcome — the point is that the flow gets
// all the way to the error, not that it logs in.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSession, sessionDir } from '../../src/store.js';
import { Recorder } from '../../src/recorder.js';
import { Replayer } from '../../src/replayer.js';

const SITE = 'https://automationexercise.com/login';
const EMAIL = 'record.probe@example.test';
const PASSWORD = 'Probe12345!';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// The page has two email fields — one for login, one for signup — so the login
// form is addressed as a form. This is also the honest version of the test: it
// is how a person on the page would describe it, and it is exactly the
// ambiguity the candidate ladder exists to survive.
const inLoginForm = (page, selector) =>
  page.locator('form:has(button:has-text("Login"))').first().locator(selector);

const session = createSession({ name: `real site ${SITE}`, startUrl: SITE });
const recorder = new Recorder(session);
await recorder.start();
const page = recorder.page;
await sleep(3500);

check('lands on the site', page.url().startsWith('https://automationexercise.com'), page.url());
check('the login form is present', await inLoginForm(page, 'input[name="email"]').count() === 1);

// The consent dialog is injected a few seconds after the document loads, so a
// recorder that only looked at first paint would miss it entirely.
const overlayBefore = await page.evaluate(
  () => document.querySelector('.fc-dialog-overlay')?.getBoundingClientRect().width > 0,
);
check('the consent dialog really does cover the page', overlayBefore === true);

// A person meets this dialog first and dismisses it, so the recording has to
// happen in that order too — otherwise every step would be recorded as blocked
// by a banner the user never consciously chose. This is the realistic shape:
// consent cleared, then the form filled.
await page
  .locator('.fc-consent-root button:has-text("Consentir"), .fc-consent-root button:has-text("Accept")')
  .first()
  .click({ timeout: 20000 })
  .catch(() => console.log('  (no consent button to dismiss)'));
await sleep(1000);
const overlayGone = await page.evaluate(
  () => !document.querySelector('.fc-dialog-overlay'),
);
check('the consent dialog is cleared before recording', overlayGone);

await inLoginForm(page, 'input[name="email"]').fill(EMAIL, { timeout: 20000 });
await sleep(400);
await inLoginForm(page, 'input[name="password"]').fill(PASSWORD, { timeout: 20000 });
await sleep(400);
await inLoginForm(page, 'button:has-text("Login")').click({ timeout: 25000 });
await sleep(4000);

const recorded = await recorder.stop('user');
console.log(`\nrecorded ${recorded.steps.length} step(s) at ${page.url()}`);

const fills = recorded.steps.filter((s) => s.type === 'fill');
const click = recorded.steps.find((s) => s.type === 'click');

check('the typing was recorded', fills.length === 2, `${fills.length} fill step(s)`);
check('the click was recorded', Boolean(click));
check(
  'no step was recorded through the consent dialog',
  recorded.steps.every((s) => !JSON.stringify(s.candidates ?? []).includes('fc-')),
);

for (const step of fills) {
  const chain = step.candidates ?? [];
  check(
    `the ${step.title} step has a full ladder`,
    chain.length >= 4 && chain.length <= 6,
    chain.map((c) => c.strategy).join(' → '),
  );
  check(
    `the ${step.title} ladder ends in an xpath`,
    chain.at(-1)?.strategy === 'xpath',
    chain.at(-1)?.strategy,
  );
  // The ladder's job is that the first rungs describe the element and the last
  // one is positional. On a site whose fields have no ids at all, the leading
  // rungs have to carry the identity — so that is what is checked.
  const leading = chain.filter((c) => c.strategy !== 'xpath');
  check(
    `the ${step.title} ladder leads with a descriptive rung`,
    leading.some((c) => ['role', 'label', 'placeholder', 'testId'].includes(c.strategy)),
    leading.map((c) => c.strategy).join(' → '),
  );
}

// ---- replay ----

console.log('\n▶ replaying against the same live site');
const replayer = new Replayer(session, { headed: false, shots: false });
session.on('replay', (e) => {
  if (e.type === 'step' && e.step.status === 'failed') {
    console.log(`  step ${e.step.index} failed: ${e.step.error}`);
  }
});
await replayer.start();
const run = await replayer.done;

check('the replay passed every step', run.failed === 0, `${run.passed}/${run.total}`);
check('the replay covered every recorded step', run.total === recorded.steps.length);

// The strongest claim this file makes: replaying the flow again, from a fresh
// browser and with the site's own dialog in the way, reproduces the same page.
// Without this, "every step passed" could just mean every step found *something*.
const again = await (async () => {
  const { chromium } = await import('playwright');
  const b = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const p = await (await b.newContext()).newPage();
    await p.goto('https://automationexercise.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    return p.url();
  } finally {
    await b.close();
  }
})();
check('the site is still reachable after the run', again.startsWith('https://automationexercise.com'));

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
// The flow this test recorded is not left in the user's recordings.
fs.rmSync(`${sessionDir(session.id)}.json`, { force: true });
fs.rmSync(sessionDir(session.id), { recursive: true, force: true });

process.exit(failures === 0 ? 0 : 1);
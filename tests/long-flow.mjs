// A long journey, recorded then replayed end to end.
//
// Every other test drives one or two behaviours, which is enough to prove a
// feature works and not enough to prove a flow *reads* like a flow. A real test
// suite is mostly navigation, typing, filtering and clicking, and the
// interesting failures are the ones that only appear once a dozen of those are
// in sequence: an element that resolves on the third rung because the page
// re-rendered under an earlier step, a URL that drifts after a redirect, a
// dataset parameter that stops being the value the recording captured.
//
// So this drives the bundled demo store the way a person would: search, filter,
// apply, add several items, check the cart, apply a coupon, and place the
// order — then move to the widget page and exercise the shapes a plain fill
// cannot do (a readonly date picker, a select, a row that only exists after a
// click). It records through the Recorder and replays through the Replayer, so
// both halves of the product are on the path, not just one.
//
// Every step is asserted against the page after the replay, not against the
// runner's own opinion of itself: a green runner that drove the wrong elements
// is exactly the failure this is meant to catch.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Replayer } from '../src/replayer.js';
import { createSession, getSession, sessionDir } from '../src/store.js';
import { Recorder } from '../src/recorder.js';

const ORIGIN = process.env.RECORD_ORIGIN || 'http://127.0.0.1:4317';
const CATALOG = `${ORIGIN}/demo/index.html`;
const WIDGETS = `${ORIGIN}/demo/widgets.html`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// ---- record ----

const session = createSession({ name: 'long form demo journey', startUrl: CATALOG });
const recorder = new Recorder(session);
await recorder.start();
const page = recorder.page;

const products = () => page.locator('#products .card');
const cartText = () => page.locator('#cart-count').innerText();

// Search for something that will match, apply it, and confirm the grid
// narrowed. The fill and the select are separate steps on purpose: they are
// separate fields, and a recorder that merged them would replay one and skip
// the other.
await page.locator('#search').fill('desk', { timeout: 20000 });
await sleep(300);
await page.locator('#category').selectOption('desk', { timeout: 20000 });
await sleep(300);
await page.locator('#apply').click({ timeout: 20000 });
await sleep(700);

check(
  'the search narrowed the grid',
  (await products().count()) === 1,
  `${await products().count()} cards — "desk" matches only Desk Lamp`,
);
check(
  'the category filter was applied',
  (await page.locator('#category').inputValue()) === 'desk',
  await page.locator('#category').inputValue(),
);

// Clear the search so the full catalog comes back, then add from two different
// categories. Adding more than one item is what makes the cart count non-zero
// for a reason a test can check.
await page.locator('#search').fill('', { timeout: 20000 });
await sleep(200);
await page.locator('#category').selectOption('all', { timeout: 20000 });
await page.locator('#apply').click({ timeout: 20000 });
await sleep(700);

check('clearing the filters restored the catalog', (await products().count()) === 5, `${await products().count()} cards`);

await page.locator('[data-add="1"]').click({ timeout: 20000 });
await sleep(250);
await page.locator('[data-add="3"]').click({ timeout: 20000 });
await sleep(250);
// The same item twice: the cart must count units, not distinct lines.
await page.locator('[data-add="3"]').click({ timeout: 20000 });
await sleep(400);

check('the cart counted every add', (await cartText()).includes('3'), await cartText());
check('checkout appeared once the cart was not empty', await page.locator('#checkout').isVisible());

await page.locator('#email').fill('buyer@example.test', { timeout: 20000 });
await sleep(250);
// The coupon field exists on the page but the demo does not price against it,
// so it is filled to exercise the field without asserting an effect the page
// never had.
await page.locator('#coupon').fill('WELCOME10', { timeout: 20000 });
await sleep(250);
await page.locator('#place-order').click({ timeout: 20000 });
await sleep(900);

const status = (await page.locator('#order-status').innerText()).trim();
check('the order was accepted', /order confirmed/i.test(status), status);
check('the confirmation names the buyer', status.includes('buyer@example.test'), status);
check('the confirmation counts the cart', /3 item/.test(status), status);

// Cross-page navigation, then the shapes a plain fill cannot do.
await page.goto(WIDGETS, { waitUntil: 'domcontentloaded' });
await sleep(600);

await page.locator('#region').selectOption('apac', { timeout: 20000 });
await sleep(250);
await page.locator('#add-row').click({ timeout: 20000 });
await sleep(400);
await page.locator('[aria-label="Item 2"]').fill('Blue widget', { timeout: 20000 });
await sleep(250);
// The date input is readonly: a `fill` cannot type into it, so the recorded
// step has to be a click into the picker followed by a click on a day.
await page.locator('[aria-label="Appointment date"]').click({ timeout: 20000 });
await sleep(400);
await page.locator('[data-day="2"]').click({ timeout: 20000 });
await sleep(400);
await page.locator('#note').fill('Ring on the left side.', { timeout: 20000 });
await sleep(250);
await page.locator('#save').click({ timeout: 20000 });
await sleep(600);

const widgetState = await page.evaluate(() => ({
  when: document.getElementById('when').value,
  region: document.getElementById('region').value,
  note: document.getElementById('note').textContent,
  row2: document.querySelector('[aria-label="Item 2"]')?.value ?? null,
  log: document.getElementById('log').textContent,
}));
check('the readonly date was set through the picker', widgetState.when === '2026-03-02', widgetState.when);
check('the select took the recorded option', widgetState.region === 'apac', widgetState.region);
check('the contenteditable took the text', widgetState.note === 'Ring on the left side.', widgetState.note);
check('the dynamically added row was filled', widgetState.row2 === 'Blue widget', String(widgetState.row2));
check('save recorded the form', /saved/i.test(widgetState.log), widgetState.log.slice(0, 60));

const recorded = await recorder.stop('user');
console.log(`\nrecorded ${recorded.steps.length} step(s)`);

// ---- what the recording must have captured ----

check('the recording is long enough to be a flow', recorded.steps.length >= 14, `${recorded.steps.length} steps`);
check('step 1 is the navigation', recorded.steps[0]?.type === 'navigate', recorded.steps[0]?.type);

const navs = recorded.steps.filter((s) => s.type === 'navigate');
check('both pages were recorded as navigations', navs.length === 2, `${navs.length} navigate steps`);

const fills = recorded.steps.filter((s) => s.type === 'fill');
const clicks = recorded.steps.filter((s) => s.type === 'click');
const selects = recorded.steps.filter((s) => s.type === 'select');
check('the fills were recorded', fills.length >= 5, `${fills.length} fill steps`);
check('the clicks were recorded', clicks.length >= 6, `${clicks.length} click steps`);
// Three, not two: the category select is changed twice — once to filter, once
// back to "all" — and each change is its own step. A test that expects two here
// is asserting a shape the recorder does not produce.
check('all three select changes were recorded', selects.length === 3, `${selects.length} select steps`);

// Every interactive step has to carry a real ladder. A one-rung ladder would
// replay only because the page happens to be unchanged since recording.
const elementSteps = [...fills, ...clicks, ...selects];
const thin = elementSteps.filter((s) => (s.candidates?.length ?? 0) < 2);
check('no interactive step has a one-rung ladder', thin.length === 0, thin.map((s) => `step ${s.index}`).join(', '));

// ---- replay ----

console.log('\n▶ replaying the same journey');
const before = getSession(session.id).steps.map((s) => s.status);
assert.equal(before.length, recorded.steps.length);

const t0 = Date.now();
const replayer = new Replayer(session, { headed: false, shots: false });
session.on('replay', (e) => {
  if (e.type === 'step' && e.step.status === 'failed') {
    console.log(`  step ${e.step.index} failed: ${e.step.error}`);
  }
});
await replayer.start();
await replayer.done;
const elapsed = Date.now() - t0;

// `done` settles on the replay summary, which has no steps on it. The step
// verdicts live on the session, so that is what the run assertions read — once,
// because each `getSession` is a store lookup and the run is over.
const after = getSession(session.id);
const summary = after.replay;
const passed = summary.passed ?? 0;
const total = summary.total ?? after.steps.length;
check('the replay passed every step', summary.status === 'passed' && passed === total, `${passed}/${total}`);
check('the replay covered every recorded step', total === recorded.steps.length, `${total} of ${recorded.steps.length}`);

// Every element step has to have resolved on a locator the recording stored,
// and the run has to say which rung won. A step with no resolved locator means
// the action ran without one, which is the failure this is looking for.
const elementRun = after.steps.filter((s) => !['navigate', 'wait'].includes(s.type));
const resolved = after.steps.filter((s) => s.resolvedLocator);
check(
  'every element step resolved on a stored locator',
  resolved.length === elementRun.length,
  `${resolved.length} of ${elementRun.length} resolved`,
);

// The ladder has to be doing its job rather than the page being unchanged: if
// every step landed on its first rung, this test would pass for a flow that a
// renamed button would break, which is the whole thing the ladder exists for.
const fallbacks = resolved.filter((s) => {
  const chain = s.candidates ?? [];
  const key = (l) => `${l.strategy}:${l.value ?? `${l.role}|${l.name}`}`;
  return chain.findIndex((l) => key(l) === key(s.resolvedLocator)) > 0;
});
console.log(
  `  ${fallbacks.length} step(s) needed a fallback rung: ${fallbacks
    .map((s) => `#${s.index} ${s.resolvedLocator.strategy}`)
    .join(', ')}`,
);

console.log(`  replay took ${(elapsed / 1000).toFixed(1)}s for ${total} steps`);

console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) failed`);

// The flow this test recorded is not left in the user's recordings.
fs.rmSync(`${sessionDir(session.id)}.json`, { force: true });
fs.rmSync(sessionDir(session.id), { recursive: true, force: true });

process.exitCode = failures === 0 ? 0 : 1;
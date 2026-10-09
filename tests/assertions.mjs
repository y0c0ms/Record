// Checks (assertion steps), end to end: recorded from the badge, replayed, and
// exported as a spec that Playwright itself runs.
//
// The point of a check is that a run fails when the page is wrong. So the same
// recording is replayed twice: against the page as recorded, where every check
// must pass, and against `?wrong`, where the page says something else and the
// checks must fail — with `assertion-failed`, not a missing element, and a
// message that says what the page showed instead.
//
// Needs the sidecar on 4317 (it serves demo/checks.html).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSession, sessionDir, GENERATED_DIR } from '../src/store.js';
import { Recorder } from '../src/recorder.js';
import { Replayer } from '../src/replayer.js';
import { generateSpec } from '../src/codegen.js';
import { assertionProblem } from '../src/assertions.js';

const BASE = 'http://127.0.0.1:4317/demo/checks.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// ---- record, through the real badge -------------------------------------
const session = createSession({ name: 'checks demo', startUrl: BASE });
const recorder = new Recorder(session);
await recorder.start();
const page = recorder.page;
await page.waitForSelector('#__record_badge__');

// The badge's controls only show while the pointer is over its corner, as
const badgeButton = async (text) => {
  const b = page.locator('#__record_badge__ button', { hasText: text });
  if (!(await b.isVisible())) await page.hover('#__record_pad__', { position: { x: 5, y: 5 } });
  await b.waitFor({ state: 'visible', timeout: 5000 });
  return b;
};
const pick = async (selector) => {
  await (await badgeButton('Check')).click();
  await page.locator(selector).click();
  await sleep(400);
};

await page.fill('#name', 'Ada');
await page.click('#terms');
await page.click('#place');
await page.waitForSelector('#result:not([hidden])');
await sleep(300);

// The press that picks an element must not act on it: picking the checkbox
// would otherwise untick it.
await pick('#result');
await pick('#name');
await pick('#terms');
check('picking an element does not act on it', await page.isChecked('#terms'));
await (await badgeButton('URL')).click();
await sleep(400);

const recorded = await recorder.stop('user');
const types = recorded.steps.map((s) => s.type);
console.log(`recorded: ${types.join(', ')}`);
const step = (type) => session.steps.find((s) => s.type === type);
check('a text check was recorded from the badge', step('assertText')?.value?.startsWith('Thank you Ada'), step('assertText')?.value);
check('a field check recorded the value as an exact match', step('assertValue')?.value === 'Ada' && step('assertValue')?.match === 'equals');
check('a checkbox check recorded its state', step('assertChecked')?.value === 'checked');
check('a URL check recorded the address', step('assertUrl')?.value === `${BASE}#done`, step('assertUrl')?.value);
check('no click was recorded for the picks', types.filter((t) => t === 'click').length === 2, types.join(','));

// The click also recorded the page's own hash change as a navigation the next
// step waits for. On the wrong page that wait fails first and stops the run
// before any check is reached — correct, but it would test navigation rather
// than checks. The URL check makes the same claim, so the wait is dropped.
session.steps = session.steps.filter((s) => !(s.type === 'navigate' && s.caused));

// Two checks the badge cannot pick, added the way the editor adds them.
const at = session.steps.indexOf(step('assertUrl'));
session.steps.splice(
  at,
  0,
  { type: 'assertCount', locator: { strategy: 'css', value: 'li.item' }, candidates: [{ strategy: 'css', value: 'li.item' }], value: '3', label: 'items' },
  { type: 'assertHidden', locator: { strategy: 'css', value: '#spinner' }, candidates: [{ strategy: 'css', value: '#spinner' }], label: 'spinner' },
);
session.steps.forEach((s, n) => (s.index = n + 1));

// ---- replay as recorded: every check holds --------------------------------
// The flow opens on its first navigate step, so that is where the page under
// test is swapped. Steps are replaced wholesale by `alone` below, so the step
// is looked up each time rather than held.
const start = () => session.steps.find((s) => s.type === 'navigate' && !s.caused);
const replay = async (url) => {
  start().url = url;
  const r = new Replayer(session, { headed: false, shots: false, timeout: 3000, locatorWait: 5000 });
  await r.start();
  return r.done;
};

let run = await replay(BASE);
check('replay of the page as recorded passes every check', run.failed === 0, `${run.passed}/${run.total}`);
for (const s of session.steps.filter((s) => s.status === 'failed')) console.log(`   step ${s.index} ${s.type}: ${s.error}`);

// ---- replay against a page that is wrong: the checks catch it --------------
// A failed check stops the run, as a failed `expect` does, so each check is
// tried on its own: the recorded actions, then that one check.
const actions = session.steps.filter((s) => !s.type.startsWith('assert'));
const alone = async (type) => {
  const all = session.steps;
  session.steps = [...actions, all.find((s) => s.type === type)].map((s, n) => ({ ...s, index: n + 1 }));
  await replay(`${BASE}?wrong`);
  const s = session.steps.at(-1);
  session.steps = all;
  return s;
};
const wrong = {};
for (const type of ['assertText', 'assertCount', 'assertHidden', 'assertUrl', 'assertValue', 'assertChecked']) {
  wrong[type] = await alone(type);
}
for (const type of ['assertText', 'assertCount', 'assertHidden', 'assertUrl']) {
  const s = wrong[type];
  check(`${type} fails when the page is wrong`, s.status === 'failed' && s.failureKind === 'assertion-failed', `${s.status} ${s.failureKind}: ${s.error}`);
}
check('the text failure says what the page showed', /was "Order failed for Ada"/.test(wrong.assertText.error || ''), wrong.assertText.error);
check('the count failure says how many there were', /found 2/.test(wrong.assertCount.error || ''), wrong.assertCount.error);
check('checks the wrong page still satisfies pass', wrong.assertValue.status === 'passed' && wrong.assertChecked.status === 'passed');

// ---- the editor refuses checks that can never mean anything ----------------
check('an empty text check is refused', assertionProblem('assertText', '', 'contains') !== null);
check('a broken regex is refused', /regular expression/.test(assertionProblem('assertText', '(', 'regex') || ''));
check('a non-numeric count is refused', assertionProblem('assertCount', 'three') !== null);
check('a sound check is accepted', assertionProblem('assertText', 'Thank you', 'equals') === null);

// ---- the exported spec runs under Playwright and agrees --------------------
start().url = BASE;
const dir = fs.mkdtempSync(path.join(GENERATED_DIR, 'checks-'));
// Forward slashes: Playwright reads the argument as a pattern, and a
// backslash in it is an escape.
const specFile = path.join(dir, 'checks.spec.mjs').replace(/\\/g, '/');
fs.writeFileSync(specFile, generateSpec(session));
const runSpec = () =>
  spawnSync('npx', ['playwright', 'test', specFile, '--reporter=line', '--workers=1'], { shell: true, encoding: 'utf8' });
let out = runSpec();
check('the exported spec passes against the page as recorded', out.status === 0, (out.stdout + out.stderr).split('\n').filter((l) => /passed|failed|Error/.test(l)).slice(0, 3).join(' | '));

start().url = `${BASE}?wrong`;
fs.writeFileSync(specFile, generateSpec(session));
out = runSpec();
check('the exported spec fails against the wrong page', out.status !== 0 && /toContainText|toHaveURL|toHaveCount|Expected/.test(out.stdout + out.stderr));
fs.rmSync(dir, { recursive: true, force: true });

// The test's flow is not left behind in the user's recordings.
fs.rmSync(`${sessionDir(session.id)}.json`, { force: true });
fs.rmSync(sessionDir(session.id), { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

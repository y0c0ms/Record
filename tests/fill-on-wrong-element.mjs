// A fill step whose target is not a text field.
//
// This happens two ways: a click recorded as a fill (the recorder or the
// editor picked the wrong action), or a step whose target was re-pointed at a
// button or a div. Before the guard, the scripted fallback threw a raw
// `Illegal invocation` from the native value setter — a page error that said
// nothing about the step. Now the step fails as a wrong target, and the
// message names the element.
//
// The positive halves matter too: a readonly date input (the reason the
// fallback exists) and a contenteditable block must still be filled by the
// same path, so the guard is checked against the page, not against a
// hard-coded element list.
//
// Run: node tests/fill-on-wrong-element.mjs

import { chromium } from 'playwright';
import { EventEmitter } from 'node:events';
import { Replayer } from '../src/replayer.js';

const PAGE = `data:text/html,
  <html><body>
    <button id="btn" type="button" aria-label="Add Trail Backpack to cart">Add to cart</button>
    <div id="box" role="button" tabindex="0">Not a field</div>
    <input id="date" type="date" readonly value="2026-01-01" />
    <div id="rich" contenteditable="true">old</div>
    <input id="plain" type="text" />
  </body></html>`;

function makeSession(steps) {
  const s = new EventEmitter();
  s.id = 'fillwrong';
  s.name = 'fillwrong';
  s.channel = 'msedge';
  s.steps = steps;
  s.replay = { status: 'idle', current: null, passed: 0, failed: 0 };
  s.params = () => [];
  s.persist = () => {};
  s.publicView = () => ({ id: s.id, name: s.name, steps: s.steps, replay: s.replay });
  return s;
}

const role = (role_, name) => [{ strategy: 'role', role: role_, name }];
const css = (v) => [{ strategy: 'css', value: v }];

const context = await chromium.launchPersistentContext('', {
  channel: 'msedge',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await context.pages()[0] || (await context.newPage());
await page.goto(PAGE, { waitUntil: 'domcontentloaded' });

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// A fill step aimed at a non-field element: the guard must turn the raw page
// error into a message that names the element and says the target is wrong.
const fillAt = async (candidates, value = 'x') => {
  const step = { index: 1, type: 'fill', locator: candidates[0], candidates, value };
  const r = new Replayer(makeSession([step]), { headed: false, shots: false, timeout: 3000, locatorWait: 3000 });
  r.page = page;
  r.context = context;
  r.runId = 'fillwrong';
  try {
    await r.execute(step);
    return { error: null, status: 'passed' };
  } catch (err) {
    return { error: String((err && err.message) || err), status: 'failed' };
  }
};

// ---- a fill on a button says what the element is ----------------------------
let res = await fillAt(role('button', 'Add Trail Backpack to cart'));
check(
  'a fill on a button fails, not passes',
  res.status === 'failed',
  res.status
);
check(
  'the failure names the element',
  /button/.test(res.error || ''),
  res.error
);
check(
  'the failure says the target is not a text field',
  /not a text field|re-point|change the step/.test(res.error || ''),
  res.error
);
check(
  'the failure is not a raw Illegal invocation',
  !/Illegal invocation/.test(res.error || ''),
  res.error
);

// ---- a fill on a div fails the same way -------------------------------------
res = await fillAt(css('#box'));
check(
  'a fill on a div fails',
  res.status === 'failed',
  res.status
);
check(
  'the div failure names the element',
  /div/.test(res.error || ''),
  res.error
);

// ---- a readonly date input still takes a value (the fallback's reason) ------
const dateStep = { index: 1, type: 'fill', locator: css('#date')[0], candidates: css('#date'), value: '2026-02-03' };
{
  const r = new Replayer(makeSession([dateStep]), { headed: false, shots: false, timeout: 3000, locatorWait: 3000 });
  r.page = page;
  r.context = context;
  r.runId = 'fillwrong';
  let err = null;
  try {
    await r.execute(dateStep);
  } catch (e) {
    err = String((e && e.message) || e);
  }
  const v = await page.inputValue('#date');
  check('a readonly date input is still filled', err === null && v === '2026-02-03', `value=${v} err=${err}`);
}

// ---- a contenteditable block still takes a value ----------------------------
const richStep = { index: 1, type: 'fill', locator: css('#rich')[0], candidates: css('#rich'), value: 'new text' };
{
  const r = new Replayer(makeSession([richStep]), { headed: false, shots: false, timeout: 3000, locatorWait: 3000 });
  r.page = page;
  r.context = context;
  r.runId = 'fillwrong';
  let err = null;
  try {
    await r.execute(richStep);
  } catch (e) {
    err = String((e && e.message) || e);
  }
  const v = await page.textContent('#rich');
  check('a contenteditable block is still filled', err === null && v === 'new text', `text=${v} err=${err}`);
}

// ---- a plain input still takes a value --------------------------------------
const plainStep = { index: 1, type: 'fill', locator: css('#plain')[0], candidates: css('#plain'), value: 'hello' };
{
  const r = new Replayer(makeSession([plainStep]), { headed: false, shots: false, timeout: 3000, locatorWait: 3000 });
  r.page = page;
  r.context = context;
  r.runId = 'fillwrong';
  let err = null;
  try {
    await r.execute(plainStep);
  } catch (e) {
    err = String((e && e.message) || e);
  }
  const v = await page.inputValue('#plain');
  check('a plain input is still filled', err === null && v === 'hello', `value=${v} err=${err}`);
}

await context.close().catch(() => {});
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;

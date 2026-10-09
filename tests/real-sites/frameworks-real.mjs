// The same user journey recorded and replayed on real public apps built with
// different front-end frameworks.
//
// TodoMVC (todomvc.com) publishes one app implemented in each framework, for
// exactly this kind of comparison; it is static, needs no account and its
// state lives in the browser's own localStorage, so nothing is written to
// anyone's server. That makes framework the only variable:
//
//   React, Vue, Angular, Svelte — virtual-DOM / compiled renders, re-created nodes
//   Lit                         — web components, every control inside shadow roots
//   jQuery                      — hand-written DOM, ids on everything
//
// Swag Labs (saucedemo.com, robots.txt `Disallow:` nothing) adds a React app
// with a real login, data-test attributes and client-side routing.
//
// The journey: add two todos, complete one, filter to Active, and check what
// the app itself shows. A replay that "passes" without the app ending in the
// recorded state is a failure here.

import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createSession, sessionDir } from '../../src/store.js';
import { Recorder } from '../../src/recorder.js';
import { Replayer } from '../../src/replayer.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = process.argv.slice(2);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const TODO = {
  react: 'https://todomvc.com/examples/react/dist/',
  vue: 'https://todomvc.com/examples/vue/dist/',
  angular: 'https://todomvc.com/examples/angular/dist/browser/',
  svelte: 'https://todomvc.com/examples/svelte/dist/',
  lit: 'https://todomvc.com/examples/lit/dist/',
  jquery: 'https://todomvc.com/examples/jquery/dist/',
};

// Playwright's CSS engine pierces open shadow roots, so one set of selectors
// drives every implementation — including Lit, where each of these is inside a
// component's shadow root. That is how a person's script would do it too; the
// point is whether *Record's* recording of it replays.
async function todoJourney(page) {
  const input = page.locator('input.new-todo');
  await input.click();
  await input.pressSequentially('Buy milk', { delay: 30 });
  await input.press('Enter');
  await sleep(400);
  await input.pressSequentially('Write report', { delay: 30 });
  await input.press('Enter');
  await sleep(500);
  // Complete the first one.
  await page.locator('.todo-list li, todo-item').first().locator('input.toggle').click();
  await sleep(500);
  // Filter to Active.
  await page.locator('a[href$="#/active"]').first().click();
  await sleep(700);
}

// What the app shows: the visible todo titles, and its own "items left" count.
async function todoState(page) {
  return page.evaluate(() => {
    const deep = (root, sel, acc = []) => {
      acc.push(...root.querySelectorAll(sel));
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(el.shadowRoot, sel, acc);
      return acc;
    };
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const titles = deep(document, 'li label, .todo-list label, label[data-testid="todo-item-label"]')
      .filter(visible)
      .map((l) => l.textContent.trim())
      .filter(Boolean);
    const count = deep(document, '.todo-count').map((e) => e.textContent.replace(/\s+/g, ' ').trim())[0] || '';
    return { titles: [...new Set(titles)], count, hash: location.hash };
  });
}

// Every recording made here, removed at the end: they are test artefacts, not
// flows the user made, and would otherwise pile up in the flow list.
const made = [];

async function record(name, url, journey) {
  const session = createSession({ name: `framework ${name}`, startUrl: url });
  made.push(session.id);
  const recorder = new Recorder(session);
  await recorder.start();
  await recorder.page.waitForLoadState('domcontentloaded');
  await sleep(2500);
  await journey(recorder.page);
  return { session, recorder };
}

async function replayAndRead(session, read) {
  // A scratch session, never registered or written, so the replay adds no
  // flow to the user's list.
  const copy = Object.assign(new EventEmitter(), {
    id: `${session.id}-replay`,
    name: `${session.name} replay`,
    channel: session.channel,
    startUrl: session.startUrl,
    steps: JSON.parse(JSON.stringify(session.steps)),
    runs: [],
    persist() {},
  });
  // Read from the app after each step, before the next one runs; the last
  // read is the state the replay left it in.
  let last = null;
  const afterStep = async () => {
    last = await read(r.pages[0]).catch(() => last);
  };
  const r = new Replayer(copy, { headed: false, shots: false, locatorWait: 15000, afterStep });
  await r.start();
  await r.done.catch(() => {});
  return { steps: copy.steps, state: last };
}

const ladderSummary = (steps) =>
  steps
    .filter((s) => s.resolvedLocator)
    .map((s) => s.resolvedLocator.strategy)
    .reduce((m, k) => ({ ...m, [k]: (m[k] || 0) + 1 }), {});

for (const [name, url] of Object.entries(TODO)) {
  if (only.length && !only.includes(name)) continue;
  console.log(`\n--- TodoMVC ${name} ---`);
  let recorded;
  try {
    const { session, recorder } = await record(name, url, todoJourney);
    const expected = await todoState(recorder.page);
    recorded = await recorder.stop('user');
    console.log(`recorded ${recorded.steps.length} steps: ${recorded.steps.map((s) => s.type).join(' ')}`);
    console.log(`app after recording: ${JSON.stringify(expected)}`);
    check(`${name}: the recording itself reached the expected state`,
      expected.titles.join('|') === 'Write report' && /1 item/.test(expected.count), JSON.stringify(expected));
    const run = await replayAndRead(session, todoState);
    const failed = run.steps.filter((s) => s.status === 'failed');
    console.log(`resolved by: ${JSON.stringify(ladderSummary(run.steps))}`);
    check(`${name}: every step passes on replay`, failed.length === 0,
      failed.map((s) => `${s.index} ${s.type} "${s.title}": ${s.error}`).join(' | '));
    check(`${name}: the replayed app shows the same todos`, JSON.stringify(run.state && run.state.titles) === JSON.stringify(expected.titles),
      JSON.stringify(run.state));
    check(`${name}: and the same item count and filter`, run.state && run.state.count === expected.count && run.state.hash === expected.hash,
      JSON.stringify(run.state));
  } catch (err) {
    check(`${name}: journey ran`, false, String(err.message).split('\n')[0]);
  }
}

// ---- Swag Labs: login, add to cart, cart badge ---------------------------------
if (!only.length || only.includes('saucedemo')) {
  console.log('\n--- Swag Labs (React) ---');
  try {
    const { session, recorder } = await record('saucedemo', 'https://www.saucedemo.com/', async (page) => {
      await page.fill('#user-name', 'standard_user');
      await page.fill('#password', 'secret_sauce');
      await page.click('#login-button');
      await page.waitForURL(/inventory/, { timeout: 15000 });
      await sleep(800);
      await page.click('[data-test="add-to-cart-sauce-labs-backpack"]');
      await sleep(400);
      await page.click('[data-test="add-to-cart-sauce-labs-bike-light"]');
      await sleep(400);
      await page.click('.shopping_cart_link');
      await sleep(1000);
    });
    const read = (page) =>
      page.evaluate(() => ({
        url: location.pathname,
        badge: document.querySelector('.shopping_cart_badge')?.textContent || '',
        items: Array.from(document.querySelectorAll('.inventory_item_name')).map((e) => e.textContent.trim()),
      }));
    const expected = await read(recorder.page);
    const recorded = await recorder.stop('user');
    console.log(`recorded ${recorded.steps.length} steps: ${recorded.steps.map((s) => s.type).join(' ')}`);
    check('saucedemo: password stored as a secret, not as typed', recorded.steps.some((s) => s.secret) &&
      !JSON.stringify(recorded.steps).includes('secret_sauce'));
    const run = await replayAndRead(session, read);
    const failed = run.steps.filter((s) => s.status === 'failed');
    console.log(`resolved by: ${JSON.stringify(ladderSummary(run.steps))}`);
    check('saucedemo: every step passes on replay', failed.length === 0,
      failed.map((s) => `${s.index} ${s.type} "${s.title}": ${s.error}`).join(' | '));
    check('saucedemo: replay logs in and the cart holds the same two items',
      run.state && run.state.url === expected.url && run.state.badge === '2' &&
      JSON.stringify(run.state.items) === JSON.stringify(expected.items), JSON.stringify(run.state));
  } catch (err) {
    check('saucedemo: journey ran', false, String(err.message).split('\n')[0]);
  }
}

for (const id of made) {
  fs.rmSync(`${sessionDir(id)}.json`, { force: true });
  fs.rmSync(sessionDir(id), { recursive: true, force: true });
}
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

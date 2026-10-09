// Form controls recorded and replayed on a real public site, each checked by
// what the site shows afterwards.
//
// practice.expandtesting.com (robots.txt `Allow: /`; the disallowed paths are
// APIs, downloads and auth endpoints, none used here) is built for automation
// practice. These are the controls a business form is made of, and the ways
// a page makes them hard to replay:
//
//   /inputs           number, text, password, date — echoed back on "Display"
//   /dropdown         native <select>
//   /checkboxes       checkbox state
//   /radio-buttons    radio groups
//   /form-validation  required fields, date, select and a submit that navigates
//   /dynamic-id       a button whose id is regenerated on every load
//   /dynamic-controls a field that is disabled until an async "Enable" finishes
//   /shadowdom        a button inside a shadow root

import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createSession, sessionDir } from '../../src/store.js';
import { Recorder } from '../../src/recorder.js';
import { Replayer } from '../../src/replayer.js';

const SITE = 'https://practice.expandtesting.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function clearConsent(page) {
  await page
    .locator('.fc-consent-root button.fc-cta-consent, .fc-consent-root button:has-text("Consent"), .fc-consent-root button:has-text("Consentir")')
    .first()
    .click({ timeout: 5000 })
    .catch(() => {});
}
async function go(page, route) {
  await page.goto(`${SITE}${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1200);
  await clearConsent(page);
}

// What the site shows after the whole journey, read on the page the journey
// ends on plus whatever earlier checkpoints were captured along the way.
const marks = {};
async function checkpoint(page, name) {
  const path = new URL(page.url()).pathname;
  const read = {
    '/inputs': () =>
      page.evaluate(() => ({
        number: document.querySelector('#output-number')?.textContent.trim(),
        text: document.querySelector('#output-text')?.textContent.trim(),
        password: document.querySelector('#output-password')?.textContent.trim(),
        date: document.querySelector('#output-date')?.textContent.trim(),
      })),
    '/dropdown': () => page.evaluate(() => ({ dropdown: document.querySelector('#dropdown').value, country: document.querySelector('#country').value })),
    '/checkboxes': () => page.evaluate(() => ({ c1: document.querySelector('#checkbox1').checked, c2: document.querySelector('#checkbox2').checked })),
    '/radio-buttons': () =>
      page.evaluate(() => ({
        color: document.querySelector('input[name=color]:checked')?.id,
        sport: document.querySelector('input[name=sport]:checked')?.id,
      })),
    '/form-confirmation': () => page.evaluate(() => ({ confirmed: /Thank you for validating your ticket/i.test(document.body.innerText) })),
    '/dynamic-id': () => page.evaluate(() => ({ clicked: document.querySelector('[id]:is(button)')?.id || '' })),
    '/dynamic-controls': () =>
      page.evaluate(() => ({ enabled: !document.querySelector('#input-example input')?.disabled, value: document.querySelector('#input-example input')?.value })),
    '/shadowdom': () => page.evaluate(() => ({ title: document.title })),
  }[path];
  if (read) marks[name] = await read().catch((e) => ({ error: String(e.message).slice(0, 80) }));
}

// ---- record ------------------------------------------------------------------
const session = createSession({ name: 'real: form controls', startUrl: `${SITE}/inputs` });
const recorder = new Recorder(session);
await recorder.start();
const page = recorder.page;
await page.waitForSelector('#input-number', { timeout: 30000 });
await sleep(1500);
await clearConsent(page);

// /inputs: four input types, then Display.
await page.fill('#input-number', '42');
await page.fill('#input-text', 'Record');
await page.fill('#input-password', 'Pa55word!');
await page.fill('#input-date', '2026-10-08');
await page.click('#btn-display-inputs');
await sleep(800);
await checkpoint(page, 'inputs');

// /dropdown: two native selects.
await go(page, '/dropdown');
await page.selectOption('#dropdown', '2');
await page.selectOption('#country', 'PT');
await sleep(400);
await checkpoint(page, 'dropdown');

// /checkboxes: tick the first, untick the second (checked by default).
await go(page, '/checkboxes');
await page.click('#checkbox1');
await page.click('#checkbox2');
await sleep(400);
await checkpoint(page, 'checkboxes');

// /radio-buttons
await go(page, '/radio-buttons');
await page.click('#red');
await page.click('#tennis');
await sleep(400);
await checkpoint(page, 'radios');

// /dynamic-id: the id changes on every load, so only the text can find it.
await go(page, '/dynamic-id');
await page.getByRole('button', { name: /Button with Dynamic ID/i }).click();
await sleep(400);

// /dynamic-controls: Enable, wait for it, type.
await go(page, '/dynamic-controls');
await page.getByRole('button', { name: 'Enable' }).click();
await page.locator('#input-example input:enabled').waitFor({ timeout: 15000 });
await page.fill('#input-example input', 'now enabled');
await sleep(400);
await checkpoint(page, 'dynamic');

// /shadowdom: a button inside a shadow root.
await go(page, '/shadowdom');
await page.locator('#shadow-host').locator('button').click().catch(async () => {
  await page.locator('button:has-text("inside a Shadow DOM")').click();
});
await sleep(400);

// /form-validation: fill and submit; the site navigates to a confirmation page.
await go(page, '/form-validation');
await page.fill('#validationCustom01', 'Ana Silva');
await page.fill('#validationCustom05[name=contactnumber]', '012-3456789');
await page.fill('input[name=pickupdate]', '2026-12-01');
await page.selectOption('#validationCustom04', { label: 'card' });
await page.click('button[type=submit]');
await page.waitForURL(/form-confirmation/, { timeout: 15000 }).catch(() => {});
await sleep(1000);
await checkpoint(page, 'submitted');

const recordedMarks = JSON.parse(JSON.stringify(marks));
const recorded = await recorder.stop('user');
console.log(`recorded ${recorded.steps.length} steps: ${recorded.steps.map((s) => s.type + (s.caused ? '*' : '')).join(' ')}`);
console.log('recording reached', JSON.stringify(recordedMarks));
check('recording: the site confirmed the submitted form', recordedMarks.submitted && recordedMarks.submitted.confirmed);

const dyn = recorded.steps.find((s) => s.type === 'click' && /dynamic id/i.test(s.label || s.title || ''));
check('the dynamic-id button is recorded without its throwaway id as the primary locator',
  dyn && !(dyn.candidates[0].strategy === 'css' && /#[0-9a-f]{8}-/.test(dyn.candidates[0].value)),
  dyn && JSON.stringify(dyn.candidates[0]));

// ---- replay ------------------------------------------------------------------
for (const k of Object.keys(marks)) delete marks[k];
const copy = Object.assign(new EventEmitter(), {
  id: session.id,
  name: 'controls replay',
  channel: session.channel,
  startUrl: session.startUrl,
  steps: JSON.parse(JSON.stringify(session.steps)),
  runs: [],
  persist() {},
});
// Read each page's state after the last step that acted on it, while it is
// still open.
const r = new Replayer(copy, {
  headed: false,
  shots: false,
  locatorWait: 15000,
  afterStep: async (step, p) => {
    const path = new URL(p.url()).pathname;
    const name = { '/inputs': 'inputs', '/dropdown': 'dropdown', '/checkboxes': 'checkboxes', '/radio-buttons': 'radios', '/dynamic-controls': 'dynamic', '/form-confirmation': 'submitted' }[path];
    if (name) await checkpoint(p, name);
  },
});
await r.start();
await r.done.catch(() => {});
console.log('replay reached', JSON.stringify(marks));

const failed = copy.steps.filter((s) => s.status === 'failed');
check('every step passes on replay', failed.length === 0, failed.map((s) => `${s.index} ${s.type} "${s.title}": ${s.error}`).join(' | '));
for (const name of ['inputs', 'dropdown', 'checkboxes', 'radios', 'dynamic', 'submitted']) {
  check(`replay leaves ${name} as the recording did`, JSON.stringify(marks[name]) === JSON.stringify(recordedMarks[name]),
    `${JSON.stringify(marks[name])} vs ${JSON.stringify(recordedMarks[name])}`);
}
check('the password field replays the real value, not the mask', marks.inputs && marks.inputs.password === 'Pa55word!', marks.inputs && marks.inputs.password);

fs.rmSync(`${sessionDir(session.id)}.json`, { force: true });
fs.rmSync(sessionDir(session.id), { recursive: true, force: true });
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

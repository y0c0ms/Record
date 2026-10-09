// Throwaway probe: drives the real Replayer's step execution over the widget
// page to check the shapes that naive replay gets wrong — a readonly date-picker
// input, a select, a contenteditable, and a row that only exists after a click.
//
// The page is opened here rather than through `start()`, because `run()` closes
// the context the moment it returns, which leaves no point at which the result
// can be read back out. Everything below the launch — locator resolution, the
// fill path, the overlay dismissal — is the runner's own code.
import fs from 'node:fs';
import { chromium } from 'playwright';
import { EventEmitter } from 'node:events';
import { Replayer } from '../src/replayer.js';

const BASE = 'http://127.0.0.1:4317/demo/widgets.html';

function makeSession(steps) {
  const s = new EventEmitter();
  s.id = 'probe';
  s.name = 'probe';
  s.channel = 'msedge';
  s.steps = steps;
  s.replay = { status: 'idle', current: null, passed: 0, failed: 0, steps: {}, dataset: null };
  s.params = () => [];
  s.persist = () => {};
  s.publicView = () => ({ id: s.id, name: s.name, steps: s.steps, replay: s.replay });
  return s;
}

const nav = { index: 1, type: 'navigate', url: BASE };
// Steps carry their locator chain in `candidates`, as the recorder writes them.
const css = (v) => [{ strategy: 'css', value: v }];

const cases = [
  {
    name: 'date picker via click',
    steps: [
      nav,
      { index: 2, type: 'click', candidates: css('[aria-label="Appointment date"]') },
      { index: 3, type: 'click', candidates: css('[data-day="2"]') },
    ],
    read: 'document.getElementById("when").value',
    expect: '2026-03-02',
  },
  {
    name: 'fill readonly date input',
    steps: [nav, { index: 2, type: 'fill', value: '2026-03-02', candidates: css('#when') }],
    read: 'document.getElementById("when").value',
    expect: '2026-03-02',
  },
  {
    name: 'select option',
    steps: [nav, { index: 2, type: 'select', value: 'apac', candidates: css('#region') }],
    read: 'document.getElementById("region").value',
    expect: 'apac',
  },
  {
    name: 'fill contenteditable',
    steps: [nav, { index: 2, type: 'fill', value: 'bring the blue one', candidates: css('#note') }],
    read: 'document.getElementById("note").textContent',
    expect: 'bring the blue one',
  },
  {
    name: 'fill dynamically added row',
    steps: [
      nav,
      { index: 2, type: 'click', candidates: css('#add-row') },
      { index: 3, type: 'fill', value: 'Widget', candidates: css('[aria-label="Item 2"]') },
    ],
    read: 'document.querySelector(\'[aria-label="Item 2"]\').value',
    expect: 'Widget',
  },
];

const report = [];

for (const c of cases) {
  const s = makeSession(c.steps);
  const r = new Replayer(s, { headless: true, shots: false });
  let seen = null;
  let error = null;
  let context = null;

  try {
    context = await chromium.launchPersistentContext('', {
      channel: 'msedge',
      headless: true,
      viewport: null,
      args: ['--start-maximized'],
    });
    r.context = context;
    r.page = context.pages()[0] || (await context.newPage());

    for (const step of c.steps) {
      await r.execute(step);
      // A click that navigates leaves the next step resolving against the old
      // document, which is what the run loop guards against.
      await r.page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    }
    seen = await r.page.evaluate(c.read);
  } catch (e) {
    error = String(e.message || e).split('\n')[0];
  } finally {
    await context?.close().catch(() => {});
  }

  report.push({ name: c.name, passed: !error && seen === c.expect, seen, expect: c.expect, error });
  fs.writeFileSync(new URL('./.probe-out.json', import.meta.url), JSON.stringify(report, null, 1));
}

process.exitCode = report.some((x) => !x.passed) ? 1 : 0;
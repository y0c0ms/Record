// What the replayer can and cannot reach, measured against demo/targets.html.
//
// These are the things a recorded flow runs into that a plain
// `page.locator(css)` does not cover: a custom element whose content lives in
// an open shadow root, a control inside an iframe, and an element that is
// present but not clickable.
//
// The gaps are asserted as gaps. They are real limitations of the locator path
// as it stands, and a test that quietly expected them to work would fail every
// run; a test that did not mention them would let a change to any of them go
// unnoticed. If one of these starts passing, that is the signal to update this
// file and the docs together.
//
// Drives the runner's own `execute`, so what is measured is the real locator
// path and the real click options, not a stand-in for them.
import { chromium } from 'playwright';
import { EventEmitter } from 'node:events';
import { Replayer } from '../src/replayer.js';

const BASE = 'http://127.0.0.1:4317/demo/targets.html';

function makeSession(steps) {
  const s = new EventEmitter();
  s.id = 'targets';
  s.name = 'targets';
  s.channel = 'msedge';
  s.steps = steps;
  s.replay = { status: 'idle', current: null, passed: 0, failed: 0 };
  s.params = () => [];
  s.persist = () => {};
  s.publicView = () => ({ id: s.id, name: s.name, steps: s.steps, replay: s.replay });
  return s;
}

const nav = { index: 1, type: 'navigate', url: BASE };
const css = (v) => [{ strategy: 'css', value: v }];
const xp = (v) => [{ strategy: 'xpath', value: v }];

// `reachable` is the documented contract: does the click land?
//
// `failsAs` is the failure kind the runner records, and the point of it is that
// the two are different: `locator-timeout` means nothing matched the selector,
// `action-failed` means the selector matched and the page refused the click.
// Reading one as the other sends you to the wrong fix.
const cases = [
  {
    name: 'a plain button still works (control)',
    candidates: css('#visible-button'),
    reached: 'clicked: visible button',
    reachable: true,
  },
  {
    name: 'a shadow host is found by its tag',
    candidates: css('shadow-suggestion'),
    reached: 'clicked: shadow host',
    reachable: true,
  },
  {
    name: 'a shadow host is found by an attribute',
    candidates: css('[data-path="0.items.0"]'),
    reached: 'clicked: shadow host',
    reachable: true,
  },
  {
    name: 'an element inside the shadow root is found by css',
    candidates: css('shadow-suggestion b'),
    reached: 'clicked: shadow host',
    reachable: true,
  },
  {
    // Playwright's css engine pierces an open shadow root; `xpath=` does not,
    // and there is no way to make it. This is why the ladder must keep css
    // ahead of xpath on a page built out of web components.
    name: 'an element inside the shadow root is NOT found by xpath',
    candidates: xp('//*[@id="suggest"]/div[2]/div[1]/div[1]/b'),
    reached: 'nothing clicked yet',
    reachable: false,
    failsAs: 'locator-timeout',
  },
  {
    // `page` is the only root the replayer resolves against, and the recorder
    // instruments the top frame only, so a control inside a frame is neither
    // recorded nor reachable.
    name: 'a control inside an iframe is NOT reachable',
    candidates: css('#frame-button'),
    reached: 'nothing clicked yet',
    reachable: false,
    failsAs: 'locator-timeout',
  },
  {
    // The locator resolves; Playwright refuses the click because the element
    // has no box. There is no `force` anywhere in the runner, so this is a
    // limitation rather than a setting.
    name: 'a display:none button is NOT clickable',
    candidates: css('#hidden-button'),
    reached: 'nothing clicked yet',
    reachable: false,
    failsAs: 'action-failed',
  },
  {
    name: 'a visibility:hidden button is NOT clickable',
    candidates: css('#invisible-button'),
    reached: 'nothing clicked yet',
    reachable: false,
    failsAs: 'action-failed',
  },
];

const context = await chromium.launchPersistentContext('', {
  channel: 'msedge',
  headless: true,
  viewport: null,
  args: ['--start-maximized'],
});

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
};

for (const c of cases) {
  const page = context.pages()[0] || (await context.newPage());
  const steps = [nav, { index: 2, type: 'click', candidates: c.candidates }];
  const session = makeSession(steps);
  const r = new Replayer(session, { headed: false, shots: false, timeout: 6000, probeTimeout: 3000 });
  r.page = page;
  r.context = context;
  r.runId = 'targets';
  let full = null;
  let error = null;
  let seen = null;
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('log').textContent = 'nothing clicked yet';
    });
    await r.execute(steps[1]);
    await page.waitForTimeout(300);
    seen = await page.evaluate('document.getElementById("log").textContent');
  } catch (e) {
    full = String(e.message || e).replace(/\s+/g, ' ');
    error = full.split('\n')[0].slice(0, 80);
  }


  const landed = seen === c.reached;
  check(c.name, landed === c.reachable, `reached=${JSON.stringify(seen)}${error ? ` err=${error}` : ''}`);

  if (c.failsAs) {
    const kind = !full ? 'none' : full.includes('matched nothing') ? 'locator-timeout' : 'action-failed';
    check(`  ...and fails as ${c.failsAs}`, kind === c.failsAs, `kind=${kind}`);
  }
}

await context.close().catch(() => {});
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

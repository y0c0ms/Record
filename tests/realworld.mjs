// Shapes a real site has that the other fixtures did not, each of which made a
// recorded flow on a real corporate site unreplayable:
//
// 1. A menu shown in capitals by CSS `text-transform`. The recorder stored the
//    rendered "INVESTIDOR" while the DOM, which locators match, says
//    "Investidor": the role and text rungs found nothing and each waited out
//    its full budget before the structural CSS rung clicked.
// 2. The same link in the header and the footer, both visible. Ambiguity was
//    waited on for the whole budget although two visible matches never become
//    one; it now settles in a moment and the ladder moves on.
// 3. One embed twice — one hidden per breakpoint — with the builder's generic
//    title. The frame hop matched both, so every step inside was ambiguous.
// 4. A click on a cookie banner's "Rejeitar tudo" that the banner never offers
//    again (consent kept, or answered by the replay's own sweep). Marked "can
//    be skipped", it is reported as skipped — not passed, not failed — after a
//    short look. Unmarked, the same missing element still fails.
//
// Needs the sidecar on 4317 (it serves demo/realworld.html and demo/inner.html).
import { createSession, sessionDir } from '../src/store.js';
import { Replayer } from '../src/replayer.js';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:4317/demo/realworld.html';
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const css = (value) => ({ strategy: 'css', value });
const session = createSession({ name: 'real-world shapes', startUrl: BASE });
session.steps = [
  { type: 'navigate', url: BASE },
  // As the old recorder stored it: the rendered capitals, on a link that
  // appears once.
  {
    type: 'click',
    label: 'CARREIRAS',
    candidates: [
      { strategy: 'role', role: 'link', name: 'CARREIRAS' },
      { strategy: 'text', value: 'CARREIRAS' },
      css('#site-header-menu > ul > li:nth-of-type(4) > a'),
    ],
  },
  // The same, on a link the footer repeats: the folded rung is ambiguous and
  // the structural rung must take over promptly.
  {
    type: 'click',
    label: 'INVESTIDOR',
    candidates: [
      { strategy: 'role', role: 'link', name: 'INVESTIDOR' },
      { strategy: 'text', value: 'INVESTIDOR' },
      css('#site-header-menu > ul > li:nth-of-type(3) > a'),
    ],
  },
  {
    type: 'click',
    label: 'Frame button',
    frame: [{ tag: 'iframe', id: null, name: null, title: 'Iframe', src: 'inner.html?copy=desktop', index: 0 }],
    candidates: [{ strategy: 'role', role: 'button', name: 'Frame button' }],
  },
  // A banner answer this page never shows, marked "can be skipped".
  {
    type: 'click',
    optional: true,
    label: 'Rejeitar tudo',
    candidates: [{ strategy: 'role', role: 'button', name: 'Rejeitar tudo' }, css('#deny')],
    fingerprint: { tag: 'button', role: 'button', name: 'Rejeitar tudo', text: 'Rejeitar tudo' },
  },
  // A missing control that is not marked must still fail.
  {
    type: 'click',
    label: 'Ver detalhe',
    candidates: [{ strategy: 'role', role: 'link', name: 'Ver detalhe' }],
  },
].map((s, n) => ({ ...s, index: n + 1, id: `${session.id}-${n + 1}`, locator: s.candidates ? s.candidates[0] : null }));

const timing = {};
session.on('replay', (e) => {
  if (e.type === 'step' && e.step.status !== 'running') timing[e.step.index] = Date.now();
});
const r = new Replayer(session, { headed: false, shots: false, timeout: 3000, locatorWait: 8000 });
const started = Date.now();
await r.start();
const run = await r.done;
const [, car, inv, frame, banner, missing] = session.steps;
const took = (i) => (timing[i] - (timing[i - 1] ?? started)) / 1000;

check('a capitalised link resolves on its role, ignoring case', car.status === 'passed' && car.resolvedLocator?.strategy === 'role' && car.resolvedLocator?.ignoreCase === true, JSON.stringify(car.resolvedLocator));
check('it did not wait out the exact rung first', took(2) < 5, `${took(2).toFixed(1)}s`);
check('a link repeated in the footer falls to its structural rung', inv.status === 'passed' && inv.resolvedLocator?.strategy === 'css', JSON.stringify(inv.resolvedLocator));
check('…without waiting out the ambiguity', took(3) < 8, `${took(3).toFixed(1)}s`);
check('a step inside a duplicated, generically titled iframe resolves', frame.status === 'passed', frame.error || '');
check('a step marked "can be skipped" whose element is absent is skipped', banner.status === 'skipped', `${banner.status}: ${banner.error}`);
check('…after a short look, not the full budget', took(5) < 8, `${took(5).toFixed(1)}s`);
check('an unmarked step whose element is absent fails', missing.status === 'failed' && missing.failureKind === 'locator-timeout', `${missing.status}`);
check('a skipped step is not counted as passed', run.passed === 4 && run.skipped === 1 && run.failed === 1, JSON.stringify({ passed: run.passed, skipped: run.skipped, failed: run.failed }));

fs.rmSync(`${sessionDir(session.id)}.json`, { force: true });
fs.rmSync(sessionDir(session.id), { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

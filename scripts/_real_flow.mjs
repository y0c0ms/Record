// Records a real flow on a real site through the sidecar's own recorder, then
// reports what was captured. No demo: the point is to see whether the locators
// the browser gives us actually resolve on a second run. Results go to a file
// because the console truncates long output in this environment.
import { writeFileSync } from 'node:fs';
import { Recorder } from '../src/recorder.js';
import { createSession } from '../src/store.js';

const log = (...a) => console.log(...a);
const out = [];
const say = (...a) => {
  out.push(a.join(' '));
  log(...a);
};
process.on('unhandledRejection', (e) => {
  say('FAILED:', e && e.message ? e.message : String(e));
  writeFileSync('real-flow.txt', out.join('\n'));
  process.exit(1);
});

const session = createSession({
  name: 'Wikipedia probe',
  startUrl: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
});
say('session', session.id);

const recorder = new Recorder(session);
await recorder.start();
const page = recorder.page;
await page.waitForLoadState('domcontentloaded');
say('loaded:', page.url());

// Four distinct elements a person would actually click, in the order a reader
// would meet them.
await page.click('a[href="#Biography"]');
await page.waitForTimeout(600);
say('clicked section link');

await page.fill('#searchInput', 'Analytical Engine');
await page.press('#searchInput', 'Enter');
await page.waitForLoadState('domcontentloaded');

// Sections that exist on the search result's page too, so both steps are real
// targets a second run has to find rather than guesses.
await page.click('a[href="#References"]');
await page.waitForTimeout(600);
say('clicked References');

await page.click('a[href="#External_links"]');
await page.waitForTimeout(600);
say('clicked External links');

const view = await recorder.stop();
say('recorded', view.steps.length, 'steps');
for (const s of view.steps) {
  say(' ', s.index, s.type, JSON.stringify(s.label), '->', JSON.stringify(s.candidates?.[0] || s.locator));
}
say('SESSION=' + session.id);
writeFileSync('real-flow.txt', out.join('\n'));
process.exit(0);
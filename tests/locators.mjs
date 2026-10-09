// Every strategy the recorder can emit has to actually resolve.
//
// The bug this guards: the `role` branch in `toLocatorStrict` sat after the
// `return` that ends `testId`, with no `case` label of its own. Nothing failed
// loudly — a role rung just threw "unknown locator strategy" and the ladder
// moved on — so the most resilient strategy the recorder produces for a button
// or a link was dead on every run, and no test noticed because every existing
// test happened to land on a different rung.
//
// Resolution is imported rather than re-implemented, so this tests the code
// that replay actually runs.
import { chromium } from 'playwright';
import { resolveCandidate } from '../src/locator.js';

// One element per strategy, each the only match for its locator.
const BODY = `
  <button data-testid="save-btn">Save</button>
  <button aria-label="Cancel the edit">Cancel</button>
  <div><label for="q">Search</label><input id="q" placeholder="Type here"></div>
  <p class="plain">Some ordinary text</p>
  <img alt="Company logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
  <section id="cart"><div><span class="total">42</span></div></section>
`;

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();
await page.goto('about:blank');
await page.evaluate((b) => {
  document.body.innerHTML = b;
}, BODY);

const cases = [
  { strategy: 'testId', value: 'save-btn' },
  { strategy: 'role', role: 'button', name: 'Cancel the edit' },
  { strategy: 'label', value: 'Search' },
  { strategy: 'placeholder', value: 'Type here' },
  { strategy: 'text', value: 'Some ordinary text' },
  { strategy: 'altText', value: 'Company logo' },
  { strategy: 'css', value: '#cart > div > span.total' },
  { strategy: 'xpath', value: '//*[@id="cart"]/div/span' },
];

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
};

for (const c of cases) {
  const step = { index: 1, type: 'click', candidates: [c] };
  const shown = c.strategy === 'role' ? `role=${c.role} name="${c.name}"` : `${c.strategy}=${c.value}`;
  try {
    const found = await resolveCandidate(page, step, { timeout: 3000, action: (l) => l.count() });
    check(`${shown} resolves`, true, `-> ${found.locator.strategy}`);
  } catch (e) {
    check(`${shown} resolves`, false, String(e.message).replace(/\s+/g, ' ').slice(0, 100));
  }
}

await browser.close();
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

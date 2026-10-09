// The position fallback clicks where an element used to be — and only when the
// element there is still recognisably the same one.
//
// The danger it guards against: a bare coordinate click passes on whatever now
// occupies that spot. If a page swaps "Save" for "Delete" at the same place,
// a test with an unverified position rung clicks Delete and reports green.
//
// Every locator in these steps is deliberately broken, so the position rung is
// the only way left to reach the element.
import { chromium } from 'playwright';
import { resolveCandidate } from '../src/locator.js';

const VIEW = { width: 900, height: 600 };

// Two buttons at fixed positions. Their ids change between "recording" and
// "replay" so every recorded locator misses.
const page_ = (first, second) => `
  <style>body{margin:0} button{position:absolute;width:140px;height:40px}</style>
  <button id="${first.id}" style="left:100px;top:100px">${first.text}</button>
  <button id="${second.id}" style="left:400px;top:100px">${second.text}</button>
  <div id="log">none</div>
  <script>
    for (const b of document.querySelectorAll('button')) {
      b.addEventListener('click', () => { document.getElementById('log').textContent = b.textContent; });
    }
  </script>`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: VIEW });
const page = await context.newPage();

// What the recorder would have stored for a click on "Save" at (170,120).
const fingerprint = {
  tag: 'button',
  role: 'button',
  name: 'Save',
  text: 'Save',
  attrs: {},
  point: { x: 170, y: 120 },
  size: { w: 140, h: 40 },
  inHost: null,
  scroll: { x: 0, y: 0 },
  viewport: { w: VIEW.width, h: VIEW.height },
};
const brokenLadder = [
  { strategy: 'css', value: '#save-old-id' },
  { strategy: 'testId', value: 'gone' },
];
const step = (fp) => ({ index: 1, type: 'click', candidates: brokenLadder, fingerprint: fp });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const attempt = async (html, fp) => {
  await page.setContent(html);
  let result = null;
  let error = null;
  try {
    result = await resolveCandidate(page, step(fp), { timeout: 400, action: (l) => l.click() });
  } catch (e) {
    error = String(e.message);
  }
  const clicked = await page.evaluate(() => document.getElementById('log').textContent);
  return { result, error, clicked };
};

// 1. Same element, new id: the position rung recovers the click.
{
  const r = await attempt(page_({ id: 'save-new-id', text: 'Save' }, { id: 'x', text: 'Cancel' }), fingerprint);
  check('the same element at the same place is clicked', r.clicked === 'Save', `clicked=${r.clicked}`);
  check('  ...and is reported as a position match', r.result && r.result.locator.strategy === 'position');
}

// 2. A different control now sits there: it must NOT be clicked.
{
  const r = await attempt(page_({ id: 'delete', text: 'Delete' }, { id: 'x', text: 'Save' }), fingerprint);
  check('a different element at that place is refused', r.clicked === 'none', `clicked=${r.clicked}`);
  check('  ...and the failure names what it found', /landed on button "delete"/.test(r.error || ''), (r.error || '').slice(-80));
}

// 3. Recorded at another window size: the coordinates mean nothing here.
{
  const r = await attempt(page_({ id: 'save-new-id', text: 'Save' }, { id: 'x', text: 'Cancel' }), {
    ...fingerprint,
    viewport: { w: 1920, h: 1080 },
  });
  check('a viewport mismatch is refused, not guessed', r.clicked === 'none', `clicked=${r.clicked}`);
  check('  ...and says why', /viewport is 900x600, recorded at 1920x1080/.test(r.error || ''));
}

// 4. A label inside the button: the point lands on the <span>, the fingerprint
//    names the <button>. The walk up to the ancestor has to find it.
{
  const html = `<style>body{margin:0} button{position:absolute;left:100px;top:100px;width:140px;height:40px}</style>
    <button id="n"><span>Save</span></button><div id="log">none</div>
    <script>document.getElementById('n').addEventListener('click',()=>{document.getElementById('log').textContent='Save'})</script>`;
  const r = await attempt(html, fingerprint);
  check('a click landing on a child label still verifies its button', r.clicked === 'Save', `clicked=${r.clicked}`);
}

// 5. A step with no fingerprint (an older recording) keeps the old behaviour.
{
  const r = await attempt(page_({ id: 'save-new-id', text: 'Save' }, { id: 'x', text: 'Cancel' }), null);
  check('a step recorded before fingerprints still fails cleanly', r.clicked === 'none' && /no locator resolved/.test(r.error || ''));
}

await browser.close();
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

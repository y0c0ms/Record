// Checks the recorded xpath against a real DOM.
//
// The bug this guards: `xpathOf` in src/recorder-inject.js used to return
// `body/...` for elements with no id on the way up. Playwright is handed
// `xpath=body/a`, and a relative path matches nothing from the document root,
// so those steps only ever worked because replay fell through to css.

import { chromium } from 'playwright';

// The same function as src/recorder-inject.js, inlined because the recorder
// runs inside the page and cannot be imported here.
function xpathOf(el, doc) {
  if (!el || el.nodeType !== 1) return null;
  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `//*[@id="${el.id}"]`;

  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== doc.documentElement) {
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
      parts.unshift(`//*[@id="${node.id}"]`);
      return parts.length > 1 ? parts.join('/') : parts[0];
    }
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      parts.unshift(same.length > 1 ? `${tag}[${same.indexOf(node) + 1}]` : tag);
    } else {
      parts.unshift(tag);
    }
    node = parent;
  }
  if (!parts.length) return null;
  return `/html/${parts.join('/')}`;
}

// Built in the page rather than via `setContent`, which does not put the markup
// where the locators will look for it.
const BODY = [
  '<header><nav><a href="/a">one</a><a href="/b">two</a></nav></header>',
  '<div id="wrap"><p class="t">hello</p></div>',
  '<mariana-widget>inner</mariana-widget>',
].join('');

const SELECTORS = ['nav a', '.t', 'mariana-widget', '#wrap p', 'header', 'body', 'nav'];

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();
await page.goto('about:blank');
await page.evaluate((b) => {
  document.body.innerHTML = b;
}, BODY);
// Generated against the live document, not a DOMParser copy: an xpath is only
// meaningful if it resolves in the document the locator will be run against.
const generated = await page.evaluate(
  ({ sels, src }) => {
    const of = new Function(`return (${src})`)();
    return sels.map((sel) => ({ sel, xpath: of(document.querySelector(sel), document) }));
  },
  { sels: SELECTORS, src: xpathOf.toString() },
);

let problems = 0;
for (const { sel, xpath } of generated) {
  const absolute = typeof xpath === 'string' && xpath.startsWith('/');
  if (!absolute) problems++;
  console.log(`${absolute ? 'ok  ' : 'BAD '} ${sel.padEnd(16)} ${xpath}`);
}

for (const { sel, xpath } of generated) {
  const loc = page.locator(`xpath=${xpath}`);
  const count = await loc.count();
  const text = count === 1 ? (await loc.innerText()).trim().slice(0, 20) : '(none)';
  console.log(`     ${sel.padEnd(16)} -> ${count} match(es) ${text}`);
  if (count !== 1) problems++;
}

await browser.close();
console.log(
  problems === 0
    ? 'PASS: every xpath is absolute and resolves to exactly one element'
    : `FAIL: ${problems} problem(s)`,
);
process.exit(problems === 0 ? 0 : 1);
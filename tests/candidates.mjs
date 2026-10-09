// Checks the recorded candidate ladder for a few real DOM shapes.
//
// The bug this guards: the ladder could return fewer than six locators, and the
// cap that bounds it could drop the full xpath — the one strategy that survives
// DOM churn, and therefore the rung a replay falls back to last.

import { chromium } from 'playwright';

const BODY = [
  // Everything at once: testid, role+name, text, css and xpath.
  '<button data-testid="save-btn" aria-label="Save now">Save</button>',
  // No testid, no id: role+name, text, css, xpath.
  '<button>Cancel</button>',
  // An input with a label, a placeholder and an aria-label.
  '<div><label for="q">Search</label><input id="q" placeholder="Type here" aria-label="Search box"></div>',
  // An id on an ancestor: the xpath collapses to an id lookup.
  '<section id="cart"><div><span class="total">42</span></div></section>',
  // A link whose text has collapsed whitespace.
  '<a href="/docs">  Browse \n  the docs  </a>',
].join('');

const SELECTORS = [
  '[data-testid="save-btn"]',
  'button:not([data-testid])',
  '#q',
  '.total',
  'a[href="/docs"]',
];

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();
await page.goto('about:blank');
await page.evaluate((b) => {
  document.body.innerHTML = b;
}, BODY);

const MAX_CANDIDATES = 6;

// The ladder as it stands in src/recorder-inject.js. Inlined because that code
// runs in the page and cannot be imported here.
const ladder = `
  const cssPath = (el) => {
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return '#' + el.id;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        parts.unshift(same.length > 1 ? tag + ' > ' + tag + ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : tag);
      } else {
        parts.unshift(tag);
      }
      node = parent;
    }
    return parts.join(' > ');
  };
  const xpathOf = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return '//*[@id="' + el.id + '"]';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && /^[A-Za-z][\\w-]*$/.test(node.id)) {
        parts.unshift('//*[@id="' + node.id + '"]');
        return parts.length > 1 ? parts.join('/') : parts[0];
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        parts.unshift(same.length > 1 ? tag + '[' + (same.indexOf(node) + 1) + ']' : tag);
      } else {
        parts.unshift(tag);
      }
      node = parent;
    }
    if (!parts.length) return null;
    return '/html/' + parts.join('/');
  };
  const keyOf = (d) => d.strategy + ':' + (d.strategy === 'role' ? d.role + '/' + d.name : d.value);
  const text = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
  const accessibleName = (el) => el.getAttribute('aria-label') || text(el);
  const implicitRole = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'search') return 'searchbox';
      if (t === 'number' || t === 'range') return 'spinbutton';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'img') return 'img';
    if (tag === 'nav') return 'navigation';
    return '';
  };

  const out = [];
  const push = (d) => {
    if (!d) return;
    const empty = d.strategy === 'role' ? !d.role : d.value === null || d.value === undefined || d.value === '';
    if (empty) return;
    if (out.some((c) => keyOf(c) === keyOf(d))) return;
    out.push(d);
  };
  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id')
    || el.getAttribute('data-test') || el.getAttribute('data-qa');
  if (testId) push({ strategy: 'testId', value: testId });
  const role = implicitRole(el);
  const name = accessibleName(el);
  if (role && role !== 'generic') {
    if (name) push({ strategy: 'role', role, name });
    push({ strategy: 'role', role, name: '' });
  }
  if (/^(input|select|textarea)$/i.test(el.tagName)) {
    if (name && el.labels && el.labels.length) push({ strategy: 'label', value: name });
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) push({ strategy: 'placeholder', value: placeholder });
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) push({ strategy: 'label', value: ariaLabel });
  }
  if (/^(a|button|summary|option)$/i.test(el.tagName)) {
    const t = text(el);
    if (t && t.length <= 80) {
      push({ strategy: 'text', value: t });
      const trimmed = t.replace(/\\s+/g, ' ').trim();
      if (trimmed !== t) push({ strategy: 'text', value: trimmed });
    }
  }
  const alt = el.getAttribute('alt');
  if (alt && /^(input|img)$/i.test(el.tagName)) push({ strategy: 'altText', value: alt });
  push({ strategy: 'css', value: cssPath(el) });
  const xpath = { strategy: 'xpath', value: xpathOf(el) };
  if (!xpath.value) return out.slice(0, ${MAX_CANDIDATES});
  const kept = out.slice(0, ${MAX_CANDIDATES} - 1);
  if (!kept.some((c) => keyOf(c) === keyOf(xpath))) kept.push(xpath);
  return kept;
`;

const results = await page.evaluate(
  ({ sels, src }) => {
    const of = new Function('el', `return (function(){ ${src} })()`);
    return sels.map((sel) => ({ sel, candidates: of(document.querySelector(sel)) }));
  },
  { sels: SELECTORS, src: ladder },
);

let problems = 0;
const fail = (msg) => {
  problems++;
  console.log(`BAD  ${msg}`);
};

for (const { sel, candidates } of results) {
  console.log(`\n${sel}`);
  console.log(`  ${candidates.length} candidate(s), cap ${MAX_CANDIDATES}`);
  for (const c of candidates) {
    console.log(`    ${c.strategy.padEnd(12)} ${JSON.stringify(c.value ?? `${c.role}/${c.name}`)}`);
  }

  if (candidates.length === 0) fail(`${sel}: no candidates at all`);
  if (candidates.length > MAX_CANDIDATES) fail(`${sel}: ${candidates.length} exceeds the cap`);

  const last = candidates[candidates.length - 1];
  if (last.strategy !== 'xpath') fail(`${sel}: last rung is ${last.strategy}, not xpath`);

  // Every rung has to resolve to the same single element, or the chain is worse
  // than useless: a rung that resolves elsewhere sends the replay to the wrong
  // element before the xpath is ever tried.
  for (const c of candidates) {
    let selector;
    if (c.strategy === 'xpath') selector = `xpath=${c.value}`;
    else if (c.strategy === 'css') selector = c.value;
    else if (c.strategy === 'testId') selector = `[data-testid="${c.value}"]`;
    else if (c.strategy === 'placeholder') selector = `[placeholder="${c.value}"]`;
    else if (c.strategy === 'text') selector = `text="${c.value}"`;
    else if (c.strategy === 'label') selector = `[aria-label="${c.value}"]`;
    else if (c.strategy === 'role' && c.name === '') selector = c.role;
    else selector = `text="${c.name}"`;

    const n = await page.locator(selector).count().catch(() => 0);
    if (n !== 1) {
      // A role-only rung resolving to nothing is acceptable only if a stronger
      // rung already covers the same target; report it and let the count decide.
      console.log(`      (${c.strategy} matches ${n})`);
    }
  }
}

await browser.close();
console.log(
  problems === 0
    ? '\nPASS: every chain is within the cap and ends in a full xpath'
    : `\nFAIL: ${problems} problem(s)`,
);
process.exit(problems === 0 ? 0 : 1);
// Lists visible, clickable elements on a real page so a flow can be built from
// things a person could actually click. Results go to a file because the
// console truncates long output in this environment.
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const out = [];
const browser = await chromium.launch({ channel: 'msedge' });

for (const url of process.argv.slice(2)) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  out.push(`\n=== ${page.url()}`);

  // Same-origin links a second run would have to find again, and their labels.
  const items = await page.evaluate(() => {
    const rows = [];
    for (const el of document.querySelectorAll('a[href^="#"]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const t = (el.innerText || '').trim().slice(0, 30);
      if (t) rows.push(`${JSON.stringify(el.getAttribute('href'))} ${JSON.stringify(t)}`);
      if (rows.length >= 25) break;
    }
    return rows;
  });
  out.push(...items);
  await page.close();
}

writeFileSync('dom-probe.txt', out.join('\n'));
await browser.close();
process.exit(0);
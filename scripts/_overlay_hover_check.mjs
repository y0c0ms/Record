// Throwaway verification of the recording badge: hover reveals the controls,
// Pause swaps to Resume without the mouse moving, and Stop ends the run. Uses
// Playwright's own mouse so the hover is a real hover, not a synthetic event.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INJECT = path.join(HERE, '..', 'src', 'recorder-inject.js');

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext();
const commands = [];
await context.exposeBinding('__recordEmit', (_s, payload) => {
  commands.push(payload);
  return true;
});
await context.addInitScript({ path: INJECT });
// Navigated rather than setContent: an init script only runs for a real
// document load, which is exactly how the recorder injects itself.
const page = await context.newPage();
await page.goto('http://localhost:4317/demo', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#__record_badge__', { timeout: 10000 });

const read = () =>
  page.evaluate(() => {
    const badge = document.getElementById('__record_badge__');
    if (!badge) return { present: false };
    return {
      label: document.getElementById('__record_count__')?.textContent,
      state: badge.dataset.state || null,
      // Which controls are visible, by name. Split on whitespace runs: the
      // labels carry a glyph and padding space, so a plain split leaves the
      // glyph in the name.
      shown: [...badge.querySelectorAll('button')]
        .filter((b) => getComputedStyle(b).display !== 'none')
        .map((b) => b.textContent.trim().split(/\s+/).pop()),
    };
  });

// Hovers the corner, which is what the pad covers. The badge grows when the
// controls appear, so the pointer is placed on the pad rather than the badge:
// hovering must work even when the badge is at its smallest.
const hoverCorner = async () => {
  const size = page.viewportSize();
  await page.mouse.move(size.width - 40, size.height - 30);
  await page.waitForTimeout(400);
};

const before = await read();
await hoverCorner();
const hovered = await read();

await page.evaluate(() => window.__recordBadge('paused', 7));
await page.waitForTimeout(300);
const pausedInPlace = await read();

await page.mouse.move(5, 5);
await page.waitForTimeout(400);
const away = await read();

await hoverCorner();
const pausedHover = await read();

// Stop is reachable from both states, which is the whole point of putting it
// on the badge: the run can always be ended from the page it is driving.
const stopBox = await page.locator('#__record_badge__ button', { hasText: 'Stop' }).boundingBox();
await page.mouse.click(stopBox.x + stopBox.width / 2, stopBox.y + stopBox.height / 2);
await page.waitForTimeout(300);

// And a normal page click must still be recorded: the badge exists over the
// page, so it must not swallow what it is watching.
await page.mouse.move(5, 5);
await page.waitForTimeout(300);
await page.locator('main a, main button, main [role="button"]').first().click();
await page.waitForTimeout(400);

const after = await read();

console.log(
  JSON.stringify(
    {
      before,
      hovered,
      pausedInPlace,
      away,
      pausedHover,
      after,
      commands: commands.map((c) => (c && c.command ? `command:${c.command}` : c && c.type)),
    },
    null,
    1,
  ),
);

await browser.close();

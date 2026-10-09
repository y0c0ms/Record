// Renders ui/icons/app.svg into the PNG sizes Windows uses and packs them into
// assets/app.ico (PNG-compressed ICO entries, supported since Vista). Run once
// after changing the SVG:  node tools/render-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const svg = fs.readFileSync(path.join(root, 'ui/icons/app.svg'), 'utf8');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const out = path.join(root, 'assets');
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
const pngs = [];
for (const size of sizes) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">` +
      svg.replace('<svg ', `<svg width="${size}" height="${size}" `) +
      `</body></html>`,
  );
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  pngs.push({ size, png });
  if (size === 256) fs.writeFileSync(path.join(out, 'app-256.png'), png);
}
await browser.close();

// ICONDIR + one ICONDIRENTRY per image, then the PNG payloads.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
const entries = [];
let offset = 6 + 16 * pngs.length;
for (const { size, png } of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0);
  e.writeUInt8(size >= 256 ? 0 : size, 1);
  e.writeUInt8(0, 2);
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += png.length;
}
fs.writeFileSync(path.join(out, 'app.ico'), Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)]));
console.log('wrote assets/app.ico with', sizes.join(', '));

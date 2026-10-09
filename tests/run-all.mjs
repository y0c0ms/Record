// Runs every test in tests/ (not tests/real-sites, which needs the internet),
// one process each, and fails if any of them does.
//
//   node tests/run-all.mjs            offline + local-sidecar tests
//   node tests/run-all.mjs --real     also the real-site tests
//
// Tests that open the demo pages need the sidecar: `npm start` first.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const real = process.argv.includes('--real');
const files = fs.readdirSync(here).filter((f) => f.endsWith('.mjs') && f !== 'run-all.mjs').sort();
if (real) {
  for (const f of fs.readdirSync(path.join(here, 'real-sites')).filter((f) => f.endsWith('.mjs')).sort()) {
    files.push(path.join('real-sites', f));
  }
}

const failed = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(here, f)], { stdio: 'inherit' });
  console.log(`\n=== ${f}: ${r.status === 0 ? 'ok' : 'FAILED'}\n`);
  if (r.status !== 0) failed.push(f);
}
console.log(failed.length ? `FAILED: ${failed.join(', ')}` : `all ${files.length} test files passed`);
process.exit(failed.length ? 1 : 0);

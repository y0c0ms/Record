// Does running two replays at once actually collide?
//
// The concern: both runs drive Edge with the same profile, so a keystroke meant
// for one run's username field could land in the other's. This measures that
// rather than assuming it — two runs fill the same page simultaneously and each
// reports what its own field ended up holding.

import { chromium } from 'playwright';

const PAGE = `data:text/html,<h1>concurrency probe</h1>
  <input id="a" aria-label="user a">
  <input id="b" aria-label="user b">`;

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// The launch exactly as src/replayer.js does it today.
const launch = () =>
  chromium.launchPersistentContext('', {
    channel: 'msedge',
    headless: true,
    viewport: null,
    args: ['--start-maximized'],
  });

console.log('--- two persistent contexts on the default profile ---');
const c1 = await launch();
const c2 = await launch().catch((e) => ({ error: e }));

if (c2.error) {
  console.log(`  second launch failed: ${c2.error.message.split('\n')[0]}`);
  check('two runs can start at the same time', false, 'the second launch was refused');
  await c1.close();
} else {
  check('two runs can start at the same time', true);
  const p1 = c1.pages()[0] || (await c1.newPage());
  const p2 = c2.pages()[0] || (await c2.newPage());

  // Both type into their own field at the same moment. `fill` goes through
  // Playwright's own input path, which is what the replayer tries first.
  await Promise.all([p1.goto(PAGE), p2.goto(PAGE)]);
  await Promise.all([
    p1.locator('#a').fill('alice@example.com'),
    p2.locator('#b').fill('bob@example.com'),
  ]);

  const [v1, v2] = await Promise.all([
    p1.locator('#a').inputValue(),
    p2.locator('#b').inputValue(),
  ]);
  check('run 1 kept its own value', v1 === 'alice@example.com', `got "${v1}"`);
  check('run 2 kept its own value', v2 === 'bob@example.com', `got "${v2}"`);

  // The same question for raw keystrokes, which is the interaction the user
  // asked about. `page.keyboard` targets whatever the page has focused, so the
  // check is which field changed, not where in it: a keystroke lands at the
  // caret, and the caret is wherever `fill` left it.
  const [b1, b2] = [await p1.locator('#a').inputValue(), await p2.locator('#b').inputValue()];
  await Promise.all([p1.locator('#a').click(), p2.locator('#b').click()]);
  await Promise.all([p1.keyboard.press('X'), p2.keyboard.press('Y')]);
  const [k1, k2] = await Promise.all([
    p1.locator('#a').inputValue(),
    p2.locator('#b').inputValue(),
  ]);
  check(
    'a keystroke stays in the field it was aimed at',
    k1 !== b1 && k1.includes('X') && k2 !== b2 && k2.includes('Y') && !k1.includes('Y') && !k2.includes('X'),
    `run1="${k1}" run2="${k2}"`,
  );

  await c1.close();
  await c2.close();
}
// and logins leak from one test into the next, which is its own bug.
console.log('\n--- is the profile shared between runs? ---');
{
  const a = await launch();
  const p = a.pages()[0] || (await a.newPage());
  // A real origin, because `data:` URLs have no storage at all and would make
  // the check pass for the wrong reason.
  const origin = 'https://example.com/';
  await p.goto(origin).catch(() => {});
  await p
    .evaluate(() => {
      localStorage.setItem('probe', 'from-first-run');
    })
    .catch(() => {});
  await a.close();

  const b = await launch();
  const q = b.pages()[0] || (await b.newPage());
  await q.goto(origin).catch(() => {});
  const leaked = await q
    .evaluate(() => {
      try {
        return localStorage.getItem('probe');
      } catch {
        return 'unreadable';
      }
    })
    .catch(() => 'unreadable');
  console.log(`  localStorage from the first run in the second: ${leaked}`);
  check(
    'a later run does not see the previous run\'s state',
    leaked !== 'from-first-run',
    `saw ${String(leaked)}`,
  );
  await b.close();
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
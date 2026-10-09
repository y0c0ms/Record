// Recording and replaying on real sites built with the platforms enterprise
// test suites actually face: WordPress, Salesforce Lightning Web Components,
// e-commerce storefronts, and SAP UI5.
//
// Every site here is either published for test-automation practice or is the
// vendor's own public demo, and was checked against its robots.txt first:
//
//   WordPress     playground.wordpress.net — WordPress' official in-browser
//                 demo. Each visitor gets a private, throwaway WordPress that
//                 runs in their own browser, so nothing touches a shared
//                 server. Two journeys: browsing the site (two nested
//                 iframes), and writing a post in the block editor (three
//                 frames deep, contenteditable blocks, a modal welcome guide).
//   Salesforce    recipes.lwc.dev — Salesforce's public Lightning Web
//                 Components recipes; every control sits several shadow roots
//                 deep (ui-app > recipe-* > ui-input).
//   E-commerce    practicesoftwaretesting.com (Angular "Toolshop", built for
//                 test practice; its API host's robots.txt is `Disallow:`
//                 nothing) and demoblaze.com (jQuery store from the
//                 automation-practice community; no robots.txt).
//   SAP UI5       ui5.sap.com Order Browser demo app (robots.txt disallows only
//                 /docs/) — generated ids, a master/detail layout, a mock
//                 server, the UI5 rendering model.
//
// As everywhere in these tests, a replay passes only if the site ends up where
// the recording left it.
//
//   node tests/real-sites/platforms-real.mjs [wordpress] [wp-editor] [lwc] [toolshop] [demoblaze] [ui5]

import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createSession, sessionDir } from '../../src/store.js';
import { Recorder } from '../../src/recorder.js';
import { Replayer } from '../../src/replayer.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = process.argv.slice(2);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const made = [];

// Records `journey`, reads `state` at the end, replays headless and reads
// `state` again after every step; the last read is compared.
async function roundTrip(name, startUrl, journey, state, { settle = 2500, locatorWait = 20000 } = {}) {
  console.log(`\n--- ${name} ---`);
  const session = createSession({ name: `platform ${name}`, startUrl });
  made.push(session.id);
  const recorder = new Recorder(session);
  let expected;
  try {
    await recorder.start();
    await recorder.page.waitForLoadState('domcontentloaded');
    await sleep(settle);
    await journey(recorder.page, recorder);
    await sleep(800);
    expected = await state(recorder.page);
  } catch (err) {
    check(`${name}: recording journey ran`, false, String(err.message).split('\n')[0]);
    await recorder.stop('user').catch(() => {});
    return;
  }
  const recorded = await recorder.stop('user');
  console.log(`recorded ${recorded.steps.length} steps: ${recorded.steps.map((s) => s.type + (s.caused ? '*' : '') + (s.frame ? '[f]' : '') + (s.page ? '@' + s.page : '')).join(' ')}`);
  console.log(`site after recording: ${JSON.stringify(expected)}`);

  const copy = Object.assign(new EventEmitter(), {
    id: session.id,
    name: `${name} replay`,
    channel: session.channel,
    startUrl,
    steps: JSON.parse(JSON.stringify(session.steps)),
    runs: [],
    persist() {},
  });
  let actual = null;
  const r = new Replayer(copy, {
    headed: false,
    shots: false,
    locatorWait,
    afterStep: async (step, page) => {
      actual = await state(page).catch(() => actual);
      // The last step's effect can land after the step returns — a cart
      // filled by an API call, a list re-rendered by a framework. The
      // recording only looked finished because a person waited, so the final
      // read waits too, the way an assertion would, for up to 15 s.
      if (step.index !== copy.steps.length) return;
      const want = JSON.stringify(expected);
      const deadline = Date.now() + 15000;
      while (JSON.stringify(actual) !== want && Date.now() < deadline) {
        await sleep(500);
        actual = await state(page).catch(() => actual);
      }
    },
  });
  await r.start();
  await r.done.catch(() => {});
  const failed = copy.steps.filter((s) => s.status === 'failed');
  const rungs = copy.steps.filter((s) => s.resolvedLocator).map((s) => s.resolvedLocator.strategy);
  console.log(`resolved by: ${JSON.stringify(rungs.reduce((m, k) => ({ ...m, [k]: (m[k] || 0) + 1 }), {}))}`);
  check(`${name}: every step passes on replay`, failed.length === 0,
    failed.map((s) => `${s.index} ${s.type} "${s.title}": ${s.error}`).join(' | '));
  check(`${name}: the site ends where the recording left it`, JSON.stringify(actual) === JSON.stringify(expected),
    `${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
  return { recorded, replayed: copy.steps };
}

// ---- WordPress Playground ------------------------------------------------------
// The site is in an iframe two levels down. The journey opens the sample page,
// then follows the link back to the first post — on a WordPress that exists
// only in this browser.
//
// Playground boots a whole PHP runtime in the browser on every load, which
// takes anywhere from 15 s to well over a minute depending on the network; the
// journey waits for the site itself rather than a fixed time. Its frames are
// addressed by their stable titles.
if (!only.length || only.includes('wordpress')) {
  const site = (page) =>
    page.frameLocator('iframe[title^="WordPress Playground wrapper"]').frameLocator('iframe#wp');
  await roundTrip(
    'wordpress',
    'https://playground.wordpress.net/',
    async (page) => {
      await site(page).locator('a:has-text("Sample Page")').first().waitFor({ timeout: 150000 });
      await sleep(1500);
      await site(page).locator('a:has-text("Sample Page")').first().click();
      await sleep(3000);
      await site(page).locator('a:has-text("Hello from WordPress Playground")').first().click();
      await sleep(3000);
    },
    async (page) => {
      const frame = page.frames().find((f) => (f.url() || '').includes('/scope:'));
      if (!frame) return null;
      return frame.evaluate(() => ({
        path: location.pathname.replace(/^\/scope:[^/]+/, ''),
        heading: (document.querySelector('h1')?.textContent || '').trim(),
      }));
    },
    { settle: 25000, locatorWait: 60000 },
  );
}

// ---- WordPress block editor (Gutenberg) ----------------------------------------
// Writing a post: dismiss the welcome guide, type a title and a paragraph into
// contenteditable blocks, save the draft. The editor is three frames deep —
// Playground wrapper > WordPress admin > the editor canvas iframe — and its
// fields are not inputs at all.
if (!only.length || only.includes('wp-editor')) {
  const admin = (page) => page.frames().find((f) => /\/scope:[^/]+\/wp-admin\/post(-new)?\.php/.test(f.url()));
  await roundTrip(
    'wp-editor',
    'https://playground.wordpress.net/?url=/wp-admin/post-new.php',
    async (page) => {
      const deadline = Date.now() + 150000;
      while (!admin(page) && Date.now() < deadline) await sleep(500);
      const ed = admin(page);
      if (!ed) throw new Error('the WordPress editor frame never loaded (Playground boot took over 150 s)');
      await ed.locator('[role=dialog] button[aria-label=Close]').first().click({ timeout: 20000 }).catch(() => {});
      await sleep(800);
      const canvas = ed.frameLocator('iframe[name=editor-canvas]');
      await canvas.locator('h1[aria-label="Add title"]').click();
      await canvas.locator('h1[aria-label="Add title"]').pressSequentially('Recorded by Record', { delay: 25 });
      await canvas.locator('h1[aria-label="Add title"]').press('Enter');
      await sleep(500);
      await page.keyboard.type('A paragraph typed into a contenteditable block.', { delay: 15 });
      await sleep(800);
      await ed.locator('button:has-text("Save draft")').click();
      await ed.locator('button:has-text("Saved")').waitFor({ timeout: 20000 }).catch(() => {});
      await sleep(1500);
    },
    async (page) => {
      const ed = admin(page);
      if (!ed) return null;
      return ed.evaluate(() => {
        const canvas = document.querySelector('iframe[name=editor-canvas]')?.contentDocument;
        return {
          saved: !!Array.from(document.querySelectorAll('button')).find((b) => /^Saved/.test(b.textContent.trim())),
          title: (canvas?.querySelector('h1.wp-block-post-title')?.textContent || '').trim(),
          paragraph: (canvas?.querySelector('p.wp-block-paragraph')?.textContent || '').trim(),
        };
      });
    },
    { settle: 25000, locatorWait: 60000 },
  );
}

// ---- Salesforce Lightning Web Components ---------------------------------------
// recipes.lwc.dev: type into the data-binding recipe and read its greeting,
// both behind ui-app > recipe-hello-binding > ui-input shadow roots.
if (!only.length || only.includes('lwc')) {
  const greeting = (page) =>
    page.evaluate(() => {
      const deep = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.tagName === 'RECIPE-HELLO-BINDING' && el.shadowRoot) {
            return (el.shadowRoot.querySelector('p')?.textContent || '').trim();
          }
          if (el.shadowRoot) {
            const hit = deep(el.shadowRoot);
            if (hit) return hit;
          }
        }
        return null;
      };
      return { greeting: deep(document) };
    });
  await roundTrip(
    'lwc',
    'https://recipes.lwc.dev/',
    async (page) => {
      const input = page.locator('recipe-hello-binding ui-input input');
      await input.waitFor({ timeout: 20000 });
      await input.fill('Record');
      await sleep(500);
      await page.locator('recipe-hello-expressions ui-input input').first().fill('Ada');
      await page.locator('recipe-hello-expressions ui-input input').nth(1).fill('Lovelace');
      await sleep(500);
    },
    async (page) => {
      const g = await greeting(page);
      const expr = await page.evaluate(() => {
        const deep = (root) => {
          for (const el of root.querySelectorAll('*')) {
            if (el.tagName === 'RECIPE-HELLO-EXPRESSIONS' && el.shadowRoot) return (el.shadowRoot.querySelector('p')?.textContent || '').trim();
            if (el.shadowRoot) { const hit = deep(el.shadowRoot); if (hit) return hit; }
          }
          return null;
        };
        return deep(document);
      });
      return { ...g, expressions: expr };
    },
  );
}

// ---- E-commerce: Toolshop (Angular) --------------------------------------------
// Search, open a product, add two to the cart, open the cart.
if (!only.length || only.includes('toolshop')) {
  await roundTrip(
    'toolshop',
    'https://practicesoftwaretesting.com/',
    async (page) => {
      await page.locator('[data-test=search-query]').waitFor({ timeout: 20000 });
      await page.fill('[data-test=search-query]', 'pliers');
      await page.click('[data-test=search-submit]');
      await sleep(2500);
      await page.locator('[data-test=product-name]', { hasText: 'Combination Pliers' }).first().click();
      await sleep(2500);
      await page.click('[data-test=increase-quantity]');
      await sleep(400);
      await page.click('[data-test=add-to-cart]');
      await sleep(2000);
      await page.click('[data-test=nav-cart]');
      await sleep(2500);
    },
    async (page) =>
      page.evaluate(() => ({
        path: location.pathname,
        items: Array.from(document.querySelectorAll('[data-test=product-title]')).map((e) => e.textContent.trim()),
        qty: Array.from(document.querySelectorAll('[data-test=product-quantity]')).map((e) => e.value),
      })),
  );
}

// ---- E-commerce: Demoblaze (jQuery + native dialogs) ---------------------------
// Open a phone, add to cart (the site confirms with a native alert), open the
// cart. The cart is per-browser, so the replay's fresh profile starts empty
// exactly as the recording did.
if (!only.length || only.includes('demoblaze')) {
  await roundTrip(
    'demoblaze',
    'https://www.demoblaze.com/',
    async (page) => {
      await page.locator('a.hrefch', { hasText: 'Samsung galaxy s6' }).waitFor({ timeout: 20000 });
      await page.click('a.hrefch:has-text("Samsung galaxy s6")');
      await page.locator('a:has-text("Add to cart")').waitFor({ timeout: 20000 });
      await sleep(800);
      const alerted = page.waitForEvent('dialog');
      await page.click('a:has-text("Add to cart")');
      await (await alerted).accept();
      await sleep(1000);
      await page.click('#cartur');
      await page.locator('#tbodyid tr').first().waitFor({ timeout: 20000 });
      await sleep(1000);
    },
    async (page) =>
      page.evaluate(() => ({
        path: location.pathname,
        // The cart table re-renders by appending, so rows repeat; what was
        // bought is the set of names.
        items: [...new Set(Array.from(document.querySelectorAll('#tbodyid tr td:nth-child(2)')).map((e) => e.textContent.trim()))],
      })),
  );
}

// ---- SAP UI5: Order Browser ----------------------------------------------------
// Search the master list by customer, open the second matching order, and read
// what the detail pane shows. UI5 renders every list item as a clone with a
// generated id (`__item0-__clone3`), so no recorded id can be trusted.
if (!only.length || only.includes('ui5')) {
  await roundTrip(
    'ui5',
    'https://ui5.sap.com/test-resources/sap/m/demokit/orderbrowser/webapp/test/mockServer.html',
    async (page) => {
      const search = page.locator('input[id$="--master--searchField-I"]');
      await search.waitFor({ timeout: 30000 });
      await sleep(2500);
      await search.fill('Tortuga');
      await search.press('Enter');
      await sleep(2500);
      // Items are `option`s on a wide window and `listitem`s on a narrow one
      // (UI5 switches to its phone layout below ~1024px); `.sapMLIB` is both.
      await page.locator('.sapMList .sapMLIB:not([id$="-trigger"])').nth(1).click();
      await sleep(3000);
    },
    async (page) =>
      page.evaluate(() => ({
        hash: location.hash,
        listed: Array.from(document.querySelectorAll('.sapMList .sapMLIB:not([id$="-trigger"])')).map((e) => (e.innerText.match(/Order \d+/) || [''])[0]),
        // The detail pane names the order that was opened.
        opened: (Array.from(document.querySelectorAll('[id*="---detail--"]')).map((e) => e.innerText).join(' ').match(/Order \d+/) || [''])[0],
      })),
    { settle: 4000 },
  );
}

for (const id of made) {
  fs.rmSync(`${sessionDir(id)}.json`, { force: true });
  fs.rmSync(sessionDir(id), { recursive: true, force: true });
}
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

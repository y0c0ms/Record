// Passwords, file uploads, native dialogs, popups and iframes — recorded and
// replayed against a real public website.
//
// practice.expandtesting.com is published for automation practice and its
// robots.txt is `Allow: /` (it disallows only APIs, downloads and auth
// endpoints, none of which are touched here). Each page used is built for one
// of these interactions:
//   /login        — a real server-side login (credentials printed on the page)
//   /upload       — a real multipart upload, server rejects files over 500 KB
//   /js-dialogs   — alert / confirm / prompt, answer echoed on the page
//   /windows      — a link that opens a new window
//   /iframe       — a newsletter form inside an iframe
//
// Every check reads the outcome from the site, not the step status: each of
// these used to fail by passing — the mask typed as a password, a confirm
// silently dismissed, a click landing in the wrong window.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSession, sessionDir } from '../../src/store.js';
import { Recorder } from '../../src/recorder.js';
import { Replayer } from '../../src/replayer.js';
import { MASK } from '../../src/secrets.js';
import { generateSpec } from '../../src/codegen.js';

const SITE = 'https://practice.expandtesting.com';
const USER = 'practice';
const PASSWORD = 'SuperSecretPassword!';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// A real PDF on disk, picked through the browser's file chooser while recording.
const tmp = path.join(process.cwd(), 'tmp-forms-real');
fs.mkdirSync(tmp, { recursive: true });
const pdfPath = path.join(tmp, 'contract.pdf');
fs.writeFileSync(pdfPath, '%PDF-1.4\n% recorded contract\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

// The site injects a Google consent dialog a few seconds after load. A person
// dismisses it before doing anything, so the recording does too; replay's own
// overlay sweep handles it on the way back.
async function clearConsent(page) {
  await page
    .locator('.fc-consent-root button.fc-cta-consent, .fc-consent-root button:has-text("Consent"), .fc-consent-root button:has-text("Consentir")')
    .first()
    .click({ timeout: 6000 })
    .catch(() => {});
}

// Navigations inside the recording are real clicks on the site's own links
// where it has them; the rest are typed URLs, exactly what a user would do.
async function go(page, route) {
  await page.goto(`${SITE}${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1200);
  await clearConsent(page);
}

// ---- record ------------------------------------------------------------------
const session = createSession({ name: 'real: login upload dialogs window iframe', startUrl: `${SITE}/login` });
const recorder = new Recorder(session);
await recorder.start();
const page = recorder.page;
await page.waitForSelector('#username', { timeout: 30000 });
await sleep(1500);
await clearConsent(page);

// 1. Login with a real password.
await page.fill('#username', USER);
await page.fill('#password', PASSWORD);
await page.click('#submit-login');
await page.waitForURL(/\/secure/, { timeout: 20000 }).catch(() => {});
const loggedIn = /\/secure/.test(page.url());

// 2. Upload a PDF through the real file chooser.
await go(page, '/upload');
const chooser = page.waitForEvent('filechooser');
await page.click('#fileInput');
await (await chooser).setFiles(pdfPath);
await sleep(800);
await page.click('#fileSubmit');
await page.waitForLoadState('domcontentloaded');
await sleep(1200);
const uploadedWhileRecording = /File Uploaded!/.test(await page.textContent('body'));

// 3. Dialogs: dismiss the confirm, answer the prompt.
await go(page, '/js-dialogs');
const answers = [(d) => d.dismiss(), (d) => d.accept('Record says hi')];
let answered = 0;
const onDialog = (d) => {
  const a = answers.shift();
  answered += 1;
  return a ? a(d) : d.dismiss();
};
page.on('dialog', onDialog);
await page.click('#js-confirm', { noWaitAfter: true });
while (answered < 1) await sleep(50);
await sleep(400);
await page.click('#js-prompt', { noWaitAfter: true });
while (answered < 2) await sleep(50);
await sleep(400);
page.off('dialog', onDialog);
const promptWhileRecording = await page.textContent('#dialog-response');

// 4. A link that opens a new window, and a click inside it.
await go(page, '/windows');
// /windows/new itself has no controls, so the popup the flow acts in is the
// site's footer link to expandtesting.com (robots.txt `Allow: /`), which opens
// in a new tab; the flow then clicks that site's "Practice Site" link in it.
const opened = recorder.context.waitForEvent('page');
await page.click('a[href="/windows/new"]');
const plain = await opened;
await plain.waitForLoadState('domcontentloaded');
await sleep(1000);
await plain.close();
await sleep(400);
const opened2 = recorder.context.waitForEvent('page');
await page.locator('a[target=_blank][href="https://expandtesting.com/"]').first().click();
const popup = await opened2;
await popup.waitForLoadState('domcontentloaded');
await sleep(2500);
await popup.locator('a[href="https://practice.expandtesting.com/"]').first().click({ timeout: 15000 });
await sleep(2000);
const popupLanded = popup.url();
await popup.close();
await sleep(500);

// 5. A form inside an iframe.
await go(page, '/iframe');
const frame = page.frameLocator('#email-subscribe');
await frame.locator('#email').fill('record.probe@example.com');
await frame.locator('#btn-subscribe').click();
await sleep(1500);

const recorded = await recorder.stop('user');
console.log(`recorded ${recorded.steps.length} steps: ${recorded.steps.map((s) => s.type + (s.page ? '@' + s.page : '') + (s.frame ? '[frame]' : '')).join(' ')}`);
check('recording: real login succeeded', loggedIn);
check('recording: real upload succeeded', uploadedWhileRecording);
check('recording: prompt answered', /Record says hi/.test(promptWhileRecording || ''), promptWhileRecording);

// ---- what was stored ------------------------------------------------------------
const file = path.join(sessionDir(session.id) + '.json');
const raw = fs.readFileSync(file, 'utf8');
const stored = JSON.parse(raw);
const passStep = stored.steps.find((s) => s.secret);
check('password step is marked secret and shows only the mask', passStep && passStep.value === MASK);
check('  …the plaintext is nowhere in the session file', !raw.includes(PASSWORD));
check('  …but it is kept, encrypted', passStep && /^v1:/.test(passStep.sealed || ''));

const upload = stored.steps.find((s) => s.type === 'upload');
check('file pick recorded as an upload step with the bytes kept in the flow',
  upload && upload.file.source === 'stored' && upload.file.files[0].stored &&
  fs.existsSync(path.join(sessionDir(session.id), 'uploads', upload.file.files[0].stored)));

const confirmStep = stored.steps.find((s) => (s.dialog || []).some((d) => d.kind === 'confirm'));
check('confirm recorded as dismissed', confirmStep && confirmStep.dialog[0].accept === false);
const promptStep = stored.steps.find((s) => (s.dialog || []).some((d) => d.kind === 'prompt'));
check('prompt recorded with its answer', promptStep && promptStep.dialog[0].text === 'Record says hi');

check('recording: the click in the second popup landed', /practice\.expandtesting\.com/.test(popupLanded), popupLanded);
check('the second popup\'s click is recorded against that tab (2)', stored.steps.some((s) => s.page === 2 && s.type === 'click'),
  stored.steps.filter((s) => s.page).map((s) => `${s.type}@${s.page}`).join(','));
check('the new window\'s own load is not recorded as "Open URL"', !stored.steps.some((s) => s.type === 'navigate' && /windows\/new/.test(s.url || '')));

const inFrame = stored.steps.filter((s) => (s.frame || []).some((h) => h.id === 'email-subscribe'));
check('iframe steps carry their frame', inFrame.length >= 2, inFrame.map((s) => s.type).join(','));

const spec = generateSpec(stored);
check('generated spec never contains the password', !spec.includes(PASSWORD));
check('  …reads it from an environment variable', /secret\("SECRET_[A-Z_]+"\)/.test(spec));

// ---- replay ------------------------------------------------------------------
// The outcome is read from the site after every step while the browser is
// still open; the last read wins.
async function replay(mutate) {
  const copy = JSON.parse(JSON.stringify(stored));
  if (mutate) mutate(copy);
  // A scratch session, never registered or written: the replay must not add
  // a flow to the user's list or touch the recording on disk. It borrows the
  // recorded flow's id because that is where the uploads are stored.
  const s = Object.assign(new EventEmitter(), {
    id: session.id,
    name: 'real replay',
    channel: stored.channel,
    startUrl: copy.startUrl,
    steps: copy.steps,
    runs: [],
    persist() {},
  });
  const seen = { secure: false, uploaded: false, prompt: null };
  // Read from the site after each step, before the next one runs — the only
  // moment the page is guaranteed to still be there.
  const afterStep = async (step) => {
    const main = r.pages[0];
    const url = main.url();
    const body = await main.textContent('body', { timeout: 2000 }).catch(() => '');
    if (/\/secure/.test(url) && /logged into a secure area|Secure Area/i.test(body)) seen.secure = true;
    if (/File Uploaded!/.test(body)) seen.uploaded = true;
    // The page writes the prompt's answer a moment after the dialog closes.
    if ((step.dialog || []).some((d) => d.kind === 'prompt')) {
      await main
        .waitForFunction(() => /Record says hi/.test(document.querySelector('#dialog-response')?.textContent || ''), null, { timeout: 2000 })
        .catch(() => {});
      seen.prompt = await main.textContent('#dialog-response', { timeout: 500 }).catch(() => null);
    }
  };
  const r = new Replayer(s, { headed: false, shots: false, locatorWait: 15000, afterStep });
  await r.start();
  await r.done.catch(() => {});
  return { steps: s.steps, seen };
}

const run = await replay();
console.log('replay saw', JSON.stringify(run.seen));
const failed = run.steps.filter((s) => s.status === 'failed');
check('every step passes on replay', failed.length === 0, failed.map((s) => `${s.index} ${s.type}: ${s.error}`).join(' | '));
check('replay logs in with the real password', run.seen.secure);
check('replay uploads the stored PDF and the site accepts it', run.seen.uploaded);
check('replay answers the prompt as recorded', /Record says hi/.test(run.seen.prompt || ''), run.seen.prompt);
const popupStep = run.steps.find((s) => s.page === 2 && s.type === 'click');
check('replay acts in the new window', popupStep && popupStep.status === 'passed', popupStep && popupStep.error);
const frameSteps = run.steps.filter((s) => s.frame);
check('replay fills and submits the iframe form', frameSteps.length >= 2 && frameSteps.every((s) => s.status === 'passed'),
  frameSteps.map((s) => `${s.type}:${s.status}`).join(','));

// The upload switched to a generated sample PDF.
const sample = await replay((c) => {
  c.steps.find((s) => s.type === 'upload').file = { source: 'sample', sample: 'pdf', name: 'generated-sample.pdf' };
});
check('a generated sample PDF is accepted by the real site', sample.seen.uploaded);

// …and to a file on this machine.
const disk = await replay((c) => {
  c.steps.find((s) => s.type === 'upload').file = { source: 'path', paths: [pdfPath] };
});
check('a file chosen from disk is accepted by the real site', disk.seen.uploaded);

// A disk path that no longer exists must fail the step, not upload nothing.
const gone = await replay((c) => {
  c.steps.find((s) => s.type === 'upload').file = { source: 'path', paths: [path.join(tmp, 'gone.pdf')] };
});
const goneStep = gone.steps.find((s) => s.type === 'upload');
check('a missing file fails its step and names the path', goneStep.status === 'failed' && /cannot find .*gone\.pdf/.test(goneStep.error || ''), goneStep.error);

// A password recorded before secrets were kept: mask, nothing behind it.
const legacy = await replay((c) => {
  delete c.steps.find((s) => s.secret).sealed;
});
const legacyStep = legacy.steps.find((s) => s.secret);
check('a legacy masked password fails instead of typing bullets', legacyStep.status === 'failed' && legacyStep.failureKind === 'secret-missing', legacyStep.error);
check('  …and the site was never logged into with the mask', !legacy.seen.secure);

// The site raises a confirm but the recording expected a prompt there.
const changed = await replay((c) => {
  const st = c.steps.find((s) => (s.dialog || []).some((d) => d.kind === 'confirm'));
  st.dialog = [{ kind: 'prompt', message: 'something else', accept: true, text: 'x' }];
});
const changedStep = changed.steps.find((s) => (s.dialog || []).some((d) => d.text === 'x'));
check('an unexpected dialog fails its step and is dismissed', changedStep.status === 'failed' && changedStep.failureKind === 'dialog-mismatch', changedStep.error);

fs.rmSync(tmp, { recursive: true, force: true });
// The recording is a test artefact, not a flow the user made.
fs.rmSync(`${sessionDir(session.id)}.json`, { force: true });
fs.rmSync(sessionDir(session.id), { recursive: true, force: true });
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

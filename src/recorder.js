import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { stepTitle, describeLocator } from './locator.js';
import { generateSpec } from './codegen.js';
import { profileDir } from './browser.js';
import { GENERATED_DIR, SESSIONS_DIR, shotDir, sessionDir } from './store.js';
import { sealStep } from './secrets.js';
import { storeUpload } from './uploads.js';
import { frameScope } from './frames.js';
import { isConsentAnswer } from './steps.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INJECT = path.join(HERE, 'recorder-inject.js');

const RECORDABLE = new Set([
  'click', 'fill', 'select', 'press', 'upload',
  // Checks picked from the recording badge.
  'assertText', 'assertValue', 'assertChecked', 'assertUrl',
]);


// Drives the recording Edge window. User actions arrive from the injected page
// script through an exposed binding; navigations are tracked Node-side via
// framenavigated, which covers full loads, SPAs and popups uniformly.
export class Recorder {
  // Defaults to the store's sessions directory. An empty default made
  // `path.join('', id, 'profile')` relative to whatever directory the process
  // was started from, so the CLI and the tests scattered logged-in browser
  // profiles across the project root, where deleting the flow never removed them.
  constructor(session, sessionsDir = SESSIONS_DIR) {
    this.session = session;
    // Where this recording's browser profile lives, so the flow keeps its
    // cookies and logins between recordings instead of starting from nothing
    // each time.
    this.sessionsDir = sessionsDir;
    this.context = null;
    this.page = null;
    this.t0 = Date.now();
    // Set while capturing a single step into an existing flow. The scratch
    // session collects the step so the existing flow is never appended to, and
    // the real session stays out of it entirely.
    this.capturing = null;
  }

  // Records exactly one action into an existing flow at `at`. The browser is
  // the only place a locator can be discovered, but recording a whole session
  // to obtain one step throws away everything else it saw, so the capture stops
  // itself at the first action.
  // Arms the capture and returns a promise for its result. Deliberately *not*
  // awaiting the action here: the caller needs the browser open before it can
  // act, so the promise it gets back is what blocks, not this call.
  async captureOne({ at }) {
    const scratch = {
      id: `${this.session.id}-capture`,
      name: this.session.name,
      status: 'recording',
      channel: this.session.channel,
      startUrl: this.session.startUrl,
      createdAt: Date.now(),
      finishedAt: null,
      error: null,
      steps: [],
      replay: null,
      runs: [],
      // In memory only: a scratch session must never be written to disk, so
      // `persist` is a no-op rather than a call that would create a file.
      persist() {},
      emit() {},
      publicView() {
        return { id: this.id, status: this.status, steps: this.steps };
      },
    };
    this.capturing = { at, done: null, settled: false };
    // Re-point the recorder at the scratch session for the duration, so every
    // existing code path collects into it without a special case.
    const real = this.session;
    this.session = scratch;
    this.capturing.real = real;
    this.capturing.done = new Promise((resolve) => {
      this.capturing.resolve = resolve;
    });
    try {
      await this.start();
    } catch (err) {
      this.session = real;
      this.capturing = null;
      throw err;
    }
    return this.capturing.done;
  }

  // Hands the captured step back and restores the recorder. The step is what
  // was actually seen in the browser, so its locator is a real one rather than
  // a guess.
  finishCapture() {
    const { capturing, session: scratch } = this;
    this.session = capturing.real;
    this.capturing = null;
    // Navigations are how the user *got* to the element, not the step itself, so
    // they are dropped: arriving at a page is not something the capture was
    // asked to record. More than one remaining action means the user did
    // something the capture did not ask for, and reporting that beats inserting
    // a guess.
    const acted = scratch.steps.filter((s) => s.type !== 'navigate');
    return acted.length === 1 ? acted[0] : null;
  }

  async start() {
    const { session } = this;
    session.status = 'recording';
    session.persist();
    session.emit('status', session.publicView());

    this.context = await chromium.launchPersistentContext(profileDir(this.sessionsDir, session.id, true), {
      channel: session.channel,
      headless: false,
      viewport: null,
      args: ['--start-maximized'],
    });

    // The binding's source says which tab and frame an action came from, which
    // the page itself cannot always know — a cross-origin iframe cannot see its
    // own <iframe> element. Both are resolved here before the step is stored.
    await this.context.exposeBinding('__recordEmit', (source, step) => this.onAction(step, source));
    await this.context.addInitScript({ path: INJECT });
    // Init scripts run when a document is created by a navigation. A frame
    // whose document is replaced in place — `document.open()`, a blob URL
    // written into an iframe, as the WordPress block editor builds its canvas
    // — gets a new document without one, so typing there went unrecorded.
    // Every frame navigation is checked and the recorder installed where it is
    // missing; the script guards against installing twice.
    this.injectSource = fs.readFileSync(INJECT, 'utf8');

    this.page = this.context.pages()[0] || (await this.context.newPage());
    // Tabs in the order they opened: 0 is the window the recording started in,
    // 1 the first popup, and so on. Replay opens them by repeating the step that
    // opened them, so a step only needs to say which one it acts in.
    this.pages = [this.page];
    this.context.on('page', (p) => {
      this.pages.push(p);
      this.trackNavigation(p);
    });
    this.trackNavigation(this.page);
    this.page.on('close', () => {
      if (!this.context) return;
      // Closing the window ends a capture by cancellation, which resolves to no
      // step; a full recording reports why it ended.
      if (this.capturing) this.stopCapture();
      else this.stop('Recording window was closed');
    });

    if (session.startUrl && session.startUrl !== 'about:blank') {
      await this.page.goto(session.startUrl, { waitUntil: 'domcontentloaded' }).catch((e) => {
        session.error = String(e.message || e);
      });
    } else {
      await this.page.goto('about:blank');
    }

    session.emit('status', session.publicView());
    return session.publicView();
  }

  trackNavigation(page) {
    page.on('framenavigated', (frame) => {
      // Child frames: make sure the recorder is in the frame's document. The
      // guard is checked first so a frame that has it is not evaluated twice.
      if (frame !== page.mainFrame()) {
        frame
          .evaluate((src) => {
            if (!document.__recordInstalled) (0, eval)(src);
          }, this.injectSource)
          .catch(() => {});
        return;
      }
      // A popup's own loads are a consequence of the click that opened it, which
      // is already a step; recording them as "Open URL" would navigate the main
      // window away at replay.
      if (page !== this.page) return;
      const url = frame.url();
      if (!url || url === 'about:blank') return;
      // Recorded as a plain "Open URL" for now. Whether the user's own action
      // caused it is only known from inside the page (see `markCaused`), and
      // that message arrives a moment later.
      this.push({ type: 'navigate', url });
    });
  }

  // A navigation the user's action caused — a form post landing on its result,
  // a link, a router following a click — is not something to repeat at replay:
  // loading the URL again re-requests a POST's result page as an empty GET, and
  // wipes a single-page app's state. It is kept as where the flow is expected
  // to arrive, and replay waits for that instead.
  //
  // The page reports it: a document reached through a user gesture inherits
  // the gesture's activation, a typed URL does not; and a same-document route
  // change is always the page's own code reacting to something. Timing is not
  // used — a person can type a new URL a second after a click.
  markCaused(url) {
    const { steps } = this.session;
    for (let i = steps.length - 1; i >= Math.max(0, steps.length - 4); i--) {
      const step = steps[i];
      if (step.type !== 'navigate' || step.url !== url) continue;
      // The flow's opening navigation is where replay starts; it has to load,
      // whatever brought the recording browser there.
      if (i === 0) return;
      step.caused = true;
      step.title = `Arrive at ${url}`;
      // A router that passes through an intermediate route on its way (Vue
      // goes `#/` then `#/active` on one click) leaves a navigation with no
      // action between it and this one. Only this one is where the action
      // led; replaying the transient one would either reload the page or
      // wait for a route the app has already left. The flow's opening
      // navigation is never dropped: it is where the flow starts.
      const before = steps[i - 1];
      if (before && before.type === 'navigate' && i - 1 > 0) {
        steps.splice(i - 1, 1);
        reindex(this.session);
      }
      this.session.persist();
      this.session.emit('status', this.session.publicView());
      return;
    }
    // The page's report beat the browser's navigation event; applied when the
    // step is pushed.
    (this.pendingCaused ||= new Set()).add(url);
  }

  // Which tab a binding call came from, by opening order.
  pageIndex(source) {
    const at = source && source.page ? this.pages.indexOf(source.page) : -1;
    return at > 0 ? at : 0;
  }

  // The flow files belong to. During a capture `this.session` is a scratch copy
  // whose id names no directory, and an upload stored under it would be lost
  // the moment the captured step was spliced into the real flow.
  flowId() {
    return this.capturing ? this.capturing.real.id : this.session.id;
  }

  // Binding calls are handled one at a time, in arrival order. Working out a
  // step's frame is asynchronous, so handling them concurrently would let a
  // quick top-frame click overtake a fill inside an iframe that came first.
  onAction(raw, source) {
    this.queue = (this.queue || Promise.resolve())
      .then(() => this.handle(raw, source))
      .catch((err) => {
        this.session.error = `recorder: ${String((err && err.message) || err)}`;
      });
    return this.queue;
  }

  async handle(raw, source) {
    // Commands come from the page badge, and are acted on even while paused —
    // otherwise there would be no way back from a pause.
    if (raw && raw.type === 'command') {
      this.command(raw.command);
      return;
    }
    if (this.session.status !== 'recording') return;
    if (!raw) return;
    // A dialog is not a step of its own: it is how the step that raised it was
    // answered, and replay has to give the answer while that step runs.
    if (raw.type === 'dialog') {
      this.attachDialog(raw, this.pageIndex(source));
      return;
    }
    // The page's own report on how it got to a URL: a full load reached by a
    // user gesture, or a client-side route change. Either way it was the
    // user's action, not a typed address. Only the top window of the main tab
    // speaks for the flow's navigation steps.
    if ((raw.type === 'ready' && raw.byGesture) || raw.type === 'navigate') {
      if (this.pageIndex(source) === 0 && raw.url) this.markCaused(raw.url);
      return;
    }
    if (!RECORDABLE.has(raw.type)) return;
    const where = {
      page: this.pageIndex(source),
      frame: source && source.frame ? await frameScope(source.frame).catch(() => null) : null,
    };
    this.push({ ...raw, ...where });
    // A capture ends at the first action. A navigation is not one: the user is
    // still getting to the thing they meant to act on.
    if (this.capturing && raw.type !== 'navigate') {
      this.stopCapture();
    }
  }

  // Pins a dialog's answer on the most recent action in the same tab. A page can
  // raise several in a row (an alert after a confirm), so they are kept in order.
  attachDialog(raw, page) {
    const { session } = this;
    for (let i = session.steps.length - 1; i >= 0; i--) {
      const step = session.steps[i];
      if (step.type === 'navigate' || (step.page || 0) !== page) continue;
      const answer = {
        kind: raw.kind,
        message: String(raw.message || '').slice(0, 500),
        // alert has nothing to choose; confirm is accept/dismiss; prompt is the
        // text typed, or null when cancelled.
        accept: raw.kind === 'alert' ? true : raw.kind === 'confirm' ? !!raw.answer : raw.answer !== null,
        text: raw.kind === 'prompt' && raw.answer !== null ? String(raw.answer) : null,
      };
      step.dialog = [...(step.dialog || []), answer];
      session.persist();
      session.emit('step', { step: stepView(step) });
      return;
    }
  }

  // Pausing keeps the browser open and simply stops collecting steps. Resuming
  // continues the same recording: the step list is never truncated, so a pause
  // costs nothing but the interval.
  command(name) {
    const { session } = this;
    if (name === 'pause') {
      if (session.status !== 'recording') return;
      session.status = 'paused';
      session.persist();
      session.emit('status', session.publicView());
      this.notifyBadge('paused');
      return;
    }
    if (name === 'resume') {
      if (session.status !== 'paused') return;
      session.status = 'recording';
      session.persist();
      session.emit('status', session.publicView());
      this.notifyBadge('recording');
      return;
    }
    if (name === 'stop') {
      // Stopping during a capture means the user changed their mind, so it
      // cancels rather than finalising the borrowed flow.
      if (this.capturing) this.stopCapture();
      else this.stop();
    }
  }

  // Pushes the recorder's real state onto the badge, so what the page shows
  // reflects the server rather than what the page last assumed.
  notifyBadge(state, count) {
    for (const page of this.context ? this.context.pages() : []) {
      page
        .evaluate(
          ([s, n]) => window.__recordBadge && window.__recordBadge(s, n),
          [state, count ?? null],
        )
        .catch(() => {});
    }
  }

  push(raw) {
    const { session } = this;
    // A router that both pushes and replaces the same URL (Vue's does on load)
    // reports one arrival twice. Replaying it twice is a reload in the middle
    // of a flow, which throws away client state the next step depends on.
    if (raw.type === 'navigate') {
      const last = session.steps[session.steps.length - 1];
      if (last && last.type === 'navigate' && last.url === raw.url) return;
    }
    // Drop an immediately preceding focus-click on the same element; the step
    // below carries the same intent and focuses as part of acting.
    this.dropFocusClick(session, raw);

    const step = {
      id: `${session.id}-${session.steps.length + 1}`,
      index: session.steps.length + 1,
      type: raw.type,
      locator: raw.locator || null,
      // The name a person would use for the element. Replay ignores it, but the
      // no-code editor shows it instead of a raw locator.
      label: raw.label || null,
      // Full fallback chain, best first. Replay tries each in turn, so a step
      // survives DOM churn that breaks the primary locator.
      candidates: raw.candidates && raw.candidates.length ? raw.candidates : raw.locator ? [raw.locator] : [],
      // What the element was, for verifying a position-based match at replay.
      fingerprint: raw.fingerprint || null,
      value: raw.value,
      key: raw.key,
      url: raw.url,
      ...(raw.match ? { match: raw.match } : {}),
      // Which tab (by opening order) and which iframe chain the step acts in.
      // Omitted for the common case so a plain flow's file is unchanged.
      ...(raw.page ? { page: raw.page } : {}),
      ...(raw.frame ? { frame: raw.frame } : {}),
      offsetMs: Date.now() - this.t0,
      title: stepTitle(raw),
      detail: raw.locator ? describeLocator(raw.locator) : raw.url,
      status: 'recorded',
      error: null,
      shot: null,
    };
    // A password is kept encrypted with only the mask in `value`, so it can be
    // replayed without ever being readable from the session file, the GUI or a
    // generated spec.
    if (raw.secret) sealStep(step, raw.value ?? '');
    // The file bytes are copied into the flow, so the replay uploads what was
    // uploaded here even on a machine where the original path means nothing.
    if (raw.type === 'upload') {
      step.file = {
        source: 'stored',
        files: (raw.files || []).map((f) => storeUpload(this.flowId(), f)),
      };
      step.value = step.file.files.map((f) => f.name).join(', ');
    }

    // A cookie-banner answer starts out "can be skipped" (see isConsentAnswer).
    if (isConsentAnswer(step)) step.optional = true;
    session.steps.push(step);
    reindex(session);
    session.persist();
    session.emit('step', { step: stepView(step) });
    // Repainted with the current state so the badge is a progress readout, not
    // just a presence indicator.
    this.notifyBadge(session.status === 'paused' ? 'paused' : 'recording', session.steps.length);
    // The page already said this URL was reached by the user's own action,
    // before the browser's navigation event created the step.
    if (step.type === 'navigate' && this.pendingCaused && this.pendingCaused.delete(step.url)) {
      this.markCaused(step.url);
    }
  }

  // A click that only focuses a field is a side effect of clicking into it
  // before typing, not user intent. Replay's fill() focuses on its own, so a
  // standalone focus click is a step that only adds a way to fail.
  dropFocusClick(session, raw) {
    if (raw.type !== 'fill' && raw.type !== 'select' && raw.type !== 'press') return;
    const last = session.steps[session.steps.length - 1];
    if (!last || last.type !== 'click') return;
    if (locatorKeyOf(last.locator) === locatorKeyOf(raw.locator)) session.steps.pop();
  }

  async stop(reason) {
    const { session } = this;
    // A paused recording is still a recording: stopping from the pause state has
    // to finalise it exactly as stopping from the recording state does.
    if (session.status !== 'recording' && session.status !== 'paused') {
      return session.publicView();
    }
    session.status = 'recorded';
    session.finishedAt = Date.now();
    if (reason && reason !== 'user') session.error = reason;
    this.writeArtifacts();
    session.persist();
    session.emit('status', session.publicView());

    const ctx = this.context;
    this.context = null;
    this.page = null;
    if (ctx) await ctx.close().catch(() => {});
    return session.publicView();
  }

  // Closes the capture's browser and hands back the step. Separate from `stop`
  // because a capture must not write artifacts or a spec for the flow it is
  // only borrowing a step from.
  async stopCapture() {
    const capturing = this.capturing;
    if (!capturing || capturing.settled) return;
    capturing.settled = true;
    const ctx = this.context;
    this.context = null;
    this.page = null;
    if (ctx) await ctx.close().catch(() => {});
    const step = this.finishCapture();
    // A cancelled capture resolves to null rather than rejecting: the user
    // closing the window is a normal outcome, not a failure.
    capturing.resolve({ step, at: capturing.at });
  }

  writeArtifacts() {
    const { session } = this;
    fs.mkdirSync(shotDir(session.id), { recursive: true });
    const spec = generateSpec(session);
    const specPath = path.join(GENERATED_DIR, `${session.id}.spec.js`);
    fs.writeFileSync(specPath, spec);
    session.spec = {
      path: path.relative(process.cwd(), specPath).replace(/\\/g, '/'),
      code: spec,
    };
  }
}

export function stepView(step) {
  // A step built outside the recorder — a check inserted by hand, a step a
  // test composed directly — may have no title. The view derives one from the
  // type and label then, rather than showing `undefined`. A stored title is
  // kept as it is: older recordings carry a title but no separate label, and
  // deriving it anew would replace their words with raw locator syntax.
  const label = step.label || null;
  return {
    id: step.id,
    index: step.index,
    type: step.type,
    title: step.title || stepTitle({ ...step, label: label || describeLocator(step.locator) }),
    detail: step.detail,
    label,
    value: step.value,
    candidates: step.candidates || [],
    url: step.url,
    offsetMs: step.offsetMs,
    status: step.status,
    error: step.error || null,
    // Which locator the run settled on, and how long it waited for it to turn
    // up. The GUI shows both, because a step that only ever passes on its third
    // candidate is a step whose first two locators have quietly gone stale.
    resolvedLocator: step.resolvedLocator || null,
    locatorWaitMs: step.locatorWaitMs ?? null,
    // How an assertion compares its expected value (contains/equals/regex).
    match: step.match || null,
    // Replay skips the step, instead of failing, when its element is absent.
    optional: !!step.optional,
    // 'locator-timeout' when every stored locator was given its full wait and
    // none matched; 'action-failed' when one resolved but the click or fill
    // did not go through; 'assertion-failed' when the element was there but
    // the page did not show what the step expected. Each needs a different fix.
    failureKind: step.failureKind || null,
    // Same fields as the stored view, so a live step and a reloaded one render
    // the same: whether a password is kept, what an upload sends, how dialogs
    // are answered, and which tab and frame the step acts in.
    secret: !!step.secret,
    secretStored: !!step.sealed,
    file: step.file || null,
    dialog: step.dialog || null,
    page: step.page || 0,
    frame: step.frame || null,
    // What a run actually uploaded, and why a dialog failed the step.
    uploaded: step.uploaded || null,
    dialogError: step.dialogError || null,
  };
}

export { sessionDir };

// Steps are positional: index and id must follow the list after any edit
// (reorder, delete, insert). Callers edit the array; this keeps identity in
// sync so the UI and SSE events never address a step that has moved.
export function reindex(session) {
  session.steps.forEach((step, i) => {
    step.index = i + 1;
    step.id = `${session.id}-${i + 1}`;
  });
}

export function locatorKeyOf(locator) {
  if (!locator) return '';
  return locator.strategy === 'role'
    ? `role:${locator.role}|${locator.name}`
    : `${locator.strategy}:${locator.value}`;
}
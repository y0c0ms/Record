import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { FALLBACK_WAIT_MS, LOCATOR_WAIT_MS, chainFor, resolveCandidate, toLocator } from './locator.js';
import { assertElement, assertLocator, assertUrl, matchMode } from './assertions.js';
import { resolveDataset, valueForStep } from './dataset.js';
import { SESSIONS_DIR, shotDir } from './store.js';
import { stepView } from './recorder.js';
import { resolvedRung, safeScreenshotName } from './steps.js';
import { profileDir } from './browser.js';
import { revealStep } from './secrets.js';
import { filesForStep } from './uploads.js';
import { describeFrame, scopeRoot } from './frames.js';

// Removes third-party overlays that sit on top of the content. Matches the
// vendor list the recorder ignores, so a step the recorder never recorded can
// never block one it did. Runs on a timer for a few seconds because these
// widgets are injected late.
const OVERLAY_DISMISS = `
(() => {
  const PATTERNS = [/usercentrics/i, /cookiebot/i, /onetrust/i, /cookie[-_]?consent/i,
                    /cookie[-_]?banner/i, /cmp[-_]?container/i, /hubspot/i, /intercom/i,
                    /drift[-_]?frame/i, /zsiq/i, /liveperson/i, /qc-cmp/i, /truste|trustarc/i,
                    /didomi/i,
                    // Federated/Consentmanager-style CMPs namespace everything
                    // fc- and mark the dialog itself role=dialog rather than
                    // aria-modal, so without this their root is invisible to
                    // the sweep and the overlay keeps eating the click.
                    /fc-(consent|dialog)/i];
  const ACCEPT = /^(accept|accept all|agree|allow all|acceptar|aceitar|ok|got it|allow|consentir|consent|同意|zustimmen|accepter|j'accepte)/i;

  // Only a vendor's layer is an overlay to sweep. Any dialog used to count,
  // which hid the application's own modals — WordPress' welcome guide, a
  // Salesforce record form, a confirm sheet — so the step the user recorded
  // inside one had nothing to click. The recorder keeps those steps; replay
  // has to leave the dialog in place for them.
  const isOverlay = (n) => {
    if (!n || n.nodeType !== 1) return false;
    const id = n.id || '';
    const cls = typeof n.className === 'string' ? n.className : '';
    for (const re of PATTERNS) if (re.test(id) || re.test(cls)) return true;
    return false;
  };

  const sweep = () => {
    // Every match is dealt with, not just the first. A CMP can re-render the
    // moment it is hidden, and a sweep that stopped at the first hit left the
    // scrim and the dialog — siblings of the node it hid — covering the page.
    for (const n of document.querySelectorAll('[id],[class],[role],[aria-modal]')) {
      let overlay = n;
      for (let i = 0; i < 6 && overlay; i++) {
        if (isOverlay(overlay)) break;
        overlay = overlay.parentElement;
      }
      if (!overlay || !isOverlay(overlay)) continue;

      // Prefer clicking an accept button: that is what a user does, and it
      // keeps the site in the state the recording was made in. The search is
      // over the whole overlay's buttons rather than the first one, because a
      // CMP that leads with "Learn more" would otherwise never be dismissed.
      // Searched through the banner's shadow root too: Usercentrics renders
      // its buttons inside one.
      const scope = overlay.shadowRoot || overlay;
      const buttons = [...scope.querySelectorAll('button,[role=button],input[type=submit],a.button')];
      // A banner that renders into a shadow root inserts its host first and
      // its buttons a moment later. Hidden now, it would never be answered —
      // and an empty host covers nothing — so it is left for a later pass.
      if (overlay.shadowRoot && !buttons.length) continue;
      const accept = buttons.find((b) => ACCEPT.test((b.innerText || b.value || '').trim()));
      if (accept) {
        accept.click();
        continue;
      }

      // Nothing to click, so it has to go. The host is only hidden when it is
      // itself a fixed-position layer — otherwise it is page content and
      // hiding it would blank the site. The overlay goes either way, and so
      // does the host when it is fixed, because that is the scrim.
      const host = overlay.parentElement;
      if (host && host !== document.body && getComputedStyle(host).position === 'fixed') {
        host.style.display = 'none';
      }
      overlay.style.display = 'none';
      // Siblings of the matched node share the same layer: a dialog and its
      // scrim are siblings, so hiding one leaves the other on top of the page.
      for (const sib of overlay.parentElement ? [...overlay.parentElement.children] : []) {
        if (sib !== overlay && isOverlay(sib)) sib.style.display = 'none';
      }
    }
  };

  sweep();
  let tries = 0;
  const timer = setInterval(() => {
    if (++tries > 40) return clearInterval(timer);
    sweep();
  }, 250);
})();
`;

// How long an optional step looks for its element before it is skipped.
const OPTIONAL_WAIT_MS = 5000;

// Bounds a promise that has no timeout of its own. Playwright's budgets cover a
// click or a fill, but a promise that never settles at all — a goto on a site
// that stalls, a binding that never answers — has nothing to bound it, and a
// run must always reach its final record rather than hanging with none.
function withDeadline(promise, ms, message) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// A replay badge in the page being driven, so a run can be paused, resumed or
// interrupted from the browser itself. Same corner and same hover rule as the
// recording badge: the badge never takes pointer events, only its controls do.
const REPLAY_BADGE = `
(() => {
  if (window.__replayBadgeInstalled) return;
  window.__replayBadgeInstalled = true;
  if (window.top !== window.self) return;

  const paint = () => {
    if (document.getElementById('__replay_badge__')) return;
    const badge = document.createElement('div');
    badge.id = '__replay_badge__';
    badge.setAttribute('data-record-ignore', '');
    badge.style.cssText = [
      'position:fixed', 'bottom:14px', 'right:14px', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'gap:8px', 'padding:7px 12px',
      'border-radius:999px',
      'font:600 12px/1 -apple-system,Segoe UI,Roboto,sans-serif',
      'background:#0b1020', 'color:#fff', 'pointer-events:none',
      'box-shadow:0 6px 20px rgba(0,0,0,.35)',
    ].join(';');

    const pad = document.createElement('div');
    pad.id = '__replay_pad__';
    pad.setAttribute('data-record-ignore', '');
    pad.style.cssText = [
      'position:fixed', 'bottom:0', 'right:0',
      'width:240px', 'height:76px', 'z-index:2147483646',
    ].join(';');

    const dot = document.createElement('span');
    dot.style.cssText =
      'width:9px;height:9px;border-radius:50%;background:#3b82f6;animation:__rep_pulse 1.1s infinite';
    const style = document.createElement('style');
    style.textContent = '@keyframes __rep_pulse{0%{opacity:1}50%{opacity:.25}100%{opacity:1}}';
    (document.head || document.documentElement).appendChild(style);

    const label = document.createElement('span');
    label.id = '__replay_label__';
    label.textContent = 'REPLAY';
    badge.appendChild(dot);
    badge.appendChild(label);

    const command = (text, title, name, color) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('data-record-ignore', '');
      button.textContent = text;
      button.title = title;
      button.style.cssText = [
        'display:none', 'pointer-events:auto', 'border:0', 'border-radius:999px',
        'padding:5px 10px', 'cursor:pointer',
        'font:600 11px/1 -apple-system,Segoe UI,Roboto,sans-serif',
        'background:' + color, 'color:#fff',
      ].join(';');
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.__replayCommand && window.__replayCommand(name);
      });
      badge.appendChild(button);
      return button;
    };

    const pause = command('❙❙ Pause', 'Pause the run', 'pause', '#5b6b8c');
    const resume = command('▶ Resume', 'Resume the run', 'resume', '#1f9d55');
    const stop = command('■ Stop', 'Stop the run', 'interrupt', '#ff3b47');

    const showOnly = (...wanted) => {
      for (const [b, on] of [[pause, wanted.includes('pause')], [resume, wanted.includes('resume')], [stop, wanted.includes('stop')]]) {
        b.style.display = on ? 'inline-block' : 'none';
      }
    };
    const controlsFor = (state) => (state === 'paused' ? ['resume', 'stop'] : ['pause', 'stop']);

    pad.addEventListener('mouseenter', () => showOnly(...controlsFor(badge.dataset.state || 'running')));
    pad.addEventListener('mouseleave', (event) => {
      const to = event.relatedTarget;
      if (to && badge.contains(to)) return;
      setTimeout(() => {
        if (badge.matches(':hover') || pad.matches(':hover')) return;
        showOnly();
      }, 180);
    });

    window.__replayBadge = (state, progress) => {
      badge.dataset.state = state;
      const word = state === 'paused' ? 'PAUSED' : state === 'cancelled' ? 'STOPPED' : 'REPLAY';
      label.textContent = progress == null ? word : word + ' ' + progress;
      dot.style.background = state === 'paused' ? '#f0a92a' : state === 'cancelled' ? '#94a3b8' : '#3b82f6';
      dot.style.animationPlayState = state === 'running' ? 'running' : 'paused';
      if (badge.matches(':hover') || pad.matches(':hover')) showOnly(...controlsFor(state));
    };

    const root = document.body || document.documentElement;
    root.appendChild(pad);
    root.appendChild(badge);
  };
  if (document.body) paint();
  else document.addEventListener('DOMContentLoaded', paint, { once: true });
})();
`;

// Replays a recorded session in Edge, one step at a time, streaming status and a
// screenshot per step. Same locator code path the generated spec uses, so a green
// replay and a green `playwright test` run agree.
export class Replayer {
  // Two budgets, deliberately different. `locatorWait` bounds how long one
  // stored locator is given to resolve before the next one in the chain is
  // tried — a full thirty seconds each, because a page that was warm when it
  // was recorded is cold when it is replayed, and a short probe calls an
  // element that is about to appear "missing". `timeout` then bounds the
  // actual click/fill, which must still wait out a late-loading overlay.
  constructor(
    session,
    {
      headed = true,
      shots = true,
      slowMo = 0,
      timeout = 10000,
      locatorWait = LOCATOR_WAIT_MS,
      dataset = {},
      // Same default as the recorder, for the same reason: an empty one put
      // headed profiles under the caller's working directory.
      sessionsDir = SESSIONS_DIR,
      // Awaited after every step, with the step and the tab it acted in, before
      // the next step starts and before the browser closes. For a caller that
      // has to read the page as the run leaves it — events arrive too late,
      // after the browser may already be gone.
      afterStep = null,
    } = {}
  ) {
    this.session = session;
    // Where a headed run's browser profile lives. Held here because the run may
    // outlive the request that started it, so the directory cannot be recomputed
    // from a value the caller has since changed.
    this.sessionsDir = sessionsDir;
    this.opts = { headed, shots, slowMo };
    this.timeout = timeout;
    this.locatorWait = locatorWait;
    this.afterStep = afterStep;
    this.context = null;
    this.page = null;
    this.pages = [];
    // Answers still owed to dialogs the running step will raise, and the step
    // they belong to. See `watchDialogs`.
    this.dialogs = [];
    this.dialogStep = null;
    this.cancelled = false;
    // Resolves when the run is paused, so the step loop can await it instead of
    // spinning. Held as a promise rather than a flag so pause costs nothing
    // while the run is in motion.
    this.paused = null;
    // What this run will actually use, resolved once so the run report and the
    // steps can never disagree about it.
    this.dataset = resolveDataset(session.steps, dataset);
  }

  // The longest a step may legitimately take: the full wait for its first
  // locator, a probe for each fallback it also stored, and the action itself.
  // Shared with the resolve call so the deadline and the ladder cannot drift
  // apart — a step whose own budget outlasts its deadline aborts on a working
  // locator.
  stepBudget(step) {
    // Every rung the resolver will try, and the position fallback after them.
    const rungs = chainFor(step).length + 1;
    return this.locatorWait + Math.max(rungs - 1, 5) * FALLBACK_WAIT_MS + this.timeout + 10000;
  }
  emit(event) {
    this.session.emit('replay', event);
  }

  // A run is kept forever: what it used, what passed, and where it failed. The
  // current `session.replay` holds only the latest state — without this, a green
  // run followed by a red one would erase the evidence of the green one.
  recordRun() {
    const { session } = this;
    const run = {
      // The same id as the screenshot directory, so a report and its pictures
      // can never be separated.
      id: this.runId,
      startedAt: session.replay.startedAt,
      finishedAt: session.replay.finishedAt,
      status: session.replay.status,
      total: session.replay.total,
      passed: session.replay.passed,
      failed: session.replay.failed,
      skipped: session.replay.skipped || 0,
      dataset: this.dataset,
      steps: session.steps.map((s) => ({
        index: s.index,
        type: s.type,
        // What the step *was*, not just its number: a run record that says
        // "step 7 passed" cannot be read a year later without the flow beside
        // it, and the flow can change.
        title: s.title,
        label: s.label || null,
        status: s.status,
        error: s.error || null,
        durationMs: s.durationMs || 0,
        shot: s.shot || null,
        // Which rung resolved, and the rung itself. A step that passed on a
        // fallback is the one worth knowing about: it means the locator the
        // recording chose no longer works on this page.
        locator: s.resolvedLocator || null,
        locatorRung: resolvedRung(s),
        locatorCount: (s.candidates || []).length,
        locatorWaitMs: s.locatorWaitMs || 0,
        // The files an upload step actually sent, by name and size, so a run
        // shows which document went in — the flow's choice can change later.
        uploaded: s.uploaded || null,
      })),
    };
    // Guarded by id: a run is identified by the directory its screenshots went
    // to, so a second write of the same id is a duplicate, not a new run. This
    // also protects against a double finalisation racing on the same run.
    const existing = (session.runs || []).findIndex((r) => r.id === this.runId);
    if (existing >= 0) return session.runs[existing];
    session.runs = [run, ...(session.runs || [])].slice(0, 20);
    return run;
  }

  async start() {
    const { session } = this;
    // Allocated before the first step so every screenshot of this run lands in
    // one directory, including the ones taken while it is still failing.
    this.runId = `run${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    session.replay = {
      status: 'running',
      total: session.steps.length,
      passed: 0,
      failed: 0,
      // Steps that were not run because there was nothing to do: a click on
      // a cookie banner replay had already dismissed. Not passes.
      skipped: 0,
      current: null,
      startedAt: Date.now(),
    };
    session.persist();
    this.emit({ type: 'replay:status', replay: session.replay });

    // Bounded: launching a persistent context blocks on the browser process,
    // and a stale profile lock or an already-running browser can leave it
    // waiting indefinitely. A run that cannot start must say so rather than
    // leaving `status: running` forever with nothing to interrupt.
    // The page size the flow was recorded at, when the recording kept one.
    // A maximised window is whatever the monitor allows, so a flow recorded on
    // a laptop and replayed on a desktop or headless would see a different
    // layout — and the position fallback, which is measured in that layout,
    // would point at the wrong place. Older recordings carry no size and keep
    // the maximised window they always had.
    const recorded = session.steps.find((s) => s.fingerprint && s.fingerprint.viewport);
    const size = recorded ? recorded.fingerprint.viewport : null;
    this.context = await withDeadline(
      chromium.launchPersistentContext(profileDir(this.sessionsDir, session.id, this.opts.headed), {
        channel: session.channel,
        headless: !this.opts.headed,
        viewport: size ? { width: size.w, height: size.h } : null,
        slowMo: this.opts.slowMo,
        args: size ? [] : ['--start-maximized'],
      }),
      60000,
      'the browser did not start'
    ).catch(async (err) => {
      // A run that never started is still a run: recorded as failed, so the
      // history shows why nothing ran rather than an empty gap.
      session.replay.status = 'failed';
      session.replay.finishedAt = Date.now();
      session.replay.failed = session.replay.total;
      session.replay.error = String(err.message || err);
      this.recordRun();
      this.emit({ type: 'replay:status', replay: session.replay });
      throw err;
    });
    this.page = this.context.pages()[0] || (await this.context.newPage());
    // Tabs in opening order, matching the recorder's numbering: a step recorded
    // in the first popup acts in pages[1]. Popups open because a replayed step
    // clicked whatever opened them, exactly as during recording.
    this.pages = [this.page];
    this.watchDialogs(this.page);
    this.context.on('page', (p) => {
      this.pages.push(p);
      this.watchDialogs(p);
    });

    // Consent banners and chat widgets load after the page and sit on top of
    // the content, so the first click after a navigation hits the overlay
    // instead of the element. The recorder ignores these by design; replay has
    // to get them out of the way the same way a user would.
    await this.context.addInitScript(OVERLAY_DISMISS);
    // The run's own controls, in the page being driven.
    await this.context.addInitScript(REPLAY_BADGE);
    // The badge's clicks arrive here rather than through the page's own JS, so
    // they are acted on even while the run is paused.
    await this.context.exposeBinding('__replayCommand', (_source, name) => {
      if (name === 'interrupt') this.interrupt();
      else if (name === 'pause') this.pause();
      else if (name === 'resume') this.resume();
    });

    // Run detached: the HTTP call returns immediately, progress arrives on SSE.
    this.done = this.run();
    return session.replay;
  }

  async run() {
    const { session } = this;
    // The per-run directory is created by `snapshot`, which is the only thing
    // that writes into it.
    fs.mkdirSync(shotDir(session.id), { recursive: true });

    for (const step of session.steps) {
      if (this.cancelled) break;
      // Checked before the step, not during: a pause must not abandon a step
      // halfway, or the run would resume on a page in an unknown state.
      if (this.paused) await this.paused;
      if (this.cancelled) break;

      step.status = 'running';
      // Cleared per step, not per run: the previous run's verdict on this step
      // says nothing about the one now in progress, and leaving it up would
      // show a passing run's locator next to a step that is still waiting.
      step.resolvedLocator = null;
      step.locatorWaitMs = null;
      step.failureKind = null;
      step.dialogError = null;
      step.uploaded = null;
      session.replay.current = step.index;
      this.emit({ type: 'step', step: stepView(step) });

      const started = Date.now();
      try {
        // Every step is bounded. The budget has to cover what the step can
        // legitimately spend: the full wait for the first locator, a probe for
        // each fallback, plus the click/fill itself. Sizing it any tighter
        // would abort a step that was still legitimately waiting for its
        // element to appear.
        await withDeadline(
          this.execute(step),
          this.stepBudget(step),
          `step ${step.index} did not finish`
        );
        await this.settleDialogs(step);
        step.status = 'passed';
        step.error = null;
      } catch (err) {
        // Marked "can be skipped" and its element is not on the page: the step
        // is reported as skipped, with why, and the run goes on. Only a missing
        // element qualifies — an optional step that was found and then failed
        // (a click that did not go through, a check that read the wrong text)
        // still fails, because that is the page misbehaving, not the step
        // being unneeded.
        if (step.optional && err && err.code === 'locator-timeout') {
          step.status = 'skipped';
          step.error = 'not on the page; skipped because the step is marked "can be skipped"';
        } else {
          step.status = 'failed';
          step.error = String((err && err.message) || err).split('\n').slice(0, 4).join(' ');
          // "We waited and the element never turned up" and "the selector was
          // wrong all along" are different bugs with different fixes, so the
          // kind is recorded rather than left to be read out of the message.
          step.failureKind = (err && err.code) || 'action-failed';
          // The screenshot of a failure is the most useful one there is: it shows
          // the page as it actually was when the step could not run.
          step.durationMs = Date.now() - started;
          if (this.opts.shots) {
            step.shot = await this.snapshot(step);
          }
          session.replay.failed += 1;
          this.emit({ type: 'error', message: step.error });
          this.emit({ type: 'step', step: stepView(step) });
          this.emit({ type: 'replay:status', replay: session.replay });
          break;
        }
      }

      // A click often triggers navigation. Without this the next step resolves
      // its locator against the previous document and times out.
      await this.page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});

      step.durationMs = Date.now() - started;
      if (this.opts.shots) {
        // The per-step snapshot is a debugging aid. A screenshot step already
        // took the picture it was asked for, and overwriting its `shot` with
        // the debug image would point the report at the wrong file and leave
        // the named one unreachable from the UI.
        if (step.type !== 'screenshot') {
          step.shot = await this.snapshot(step);
        }
      }

      // A hook that throws must not fail a step that passed.
      if (this.afterStep) await Promise.resolve(this.afterStep(step, this.page)).catch(() => {});
      if (step.status === 'passed') session.replay.passed += 1;
      if (step.status === 'skipped') session.replay.skipped = (session.replay.skipped || 0) + 1;
      session.persist();
      this.emit({ type: 'step', step: stepView(step) });
      this.emit({ type: 'replay:status', replay: session.replay });
    }

    // The single place a run is finalised and recorded. A run stopped by
    // `interrupt` arrives here too, so an interrupted run is still a run.
    session.replay.current = null;
    session.replay.status = this.cancelled
      ? 'cancelled'
      : session.replay.failed
        ? 'failed'
        : 'passed';
    session.replay.finishedAt = Date.now();
    const run = this.recordRun();
    session.persist();
    this.emit({ type: 'replay:status', replay: session.replay });
    this.emit({ type: 'run', run });

    const ctx = this.context;
    this.context = null;
    if (ctx) await ctx.close().catch(() => {});
    return session.replay;
  }

  // Stops the run but keeps the browser, so the user can look at where it got
  // to. Recording is left to `run()`: it reaches the same conclusion from the
  // loop's own exit, and two owners of finalisation would write the run twice.
  async interrupt() {
    if (this.cancelled) return;
    this.resume();
    this.cancelled = true;
    const { session } = this;
    session.replay.status = 'cancelled';
    session.persist();
    this.emit({ type: 'replay:status', replay: session.replay });
    this.paintBadge('cancelled');
  }

  // Each stored locator gets the full wait before the next is tried, then the
  // action runs once against whichever resolved. Which one resolved, and how
  // long it took to appear, are recorded on the step: a step that only ever
  // passes on its third locator is the kind of thing a user needs to see, and
  // without it the ladder looks like it was never used.
  async execute(step) {
    const page = await this.pageFor(step);
    // Inside an iframe the step's locators resolve against the frame, not the
    // page. The position fallback needs page coordinates, which a frame chain
    // does not have, so it is simply unavailable there.
    const root = scopeRoot(page, step.frame);
    const resolve = async (action) => {
      let found;
      try {
        found = await resolveCandidate(root, step, {
          action,
          // An optional step's element is there as the page settles or not
          // shown this visit at all (a cookie banner answered before); half a
          // minute of waiting changes neither, so it gets a short look.
          timeout: step.optional ? Math.min(this.locatorWait, OPTIONAL_WAIT_MS) : this.locatorWait,
        });
      } catch (err) {
        if (step.frame && err && err.message) err.message = `in frame ${describeFrame(step.frame)}: ${err.message}`;
        throw err;
      }
      step.resolvedLocator = found.locator;
      step.locatorWaitMs = found.waited * 1000;
      return found;
    };

    // Answers for any alert/confirm/prompt this step raises, in the order the
    // recording saw them.
    this.dialogs = Array.isArray(step.dialog) ? step.dialog.slice() : [];
    this.dialogStep = step;

    // Values come from the dataset when the step was parameterised, and from
    // the recording otherwise. A password's recorded value is only a mask; the
    // real one is decrypted here, at the last moment, and never stored on the
    // step or in the run.
    const value = this.valueFor(step);

    switch (step.type) {
      case 'navigate':
        // A navigation the previous action caused is not repeated: loading
        // the URL again would re-request a POST's result page as an empty GET
        // and wipe a single-page app's state. The step instead checks that the
        // action really did arrive there, which is what it recorded.
        if (step.caused) {
          await this.arrivedAt(page, step.url);
          return;
        }
        // Bounded, unlike the click budget: a real site routinely holds the
        // load event open for assets that never arrive, and an unbounded goto
        // hangs the whole run with no failure to show. `domcontentloaded` is
        // what the step needs anyway — the document is there to resolve against.
        await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: this.timeout });
        await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
        return;
      case 'click':
        await resolve((l) => l.click({ timeout: this.timeout }));
        return;
      case 'fill':
        // A date picker is not a text field. Its input is `readonly` with the
        // real calendar behind it, and Playwright's `fill` refuses a readonly
        // input outright — so a date could be recorded and then never replayed.
        // Setting the value directly and firing the events a framework listens
        // for covers plain inputs, readonly inputs and custom pickers alike.
        await this.fillValue(resolve, value);
        return;
      case 'select':
        await resolve((l) => l.selectOption(value, { timeout: this.timeout }));
        return;
      case 'press':
        await resolve((l) => l.press(value, { timeout: this.timeout }));
        return;
      case 'upload': {
        // Resolved before the locator, so a missing file fails as a missing
        // file rather than after thirty seconds of waiting for the input.
        const files = filesForStep(this.session.id, step);
        // setInputFiles works on the <input type=file> directly, hidden or not
        // — which it usually is, behind a styled "Choose file" button — and
        // never opens the OS file chooser, which would stall a headless run.
        await resolve((l) => l.setInputFiles(files, { timeout: this.timeout }));
        step.uploaded = files.map((f) => `${f.name} (${f.buffer.length} bytes)`);
        return;
      }
      case 'assertVisible':
        await resolve((l) => l.waitFor({ state: 'visible', timeout: this.timeout }));
        return;
      case 'assertText':
      case 'assertValue':
      case 'assertChecked': {
        // The element is found first and checked after. Checking inside the
        // resolver would turn a wrong value into "try the next rung", and a
        // page showing the wrong text would be reported as a missing element.
        let handle;
        await resolve(async (l) => {
          handle = l;
        });
        await assertElement(handle, step.type, value, matchMode(step), this.timeout);
        return;
      }
      case 'assertHidden':
      case 'assertCount': {
        // A claim about everything the locator matches, so none or several is
        // a valid answer: the primary rung is read as it stands rather than
        // resolved to one element. Fallback rungs would each count something
        // different, so they are not consulted.
        const primary = chainFor(step)[0];
        await assertLocator(toLocator(root, primary), step.type, value, this.timeout);
        step.resolvedLocator = primary;
        return;
      }
      case 'assertUrl':
        await assertUrl(page, value, matchMode(step), this.timeout);
        return;
      case 'wait':
        await page.waitForTimeout(step.ms || 0);
        return;
      case 'screenshot':
        // The named picture, which is the whole point of the step. `snapshot`
        // already runs after every step for debugging; this writes a file a
        // reader can find by the name they gave it.
        step.shot = await this.claim(String(value).trim());
        return;
      default:
        throw new Error(`unsupported step type: ${step.type}`);
    }
  }

  // The tab a step acts in. A popup opens asynchronously after the click that
  // caused it, so the step after that click may arrive before the tab exists;
  // it is waited for, bounded, rather than failing on a race the user never
  // sees. The tab becomes the one screenshots are taken of.
  async pageFor(step) {
    const want = Number.isInteger(step.page) && step.page > 0 ? step.page : 0;
    // A caller that hands the replayer its own page and drives `execute`
    // directly, without `start`, has one tab: that page.
    if (!this.pages.length && this.page) this.pages = [this.page];
    if (want >= this.pages.length) {
      const deadline = Date.now() + this.timeout;
      while (this.pages.length <= want && Date.now() < deadline) {
        await this.context.waitForEvent('page', { timeout: Math.max(1, deadline - Date.now()) }).catch(() => {});
      }
      if (this.pages.length <= want) {
        const err = new Error(
          `step ${step.index} acts in popup ${want}, but only ${this.pages.length - 1} popup(s) opened — ` +
            'the step that should have opened it did not',
        );
        err.code = 'popup-missing';
        throw err;
      }
    }
    const page = this.pages[want];
    if (want > 0) await page.waitForLoadState('domcontentloaded', { timeout: this.timeout }).catch(() => {});
    this.page = page;
    return page;
  }

  // Answers native dialogs the way the recording did. Without a handler
  // Playwright dismisses every dialog: a confirm that was accepted while
  // recording would be cancelled at replay, and the step would still pass.
  //
  // A dialog nobody recorded is dismissed and the step that raised it fails,
  // because a page asking something new is a change a reviewer has to see —
  // accepting it blindly could confirm a deletion nobody asked for.
  watchDialogs(page) {
    page.on('dialog', async (dialog) => {
      const step = this.dialogStep;
      const expected = this.dialogs && this.dialogs.length ? this.dialogs.shift() : null;
      if (!expected || expected.kind !== dialog.type()) {
        await dialog.dismiss().catch(() => {});
        if (step && dialog.type() !== 'beforeunload') {
          step.dialogError =
            `unexpected ${dialog.type()} "${dialog.message().slice(0, 120)}"` +
            (expected ? ` (recorded a ${expected.kind})` : ' (none was recorded)') +
            ' — dismissed';
        }
        return;
      }
      if (expected.accept) {
        await dialog.accept(dialog.type() === 'prompt' ? (expected.text ?? '') : undefined).catch(() => {});
      } else {
        await dialog.dismiss().catch(() => {});
      }
    });
  }

  // Waits for the page to reach where the recording's action led. Compared on
  // origin, path and hash: a query string routinely carries a session token or
  // a timestamp that is different every run, while the path is the page.
  async arrivedAt(page, url) {
    const key = (href) => {
      try {
        const u = new URL(href);
        return `${u.origin}${u.pathname}${u.hash}`;
      } catch {
        return href;
      }
    };
    const want = key(url);
    const deadline = Date.now() + this.timeout;
    while (key(page.url()) !== want && Date.now() < deadline) {
      await page.waitForTimeout(100);
    }
    if (key(page.url()) !== want) {
      const err = new Error(`expected the previous step to arrive at ${want}, but the page is at ${key(page.url())}`);
      err.code = 'navigation-mismatch';
      throw err;
    }
    await page.waitForLoadState('domcontentloaded', { timeout: this.timeout }).catch(() => {});
  }

  valueFor(step) {
    if (step.secret && !step.valueParam) return revealStep(step);
    return valueForStep(step, this.dataset);
  }

  // A dialog is raised by the page's own script after the action returns, so
  // the step waits a moment for the ones it recorded. A recorded dialog that
  // never appears, or one that was not recorded, fails the step: either way the
  // page did not behave as it did when the flow was recorded.
  async settleDialogs(step) {
    const deadline = Date.now() + 3000;
    while (this.dialogs.length && !step.dialogError && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // An unrecorded dialog that fires after this returns is still caught: the
    // handler is live, and it is pinned on whichever step is running by then.
    this.dialogStep = null;
    let message = step.dialogError;
    if (!message && this.dialogs.length) {
      const missed = this.dialogs[0];
      message = `expected a ${missed.kind} "${missed.message.slice(0, 120)}" that the page never raised`;
    }
    this.dialogs = [];
    if (message) {
      const err = new Error(message);
      err.code = 'dialog-mismatch';
      throw err;
    }
  }

  // Sets a value on whatever the locator resolved to, in a way that survives the
  // three shapes a form control comes in: an editable input, a readonly input
  // fronting a date picker, and a contenteditable element.
  async fillValue(resolve, value) {
    await resolve(async (handle) => {
      // The normal path first: it is the only one that produces a trusted input
      // event, which is what most frameworks already listen for.
      try {
        await handle.fill(value, { timeout: this.timeout });
        return;
      } catch {
        // A readonly input is the expected case for a date picker, so the
        // scripted path below is the real path, not an edge case.
      }
      await handle.evaluate(
        (node, text) => {
          const editable = node.isContentEditable;
          if (editable) {
            node.textContent = text;
          } else {
            // The native setter, so React and Vue see the change: assigning
            // `.value` directly bypasses their value tracking and the new value
            // is thrown away on the next render.
            const proto =
              node instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(node, text);
            else node.value = text;
          }
          // A date input keeps only a value it can parse, so a human-readable one
          // is normalised here instead of leaving the field silently empty.
          if (!editable && node.type === 'date' && node.value !== text) {
            const parsed = new Date(text);
            if (!Number.isNaN(parsed.getTime())) {
              node.value = parsed.toISOString().slice(0, 10);
            }
          }
          for (const type of ['input', 'change', 'blur']) {
            node.dispatchEvent(new Event(type, { bubbles: true }));
          }
        },
        value
      );
    });
  }

  async snapshot(step) {
    const name = `${String(step.index).padStart(3, '0')}.jpg`;
    try {
      const buf = await this.page.screenshot({ type: 'jpeg', quality: 55, timeout: 5000 });
      // Per run, not per session: a run's screenshots are the evidence for that
      // run's outcome, and reusing one directory would let a later run
      // overwrite the pictures an earlier run's report points at.
      const dir = path.join(shotDir(this.session.id), this.runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), buf);
      return `${this.runId}/${name}`;
    } catch {
      return null;
    }
  }

  // Writes the picture a screenshot step asked for, under the name it was
  // given. Returns the run-relative path, or null when the browser could not
  // produce one — a picture that silently fails to write must not fail the
  // step, because the page state it was recording is still what is under test.
  async claim(name) {
    const file = `${safeScreenshotName(name)}.png`;
    try {
      const buf = await this.page.screenshot({ type: 'png', timeout: 10000 });
      const dir = path.join(shotDir(this.session.id), this.runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), buf);
      return `${this.runId}/${file}`;
    } catch {
      return null;
    }
  }

  // Suspends before the next step. The browser stays open and the run's history
  // is unaffected: resuming continues from the same step.
  pause() {
    if (this.paused || this.cancelled) return;
    this.paused = new Promise((resolve) => {
      this._resume = resolve;
    });
    this.session.replay.status = 'paused';
    this.session.persist();
    this.emit({ type: 'replay:status', replay: this.session.replay });
    this.paintBadge('paused');
  }

  resume() {
    if (!this.paused) return;
    const done = this._resume;
    this.paused = null;
    this._resume = null;
    if (this.cancelled) return;
    this.session.replay.status = 'running';
    this.session.persist();
    this.emit({ type: 'replay:status', replay: this.session.replay });
    this.paintBadge('replaying');
    if (done) done();
  }


  // Mirrors the recording badge so a replay is as controllable from the page as
  // a recording is.
  paintBadge(state) {
    for (const page of this.context ? this.context.pages() : []) {
      page
        .evaluate(
          ([s, n]) => window.__recordBadge && window.__recordBadge(s, n),
          [state, this.session.replay.passed],
        )
        .catch(() => {});
    }
  }

  async cancel() {
    this.cancelled = true;
    // A paused run has a pending resume; releasing it lets the step loop finish
    // and observe the cancellation instead of hanging on a promise forever.
    if (this.paused) this.resume();
    const ctx = this.context;
    this.context = null;
    this.page = null;
    if (ctx) await ctx.close().catch(() => {});
  }
}
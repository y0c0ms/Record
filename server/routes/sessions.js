// Everything under /api/sessions: creating, recording, replaying, editing and
// deleting. Each handler returns true when it has answered the request, which
// is what lets the caller fall through to the next route.

import fs from 'node:fs';
import path from 'node:path';

import { createSession, getSession, listSessions, GENERATED_DIR } from '../../src/store.js';
import { Recorder } from '../../src/recorder.js';
import { Replayer } from '../../src/replayer.js';
import { dropProfile } from '../../src/browser.js';
import { generateListing, generateSpec } from '../../src/codegen.js';
import { ACTION_IDS, actionById, describeStep } from '../../src/steps.js';
import { MATCH_MODES, assertionProblem } from '../../src/assertions.js';
import { MASK, sealStep } from '../../src/secrets.js';
import { SAMPLE_KINDS, SOURCES, pruneUploads, storeUpload } from '../../src/uploads.js';
import { json, readBody, serveStatic } from '../http.js';

// Applies an upload step's file choice from the editor. Returns a message when
// the choice is unusable, so the request fails instead of saving a step that
// can only fail at replay.
//
//   { source: 'stored', attach: [{ name, type, data(base64) }] }  — copy in
//   { source: 'stored' }                                         — keep current
//   { source: 'path', paths: ['C:\\docs\\invoice.pdf'] }
//   { source: 'sample', sample: 'pdf', name?: 'contract.pdf' }
function applyFile(flowId, step, file) {
  const source = file.source || 'stored';
  if (!SOURCES.includes(source)) return `unknown file source "${source}"; use ${SOURCES.join(', ')}`;
  const current = step.file || {};
  if (source === 'stored') {
    let files = current.files || [];
    if (Array.isArray(file.attach) && file.attach.length) {
      files = file.attach.map((f) => storeUpload(flowId, f));
      if (files.some((f) => f.missing)) return 'an attached file had no contents';
    }
    if (!files.length) return 'choose a file to store with the flow';
    step.file = { ...current, source, files };
    step.value = files.map((f) => f.name).join(', ');
  } else if (source === 'path') {
    const paths = (Array.isArray(file.paths) ? file.paths : [file.paths])
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => p.trim());
    if (!paths.length) return 'choose a file on this machine';
    const missing = paths.find((p) => !fs.existsSync(p) || !fs.statSync(p).isFile());
    if (missing) return `no file at ${missing}`;
    // The stored copy is kept alongside, so switching back costs nothing.
    step.file = { ...current, source, paths };
    step.value = paths.map((p) => path.basename(p)).join(', ');
  } else {
    const sample = SAMPLE_KINDS.includes(file.sample) ? file.sample : 'pdf';
    const name = typeof file.name === 'string' && file.name.trim() ? file.name.trim() : `sample.${sample}`;
    step.file = { ...current, source, sample, name };
    step.value = `${name} (generated)`;
  }
  step.title = `Upload ${step.value} to ${step.label || 'file input'}`;
  return null;
}

// Wait steps are dictated by what actually happened in the browser, so they are
// shown but not editable. Navigation is editable: it is step 1 of the flow, and
// a flow that cannot start somewhere else is not a flow.
function isEditable(kind) {
  return kind !== 'wait';
}

// How a hand-inserted step's target is described in the step list. Recorded
// steps get this from the browser at capture time; an inserted one has no such
// context, so the locator itself is the honest description.
function describeInsertTarget(locator) {
  if (!locator) return 'no target';
  if (locator.strategy === 'role') return `role ${locator.role || '?'} "${locator.name || ''}"`;
  return `${locator.strategy || 'locator'}: ${locator.value || ''}`;
}

// The locator ladder for a hand-typed target, best guess first. Replay tries
// each rung in turn, so a name that is exposed several ways still resolves.
// A typed name never reaches a field through `text`, which is why label and
// placeholder are included rather than left to a recorded step's own ladder.
function labelLadder(label, type) {
  // A file input has no role a person would name, and is usually hidden behind
  // a styled button, so it is found by its label, then as the only file input.
  if (type === 'upload') {
    return [
      { strategy: 'label', value: label },
      { strategy: 'css', value: `input[type=file][name="${label.replace(/"/g, '\\"')}"]` },
      { strategy: 'css', value: 'input[type=file]' },
    ];
  }
  // A field's value is read from the field, and a checkbox is named by its
  // label; both are form controls first.
  if (type === 'assertValue' || type === 'assertChecked') {
    return [
      { strategy: 'label', value: label },
      { strategy: 'role', role: type === 'assertChecked' ? 'checkbox' : 'textbox', name: label },
      { strategy: 'placeholder', value: label },
    ];
  }
  // What a text, visibility or count check names is usually the text a person
  // sees on the page — a heading, a message — not a button, so the text rung
  // comes first and the role rung is the fallback.
  if (type.startsWith('assert')) {
    return [
      { strategy: 'text', value: label },
      { strategy: 'role', role: 'button', name: label },
      { strategy: 'label', value: label },
    ];
  }
  return [
    { strategy: 'role', role: type === 'fill' ? 'textbox' : 'button', name: label },
    { strategy: 'label', value: label },
    { strategy: 'placeholder', value: label },
    { strategy: 'text', value: label },
  ];
}

export function createSessionRoutes({ recorders, replayerBySession, subscribe, broadcast, attach, sessionsDir }) {
  return async function handleSessions(req, res, parts, method) {
    // ---- list ----
    if (parts.length === 2 && method === 'GET') {
      return json(res, 200, {
        sessions: listSessions().map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status,
          stepCount: s.stepCount,
          createdAt: s.createdAt,
          replay: s.replay,
          folder: s.folder || null,
          // Whether this flow has anything to parameterise, so the GUI only
          // offers a dataset editor when there is something to fill in.
          runCount: (s.runs || []).length,
        })),
      }), true;
    }

    // ---- create (start recording) ----
    if (parts.length === 2 && method === 'POST') {
      const body = await readBody(req);
      const session = createSession({
        name: body.name,
        startUrl: body.startUrl,
        channel: 'msedge',
        folder: body.folder || null,
      });
      attach(session);
      const recorder = new Recorder(session, sessionsDir);
      recorders.set(session.id, recorder);
      try {
        await recorder.start();
      } catch (err) {
        session.status = 'error';
        session.error = String(err.message || err);
        session.persist();
      }
      return json(res, 200, { session: session.publicView() }), true;
    }

    if (parts.length < 3) return false;

    // ---- session-scoped ----
    const id = parts[2];
    const session = getSession(id);
    if (!session) {
      json(res, 404, { error: 'session not found' });
      return true;
    }
    const tail = parts[3];

    if (!tail && method === 'GET') {
      json(res, 200, { session: session.publicView() });
      return true;
    }

    if (!tail && method === 'DELETE') {
      if (recorders.has(id)) {
        await recorders.get(id).stop('user');
        recorders.delete(id);
      }
      if (replayerBySession.has(id)) {
        await replayerBySession.get(id).cancel();
        replayerBySession.delete(id);
      }
      session.status = 'deleted';
      session.persist();
      json(res, 200, { ok: true });
      return true;
    }

    // ---- live event stream ----
    if (tail === 'events' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'status', session: session.publicView() })}\n\n`);
      subscribe(id, res);
      const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15000);
      res.on('close', () => clearInterval(keepalive));
      return true;
    }

    // ---- stop recording ----
    if (tail === 'stop' && method === 'POST') {
      const recorder = recorders.get(id);
      if (recorder) {
        await recorder.stop('user');
        recorders.delete(id);
      } else if (session.status === 'recording' || session.status === 'paused') {
        // The browser closed on its own; settle the status so the UI stops
        // showing a recording that no longer exists.
        session.status = 'recorded';
        session.persist();
        broadcast(id, { type: 'status', session: session.publicView() });
      }
      json(res, 200, { session: session.publicView() });
      return true;
    }

    // ---- pause / resume recording ----
    // Reachable from the GUI as well as the page badge, so pausing does not
    // require finding the browser window on screen.
    if ((tail === 'pause' || tail === 'resume') && method === 'POST') {
      const recorder = recorders.get(id);
      if (!recorder) return json(res, 404, { error: 'not recording' }), true;
      recorder.command(tail);
      return json(res, 200, { session: session.publicView() }), true;
    }

    // ---- start replay ----
    if (tail === 'replay' && method === 'POST') {
      if (replayerBySession.has(id)) {
        return json(res, 200, { replay: session.replay }), true;
      }
      // A run may supply values for the flow's dataset parameters. Anything it
      // leaves out falls back to what was recorded, so a partial dataset is a
      // valid dataset.
      const body = await readBody(req);
      // A replay is as much of a live session as a recording: its step and
      // status events are what the GUI's Pause and Stop read to know what the
      // run is doing. Attaching only when a recording starts left a replayed
      // flow silent, so those buttons described a run the GUI had never
      // heard of.
      attach(session);
      const replayer = new Replayer(session, {
        headed: true,
        shots: true,
        dataset: body.dataset || {},
        sessionsDir,
      });
      replayerBySession.set(id, replayer);
      try {
        const replay = await replayer.start();
        const forget = () => replayerBySession.delete(id);
        replayer.done?.then(forget).catch(forget);
        return json(res, 200, { replay }), true;
      } catch (err) {
        replayerBySession.delete(id);
        return json(res, 500, { error: String(err.message || err) }), true;
      }
    }

    // ---- pause / resume / interrupt a running replay ----
    // Distinct from DELETE above, which tears the run down; these keep the run's
    // record and its screenshots, which is the point of interrupting rather
    // than cancelling.
    //
    // The reply says whether a run was actually controlled, rather than 404ing
    // when there was not one. A client pressing Stop cannot know for certain
    // whether a run is live — its view is whatever the last event told it — and
    // a 404 leaves it unable to tell "there was nothing to stop" apart from
    // "the request failed". With the answer in the body it can fall back to
    // stopping a recording instead.
    if (['replay-pause', 'replay-resume', 'replay-interrupt'].includes(tail) && method === 'POST') {
      const replayer = replayerBySession.get(id);
      if (!replayer) return json(res, 200, { running: false, replay: session.replay || null }), true;
      if (tail === 'replay-pause') replayer.pause();
      else if (tail === 'replay-resume') replayer.resume();
      else await replayer.interrupt();
      return json(res, 200, { running: true, replay: session.replay }), true;
    }

    // ---- cancel replay ----
    if (tail === 'replay' && method === 'DELETE') {
      const replayer = replayerBySession.get(id);
      if (replayer) await replayer.cancel();
      replayerBySession.delete(id);
      json(res, 200, { ok: true });
      return true;
    }

    // ---- generated spec ----
    // Always rewrites the file: steps can be edited after the recording ends,
    // and a stale spec on disk is worse than none — this is the artifact a user
    // hands to their test suite.
    if (tail === 'spec' && method === 'GET') {
      const code = generateSpec(session);
      const specPath = path.join(GENERATED_DIR, `${session.id}.spec.js`);
      fs.mkdirSync(GENERATED_DIR, { recursive: true });
      fs.writeFileSync(specPath, code);
      session.spec = {
        path: path.relative(process.cwd(), specPath).replace(/\\/g, '/'),
        code,
      };
      session.persist();
      return json(res, 200, { spec: session.spec, listing: generateListing(session) }), true;
    }

    // ---- edit one step ----
    if (tail === 'step' && parts[4] && (method === 'PATCH' || method === 'POST')) {
      const index = Number(parts[4]);
      const step = session.steps.find((s) => s.index === index);
      if (!step) {
        return json(res, 404, { error: 'step not found' }), true;
      }
      if (!isEditable(step.type)) {
        return json(res, 409, {
          error: 'wait steps are fixed by the recording',
        }), true;
      }

      const body = await readBody(req);
      const nextType = body.type ?? step.type;
      const action = actionById(nextType);
      if (!action) {
        return json(res, 400, { error: `unknown action: ${nextType}`, actions: ACTION_IDS }), true;
      }
      // A step keeps whatever target it already had unless the new action has
      // no target at all. Navigation and wait have none, so their locators are
      // dropped rather than left behind as a target that will never be used.

      // A literal that looks like a placeholder is a client bug, not data: it
      // would resolve from the environment at replay time, and no environment
      // variable of that name exists.
      if (typeof body.value === 'string' && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(body.value)) {
        return json(res, 400, {
          error: `${body.value} looks like a placeholder, not a value. Send it in "param" instead.`,
        }), true;
      }

      // An assertion that can never pass, or never fail, is refused here rather
      // than discovered as a confusing run. The value it would end up with is
      // the one sent, or the one it already has.
      {
        const expected = typeof body.value === 'string' ? body.value : step.value;
        const mode = body.match ?? step.match;
        const problem = assertionProblem(nextType, expected, action.match ? mode ?? 'contains' : undefined);
        if (problem && !(typeof body.param === 'string' && body.param.trim())) {
          return json(res, 400, { error: problem }), true;
        }
      }

      if (action.needsValue) {
        const param = typeof body.param === 'string' ? body.param.trim() : '';
        if (param) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(param)) {
            return json(res, 400, {
              error: `"${param}" is not a valid parameter name. Use letters, digits and underscores.`,
            }), true;
          }
          // The recorded literal is kept: the parameter overrides it at replay
          // time, and the spec documents the recorded default.
          step.valueParam = param;
        } else {
          delete step.valueParam;
          // A password step's `value` is only its mask; the real value goes
          // through `secret` below, so an editor echoing the mask back cannot
          // replace it.
          if (!step.secret && (typeof body.value === 'string' || Array.isArray(body.value))) {
            step.value = body.value;
          }
        }
      }

      // The target can be re-pointed: a step that no longer resolves is usually
      // one whose element was renamed, and editing the label is the fix.
      if (typeof body.label === 'string' && body.label.trim()) {
        const label = body.label.trim();
        // The ladder is rebuilt on every label edit, not only when the text
        // changes: a step whose only candidate is `text` can never have been
        // resolved by a field, and re-saving the same name is how a user
        // re-points a target that has to be a label or a role.
        step.label = label;
        step.candidates = labelLadder(label, nextType);
        step.locator = step.candidates[0];
        step.title = `${action.label} ${label}`.trim();
        step.detail = describeInsertTarget(step.locator);
      } else if (Array.isArray(body.candidates) && body.candidates.length) {
        step.candidates = body.candidates;
        step.locator = body.candidates[0];
        step.detail = describeInsertTarget(step.locator);
      }

      step.type = nextType;
      // How an assertion compares; meaningless on any other step.
      if (action.match) {
        if (MATCH_MODES.includes(body.match)) step.match = body.match;
        else if (!MATCH_MODES.includes(step.match)) step.match = 'contains';
      } else {
        delete step.match;
      }
      // Each action reads its value from a different field; clear the others so
      // the step cannot carry a stale one. Navigation writes `url` — that is
      // the field the replayer navigates on, so editing a navigate step that
      // only set `value` would replay the old URL.
      if (nextType === 'navigate') {
        delete step.value;
        delete step.key;
        delete step.ms;
        delete step.candidates;
        delete step.locator;
        step.label = null;
        if (typeof body.url === 'string' && body.url.trim()) step.url = body.url.trim();
        else if (typeof body.value === 'string' && body.value.trim()) step.url = body.value.trim();
        else step.url = null;
        // `detail` is a string everywhere else in the schema, so null here
        // would fail the GUI's deserialiser. A navigate step's detail is its
        // URL, which is what the row shows under the action.
        step.detail = typeof step.url === 'string' ? step.url : '';
        step.title = 'Open URL';
      } else if (nextType === 'press') {
        if (typeof body.value === 'string' && body.value) step.key = body.value;
        delete step.value;
        delete step.url;
      } else if (nextType === 'wait') {
        delete step.key;
        delete step.url;
      } else {
        delete step.key;
        delete step.url;
        if (typeof body.value === 'string' && !step.secret) step.value = body.value;
      }

      // A password is re-entered rather than edited: the editor never sees the
      // stored one, so what it sends is the new value, sealed on arrival. A
      // field can also be marked as (or no longer) a password here, for a
      // secret field the recorder could not recognise by its type.
      if (typeof body.secret === 'string' && body.secret !== '') {
        sealStep(step, body.secret);
      } else if (body.secret === false) {
        delete step.secret;
        delete step.sealed;
        if (step.value === MASK) step.value = '';
      }

      // Whether replay may skip the step when its element is not on the page.
      if (typeof body.optional === 'boolean') {
        if (body.optional) step.optional = true;
        else delete step.optional;
      }

      if (nextType === 'upload' && body.file && typeof body.file === 'object') {
        const problem = applyFile(session.id, step, body.file);
        if (problem) return json(res, 400, { error: problem }), true;
      }
      if (step.file) pruneUploads(session.id, session.steps);

      step.edited = true;
      session.spec = { path: null, code: generateSpec(session) };
      session.persist();
      broadcast(id, { type: 'reset', session: session.publicView() });
      return json(res, 200, { session: session.publicView(), listing: generateListing(session) }), true;
    }

    // ---- delete one step ----
    if (tail === 'step' && parts[4] && method === 'DELETE') {
      const index = Number(parts[4]);
      const at = session.steps.findIndex((s) => s.index === index);
      if (at < 0) {
        return json(res, 404, { error: 'step not found' }), true;
      }
      session.steps.splice(at, 1);
      session.steps.forEach((s, n) => {
        s.index = n + 1;
      });
      session.spec = { path: null, code: generateSpec(session) };
      session.persist();
      broadcast(id, { type: 'reset', session: session.publicView() });
      return json(res, 200, { session: session.publicView() }), true;
    }

    // ---- insert a step at a position ----
    // `at` is the index the new step takes, so `at: 1` puts it before the step
    // currently numbered 1. Omitting `at`, or passing a value past the end,
    // appends: that is what the trailing "+" in the step list does.
    if (tail === 'steps' && !parts[4] && method === 'POST') {
      const body = await readBody(req);
      const at = Number.isInteger(body.at) ? body.at : session.steps.length + 1;
      if (at < 1 || at > session.steps.length + 1) {
        return json(res, 400, { error: `no position ${at} in a ${session.steps.length}-step flow` }), true;
      }
      const type = body.type || 'click';
      const action = actionById(type);
      if (!action) {
        return json(res, 400, { error: `unknown action: ${type}`, actions: ACTION_IDS }), true;
      }
      // Only an action that acts on something needs to be told what to act on.
      // Rejecting every targetless action here also rejected the ones that are
      // perfectly replayable without one: a screenshot captures the page, so
      // asking for a locator made the step impossible to add rather than
      // merely unusual.
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      const param = typeof body.param === 'string' && body.param.trim();
      const problem = param ? null : assertionProblem(type, body.value, action.match ? body.match ?? 'contains' : undefined);
      if (problem) return json(res, 400, { error: problem }), true;
      if (action.needsTarget && !label) {
        // A locatorless step cannot be replayed, so the request names what to
        // target rather than accepting a step that would fail at run time.
        return json(res, 400, { error: 'a new step needs a label or locator naming what to act on' }), true;
      }
      const candidates = action.needsTarget
        ? body.candidates && body.candidates.length
          ? body.candidates
          : body.locator
            ? [body.locator]
            : labelLadder(label, type)
        : [];
      const value = body.value ?? null;
      const step = {
        id: `${id}-${at}`,
        index: at,
        type,
        locator: candidates[0] || null,
        label,
        candidates,
        // The value field is named per action — `ms` for a wait, `name` for a
        // screenshot — so it is written under the name the action declared
        // rather than the single field the editor sends it in.
        [action.value === 'none' ? 'value' : action.value]: action.value === 'none' ? null : value,
        key: action.value === 'key' ? value : (body.key ?? null),
        ms: action.value === 'ms' ? Number(value) || 0 : (body.ms ?? null),
        valueParam: typeof body.param === 'string' && body.param.trim() ? body.param.trim() : null,
        ...(action.match ? { match: MATCH_MODES.includes(body.match) ? body.match : 'contains' } : {}),
        url: action.value === 'url' ? String(value || '') : (body.url ?? null),
        // Marked as hand-added: replay must not pretend it was recorded, and the
        // editor shows it differently so a hand-edit is visible in review.
        edited: true,
        offsetMs: null,
        detail: body.detail || (candidates.length ? describeInsertTarget(candidates[0]) : action.label),
        status: 'recorded',
        error: null,
        shot: null,
      };
      // The title is derived rather than concatenated: an action with no target
      // reads "Take a screenshot named receipt", not "Take screenshot " with a
      // trailing gap where the label would have been.
      step.title = describeStep(step).phrase;
      // A hand-added upload names its file the same way an edit does; a hand
      // -added password is sealed before it is ever stored.
      if (type === 'upload') {
        const problem = applyFile(id, step, body.file || { source: 'sample', sample: 'pdf' });
        if (problem) return json(res, 400, { error: problem }), true;
      }
      if (typeof body.secret === 'string' && body.secret !== '') {
        sealStep(step, body.secret);
        step.title = describeStep(step).phrase;
      }
      session.steps.splice(at - 1, 0, step);
      session.steps.forEach((s, n) => {
        s.index = n + 1;
        s.id = `${id}-${n + 1}`;
      });
      session.spec = { path: null, code: generateSpec(session) };
      session.persist();
      broadcast(id, { type: 'reset', session: session.publicView() });
      return json(res, 200, { session: session.publicView(), listing: generateListing(session) }), true;
    }

    // ---- move a step to another position ----
    // `POST /api/sessions/<id>/steps/reorder` with `{ from, to }`, both 1-based
    // indexes the user can see. Reordering is the one edit that changes what
    // every later step *means* — a click that opened the cart now happens after
    // the checkout — so it is a separate, explicit call rather than a field on
    // the step-edit route, where it would be easy to apply by accident.
    if (tail === 'steps' && parts[4] === 'reorder' && method === 'POST') {
      const body = await readBody(req);
      const from = Number(body.from);
      const to = Number(body.to);
      const count = session.steps.length;
      if (
        !Number.isInteger(from) ||
        !Number.isInteger(to) ||
        from < 1 ||
        to < 1 ||
        from > count ||
        to > count
      ) {
        return json(
          res,
          400,
          { error: `cannot move step ${from} to position ${to} in a ${count}-step flow` },
        ), true;
      }
      if (from === to) {
        return json(res, 200, { session: session.publicView() }), true;
      }
      // Take the step out first, then work out where it lands. Computing the
      // target against the already-shortened list is what stops a downward move
      // from landing one position short.
      const [moved] = session.steps.splice(from - 1, 1);
      session.steps.splice(to - 1, 0, moved);
      session.steps.forEach((s, n) => {
        s.index = n + 1;
        s.id = `${id}-${n + 1}`;
      });
      session.spec = { path: null, code: generateSpec(session) };
      session.persist();
      broadcast(id, { type: 'reset', session: session.publicView() });
      return json(
        res,
        200,
        { session: session.publicView(), listing: generateListing(session) },
      ), true;
    }


    // ---- screenshot ----
    // The path is `<runId>/<file>`, so a run's pictures stay together and are
    // addressed by the same id as the run that produced them. Anything escaping
    // the session directory is rejected rather than served.
    if (tail === 'shot' && parts[4] && method === 'GET') {
      const rel = parts.slice(4).join('/');
      const resolved = path.resolve(sessionsDir, id, 'shots', rel);
      const base = path.resolve(sessionsDir, id, 'shots');
      if (resolved !== base && !resolved.startsWith(base + path.sep)) {
        return json(res, 400, { error: 'invalid screenshot path' }), true;
      }
      serveStatic(res, path.join(sessionsDir, id), `shots/${rel}`);
      return true;
    }

    // ---- record one step into an existing flow ----
    // The browser is the only place a real locator can come from, and recording
    // a whole session to obtain one step throws away everything else it saw.
    // This arms the recorder to stop itself at the first action.
    if (tail === 'capture' && method === 'POST') {
      const body = await readBody(req);
      const at = Number.isInteger(body.at) ? body.at : session.steps.length + 1;
      if (at < 1 || at > session.steps.length + 1) {
        return json(res, 400, { error: `no position ${at} in a ${session.steps.length}-step flow` }), true;
      }
      const recorder = recorders.get(id) || new Recorder(session, sessionsDir);
      recorders.set(id, recorder);
      const captured = await recorder.captureOne({ at });
      const step = captured && captured.step;
      // A cancelled capture, or one that only saw a navigation, leaves the flow
      // untouched: a half-step is worse than none.
      if (!step) {
        // Either the user closed the window or did more than one thing; both
        // mean the flow is left exactly as it was.
        recorders.delete(id);
        return json(res, 400, { error: 'no single step was recorded' }), true;
      }
      const candidates = step.candidates && step.candidates.length ? step.candidates : [step.locator];
      session.steps.splice(at - 1, 0, { ...step, candidates, valueParam: null, edited: true });
      session.steps.forEach((s, n) => {
        s.index = n + 1;
        s.id = `${id}-${n + 1}`;
      });
      session.spec = { path: null, code: generateSpec(session) };
      session.persist();
      broadcast(id, { type: 'reset', session: session.publicView() });
      recorders.delete(id);
      return json(res, 200, { session: session.publicView(), listing: generateListing(session) }), true;
    }

    // ---- cancel a capture in progress ----
    if (tail === 'capture' && method === 'DELETE') {
      const recorder = recorders.get(id);
      if (recorder && recorder.capturing) {
        await recorder.stopCapture();
        recorders.delete(id);
      }
      return json(res, 200, { ok: true }), true;
    }

    return false;
  };
}

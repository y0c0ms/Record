// Subflows: reusable groups of steps, shared across flows.
//
// Kept separate from the session routes because a subflow is not part of any
// one flow — it outlives the flow it was carved out of, which is the whole point
// of saving it. The rules about what may be saved live with the data in
// src/subflows.js.

import { getSession } from '../../src/store.js';
import {
  createSubflow,
  deleteSubflow,
  getSubflow,
  listSubflows,
  stepsForInsert,
} from '../../src/subflows.js';
import { json, readBody } from '../http.js';

export function createSubflowRoutes({ broadcast }) {
  return async function handleSubflows(req, res, parts, method) {
    // ---- list ----
    if (parts.length === 2 && method === 'GET') {
      return json(res, 200, { subflows: listSubflows() }), true;
    }

    // ---- create from a run of a flow's steps ----
    // The steps are named by index rather than sent as objects: the server
    // already holds the flow, so accepting a copy of the steps would let a
    // client save a subflow that never existed.
    if (parts.length === 2 && method === 'POST') {
      const body = await readBody(req);
      try {
        const session = getSession(body.sessionId);
        if (!session) return json(res, 404, { error: 'flow not found' }), true;
        const from = Number(body.from);
        const to = Number(body.to);
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
          return json(res, 400, { error: 'select a run of steps within the flow' }), true;
        }
        const picked = session.steps.slice(from - 1, to);
        if (picked.length !== to - from + 1) {
          return json(res, 400, { error: `steps ${from}-${to} are not all in this flow` }), true;
        }
        // Reindexed to 1..n so the subflow is a flow in its own right rather
        // than a fragment carrying the indices it happened to have.
        const steps = picked.map((s, i) => ({ ...s, index: i + 1 }));
        return json(res, 200, { subflow: createSubflow(body.name, steps) }), true;
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) }), true;
      }
    }

    // ---- import into a flow ----
    // `POST /api/subflows/<id>/import` with `{ sessionId, at }`. The steps are
    // spliced in at `at` and every following step renumbers, exactly as a manual
    // insert does, so the two paths cannot drift apart.
    if (parts[2] && parts[3] === 'import' && method === 'POST') {
      const body = await readBody(req);
      try {
        const subflow = getSubflow(parts[2]);
        if (!subflow) return json(res, 404, { error: 'subflow not found' }), true;
        const session = getSession(body.sessionId);
        if (!session) return json(res, 404, { error: 'flow not found' }), true;
        const at = Number.isInteger(body.at) ? body.at : session.steps.length + 1;
        if (at < 1 || at > session.steps.length + 1) {
          return json(
            res,
            400,
            { error: `no position ${at} in a ${session.steps.length}-step flow` },
          ), true;
        }
        session.steps.splice(at - 1, 0, ...stepsForInsert(subflow, at));
        session.steps.forEach((s, n) => {
          s.index = n + 1;
          s.id = `${session.id}-${n + 1}`;
          // Imported steps are hand-added as far as this flow is concerned, so
          // the editor shows them as edited and a reviewer can see they were
          // not recorded here.
          s.edited = true;
        });
        session.spec = null;
        session.persist();
        broadcast(session.id, { type: 'reset', session: session.publicView() });
        return json(res, 200, { session: session.publicView() }), true;
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) }), true;
      }
    }

    // ---- delete ----
    if (parts.length === 3 && method === 'DELETE') {
      try {
        deleteSubflow(parts[2]);
        return json(res, 200, { ok: true }), true;
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) }), true;
      }
    }

    return json(res, 404, { error: 'not found' }), true;
  };
}

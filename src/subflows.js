// Subflows: a named, reusable group of steps.
//
// The use case is repetition across flows — every test needs a login step, and
// re-recording it into each one means the flows drift apart the moment the login
// page changes. A subflow keeps one copy of those steps, so a flow that needs it
// pulls it in rather than owning a second, diverging version.
//
// A subflow is a step list and nothing more. It does not record, replay, or hold
// a dataset of its own: the steps carry their own values and parameters, and
// those travel with them. What makes it a subflow rather than a snippet is that
// it has an identity and a name, so the same group can be dropped into any
// number of flows and still be recognised as the same thing.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, writeFileAtomic } from './store.js';

const SUBFLOWS_FILE = path.join(DATA_DIR, 'subflows.json');

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SUBFLOWS_FILE, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Missing or corrupt file: fall through to the empty default.
  }
  return [];
}

// Atomic for the same reason as folders: the reader treats a torn file as
// "no subflows yet", so one interrupted write would lose them all.
function write(all) {
  writeFileAtomic(SUBFLOWS_FILE, JSON.stringify(all, null, 2));
}

let subflows = read();

let counter = 0;
const nextId = () => {
  counter += 1;
  return `x${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}`;
};

// A deep copy, so the stored subflow and the flow that imported it cannot end up
// sharing a step object. Editing an imported login must not edit the subflow
// every other flow pulls from.
const copySteps = (steps) => steps.map((s) => JSON.parse(JSON.stringify(s)));

export function listSubflows() {
  return subflows.map((s) => ({ ...s, stepCount: s.steps.length }));
}

export function getSubflow(id) {
  return subflows.find((s) => s.id === id) || null;
}

export function createSubflow(name, steps) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('a subflow needs a name');
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('select at least one step to save');
  }
  const subflow = {
    id: nextId(),
    name: trimmed,
    steps: copySteps(steps),
    createdAt: Date.now(),
  };
  subflows.push(subflow);
  write(subflows);
  return { ...subflow, stepCount: subflow.steps.length };
}

export function deleteSubflow(id) {
  const before = subflows.length;
  subflows = subflows.filter((s) => s.id !== id);
  if (subflows.length === before) throw new Error('subflow not found');
  write(subflows);
  return { ok: true };
}

// The steps a flow would receive, renumbered to sit after everything already in
// it. Steps are positional, so the index has to be assigned at insert time —
// the caller cannot fix it up afterwards without knowing how many precede.
export function stepsForInsert(subflow, fromIndex) {
  return copySteps(subflow.steps).map((s, i) => ({ ...s, index: fromIndex + i }));
}

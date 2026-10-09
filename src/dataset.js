// Dataset parameters: the values a recorded literal can be replaced with.
//
// One rule, applied everywhere: a parameter resolves to its override if one was
// supplied, and to the value that was recorded otherwise. That is what lets a
// parameterised step be run with no dataset at all and still do what it did
// when it was recorded.

import { collectParams } from './steps.js';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isParamName(name) {
  return typeof name === 'string' && NAME.test(name.trim());
}

// Dataset values supplied for a run, as NAME -> string.
export function normalizeDataset(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (isParamName(key)) out[key.trim()] = String(value);
  }
  return out;
}

// Every parameter the flow uses, and what it will actually use for this run.
// Returned so a run can report the dataset it ran with — otherwise a result
// with no data on it is not reproducible.
export function resolveDataset(steps, overrides = {}) {
  const dataset = normalizeDataset(overrides);
  return collectParams(steps).map((name) => ({
    name,
    value: dataset[name] !== undefined ? dataset[name] : recordedValue(steps, name),
    overridden: dataset[name] !== undefined,
  }));
}

// The literal recorded against the first step using this parameter.
function recordedValue(steps, name) {
  const step = steps.find((s) => s.valueParam === name);
  if (!step) return '';
  const raw = step.type === 'press' ? step.key : step.value;
  return Array.isArray(raw) ? raw.join(', ') : String(raw ?? '');
}

// Substitutes the dataset into a step, without mutating the recording: the
// stored step keeps its literal so the spec documents what was recorded.
export function valueForStep(step, dataset) {
  const name = step.valueParam;
  if (!name) {
    const raw = step.type === 'press' ? step.key : step.value;
    return Array.isArray(raw) ? raw : raw ?? '';
  }
  const resolved = dataset[name];
  if (resolved !== undefined) return resolved;
  const raw = step.type === 'press' ? step.key : step.value;
  return Array.isArray(raw) ? raw.join(', ') : String(raw ?? '');
}
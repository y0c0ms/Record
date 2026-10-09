// The canonical, code-independent vocabulary for a recorded step.
//
// The recorder emits rich steps (locator chains, offsets, snapshots) because
// replay needs them. Neither the human view nor the no-code editor should have
// to know that, so every view goes through this module: it turns a recorded
// step into a plain "action + value + target" triple, and back.
//
// The code view is not a competing model. It is generated from the same steps,
// so switching views never loses anything.

import { chainFor, describeLocator } from './locator.js';
import { describeExpectation, matchMode } from './assertions.js';

// Ordered for the dropdown: navigation and entry first, because that is the
// order a person thinks in.
export const ACTIONS = [
  {
    id: 'navigate',
    label: 'Open URL',
    value: 'url',
    valueLabel: 'URL',
    needsValue: true,
    needsTarget: false,
    // Phrased as a sentence when rendered in the step list.
    phrase: (v) => `Open ${v}`,
  },
  {
    id: 'click',
    label: 'Click',
    value: 'none',
    needsValue: false,
    needsTarget: true,
    phrase: (_v, target) => `Click ${target}`,
  },
  {
    id: 'fill',
    label: 'Enter text',
    value: 'text',
    valueLabel: 'Text',
    needsValue: true,
    needsTarget: true,
    phrase: (v, target) => `Enter ${v} into ${target}`,
  },
  {
    id: 'select',
    label: 'Select option',
    value: 'option',
    valueLabel: 'Option',
    needsValue: true,
    needsTarget: true,
    phrase: (v, target) => `Select ${v} in ${target}`,
  },
  {
    id: 'press',
    label: 'Press key',
    value: 'key',
    valueLabel: 'Key',
    needsValue: true,
    needsTarget: true,
    phrase: (v, target) => `Press ${v} on ${target}`,
  },
  {
    // A file handed to an <input type=file>. The value is what the step shows —
    // the file name — while what is actually uploaded lives in `step.file`:
    // a stored copy, a path on this machine, or a generated sample.
    id: 'upload',
    label: 'Upload file',
    value: 'value',
    valueLabel: 'File',
    // The file is chosen through `file`, not typed into the value box.
    needsValue: false,
    needsTarget: true,
    phrase: (v, target) => `Upload ${v || 'a file'} to ${target}`,
  },
  {
    id: 'assertVisible',
    label: 'Check visible',
    value: 'none',
    needsValue: false,
    needsTarget: true,
    phrase: (_v, target) => `Check ${target} is visible`,
  },
  // Assertions. Each reads its expected value from `value`, and the ones that
  // compare text also carry `match` (contains, equals, regex). The rules for
  // what each one checks live in assertions.js.
  {
    id: 'assertText',
    label: 'Check text',
    value: 'value',
    valueLabel: 'Expected text',
    needsValue: true,
    needsTarget: true,
    match: true,
    phrase: (v, target, step) => `Check ${target} ${describeExpectation('assertText', v, matchMode(step))}`,
  },
  {
    id: 'assertValue',
    label: 'Check field value',
    value: 'value',
    valueLabel: 'Expected value',
    needsValue: true,
    needsTarget: true,
    match: true,
    phrase: (v, target, step) => `Check ${target} ${describeExpectation('assertValue', v, matchMode(step))}`,
  },
  {
    id: 'assertUrl',
    label: 'Check URL',
    value: 'value',
    valueLabel: 'Expected URL',
    needsValue: true,
    needsTarget: false,
    match: true,
    phrase: (v, _target, step) => `Check ${describeExpectation('assertUrl', v, matchMode(step))}`,
  },
  {
    id: 'assertChecked',
    label: 'Check checkbox',
    value: 'value',
    valueLabel: 'State',
    needsValue: true,
    needsTarget: true,
    phrase: (v, target) => `Check ${target} ${describeExpectation('assertChecked', v)}`,
  },
  {
    id: 'assertCount',
    label: 'Check count',
    value: 'value',
    valueLabel: 'Expected count',
    needsValue: true,
    needsTarget: true,
    phrase: (v, target) => `Check ${describeExpectation('assertCount', v)} of ${target}`,
  },
  {
    id: 'assertHidden',
    label: 'Check hidden',
    value: 'none',
    needsValue: false,
    needsTarget: true,
    phrase: (_v, target) => `Check ${target} is hidden`,
  },
  {
    id: 'wait',
    label: 'Wait',
    value: 'ms',
    valueLabel: 'Milliseconds',
    needsValue: true,
    needsTarget: false,
    phrase: (v) => `Wait ${v} ms`,
  },
  {
    // A screenshot on purpose, not as a by-product of running a step. The
    // per-step snapshots are there to explain a failure; this one is a claim
    // about the page in its own right, so it keeps a name the reader chose
    // rather than the index it happened to land on.
    id: 'screenshot',
    label: 'Take screenshot',
    // The name lives in `value`, the field every step's value is read from, so
    // the dataset resolver and the editor's value box work on it unchanged.
    value: 'value',
    valueLabel: 'Name',
    needsValue: true,
    needsTarget: false,
    phrase: (v) => `Take a screenshot${v ? ` named ${v}` : ''}`,
  },
];

export const ACTION_IDS = ACTIONS.map((a) => a.id);

export function actionById(id) {
  return ACTIONS.find((a) => a.id === id) || null;
}

// A screenshot step's name becomes a filename, so it is reduced to something
// that cannot escape the directory it is written into. Shared by the runtime
// and the generated spec: the two write the same picture, and two different
// rules for the same input would mean the spec saved a file the runtime would
// not have named the same way.
export function safeScreenshotName(name) {
  return (
    String(name || '')
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[.-]+/, '')
      .slice(0, 60) || 'screenshot'
  );
}

// Whether two ladder rungs name the same element. Compared field by field
// rather than as JSON: the replay writes back the rung it used with its
// attributes resolved, so a string compare would call the primary a different
// rung from itself and report a fallback on every step.
function sameLocator(a, b) {
  if (!a || !b) return false;
  return (
    (a.strategy || '') === (b.strategy || '') &&
    (a.value || '') === (b.value || '') &&
    (a.role || '') === (b.role || '') &&
    (a.name || '') === (b.name || '') &&
    (a.attr || '') === (b.attr || '')
  );
}

// Which rung of a step's ladder the replay actually resolved on: 0 is the
// primary, higher numbers are fallbacks, and -1 means the step did not use a
// locator at all — a navigation, a wait, a screenshot.
//
// The position fallback is not in the ladder; it runs after every rung has
// failed. It is reported as the rung one past the end, so the run panel can
// say "fell back to position" in the same place it says "fell back to 3 of 5".
//
// This is the answer to "did the page change, or is my test brittle?", which
// a pass/fail badge cannot give: a step that passed on its last rung is one
// edit away from failing.
export function resolvedRung(step) {
  const used = step.resolvedLocator;
  if (!used) return -1;
  const ladder = step.candidates || [];
  if (used.strategy === 'position') return ladder.length;
  const index = ladder.findIndex((c) => sameLocator(c, used));
  return index >= 0 ? index : -2;
}

// A rung as a person would read it: the strategy, and what it named.
export function describeRung(locator) {
  if (!locator) return '';
  switch (locator.strategy) {
    case 'role':
      return `role ${locator.role || '?'} "${locator.name || ''}"`;
    case 'testId':
      return `testId=${locator.value}`;
    case 'text':
      return `text="${locator.value}"`;
    default:
      return `${locator.strategy}: ${locator.value || locator.name || ''}`;
  }
}

// The whole label of a cookie-banner answer, in the languages the banners this
// tool meets are written in. Whole-string only: "Accept" alone is too common a
// page button to read as a banner answer, so it needs a qualifier.
const CONSENT_ANSWER = new RegExp(
  '^(' +
    [
      '(accept|reject|decline|deny|refuse|allow) (all|all cookies|cookies|necessary|necessary cookies)',
      'only (necessary|essential)( cookies)?',
      '(aceitar|rejeitar|recusar|permitir) (tudo|todos|todas|cookies|todos os cookies)',
      '(aceptar|rechazar|denegar) (todo|todas|todas las cookies|cookies)',
      'tout (accepter|refuser)',
      '(accepter|refuser) (tout|les cookies)',
      'alle (akzeptieren|ablehnen)',
      '(accetta|rifiuta) (tutto|tutti)',
    ].join('|') +
    ')$',
  'i',
);

// Whether a recorded click answers a cookie banner. Such a step is recorded
// as "can be skipped": the banner is not shown again once consent is kept, is
// often not shown to an automated browser at all, and is answered by the
// replay's own overlay sweep when it is — so the click usually has nothing to
// click. The user can untick it.
export function isConsentAnswer(step) {
  if (!step || step.type !== 'click' || step.frame) return false;
  const fp = step.fingerprint || {};
  return [step.label, fp.name, fp.text]
    .filter((s) => typeof s === 'string' && s.trim())
    .some((s) => CONSENT_ANSWER.test(s.replace(/\s+/g, ' ').trim()));
}

// Every value a step carries, regardless of the field name the recorder used.
export function stepValue(step) {
  if (step.value !== undefined) return step.value;
  if (step.key !== undefined) return step.key;
  if (step.url !== undefined) return step.url;
  if (step.ms !== undefined) return step.ms;
  return '';
}

export function stepTarget(step) {
  if (typeof step.label === 'string' && step.label.trim()) return step.label.trim();
  return describeLocator(chainFor(step)[0]) || 'element';
}

// A dataset parameter, e.g. `${USERNAME}`, is stored as `valueParam: "USERNAME"`
// alongside the recorded literal. Both survive: the literal is the recorded
// default, the parameter is how the value is overridden at replay time.
export function isParameter(step) {
  return typeof step.valueParam === 'string' && step.valueParam.trim() !== '';
}

// Suggests a parameter name from the target, so promoting a value to a
// parameter is one keystroke rather than a naming exercise.
export function suggestParamName(step) {
  const base = stepTarget(step)
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join('_')
    .toUpperCase();
  if (step.type === 'fill') return `${base}_VALUE` || 'VALUE';
  if (step.type === 'select') return `${base}_OPTION` || 'OPTION';
  if (step.type === 'press') return `${base}_KEY` || 'KEY';
  return base || 'VALUE';
}

// The single shape both views render from.
export function describeStep(step) {
  const action = actionById(step.type);
  const target = step.needsTarget === false ? '' : stepTarget(step);
  const raw = stepValue(step);
  const value = isParameter(step) ? `\${${step.valueParam}}` : formatValue(step, raw);
  const phrase = action ? action.phrase(value, target, step) : `${step.type} ${value}`.trim();
  return {
    index: step.index,
    actionId: step.type,
    actionLabel: action ? action.label : step.type,
    needsValue: action ? action.needsValue : false,
    valueLabel: action && action.valueLabel ? action.valueLabel : 'Value',
    needsTarget: action ? action.needsTarget : false,
    // How an assertion compares its expected value; null for every other step.
    match: action && action.match ? matchMode(step) : null,
    value,
    rawValue: raw,
    isParameter: isParameter(step),
    paramName: step.valueParam || '',
    suggestedParam: suggestParamName(step),
    target,
    chain: chainFor(step),
    primary: step.primary ?? 0,
    phrase,
  };
}

function formatValue(step, raw) {
  if (Array.isArray(raw)) return raw.map((v) => `"${v}"`).join(', ');
  if (typeof raw === 'number') return String(raw);
  return `"${raw ?? ''}"`;
}

// Every dataset parameter referenced by the flow, in first-use order.
export function collectParams(steps) {
  const seen = [];
  for (const step of steps) {
    if (isParameter(step) && !seen.includes(step.valueParam)) {
      seen.push(step.valueParam);
    }
  }
  return seen;
}
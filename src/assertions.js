// Assertion steps: claims about the page rather than actions on it.
//
// A replay that only clicks proves the clicks went through, not that the page
// showed the right thing afterwards. An assertion step is what turns a green
// run into "the user saw what they were meant to see".
//
// Every rule lives here — what each assertion reads, how expected and actual
// are compared, what a failure says — so the replayer, the generated spec and
// the editor's validation cannot disagree about what a step means.

export const MATCH_MODES = ['contains', 'equals', 'regex'];

// Assertions that read one element, found through the step's locator ladder
// exactly like an action's target.
export const ELEMENT_ASSERTIONS = new Set(['assertText', 'assertValue', 'assertChecked']);
// Assertions about every element the primary locator matches, so "none" or
// "three" can be true: they never require a unique match.
export const LOCATOR_ASSERTIONS = new Set(['assertHidden', 'assertCount']);
export const ASSERTIONS = new Set(['assertVisible', 'assertUrl', ...ELEMENT_ASSERTIONS, ...LOCATOR_ASSERTIONS]);

// Assertions whose expected value is text compared under a match mode.
export const MATCHED = new Set(['assertText', 'assertValue', 'assertUrl']);

export const CHECKED_STATES = ['checked', 'unchecked'];

// Polling interval while an assertion waits for the page to agree. Pages
// render after the action that changed them, so a claim is retried until it
// holds or the step's timeout runs out — never decided on the first look.
const POLL_MS = 150;

export function matchMode(step) {
  return MATCH_MODES.includes(step && step.match) ? step.match : 'contains';
}

// Whitespace is normalised on both sides: rendered text wraps and indents
// differently from what a person reads, and Playwright's own text matchers
// compare the same way, so the runtime and the exported spec agree.
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function matches(actual, expected, mode) {
  switch (mode) {
    case 'equals':
      return norm(actual) === norm(expected);
    case 'regex':
      return new RegExp(String(expected)).test(norm(actual));
    default:
      return norm(actual).includes(norm(expected));
  }
}

// Why a step's expected value cannot work, or null. Checked when the step is
// saved, so a typo in a regex is reported in the editor rather than as a
// failed run days later.
export function assertionProblem(type, expected, mode) {
  if (!ASSERTIONS.has(type)) return null;
  const value = expected == null ? '' : String(expected);
  if (MATCHED.has(type)) {
    if (mode !== undefined && mode !== null && !MATCH_MODES.includes(mode)) {
      return `"${mode}" is not a match mode. Use ${MATCH_MODES.join(', ')}.`;
    }
    if (mode === 'regex') {
      try {
        new RegExp(value);
      } catch (err) {
        return `not a valid regular expression: ${err.message}`;
      }
    }
    // An empty "contains" holds for every page, which is a step that can never
    // fail — the most misleading kind of green.
    if (mode !== 'regex' && value.trim() === '' && type !== 'assertValue') {
      return 'an empty expected value would match anything';
    }
  }
  if (type === 'assertCount' && !/^\d+$/.test(value.trim())) {
    return `expected count must be a whole number, got "${value}"`;
  }
  if (type === 'assertChecked' && value !== '' && !CHECKED_STATES.includes(value)) {
    return `expected state must be "checked" or "unchecked", got "${value}"`;
  }
  return null;
}

// The expectation in words, for step phrases and failure messages.
export function describeExpectation(type, expected, mode) {
  const v = JSON.stringify(String(expected ?? ''));
  const how = mode === 'equals' ? 'is' : mode === 'regex' ? 'matches' : 'contains';
  switch (type) {
    case 'assertText':
      return `text ${how} ${v}`;
    case 'assertValue':
      return `value ${how} ${v}`;
    case 'assertUrl':
      return `URL ${how} ${v}`;
    case 'assertCount':
      return `${String(expected ?? '').trim()} found`;
    case 'assertChecked':
      return expected === 'unchecked' ? 'is unchecked' : 'is checked';
    case 'assertHidden':
      return 'is hidden';
    default:
      return 'is visible';
  }
}

const clip = (s) => {
  const t = norm(s);
  return JSON.stringify(t.length > 120 ? `${t.slice(0, 117)}...` : t);
};

function failure(message) {
  const err = new Error(message);
  // Its own kind: "the page is wrong" is a different finding from "the
  // element was not there", and the run panel says which.
  err.code = 'assertion-failed';
  return err;
}

async function poll(read, holds, timeout) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await read();
      if (holds(last)) return { ok: true, last };
    } catch (err) {
      // A regex that cannot compile will never start holding; anything else
      // (an element re-rendered mid-read) is retried.
      if (err instanceof SyntaxError) throw failure(err.message);
    }
    if (Date.now() >= deadline) return { ok: false, last };
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// Checks a claim about one resolved element.
export async function assertElement(handle, type, expected, mode, timeout) {
  if (type === 'assertChecked') {
    const want = expected !== 'unchecked';
    const r = await poll(() => handle.isChecked({ timeout: 1000 }), (v) => v === want, timeout);
    if (!r.ok) {
      const was = r.last === undefined ? 'not a checkbox or radio' : r.last ? 'checked' : 'unchecked';
      throw failure(`expected ${want ? 'checked' : 'unchecked'}, was ${was}`);
    }
    return;
  }
  const read = type === 'assertValue' ? () => handle.inputValue({ timeout: 1000 }) : () => handle.innerText({ timeout: 1000 });
  const r = await poll(read, (v) => matches(v, expected, mode), timeout);
  if (!r.ok) {
    throw failure(
      `expected ${describeExpectation(type, expected, mode)}, was ${r.last === undefined ? 'unreadable' : clip(r.last)}`,
    );
  }
}

// Checks a claim about every element a locator matches.
export async function assertLocator(locator, type, expected, timeout) {
  const visible = locator.locator('visible=true');
  if (type === 'assertHidden') {
    const r = await poll(() => visible.count(), (n) => n === 0, timeout);
    if (!r.ok) throw failure(`expected hidden, ${r.last} still visible`);
    return;
  }
  const want = Number(String(expected).trim());
  const r = await poll(() => locator.count(), (n) => n === want, timeout);
  if (!r.ok) throw failure(`expected ${want} matching element${want === 1 ? '' : 's'}, found ${r.last ?? 0}`);
}

export async function assertUrl(page, expected, mode, timeout) {
  const r = await poll(() => page.url(), (u) => matches(u, expected, mode), timeout);
  if (!r.ok) throw failure(`expected ${describeExpectation('assertUrl', expected, mode)}, was ${clip(r.last)}`);
}

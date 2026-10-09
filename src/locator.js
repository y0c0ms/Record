// Maps a recorded locator descriptor (see src/recorder-inject.js) back onto a
// Playwright Locator. Single source of truth for both replay and codegen.
//
// Every element step carries an ordered `candidates` chain (most reliable
// first). Replay walks the chain; codegen emits the primary plus a commented
// fallback ladder so the generated spec degrades the same way.

// How long the *first* locator in a chain is given to resolve. A page that
// takes twenty seconds to render the element is the common case for a recorded
// test, not an edge case: the recording happened on a warm page and the replay
// starts on a cold one, so a short probe reports "matched nothing" for an
// element that is about to exist. This is the wait that has to be patient.
export const LOCATOR_WAIT_MS = 30000;

// How long a *fallback* locator is given before the rung after it is tried.
//
// Fallbacks exist for a page that has already changed under the recording, and
// the change is nearly always finished by the time the primary's full wait is
// over — the run has been sitting on that element for thirty seconds. Giving
// every rung the same thirty seconds made the ladder cost its worst case times
// its length: a six-rung step whose answer was the fifth spent over two
// minutes, almost all of it on rungs that had already been disproved by the
// time they were reached. The primary still gets the full patience; only the
// rungs that exist to catch a renamed element get a probe.
export const FALLBACK_WAIT_MS = 2500;

// Chain for a step, always ending with the step's primary locator so an edited
// or legacy step still resolves.
export function chainFor(step) {
  const primary = step && step.locator;
  const list = Array.isArray(step && step.candidates) ? step.candidates.slice() : [];
  if (primary && !list.some((c) => sameLocator(c, primary))) list.unshift(primary);
  return list.filter(Boolean);
}

// A name or text written all in capitals may only look that way: CSS
// `text-transform: uppercase` shows "Investidor" as "INVESTIDOR", and older
// recordings stored what was shown. Exact matching then finds nothing, every
// rung waits out its budget, and a step a person can plainly see fails after
// half a minute. So a capitalised role or text rung is matched ignoring case
// instead — still the whole string, still required to match exactly one
// element. It is a superset of the exact match, so nothing that resolved
// before stops resolving, except where case alone told two elements apart,
// and then the ladder's next rung takes over as it would for any ambiguity.
const CASE_FOLDABLE = new Set(['role', 'text']);
const isShouted = (s) => typeof s === 'string' && /\p{Lu}/u.test(s) && s === s.toUpperCase();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function caseFolded(locator) {
  if (!locator || !CASE_FOLDABLE.has(locator.strategy)) return null;
  const word = locator.strategy === 'role' ? locator.name : locator.value;
  if (!isShouted(word)) return null;
  return { ...locator, ignoreCase: true };
}

export function sameLocator(a, b) {
  if (!a || !b) return false;
  if (a.strategy !== b.strategy) return false;
  return locatorKey(a) === locatorKey(b);
}

export function locatorKey(locator) {
  if (!locator) return '';
  // A case-folded attempt reads as its own rung in failure messages.
  if (locator.ignoreCase) return `${locatorKey({ ...locator, ignoreCase: false })} (any case)`;
  switch (locator.strategy) {
    case 'role':
      return `role:${locator.role}|${locator.name}`;
    case 'testId':
      // The attribute is part of the identity: the same value under
      // `data-qa` and under `data-testid` are two different locators, and
      // collapsing them would let a recording's first rung be mistaken for
      // its own fallback.
      return `testId:${locator.attr || 'data-testid'}:${locator.value}`;
    default:
      return `${locator.strategy}:${locator.value}`;
  }
}

// A locator value is a string typed by a page, so it can legitimately contain
// a quote. Escaping it is what stops a value like `say "hi"` from closing the
// attribute selector and matching something else.
function cssEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function toLocatorStrict(root, locator) {
  switch (locator.strategy) {
    case 'testId':
      // The recorder folds `data-testid`, `data-test-id`, `data-test` and
      // `data-qa` into one strategy, because they all mean "the page labelled
      // this element for a test". Playwright's own `getByTestId` only ever
      // looks at `data-testid`, so a locator captured from any of the other
      // three could never resolve — it would sit at the top of its ladder and
      // be skipped every run, which is exactly what was happening. The
      // attribute is stored alongside the value so the lookup uses the one the
      // page actually has; a locator with no attribute recorded falls back to
      // Playwright's default, which is what every older recording means.
      return locator.attr
        ? root.locator(`[${locator.attr}="${cssEscape(locator.value)}"]`)
        : root.getByTestId(locator.value);
    // This was unreachable: it sat after the `return` that ends `testId`, with
    // no label of its own, so every role rung in every ladder fell through to
    // the default and failed with "unknown locator strategy: role". Role is the
    // most resilient strategy the recorder produces for a button or a link, so
    // the rungs that should have carried a step were dead weight on every run.
    case 'role':
      // An empty accessible name means "the only one of its kind on the page",
      // so the name filter has to be left off entirely. Passing `name: ''`
      // asks for an element whose accessible name is the empty string, which
      // matches nothing — the rung would sit in every ladder and never resolve.
      if (locator.ignoreCase) {
        return root.getByRole(locator.role, { name: new RegExp(`^\\s*${escapeRe(locator.name)}\\s*$`, 'i') });
      }
      return locator.name
        ? root.getByRole(locator.role, { name: locator.name, exact: true })
        : root.getByRole(locator.role);
    case 'label':
      return root.getByLabel(locator.value, { exact: true });
    case 'placeholder':
      return root.getByPlaceholder(locator.value, { exact: true });
    case 'text':
      if (locator.ignoreCase) return root.getByText(new RegExp(`^\\s*${escapeRe(locator.value)}\\s*$`, 'i'));
      return root.getByText(locator.value, { exact: true });
    case 'altText':
      return root.getByAltText(locator.value, { exact: true });
    case 'css':
      return root.locator(locator.value);
    case 'xpath':
      // `xpath=` is a Playwright selector engine prefix; a bare //path would
      // otherwise be parsed as CSS and match nothing.
      return root.locator(`xpath=${locator.value}`);
    default:
      throw new Error(`unknown locator strategy: ${locator.strategy}`);
  }
}

// A single locator: used by the probe endpoint to test one candidate at a time.
export function toLocator(root, locator) {
  if (!locator) throw new Error('step has no locator');
  return toLocatorStrict(root, locator);
}


// Resolves a handle to exactly one element. A locator may legitimately match
// several DOM nodes when a site renders duplicate markup for responsive
// layouts — one visible, the rest hidden. That is still a unique target, so
// ambiguity is only real when two or more matches are visible at once.
// How long several visible matches are watched for one of them to go away (a
// menu closing, an animation ending) before the rung is called ambiguous.
// Two settled, visible matches stay two; waiting out the full budget on them
// only delays the rung that would resolve, which is what made a header link
// duplicated in the footer cost thirty seconds a step.
const AMBIGUITY_SETTLE_MS = 1500;

async function resolveUnique(handle, timeout) {
  const deadline = Date.now() + timeout;
  let ambiguousSince = null;
  for (;;) {
    const total = await handle.count();
    if (total === 1) return { total: 1, unique: true, handle };
    if (total === 0) {
      if (Date.now() >= deadline) return { total: 0, unique: false, handle };
    } else {
      const visible = await handle
        .locator('visible=true')
        .count()
        .catch(() => total);
      if (visible === 1) return { total, unique: true, handle };
      if (visible > 1) {
        ambiguousSince ??= Date.now();
        if (Date.now() - ambiguousSince >= AMBIGUITY_SETTLE_MS) return { total, visible, unique: false, handle };
      } else {
        ambiguousSince = null;
      }
      // Ambiguity is not something waiting resolves: two visible matches stay
      // two. Only a match that is not yet visible has a chance of settling, so
      // the deadline is honoured on every ambiguous count rather than just the
      // invisible one — otherwise a step matching two live elements spins here
      // forever and the run never reaches its final record.
      if (Date.now() >= deadline) {
        return { total, visible, unique: false, handle };
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Tries each candidate in order, resolving to the first one that uniquely
// matches an element, and only then performs the action once.
//
// Probing and acting are separate on purpose. Clicking a candidate to "see if
// it works" mutates the page: an ambiguous match would click the wrong
// element, and a failed match burns a full timeout per rung. Verifying first
// means a step either resolves to exactly one element or fails without
// touching the page.
export async function resolveCandidate(
  root,
  step,
  { action, timeout = LOCATOR_WAIT_MS, onCandidate } = {},
) {
  const recorded = chainFor(step);
  if (!recorded.length) throw new Error('step has no locator');
  // Capitalised role/text rungs are matched ignoring case (see `caseFolded`).
  const chain = recorded.map((c) => caseFolded(c) || c);

  // The first rung is the one the recording saw work, so it gets the full
  // wait. Every rung after it exists to catch a page that has changed under
  // the recording, and gets a probe instead — see `FALLBACK_WAIT_MS`. The
  // first rung that resolves still wins, whichever it is.
  const failures = [];
  const begun = Date.now();
  const elapsed = () => Math.round((Date.now() - begun) / 100) / 10;
  for (const [position, locator] of chain.entries()) {
    const started = Date.now();
    // A caller may pass a `timeout` shorter than the fallback budget — the
    // short-wait tests do, to stand in for the thirty-second default. The
    // fallback is capped by it so the budget a step is given and the wait it
    // actually performs are the same number.
    const budget = position === 0 ? timeout : Math.min(FALLBACK_WAIT_MS, timeout);
    try {
      const handle = toLocatorStrict(root, locator);
      const found = await resolveUnique(handle, budget);
      if (!found.unique) {
        const waited = Math.round((Date.now() - started) / 100) / 10;
        failures.push(
          found.total === 0
            ? `${locatorKey(locator)} matched nothing after ${waited}s`
            : `${locatorKey(locator)} matched ${found.visible ?? found.total} visible of ${found.total} after ${waited}s`
        );
        continue;
      }
      if (onCandidate) onCandidate(locator, Math.round((Date.now() - started) / 100) / 10);
      await action(found.handle);
      // `waited` is the whole cost of resolving this step, not just the final
      // rung: a locator that only works as a fallback took just as long as the
      // ones that were tried and given up on first, and reporting only the
      // winning rung's time would make a 30-second wait look instantaneous.
      return { locator, count: found.total, waited: elapsed(), tried: failures.length + 1 };
    } catch (err) {
      failures.push(`${locatorKey(locator)}: ${String((err && err.message) || err).split('\n')[0]}`);
    }
  }

  // Last resort for a click: whatever sits where the element used to be, but
  // only if it is recognisably the same element. Tried after every locator has
  // failed, never instead of one.
  if (step.type === 'click' && step.fingerprint && step.fingerprint.point && root && root.mouse && typeof root.evaluate === 'function') {
    const hit = await resolveByPosition(root, step.fingerprint);
    if (hit.ok) {
      await root.mouse.click(hit.x, hit.y);
      return {
        locator: { strategy: 'position', value: `${hit.x},${hit.y}`, matched: hit.matched },
        count: 1,
        waited: elapsed(),
        tried: failures.length + 1,
      };
    }
    failures.push(`position ${step.fingerprint.point.x},${step.fingerprint.point.y}: ${hit.reason}`);
  }

  // The message says how long was actually spent, because "no locator
  // resolved" with no times is the difference between a page that was too slow
  // and a selector that was always wrong. `elapsed()` is the measured time, so
  // it cannot overstate the wait the way the budget could.
  // A caller may also pass a `timeout` shorter than the fallback budget, and
  // the fallback is then capped by it rather than raising the ceiling.
  const fallback = Math.min(FALLBACK_WAIT_MS, timeout);
  const error = new Error(
    `no locator resolved after ${elapsed()}s of waiting (${failures.join('; ')})`,
  );
  error.code = 'locator-timeout';
  error.waitedMs = timeout + (chain.length - 1) * fallback;
  error.failures = failures;
  throw error;
}

// Finds the element at a fingerprint's recorded point and checks it is the
// same element, before anything is clicked.
//
// A bare coordinate click is the most dangerous fallback a test tool can have:
// when the page changes and something else now sits at that point, it clicks
// the wrong control and the step still passes. So the element found there has
// to agree with what was recorded — same tag, compatible role, and the same
// visible text or accessible name — or the rung fails and says what it found.
//
// The viewport must match too. Coordinates taken in a 1908x932 window mean
// nothing in a 1280x720 one, so a size mismatch is reported rather than
// guessed at; replaying at the recorded size is the caller's job.
export async function resolveByPosition(page, fp) {
  return page.evaluate((fp) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (fp.viewport && (fp.viewport.w !== window.innerWidth || fp.viewport.h !== window.innerHeight)) {
      return {
        ok: false,
        reason: `viewport is ${window.innerWidth}x${window.innerHeight}, recorded at ${fp.viewport.w}x${fp.viewport.h}`,
      };
    }
    // The recording's scroll position, so a point near the bottom of a long
    // page is looked for where it was, not where the top of the page is now.
    if (fp.scroll) window.scrollTo(fp.scroll.x, fp.scroll.y);
    const { x, y } = fp.point;
    // elementFromPoint stops at a shadow host; follow open roots down to the
    // element actually under the point. A closed root cannot be entered.
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (!el) return { ok: false, reason: 'nothing at that point' };
    // The recorded element may be an ancestor of what is under the pointer —
    // a button whose label is a <span> — so walk up a few levels looking for it.
    let candidate = el;
    for (let depth = 0; candidate && depth < 4; depth += 1) {
      const tag = candidate.tagName.toLowerCase();
      const role = candidate.getAttribute('role') || '';
      const label = norm(candidate.getAttribute('aria-label') || candidate.innerText || candidate.textContent);
      const sameTag = tag === fp.tag;
      const roleOk = !fp.role || !role || role === fp.role;
      const want = norm(fp.text) || norm(fp.name);
      const textOk = !want || label === want || (want.length >= 3 && label.includes(want));
      if (sameTag && roleOk && textOk) {
        return { ok: true, x, y, matched: `${tag}${want ? ` "${want.slice(0, 40)}"` : ''}` };
      }
      const parent = candidate.parentElement || (candidate.getRootNode() && candidate.getRootNode().host);
      candidate = parent || null;
    }
    const found = `${el.tagName.toLowerCase()}${norm(el.innerText || el.textContent) ? ` "${norm(el.innerText || el.textContent).slice(0, 40)}"` : ''}`;
    const want = `${fp.tag}${norm(fp.text || fp.name) ? ` "${norm(fp.text || fp.name).slice(0, 40)}"` : ''}`;
    return { ok: false, reason: `landed on ${found}, expected ${want}` };
  }, fp);
}

// Playwright source for a descriptor, used when generating a spec file.
export function toLocatorSource(locator) {
  if (!locator) return '/* missing locator */';
  const q = (s) => JSON.stringify(s);
  switch (locator.strategy) {
    // Emits the same lookup `toLocatorStrict` performs, so a generated spec
    // resolves on the locator the recording actually captured rather than on
    // `data-testid` alone.
    case 'testId':
      return locator.attr && locator.attr !== 'data-testid'
        ? `page.locator('[${locator.attr}=${q(locator.value)}]')`
        : `page.getByTestId(${q(locator.value)})`;
    case 'role':
      return `page.getByRole(${q(locator.role)}, { name: ${q(locator.name)}, exact: true })`;
    case 'label':
      return `page.getByLabel(${q(locator.value)}, { exact: true })`;
    case 'placeholder':
      return `page.getByPlaceholder(${q(locator.value)}, { exact: true })`;
    case 'text':
      return `page.getByText(${q(locator.value)}, { exact: true })`;
    case 'altText':
      return `page.getByAltText(${q(locator.value)}, { exact: true })`;
    case 'css':
      return `page.locator(${q(locator.value)})`;
    case 'xpath':
      return `page.locator(${q(`xpath=${locator.value}`)})`;
    default:
      return `page.locator(${q(String(locator.value))})`;
  }
}

export function describeLocator(locator) {
  if (!locator) return '';
  switch (locator.strategy) {
    case 'role':
      return `role=${locator.role} name="${locator.name}"`;
    case 'xpath':
      return locator.value;
    default:
      return `${locator.strategy}=${locator.value}`;
  }
}

// Step titles read best when they match the locator replay will use, so the
// accessible name wins over raw inner text.
export function stepTitle(raw) {
  const label = (raw && raw.label) || '';
  switch (raw.type) {
    case 'navigate':
      return `Open ${raw.url}`;
    case 'click':
      return `Click "${label}"`;
    case 'fill':
      return `Type in ${label}`;
    case 'select':
      return `Select option in ${label}`;
    case 'press':
      return `Press ${raw.key} in ${label}`;
    case 'upload': {
      const names = (raw.files || []).map((f) => f.name).filter(Boolean);
      return `Upload ${names.length ? names.join(', ') : 'a file'} to ${label}`;
    }
    case 'assertVisible':
      return `Check ${label} is visible`;
    case 'assertText':
      return `Check text of ${label}`;
    case 'assertValue':
      return `Check value of ${label}`;
    case 'assertChecked':
      return `Check ${label} is ${raw.value === 'unchecked' ? 'unchecked' : 'checked'}`;
    case 'assertHidden':
      return `Check ${label} is hidden`;
    case 'assertCount':
      return `Check count of ${label}`;
    case 'assertUrl':
      return `Check URL`;
    case 'wait':
      return `Wait ${raw.ms || 0}ms`;
    default:
      return raw.type;
  }
}
import { chainFor, describeLocator, toLocatorSource } from './locator.js';
import { collectParams, isParameter, safeScreenshotName } from './steps.js';
import { matchMode } from './assertions.js';
import { hopSelector } from './frames.js';

// Origin, path and hash — the part of a URL that names a page, without the
// query string that changes every run.
function urlKey(href) {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}${u.hash}`;
  } catch {
    return String(href);
  }
}

const q = (s) => JSON.stringify(s);

// Text for a `//` comment, made unable to leave it.
//
// Step titles, flow names and locator descriptions come from the recorded page
// — an aria-label, a button's text — so a page can put a newline in them. Inside
// a line comment a newline ends the comment, and whatever follows becomes code
// that runs when anyone executes the spec. Every line terminator JavaScript
// recognises is folded to a space, not just `\n`: U+2028 and U+2029 end a line
// comment too.
const comment = (s) => String(s ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ');

// Emits a runnable @playwright/test spec. The POC runs generated specs with
// `npx playwright test` as proof the recorded flow replays outside our own
// replayer too.
//
// The spec embeds a self-contained resolver rather than importing ours, so a
// user can copy the single file into any project and have it work. It makes
// exactly the same decisions as src/locator.js: walk the candidate chain, take
// the first that resolves to exactly one element, act once.
const RESOLVER = `
// Walks a step's locator chain and performs the action once, on the first
// candidate that resolves to exactly one element. Ambiguity is a failure, not a
// coin flip: clicking the first of three matches is how a replay passes while
// doing the wrong thing.
//
// A locator matching several nodes is still unique when exactly one is
// visible — that is what sites duplicating markup per breakpoint produce.
async function resolveStep(page, chain, action, timeout = 2500) {
  const failures = [];
  // A rung in capitals may be CSS text-transform over lower-case text, so it
  // is matched ignoring case — the same rule the replayer applies.
  const shouted = (s) => typeof s === 'string' && /\\p{Lu}/u.test(s) && s === s.toUpperCase();
  const folded = chain.flatMap((c) =>
    (c.strategy === 'role' && shouted(c.name)) || (c.strategy === 'text' && shouted(c.value)) ? [{ ...c, ignoreCase: true }] : [c]);
  for (const c of folded) {
    const locator = source(page, c);
    const deadline = Date.now() + timeout;
    let total = 0;
    let unique = false;
    for (;;) {
      total = await locator.count();
      if (total === 1) { unique = true; break; }
      if (total > 1) {
        const visible = await locator.locator('visible=true').count().catch(() => total);
        if (visible === 1) { unique = true; break; }
        if (visible === 0 && Date.now() >= deadline) break;
      } else if (Date.now() >= deadline) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!unique) {
      failures.push(key(c) + (total === 0 ? ' matched nothing' : ' matched ' + total + ' elements'));
      continue;
    }
    await action(locator);
    return;
  }
  throw new Error('no locator resolved (' + failures.join('; ') + ')');
}

// Resolves a dataset parameter: an environment variable when one is set,
// otherwise the value recorded with the step. A test with parameters in it
// must still run with no dataset supplied, which is why the default is baked
// into the call rather than assumed.
function dataset(name, fallback) {
  const fromEnv = process.env[name];
  return fromEnv === undefined || fromEnv === '' ? fallback : fromEnv;
}

// A password, from the environment only. There is no recorded default to fall
// back on — the spec never contains one — so a missing variable stops the test
// with its name rather than typing nothing into a login form.
function secret(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error('set the ' + name + ' environment variable to run this test');
  return value;
}

function key(c) {
  // Mirrors locatorKey in locator.js. The attribute is part of a test-id
  // locator's identity: without it, a data-qa rung and a data-testid rung with
  // the same value would collapse into one and the ladder would lose a rung.
  if (c.strategy === 'role') return 'role:' + c.role + '|' + c.name;
  if (c.strategy === 'testId') return 'testId:' + (c.attr || 'data-testid') + ':' + c.value;
  return c.strategy + ':' + c.value;
}

function source(page, c) {
  switch (c.strategy) {
    // The attribute the recording captured, so the generated spec resolves on
    // the same locator the replayer does. Playwright's getByTestId only ever
    // reads data-testid, which would miss a data-qa labelled element.
    case 'testId':
      return c.attr && c.attr !== 'data-testid'
        ? page.locator('[' + c.attr + '="' + c.value + '"]')
        : page.getByTestId(c.value);
    case 'role':
      return c.ignoreCase
        ? page.getByRole(c.role, { name: new RegExp('^\\\\s*' + c.name.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + '\\\\s*$', 'i') })
        : page.getByRole(c.role, { name: c.name, exact: true });
    case 'label': return page.getByLabel(c.value, { exact: true });
    case 'placeholder': return page.getByPlaceholder(c.value, { exact: true });
    case 'text':
      return c.ignoreCase
        ? page.getByText(new RegExp('^\\\\s*' + c.value.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + '\\\\s*$', 'i'))
        : page.getByText(c.value, { exact: true });
    case 'altText': return page.getByAltText(c.value, { exact: true });
    case 'css': return page.locator(c.value);
    case 'xpath': return page.locator('xpath=' + c.value);
    default: throw new Error('unknown locator strategy: ' + c.strategy);
  }
}
`;

// A dataset parameter resolves through `dataset(NAME, default)`: an
// environment variable if one is set, otherwise the value that was recorded.
// Emitting a bare `${NAME}` would reference a variable nobody declared, so the
// spec would not even parse — a parameterised test has to be runnable as it
// stands.
//
// A password is the exception: its recorded value is never written into the
// spec, because the spec is the file people share. It is read from an
// environment variable with no default, and the test fails up front naming
// the variable when it is not set.
function valueExpr(step) {
  const param = typeof step.valueParam === 'string' ? step.valueParam.trim() : '';
  if (step.secret) return `secret(${q(param || secretName(step))})`;
  if (param) {
    const fallback = step.type === 'press' ? step.key : step.value;
    return `dataset(${q(param)}, ${q(fallback ?? '')})`;
  }
  return q(step.value);
}

// The environment variable a secret step reads in an exported spec.
export function secretName(step) {
  const base = String(step.label || 'password')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return `SECRET_${base || 'PASSWORD'}`;
}

// What an upload step hands setInputFiles in an exported spec. A stored copy is
// referenced where it lives in the flow, relative to the project root that
// `npx playwright test` runs from; a disk path as chosen; a sample by a path
// the reader is told to provide, since a spec has no generator.
function uploadExpr(step, flowId) {
  const spec = step.file || {};
  if (spec.source === 'path') return q((spec.paths || []).length === 1 ? spec.paths[0] : spec.paths || []);
  if (spec.source === 'sample') return q(`fixtures/${spec.name || `sample.${spec.sample || 'pdf'}`}`);
  const stored = (spec.files || []).filter((f) => f.stored).map((f) => `data/sessions/${flowId}/uploads/${f.stored}`);
  return q(stored.length === 1 ? stored[0] : stored);
}

// The Playwright call for a step, as source text. Shared by the spec body and
// the listing so both describe the step identically.
export function actionFor(step, flowId = '<flow>') {
  switch (step.type) {
    case 'click':
      return `click({ timeout: 10000 })`;
    case 'fill':
      return `fill(${valueExpr(step)}, { timeout: 10000 })`;
    case 'select':
      return Array.isArray(step.value)
        ? `selectOption([${step.value.map(q).join(', ')}], { timeout: 10000 })`
        : `selectOption(${valueExpr(step)}, { timeout: 10000 })`;
    case 'press': {
      const param = typeof step.valueParam === 'string' && step.valueParam.trim();
      const key = param
        ? `dataset(${q(step.valueParam.trim())}, ${q(step.key ?? '')})`
        : q(step.key);
      return `press(${key}, { timeout: 10000 })`;
    }
    case 'upload':
      return `setInputFiles(${uploadExpr(step, flowId)}, { timeout: 10000 })`;
    case 'assertVisible':
      return `waitFor({ state: 'visible', timeout: 10000 })`;
    default:
      return null;
  }
}

// A string as a RegExp source that matches it literally.
const literalRe = (expr) => 'new RegExp(' + expr + ".replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'))";

// An assertion step as a Playwright `expect`, or null for any other step.
// Element assertions still go through `resolveStep`, so the spec finds the
// element on the same ladder the replay does; the claim about it is then
// Playwright's own matcher, with its own retrying.
function assertionLine(step, root, chain) {
  const value = valueExpr(step);
  const mode = matchMode(step);
  const text = mode === 'regex' ? `new RegExp(${value})` : value;
  const opts = `{ timeout: 10000 }`;
  switch (step.type) {
    case 'assertText':
      return `await resolveStep(${root}, ${q(chain)}, (l) => expect(l).${mode === 'contains' ? 'toContainText' : 'toHaveText'}(${text}, ${opts}));`;
    case 'assertValue':
      return `await resolveStep(${root}, ${q(chain)}, (l) => expect(l).toHaveValue(${mode === 'contains' ? literalRe(value) : text}, ${opts}));`;
    case 'assertChecked':
      return `await resolveStep(${root}, ${q(chain)}, (l) => expect(l).toBeChecked({ checked: ${step.value !== 'unchecked'}, timeout: 10000 }));`;
    case 'assertCount':
      return `await expect(source(${root}, ${q(chain[0])})).toHaveCount(${Number(String(step.value).trim()) || 0}, ${opts});`;
    case 'assertHidden':
      return `await expect(source(${root}, ${q(chain[0])}).locator('visible=true')).toHaveCount(0, ${opts});`;
    case 'assertUrl':
      return `await expect(page).toHaveURL(${mode === 'contains' ? literalRe(value) : text}, ${opts});`;
    default:
      return null;
  }
}

// The root a step's locators resolve against in the spec: the page, or a chain
// of frameLocators down to the iframe it was recorded in.
function rootExpr(step) {
  if (!Array.isArray(step.frame) || !step.frame.length) return 'page';
  return step.frame.reduce((acc, hop) => `${acc}.frameLocator(${q(`${hopSelector(hop)} >> visible=true`)})`, 'page');
}

// Dialog answers, registered before the step that raises them.
function dialogLines(step) {
  return (step.dialog || []).map((d) =>
    d.accept
      ? `  page.once('dialog', (d) => d.accept(${d.kind === 'prompt' ? q(d.text ?? '') : ''}));  // ${comment(d.kind)}: ${comment(d.message)}`
      : `  page.once('dialog', (d) => d.dismiss());  // ${comment(d.kind)}: ${comment(d.message)}`,
  );
}

// Commented fallback ladder, so the exported test shows what else it can fall
// back to when a locator goes stale.
function candidateComment(step) {
  const chain = chainFor(step).slice(1);
  if (!chain.length) return [];
  return [`  //   fallbacks: ${comment(chain.map(describeLocator).join('  |  '))}`];
}

export function generateSpec(session) {
  const lines = [];
  lines.push(`// Generated by Record POC — recorded in Microsoft Edge`);
  lines.push(`// Flow: ${comment(session.name)}`);
  lines.push(`// Recorded: ${new Date(session.createdAt).toISOString()}`);
  lines.push('');
  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push('');
  lines.push(`test.use({ channel: 'msedge' });`);
  lines.push(RESOLVER);
  lines.push(`test(${q(session.name)}, async ({ page, context }) => {`);
  // Tabs in opening order, so a step recorded in a popup acts in that popup.
  if (session.steps.some((s) => s.page)) {
    lines.push(`  const pages = [page];`);
    lines.push(`  context.on('page', (p) => pages.push(p));`);
    lines.push(`  const tab = async (n) => { while (pages.length <= n) await context.waitForEvent('page'); return pages[n]; };`);
    lines.push('');
  }
  const secrets = [...new Set(session.steps.filter((s) => s.secret).map((s) => (s.valueParam || '').trim() || secretName(s)))];
  if (secrets.length) {
    lines.push(`  // Passwords are never written into this file. Set these environment variables:`);
    for (const name of secrets) lines.push(`  //   ${comment(name)}`);
    lines.push('');
  }

  // Dataset parameters in first-use order, so the file documents what it needs
  // before anyone tries running it. Each is read from an environment variable
  // of the same name, so a run is parameterised by setting environment
  // variables and nothing else.
  const params = collectParams(session.steps);
  if (params.length) {
    lines.push(`// Dataset parameters — override by setting an environment variable of the same name.`);
    for (const name of params) {
      lines.push(`//   ${comment(name)}`);
    }
    lines.push('');
  }

  for (const step of session.steps) {
    lines.push(`  // [${step.index}] ${comment(step.title)}`);
    // The recorded literal stays visible when a parameter replaces it, so the
    // default is never lost.
    if (isParameter(step)) {
      const fallback =
        step.type === 'press' ? step.key : Array.isArray(step.value) ? step.value.join(', ') : step.value;
      lines.push(`  //   recorded default: ${JSON.stringify(fallback ?? '')}`);
    }
    const chain = chainFor(step);
    if (!chain.length) {
      lines.push(`  //   no locator recorded`);
    } else if (chain.length === 1) {
      lines.push(`  //   ${comment(describeLocator(chain[0]))}`);
    } else {
      lines.push(`  //   primary: ${comment(describeLocator(chain[0]))}`);
      lines.push(...candidateComment(step));
    }

    const action = actionFor(step, session.id);
    lines.push(...dialogLines(step));
    // The page the step acts in, and the frame inside it.
    const pageExpr = step.page ? `(await tab(${Number(step.page)}))` : 'page';
    const root = rootExpr(step).replace(/^page/, pageExpr);
    switch (step.type) {
      case 'navigate':
        // A navigation the previous step caused is waited for, not repeated.
        if (step.caused) {
          lines.push(`  await page.waitForURL((u) => u.origin + u.pathname + u.hash === ${q(urlKey(step.url))});`);
        } else {
          lines.push(`  await page.goto(${q(step.url)});`);
          lines.push(`  await page.waitForLoadState('domcontentloaded');`);
        }
        break;
      case 'wait':
        lines.push(`  await page.waitForTimeout(${Number(step.ms) || 0});`);
        break;
      case 'screenshot':
        // Same rule as the runtime: the name is a filename, so it is reduced
        // to something that cannot escape the output directory.
        lines.push(`  await page.screenshot({ path: ${q(screenshotFile(step))} });`);
        break;
      default:
        if (assertionLine(step, root, chain)) {
          lines.push(`  ${assertionLine(step, root, chain)}`);
        } else if (action) {
          lines.push(`  await resolveStep(${root}, ${q(chain)}, (l) => l.${action});`);
        } else {
          lines.push(`  // unsupported step type: ${comment(step.type)}`);
        }
    }
    lines.push('');
  }

  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

// Human-readable listing shown in the UI's "generated code" tab.
export function generateListing(session) {
  const out = [];
  for (const step of session.steps) {
    switch (step.type) {
      case 'navigate':
        out.push(step.caused ? `await page.waitForURL(${q(urlKey(step.url))});` : `await page.goto(${q(step.url)});`);
        break;
      case 'wait':
        out.push(`await page.waitForTimeout(${Number(step.ms) || 0});`);
        break;
      case 'screenshot':
        out.push(`await page.screenshot({ path: ${q(screenshotFile(step))} });`);
        break;
      default: {
        const chain = chainFor(step);
        const assertion = assertionLine(step, 'page', chain);
        if (assertion) {
          out.push(assertion);
          break;
        }
        const action = actionFor(step, session.id);
        if (!chain.length || !action) {
          out.push(`// unsupported step type: ${comment(step.type)}`);
          break;
        }
        out.push(`await resolveStep(page, ${q(chain)}, (l) => l.${action});`);
        break;
      }
    }
  }
  return out.join('\n');
}

// Where a screenshot step's picture is written by the generated spec. Two
// steps sharing a name share a file, which is what a reader would expect from
// naming them the same thing.
export function screenshotFile(step) {
  return `screenshots/${safeScreenshotName(step.value)}.png`;
}

// Primary locator as Playwright source, for display next to the ladder.
export function primarySource(step) {
  const chain = chainFor(step);
  return chain.length ? toLocatorSource(chain[0]) : null;
}
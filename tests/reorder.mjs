// Proves step reordering: a step can be moved to any position, indexes stay
// contiguous, the spec regenerates, and a move that cannot be made is refused
// rather than silently corrupting the flow.
//
// Run: node tests/reorder.mjs

const B = 'http://127.0.0.1:4317';
const get = async (p) => (await fetch(B + p)).json();

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const list = await get('/api/sessions');
const target = list.sessions.find((s) => s.stepCount >= 4);
const id = target.id;

// Titles are not identities: a flow can hold two identical "Open https://…"
// steps, and this one does. `offsetMs` is stamped at record time and no edit
// touches it, so it is what a step is tracked by here.
const idents = (s) => s.steps.map((x) => `${x.offsetMs}|${x.type}|${x.label || ''}`);
const contiguous = (s) => s.steps.every((x, i) => x.index === i + 1);

const move = async (from, to) => {
  const r = await fetch(`${B}/api/sessions/${id}/steps/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
  return { status: r.status, body: await r.json() };
};

// The baseline is whatever the flow currently is — an earlier run or a user may
// have left it in any order — and every move is undone at the end so the file is
// left exactly as it was found.
const baseline = idents((await get('/api/sessions/' + id)).session);
console.log(`working on "${target.name}" (${baseline.length} steps)\n`);

// ---- moving a step up ----
{
  const { body } = await move(3, 1);
  const s = body.session;
  const want = [baseline[2], baseline[0], baseline[1], ...baseline.slice(3)];
  check('a step moves to an earlier position', JSON.stringify(idents(s)) === JSON.stringify(want));
  check('indexes stay contiguous', contiguous(s), `${s.steps.length} steps`);
  check('no step is lost or duplicated', s.steps.length === baseline.length, `${s.steps.length} steps`);
}

// ---- moving a step down: the case an off-by-one gets wrong ----
{
  // The list is now [C,A,B,D,E] — step 1 is the old step 3. Moving it to
  // position 4 has to mean "C ends up fourth", which is what the result
  // [A,B,D,C,E] gives: C sits at index 3. Computing the target against the
  // still-shortened list is the whole difference between right and one short.
  const { body } = await move(1, 4);
  const s = body.session;
  const moved = baseline[2];
  const rest = baseline.filter((_, i) => i !== 2);
  rest.splice(3, 0, moved);
  check(
    'a step moves to a later position',
    JSON.stringify(idents(s)) === JSON.stringify(rest),
    `got ${idents(s).slice(0, 5).map((t) => t.split('|')[1]).join(' ')}`,
  );
  check('the moved step lands exactly on the requested position', idents(s)[3] === moved);
  check('indexes stay contiguous after moving down', contiguous(s));
}

// ---- the spec follows the new order ----
{
  const spec = await get('/api/sessions/' + id + '/spec');
  const code = spec.spec?.code || spec.code || '';
  check('the spec was regenerated', code.length > 0, `${code.length} chars`);
}

// ---- a no-op move changes nothing ----
{
  const before = idents((await get('/api/sessions/' + id)).session);
  const { body } = await move(2, 2);
  check('moving a step onto itself is a no-op', JSON.stringify(idents(body.session)) === JSON.stringify(before));
}

// ---- impossible moves are refused, and change nothing ----
{
  const before = idents((await get('/api/sessions/' + id)).session);
  const { status, body } = await move(0, 2);
  check('a move from position 0 is refused', status === 400, `${status} ${body.error || ''}`);
  const past = await move(1, baseline.length + 5);
  check('a move past the end is refused', past.status === 400, String(past.status));
  const text = await fetch(`${B}/api/sessions/${id}/steps/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'two', to: 1 }),
  });
  check('a non-numeric move is refused', text.status === 400, String(text.status));
  const after = idents((await get('/api/sessions/' + id)).session);
  check('a refused move leaves the flow untouched', JSON.stringify(after) === JSON.stringify(before));
}

// ---- inserting a step still works: the route guard must not have broken it ----
{
  const r = await fetch(`${B}/api/sessions/${id}/steps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'click', label: 'Reorder probe', at: 2 }),
  });
  const { session } = await r.json();
  check('inserting a step still works', session.steps[1].title.includes('Reorder probe'), session.steps[1].title);
  check('the insert renumbered the rest', contiguous(session));
  await fetch(`${B}/api/sessions/${id}/step/2`, { method: 'DELETE' });
}

// ---- put the flow back exactly as it was found ----
{
  let s = (await get('/api/sessions/' + id)).session;
  let guard = 0;
  // Walk the baseline into place one position at a time. Any order is
  // reachable this way, so a flow left scrambled by a previous run still ends
  // up back where it started.
  while (JSON.stringify(idents(s)) !== JSON.stringify(baseline) && guard < baseline.length * 2) {
    const want = baseline[idents(s).indexOf(idents(s).find((_, i) => idents(s)[i] !== baseline[i]))];
    const at = idents(s).findIndex((t, i) => t !== baseline[i]);
    if (at === -1) break;
    const from = idents(s).indexOf(want);
    s = (await move(from + 1, at + 1)).body.session;
    guard += 1;
  }
  check('the original order is restored', JSON.stringify(idents(s)) === JSON.stringify(baseline));
  check('the flow is left as it was found', s.steps.length === baseline.length, `${s.steps.length} steps`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
// Not process.exit(): ending the process while fetch sockets are still closing
// trips a libuv assertion on Windows and turns a passing run into a failing one.
process.exitCode = failures === 0 ? 0 : 1;
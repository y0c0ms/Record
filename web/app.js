// Live demo panel for the landing page. Talks to the same sidecar API the
// desktop GUI uses, so the page exercises the real recorder/replayer.

const $ = (id) => document.getElementById(id);

const els = {
  statusPill: $('statusPill'),
  sessionId: $('sessionId'),
  flowName: $('flowName'),
  btnRecord: $('btnRecord'),
  btnStop: $('btnStop'),
  btnReplay: $('btnReplay'),
  btnExport: $('btnExport'),
  btnCopy: $('btnCopy'),
  steps: $('steps'),
  stepCount: $('stepCount'),
  code: $('code'),
  replaySummary: $('replaySummary'),
  rsResult: $('rsResult'),
  rsSteps: $('rsSteps'),
  rsPassed: $('rsPassed'),
  rsFailed: $('rsFailed'),
  demoUrl: $('demoUrl'),
};

let sessionId = null;
let es = null;
let specCode = '';

const TAGS = {
  navigate: 'goto',
  click: 'click',
  fill: 'fill',
  select: 'select',
  press: 'press',
  assertVisible: 'assert',
  wait: 'wait',
};

function setStatus(text, cls) {
  els.statusPill.textContent = text;
  els.statusPill.className = `pill${cls ? ` ${cls}` : ''}`;
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function renderSteps(steps) {
  els.stepCount.textContent = `${steps.length} step${steps.length === 1 ? '' : 's'}`;
  if (!steps.length) {
    els.steps.innerHTML =
      '<li class="steps-empty">No steps yet — press <em>Record</em> and use the Edge window.</li>';
    return;
  }

  els.steps.innerHTML = '';
  for (const step of steps) {
    const li = document.createElement('li');
    li.className = `step ${step.status === 'passed' ? 'ok' : step.status === 'running' ? 'running' : step.status === 'failed' ? 'failed' : ''}`.trim();
    li.dataset.stepId = step.id;

    const n = document.createElement('span');
    n.className = 'step-n';
    n.textContent = step.index;

    const main = document.createElement('div');
    main.className = 'step-main';
    const title = document.createElement('div');
    title.className = 'step-title';
    title.textContent = step.title;
    const detail = document.createElement('div');
    detail.className = 'step-detail';
    detail.textContent = step.detail || '';
    detail.title = step.detail || '';
    main.append(title, detail);

    const tag = document.createElement('span');
    tag.className = 'step-tag';
    tag.textContent = TAGS[step.type] || step.type;

    li.append(n, main, tag);

    if (step.error) {
      const err = document.createElement('div');
      err.className = 'step-error';
      err.textContent = step.error;
      li.appendChild(err);
    }
    if (step.shot) {
      const shot = document.createElement('div');
      shot.className = 'step-shot';
      const img = document.createElement('img');
      img.src = `/api/sessions/${sessionId}/shot/${step.shot}?t=${Date.now()}`;
      img.alt = `Screenshot after step ${step.index}: ${step.title}`;
      img.loading = 'lazy';
      shot.appendChild(img);
      li.appendChild(shot);
    }

    els.steps.appendChild(li);
  }
  els.steps.scrollTop = els.steps.scrollHeight;
}

function highlightSyntax(code) {
  const escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(/(\/\/[^\n]*)/g, '<span class="com">$1</span>')
    .replace(/('(?:[^'\\]|\\.)*')/g, '<span class="str">$1</span>')
    .replace(/\b(import|from|test|test\.use|async|await|page|expect|const)\b/g, '<span class="kw">$1</span>');
}

function setCode(code) {
  specCode = code || '';
  if (!specCode) {
    els.code.innerHTML = '<code class="dim">// Export the recording to see the generated spec here.</code>';
    els.btnCopy.disabled = true;
    return;
  }
  els.code.innerHTML = `<code>${highlightSyntax(specCode)}</code>`;
  els.btnCopy.disabled = false;
}

function renderReplaySummary(replay) {
  if (!replay) {
    els.replaySummary.hidden = true;
    return;
  }
  els.replaySummary.hidden = false;
  els.rsSteps.textContent = replay.total ?? 0;
  els.rsPassed.textContent = replay.passed ?? 0;
  els.rsFailed.textContent = replay.failed ?? 0;
  els.rsPassed.className = replay.passed ? 'pass' : '';
  els.rsFailed.className = replay.failed ? 'fail' : '';
  const label = {
    running: 'Running…',
    passed: 'All steps passed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  }[replay.status] || replay.status;
  els.rsResult.textContent = label;
  els.rsResult.className = replay.status === 'passed' ? 'pass' : replay.status === 'failed' ? 'fail' : '';
}

function applySession(session) {
  sessionId = session.id;
  els.sessionId.textContent = session.id;
  renderSteps(session.steps || []);
  renderReplaySummary(session.replay);

  const recording = session.status === 'recording';
  els.btnRecord.disabled = recording;
  els.btnStop.disabled = !recording;
  els.btnReplay.disabled = recording || !session.steps.length;
  els.btnExport.disabled = !session.steps.length;

  if (recording) setStatus('Recording', 'is-recording');
  else if (session.status === 'error') setStatus('Error');
  else setStatus(session.steps.length ? 'Ready' : 'Idle');
}

function connectEvents(id) {
  es?.close();
  es = new EventSource(`/api/sessions/${id}/events`);
  es.onmessage = (msg) => {
    const event = JSON.parse(msg.data);
    if (event.type === 'status') {
      applySession(event.session);
    } else if (event.type === 'step') {
      refreshSteps();
    } else if (event.type === 'reset') {
      applySession(event.session);
    } else if (event.type === 'replay:status') {
      renderReplaySummary(event.replay);
      if (event.replay.status === 'passed' || event.replay.status === 'failed') {
        setStatus(event.replay.status === 'passed' ? 'Replay passed' : 'Replay failed',
          event.replay.status === 'passed' ? 'is-passed' : 'is-failed');
      }
    } else if (event.type === 'error') {
      setStatus('Replay failed', 'is-failed');
    }
  };
  es.onerror = () => setStatus('Disconnected', 'is-failed');
}

// Step events arrive one at a time; refetch the authoritative list so ordering
// and screenshots stay consistent.
let refreshTimer = null;
function refreshSteps() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (!sessionId) return;
    try {
      const { session } = await api(`/api/sessions/${sessionId}`);
      renderSteps(session.steps || []);
      renderReplaySummary(session.replay);
      els.btnReplay.disabled = session.status === 'recording' || !session.steps.length;
      els.btnExport.disabled = !session.steps.length;
    } catch {}
  }, 60);
}

els.btnRecord.addEventListener('click', async () => {
  els.btnRecord.disabled = true;
  setStatus('Starting Edge…');
  try {
    // Point the recording window straight at the demo store, so there is a
    // target to drive the moment Edge opens.
    const { session } = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: els.flowName.value.trim() || undefined,
        startUrl: els.demoUrl.href,
      }),
    });
    applySession(session);
    connectEvents(session.id);
  } catch (err) {
    setStatus('Failed to start', 'is-failed');
    alert(`Could not start recording: ${err.message}`);
    els.btnRecord.disabled = false;
  }
});

els.btnStop.addEventListener('click', async () => {
  els.btnStop.disabled = true;
  setStatus('Stopping…');
  try {
    const { session } = await api(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
    applySession(session);
  } catch (err) {
    setStatus('Failed to stop', 'is-failed');
    alert(`Could not stop recording: ${err.message}`);
  }
});

els.btnReplay.addEventListener('click', async () => {
  els.btnReplay.disabled = true;
  setStatus('Replaying…');
  try {
    const { replay } = await api(`/api/sessions/${sessionId}/replay`, { method: 'POST' });
    renderReplaySummary(replay);
  } catch (err) {
    setStatus('Replay failed', 'is-failed');
    alert(`Could not replay: ${err.message}`);
    els.btnReplay.disabled = false;
  }
});

els.btnExport.addEventListener('click', async () => {
  try {
    const { spec, listing } = await api(`/api/sessions/${sessionId}/spec`);
    setCode(spec.code);
    void listing;
  } catch (err) {
    alert(`Could not export: ${err.message}`);
  }
});

els.btnCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(specCode);
    els.btnCopy.textContent = 'Copied';
    setTimeout(() => (els.btnCopy.textContent = 'Copy'), 1400);
  } catch {
    els.btnCopy.textContent = 'Copy failed';
    setTimeout(() => (els.btnCopy.textContent = 'Copy'), 1400);
  }
});

(async function init() {
  const health = await api('/api/health').catch(() => null);
  if (health) {
    els.demoUrl.href = health.demoUrl;
    els.demoUrl.textContent = health.demoUrl.replace(/^https?:\/\//, '');
    els.flowName.value = 'Northwind checkout';
  }

  const { sessions } = await api('/api/sessions').catch(() => ({ sessions: [] }));
  const last = sessions.find((s) => s.stepCount > 0) || sessions[0];
  if (last) {
    const { session } = await api(`/api/sessions/${last.id}`);
    applySession(session);
    connectEvents(session.id);
    if (session.steps.length) {
      const { spec } = await api(`/api/sessions/${session.id}/spec`).catch(() => ({ spec: null }));
      if (spec) setCode(spec.code);
    }
  } else {
    setStatus('Idle');
  }
})();
// Headless CLI for the same engine the GUI uses. Useful for CI or for recording
// without the desktop app.
//
//   node cli.js record https://example.com --name "Sign in"
//   node cli.js replay <sessionId>
//   node cli.js codegen <sessionId>

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createSession, getSession, listSessions } from './src/store.js';
import { Recorder } from './src/recorder.js';
import { Replayer } from './src/replayer.js';
import { generateSpec } from './src/codegen.js';
import { stepTitle } from './src/locator.js';

const [, , command, ...rest] = process.argv;

function printSession(session) {
  console.log(`\n${session.name}  [${session.id}]  ${session.steps.length} step(s)`);
  for (const step of session.steps) {
    const mark = { passed: '✓', failed: '✗', running: '…' }[step.status] || '·';
    console.log(`  ${mark} ${String(step.index).padStart(2)}. ${stepTitle(step)}`);
    console.log(`       ${step.detail}`);
  }
}

async function record(startUrl, name) {
  const session = createSession({ startUrl, name });
  const recorder = new Recorder(session);

  console.log(`Recording "${session.name}" — an Edge window is opening.`);
  console.log('Use the browser, then press Ctrl+C here to stop.\n');

  session.on('step', ({ step }) => {
    console.log(`  ${String(step.index).padStart(2)}. ${step.title}`);
  });

  await recorder.start();

  const stop = async () => {
    console.log('\nStopping…');
    const view = await recorder.stop('user');
    printSession(view);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Keep the process alive until the window closes or the user interrupts.
  await new Promise((resolve) => {
    recorder.context?.on('close', resolve);
    process.stdin.resume();
  });
  if (session.status === 'recording') await stop();
}

async function replay(id) {
  const session = getSession(id);
  if (!session) throw new Error(`no session ${id}`);
  const replayer = new Replayer(session, { headed: true, shots: true });
  session.replay = { status: 'running', total: session.steps.length, passed: 0, failed: 0 };
  session.on('replay', (e) => {
    if (e.type === 'step') {
      const mark = e.step.status === 'passed' ? '✓' : e.step.status === 'failed' ? '✗' : '…';
      console.log(`  ${mark} ${String(e.step.index).padStart(2)}. ${e.step.title}`);
      if (e.step.error) console.log(`       ${e.step.error}`);
    } else if (e.type === 'replay:status' && e.replay.status !== 'running') {
      const r = e.replay;
      console.log(`\n${r.status.toUpperCase()} — ${r.passed}/${r.total} passed, ${r.failed} failed`);
    }
  });

  console.log(`Replaying "${session.name}" in Edge…\n`);
  await replayer.start();
  await replayer.done;
  printSession(session);
  process.exit(session.replay.failed ? 1 : 0);
}

async function codegen(id) {
  const session = getSession(id);
  if (!session) throw new Error(`no session ${id}`);
  const code = generateSpec(session);
  console.log(code);
}

async function runSpec(id) {
  const session = getSession(id);
  if (!session) throw new Error(`no session ${id}`);
  const specPath = `generated/${session.id}.spec.js`;
  console.log(`Running ${specPath} with @playwright/test…\n`);
  const child = spawn('npx', ['playwright', 'test', specPath, '--reporter=list'], {
    stdio: 'inherit',
    shell: true,
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}

async function list() {
  const sessions = listSessions();
  if (!sessions.length) {
    console.log('No recordings yet.');
    return;
  }
  for (const s of sessions) {
    console.log(
      `${s.id}  ${String(s.stepCount).padStart(3)} steps  ${s.status.padEnd(12)} ${s.name}`
    );
  }
}

const commands = {
  record: () => {
    const url = rest.find((a) => !a.startsWith('--')) || 'https://example.com';
    const nameIdx = rest.indexOf('--name');
    const name = nameIdx >= 0 ? rest[nameIdx + 1] : undefined;
    return record(url, name);
  },
  replay: () => replay(rest[0]),
  codegen: () => codegen(rest[0]),
  test: () => runSpec(rest[0]),
  list: () => list(),
};

if (!commands[command]) {
  console.log(`Usage:
  node cli.js record [url] [--name "Flow name"]   record in Edge, Ctrl+C to stop
  node cli.js replay <sessionId>                   replay steps in Edge
  node cli.js codegen <sessionId>                  print the generated Playwright spec
  node cli.js test <sessionId>                     run the generated spec
  node cli.js list                                 list recordings`);
  process.exit(command ? 1 : 0);
}

commands[command]().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
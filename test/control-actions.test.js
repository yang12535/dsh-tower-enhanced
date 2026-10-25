import assert from 'node:assert/strict';
import test from 'node:test';
import { TowerError } from '../lib/errors.js';
import { TowerRuntime } from '../lib/runtime.js';
import { addAndRunWorker, initializedCore, makeRepo } from './helpers.js';

async function controlHarness(t) {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const calls = { send: [], interrupt: [], warnings: [] };
  const agent = {
    id: 'controller-agent',
    session: {
      id: 'controller-session',
      header: {},
      requestHeader: () => undefined,
    },
  };
  const ctx = {
    workingDirectory: { async ensure() { return repo; } },
    sessions: { async flush() {} },
    llm: { async resolveCallConfig(config) { return config; } },
    subagents: {
      async sendMessage(callingAgent, childId, content, options) {
        calls.send.push({ callingAgent, childId, content, options });
        return `message-${calls.send.length}`;
      },
      interrupt(childId, options) {
        calls.interrupt.push({ childId, options });
      },
    },
    logger: { warn(message) { calls.warnings.push(String(message)); } },
  };
  const runtime = new TowerRuntime(ctx, {});
  runtime.cores.set(repo, core);
  return { repo, core, runtime, agent, calls };
}

function execute(harness, action, args = {}) {
  return harness.runtime.execute(
    { action, ...args },
    { agent: harness.agent, signal: new AbortController().signal },
  );
}

function ownActivation(harness, { runId, missionId, role, childId }) {
  const activation = {
    childId,
    result: new Promise(() => {}),
    async dispose() {},
  };
  harness.runtime.active.set(runId, {
    activation,
    core: harness.core,
    parent: harness.agent,
    missionId,
    role,
    runId,
    childId,
    done: Promise.resolve(),
  });
}

async function runningWorker(harness, { attach = true, active = true } = {}) {
  const mission = await harness.core.addMission({ title: 'Control worker', description: 'Exercise control actions.' });
  const begun = await harness.core.beginSpawn({
    missionId: mission.id,
    role: 'worker',
    controllerSessionId: harness.agent.session.id,
  });
  const run = {
    missionId: mission.id,
    role: 'worker',
    runId: begun.runId,
    childId: `child-worker-${mission.id}`,
  };
  if (attach) await harness.core.attachSpawn(run.runId, run.childId);
  if (active) ownActivation(harness, run);
  return run;
}

async function runningReviewer(harness) {
  const completed = await addAndRunWorker(harness.core, { title: 'Review control', description: 'Exercise reviewer control actions.' });
  const begun = await harness.core.beginSpawn({
    missionId: completed.mission.id,
    role: 'reviewer',
    controllerSessionId: harness.agent.session.id,
  });
  const run = {
    missionId: completed.mission.id,
    role: 'reviewer',
    runId: begun.runId,
    childId: `child-reviewer-${completed.mission.id}`,
  };
  await harness.core.attachSpawn(run.runId, run.childId);
  ownActivation(harness, run);
  return run;
}

async function assertControlError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof TowerError);
    assert.equal(error.code, code);
    if (message !== undefined) assert.match(error.message, message);
    return true;
  });
}

test('send forwards a worker instruction to the attached child and returns its run address', async (t) => {
  const harness = await controlHarness(t);
  const run = await runningWorker(harness);
  const result = await execute(harness, 'send', {
    mission_id: run.missionId,
    role: 'worker',
    message: '  Include the regression test.  ',
  });

  assert.equal(result.sent, true);
  assert.equal(result.messageId, 'message-1');
  assert.equal(result.runId, run.runId);
  assert.equal(result.childId, run.childId);
  assert.equal(harness.calls.send.length, 1);
  const forwarded = harness.calls.send[0];
  assert.equal(forwarded.callingAgent, harness.agent);
  assert.equal(forwarded.childId, run.childId);
  assert.deepEqual(forwarded.content, [{ type: 'text', text: 'Include the regression test.' }]);
  assert.ok(forwarded.options.signal instanceof AbortSignal);
  assert.equal(forwarded.options.signal.aborted, false);
  assert.deepEqual(harness.calls.interrupt, []);
});

test('send forwards a reviewer instruction while review is running', async (t) => {
  const harness = await controlHarness(t);
  const run = await runningReviewer(harness);
  const result = await execute(harness, 'send', {
    mission_id: run.missionId,
    role: 'reviewer',
    message: 'Check the exact base and tip binding.',
  });

  assert.equal(result.sent, true);
  assert.equal(result.runId, run.runId);
  assert.equal(result.childId, run.childId);
  assert.equal(harness.calls.send.length, 1);
  assert.equal(harness.calls.send[0].childId, run.childId);
  assert.deepEqual(harness.calls.send[0].content, [{ type: 'text', text: 'Check the exact base and tip binding.' }]);
  assert.deepEqual(harness.calls.interrupt, []);
});

test('interrupt cancels the attached worker as an ancestor and returns its run address', async (t) => {
  const harness = await controlHarness(t);
  const run = await runningWorker(harness);
  const result = await execute(harness, 'interrupt', { mission_id: run.missionId, role: 'worker' });

  assert.equal(result.interrupted, true);
  assert.equal(result.runId, run.runId);
  assert.equal(result.childId, run.childId);
  assert.deepEqual(harness.calls.interrupt, [{ childId: run.childId, options: { kind: 'ancestor', agent: harness.agent } }]);
  assert.deepEqual(harness.calls.send, []);
});

test('send and interrupt reject a pending mission without calling subagents', async (t) => {
  const harness = await controlHarness(t);
  const mission = await harness.core.addMission({ title: 'Pending', description: 'No activation has started.' });
  for (const action of ['send', 'interrupt']) {
    await assertControlError(
      execute(harness, action, { mission_id: mission.id, role: 'worker', message: 'hello' }),
      'AGENT_NOT_RUNNING',
      /has no attached worker/,
    );
  }
  assert.deepEqual(harness.calls.send, []);
  assert.deepEqual(harness.calls.interrupt, []);
});

test('send rejects a completed worker without calling subagents', async (t) => {
  const harness = await controlHarness(t);
  const completed = await addAndRunWorker(harness.core);
  await assertControlError(
    execute(harness, 'send', { mission_id: completed.mission.id, role: 'worker', message: 'too late' }),
    'AGENT_NOT_RUNNING',
    /is worker_completed, not worker_running/,
  );
  assert.deepEqual(harness.calls.send, []);
  assert.deepEqual(harness.calls.interrupt, []);
});

test('interrupt rejects a completed worker without calling subagents', async (t) => {
  const harness = await controlHarness(t);
  const completed = await addAndRunWorker(harness.core);
  await assertControlError(
    execute(harness, 'interrupt', { mission_id: completed.mission.id, role: 'worker' }),
    'AGENT_NOT_RUNNING',
    /is worker_completed, not worker_running/,
  );
  assert.deepEqual(harness.calls.send, []);
  assert.deepEqual(harness.calls.interrupt, []);
});

test('a running mission without an attached child fails cleanly', async (t) => {
  const harness = await controlHarness(t);
  const run = await runningWorker(harness, { attach: false, active: false });
  for (const action of ['send', 'interrupt']) {
    await assertControlError(
      execute(harness, action, { mission_id: run.missionId, role: 'worker', message: 'hello' }),
      'AGENT_NOT_RUNNING',
      /has no attached worker/,
    );
  }
  assert.deepEqual(harness.calls.send, []);
  assert.deepEqual(harness.calls.interrupt, []);
});

test('send rejects a role that does not match the running activation', async (t) => {
  const harness = await controlHarness(t);
  const run = await runningWorker(harness);
  await assertControlError(
    execute(harness, 'send', { mission_id: run.missionId, role: 'reviewer', message: 'wrong role' }),
    'AGENT_NOT_RUNNING',
    /has no attached reviewer/,
  );
  assert.deepEqual(harness.calls.send, []);
});

test('send and interrupt require mission_id and role', async (t) => {
  const harness = await controlHarness(t);
  const run = await runningWorker(harness);
  for (const action of ['send', 'interrupt']) {
    await assertControlError(execute(harness, action, { role: 'worker', message: 'hello' }), 'ARGUMENT_INVALID', /mission_id/);
    await assertControlError(execute(harness, action, { mission_id: run.missionId, message: 'hello' }), 'ARGUMENT_INVALID', /role/);
  }
  assert.deepEqual(harness.calls.send, []);
  assert.deepEqual(harness.calls.interrupt, []);
});

test('send and interrupt report a missing mission', async (t) => {
  const harness = await controlHarness(t);
  for (const action of ['send', 'interrupt']) {
    await assertControlError(
      execute(harness, action, { mission_id: 'NOPE', role: 'worker', message: 'hello' }),
      'MISSION_NOT_FOUND',
      /mission NOPE does not exist/,
    );
  }
  assert.deepEqual(harness.calls.send, []);
  assert.deepEqual(harness.calls.interrupt, []);
});

test('send and interrupt reject an unsupported role', async (t) => {
  const harness = await controlHarness(t);
  const run = await runningWorker(harness);
  for (const action of ['send', 'interrupt']) {
    await assertControlError(
      execute(harness, action, { mission_id: run.missionId, role: 'manager', message: 'invalid role' }),
      'ARGUMENT_INVALID',
      /role must be worker or reviewer/,
    );
  }
  assert.deepEqual(harness.calls.send, []);
  assert.deepEqual(harness.calls.interrupt, []);
});

test('send rejects an attached run left active in state after a runtime restart', async (t) => {
  const harness = await controlHarness(t);
  const run = await runningWorker(harness, { active: false });
  await assertControlError(
    execute(harness, 'send', { mission_id: run.missionId, role: 'worker', message: 'are you still there?' }),
    'AGENT_NOT_RUNNING',
    /not an active activation in this runtime/,
  );
  assert.deepEqual(harness.calls.send, []);
});

test('interrupt rejects an attached run left active in state after a runtime restart', async (t) => {
  const harness = await controlHarness(t);
  const run = await runningWorker(harness, { active: false });
  await assertControlError(
    execute(harness, 'interrupt', { mission_id: run.missionId, role: 'worker' }),
    'AGENT_NOT_RUNNING',
    /not an active activation in this runtime/,
  );
  assert.deepEqual(harness.calls.interrupt, []);
});

test('send rejects a persisted run not owned by this runtime', async (t) => {
  const harness = await controlHarness(t);
  const run = await runningWorker(harness, { active: false });
  ownActivation(harness, { ...run, runId: 'another-run' });
  await assertControlError(
    execute(harness, 'send', { mission_id: run.missionId, role: 'worker', message: 'wrong run owner' }),
    'AGENT_NOT_RUNNING',
    /not an active activation in this runtime/,
  );
  assert.deepEqual(harness.calls.send, []);
});

test('send and interrupt results identify mission and role as well as runId', async (t) => {
  const harness = await controlHarness(t);
  const run = await runningWorker(harness);
  const sent = await execute(harness, 'send', { mission_id: run.missionId, role: 'worker', message: 'hello' });
  const interrupted = await execute(harness, 'interrupt', { mission_id: run.missionId, role: 'worker' });
  for (const result of [sent, interrupted]) {
    assert.equal(result.mission, run.missionId);
    assert.equal(result.role, 'worker');
    assert.equal(result.runId, run.runId);
  }
});

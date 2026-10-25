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

// Reproduction: this test creates a worker_running mission with an active worker, then calls
// send with role=manager through that same runtime.
// Current behavior: core.agentAddress treats manager as reviewer, so send rejects with
// AGENT_NOT_RUNNING ("has no attached reviewer") and does not forward the message.
// Expected: reject before address resolution with ARGUMENT_INVALID and a role whitelist message.
// Suggested fix: in lib/core.js agentAddress or the lib/runtime.js entry point, allow only
// worker/reviewer and throw ARGUMENT_INVALID for every other role.
// After the production fix (see M37), convert this todo into a passing test.
test('send rejects an unsupported role', { todo: 'core.agentAddress currently treats every non-worker role as reviewer' }, async (t) => {
  const harness = await controlHarness(t);
  const run = await runningWorker(harness);
  await assertControlError(
    execute(harness, 'send', { mission_id: run.missionId, role: 'manager', message: 'invalid role' }),
    'ARGUMENT_INVALID',
    /role must be worker or reviewer/,
  );
  assert.deepEqual(harness.calls.send, []);
});

// Reproduction: this test persists a worker_running run and attached childId but deliberately
// leaves runtime.active empty, as after a process restart, then sends through that runtime.
// Current behavior: send still forwards to the persisted childId and returns sent/messageId/
// childId/runId instead of detecting that this runtime owns no active activation for the run.
// Expected: throw AGENT_NOT_RUNNING and make no subagents call.
// Suggested fix: before calling subagents, lib/runtime.js should look up address.runId in
// this.active and verify core, missionId, role, and childId; missing or mismatched entries must
// throw AGENT_NOT_RUNNING.
// After the production fix (see M37), convert this todo into a passing test.
test('send rejects an attached run left active in state after a runtime restart', { todo: 'runtime currently forwards using persisted childId without checking runtime.active' }, async (t) => {
  const harness = await controlHarness(t);
  const run = await runningWorker(harness, { active: false });
  await assertControlError(
    execute(harness, 'send', { mission_id: run.missionId, role: 'worker', message: 'are you still there?' }),
    'AGENT_NOT_RUNNING',
  );
  assert.deepEqual(harness.calls.send, []);
});

// Reproduction: this test persists a worker_running run and attached childId with no matching
// entry in runtime.active, then calls interrupt through that same runtime (the restart case).
// Current behavior: interrupt still calls subagents.interrupt for the persisted childId with
// kind=ancestor and returns interrupted/childId/runId, cancelling a run this runtime does not own.
// Expected: throw AGENT_NOT_RUNNING and make no cancellation call.
// Suggested fix: before calling subagents, lib/runtime.js should find address.runId in this.active
// and verify core, missionId, role, and childId, throwing AGENT_NOT_RUNNING when absent or mismatched.
// After the production fix (see M37), convert this todo into a passing test.
test('interrupt rejects an attached run left active in state after a runtime restart', { todo: 'runtime currently cancels using persisted childId without checking runtime.active' }, async (t) => {
  const harness = await controlHarness(t);
  const run = await runningWorker(harness, { active: false });
  await assertControlError(
    execute(harness, 'interrupt', { mission_id: run.missionId, role: 'worker' }),
    'AGENT_NOT_RUNNING',
  );
  assert.deepEqual(harness.calls.interrupt, []);
});

// Reproduction: this test persists run A with an attached childId, registers only another-run
// in runtime.active, and sends to run A through that runtime.
// Current behavior: send forwards to run A's persisted childId and returns sent/messageId/
// childId/runId even though the sole local activation belongs to a different runId.
// Expected: reject run A with AGENT_NOT_RUNNING and make no subagents call.
// Suggested fix: before calling subagents, lib/runtime.js should look up address.runId itself in
// this.active and verify core, missionId, role, and childId; do not substitute another active run,
// and throw AGENT_NOT_RUNNING on a missing or mismatched entry.
// After the production fix (see M37), convert this todo into a passing test.
test('send rejects a persisted run not owned by this runtime', { todo: 'runtime currently does not compare agentAddress.runId with its active entries' }, async (t) => {
  const harness = await controlHarness(t);
  const run = await runningWorker(harness, { active: false });
  ownActivation(harness, { ...run, runId: 'another-run' });
  await assertControlError(
    execute(harness, 'send', { mission_id: run.missionId, role: 'worker', message: 'wrong run owner' }),
    'AGENT_NOT_RUNNING',
  );
  assert.deepEqual(harness.calls.send, []);
});

// Reproduction: this test creates a worker_running mission with a matching active activation,
// then executes successful send and interrupt calls through the same runtime.
// Current behavior: send returns sent/messageId/childId/runId and interrupt returns
// interrupted/childId/runId; both results have mission === undefined and role === undefined.
// Expected: each successful result explicitly identifies mission and role as well as runId.
// Suggested fix: include mission and role in the success result assembled by lib/runtime.js
// (or enrich the address returned by lib/core.js agentAddress and preserve both fields).
// After the production fix (see M37), convert this todo into a passing test.
test('send and interrupt results identify mission and role as well as runId', { todo: 'core.agentAddress currently returns only childId and runId' }, async (t) => {
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

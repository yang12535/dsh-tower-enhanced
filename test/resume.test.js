import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Context as CordisContext, Service } from '@deepseek-ai/cordis';
import { SUBAGENT_DESCRIPTOR_VERSION, SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';

import { apply, inject } from '../lib/index.js';
import { TowerRuntime } from '../lib/runtime.js';
import { addAndRunWorker, commitFile, initializedCore, makeRepo } from './helpers.js';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const blocks = (text) => [{ type: 'text', text }];
const validVerdict = { verdict: 'clean', merge: true, summary: 'clean', findings: [], checks: [] };

function controllerAgent(id = 'parent') {
  return { id, session: { id, header: {} }, steer() {} };
}

/** Session-log event fixtures shaped like the child's own durable events. */
function userEvent(seq, text) {
  return { seq, type: 'user/message', data: { content: blocks(text) } };
}

function assistantEvent(seq, text) {
  return { seq, type: 'assistant/message', data: { message: { content: blocks(text) }, stream: [] } };
}

function turnEndEvent(reason) {
  return { type: 'turn/end', data: { reason } };
}

const errorReason = (message, code = 'ELOOP') => ({ kind: 'error', error: { message, code } });

/**
 * Fake host for resume flows: a cordis-shaped event bus, a sessionQuery over
 * mutable per-child logs, and a subagents facade whose sendMessage publishes
 * the new epoch's subagent/start the real host publishes during delivery.
 * Everything Tower actually calls is exercised; no model runs.
 */
function resumeHarness(options = {}) {
  const listeners = new Map();
  const interrupts = [];
  const sent = [];
  const started = [];
  const sessionLogs = new Map(options.sessionLogs ?? []);
  const startActivationCalls = [];
  const observations = [];
  let hostRuns = 0;
  let messageIds = 0;
  const warnings = [];
  const ctx = {
    on(name, fn) {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      set.add(fn);
      return () => set.delete(fn);
    },
    sessionQuery: {
      async observeSession(id) {
        const events = sessionLogs.get(id);
        if (events === undefined) throw new Error(`session ${id} not found`);
        const observation = { disposed: false };
        observations.push(observation);
        return {
          source: 'live',
          header: { parentSession: options.parentSession ?? 'parent' },
          inheritedEventCount: 0,
          events: [...events],
          cursor: events.at(-1)?.seq ?? -1,
          [Symbol.dispose]: () => { observation.disposed = true; },
        };
      },
    },
    subagents: {
      async startActivation(spec) {
        startActivationCalls.push(spec);
        throw new Error('resume must cold-resume through sendMessage, never startActivation');
      },
      sendMessage: options.sendMessage ?? (async (parent, childId, content) => {
        hostRuns += 1;
        const runId = `host-run-${hostRuns}`;
        started.push({ childId, runId });
        sent.push({ parent, childId, content });
        emit('subagent/start', { id: childId, runId });
        messageIds += 1;
        return `message-${messageIds}`;
      }),
      interrupt(id, authority) {
        interrupts.push({ id, authority });
      },
    },
    sessions: { async flush() {} },
    logger: {
      warn(message) { warnings.push(String(message)); },
      error(message) { warnings.push(String(message)); },
    },
  };
  const runtime = new TowerRuntime(ctx, {});
  const emit = (name, info) => {
    for (const fn of [...(listeners.get(name) ?? [])]) fn(info);
  };
  return {
    runtime, ctx, emit, interrupts, sent, started, sessionLogs, startActivationCalls, observations, warnings,
    listenerCount: (name) => listeners.get(name)?.size ?? 0,
    lastStart: () => started.at(-1),
  };
}

/** Grow one child's log by one resumed epoch and publish its matched end edge. */
function completeEpoch(harness, { childId, hostRunId, prompt = 'resume round', assistant, extra = [], stopReason = 'completed' }) {
  const log = harness.sessionLogs.get(childId);
  let seq = (log.at(-1)?.seq ?? -1) + 1;
  log.push(userEvent(seq, prompt));
  seq += 1;
  if (assistant !== undefined) {
    log.push(assistantEvent(seq, assistant));
    seq += 1;
  }
  for (const event of extra) {
    log.push({ ...event, seq });
    seq += 1;
  }
  harness.emit('subagent/end', {
    id: childId,
    runId: hostRunId,
    stopReason,
    lastAssistantMessage: assistant === undefined ? [] : blocks(assistant),
  });
}

/** A mission whose worker settled, with an attached child session log. */
async function workerFixture(t, options = {}) {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const added = await core.addMission({ title: 'Implement feature', description: 'Implement and test the feature.' });
  const childId = options.childId ?? 'child-M1';
  const begun = await core.beginSpawn({ missionId: added.id, role: 'worker', ...(options.route ?? {}) });
  await core.attachSpawn(begun.runId, childId);
  commitFile(begun.mission.worktree, 'src/feature.txt', 'implemented\n');
  const mission = await core.completeSpawn(begun.runId, { stopReason: 'completed', output: 'first report' });
  return { core, mission, runId: begun.runId, childId };
}

/** A mission whose first review round failed, leaving a resumable reviewer child. */
async function reviewerFixture(t) {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core);
  const childId = `review-${mission.id}`;
  const begun = await core.beginSpawn({ missionId: mission.id, role: 'reviewer' });
  await core.attachSpawn(begun.runId, childId);
  const failed = await core.failSpawn(begun.runId, new Error('interrupted review'));
  return { core, mission: failed, childId };
}

/** Wrap the core's mutating methods so their relative order is assertable. */
function spyOrder(core, order) {
  for (const name of ['beginSpawn', 'sealResumePrompt', 'attachSpawn', 'completeSpawn', 'failSpawn']) {
    const original = core[name].bind(core);
    core[name] = async (...call) => {
      const value = await original(...call);
      order.push(name);
      return value;
    };
  }
}

// ---------------------------------------------------------------------------
// WAL: beginSpawn → prompt from the new binding → seal hash → send → attach.
// ---------------------------------------------------------------------------

test('resume writes the run, then the prompt fingerprint, before delivering the message', async (t) => {
  const order = [];
  const { core, mission, childId } = await workerFixture(t, { route: { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' } });
  spyOrder(core, order);
  let atSend;
  const harness = resumeHarness({
    sessionLogs: [[childId, [assistantEvent(0, 'first round done')]]],
    sendMessage: async (parent, id, content) => {
      atSend = { mission: await core.mission(mission.id), prompt: content[0].text };
      order.push('sendMessage');
      harness.emit('subagent/start', { id, runId: 'host-run-1' });
      return 'message-1';
    },
  });
  const result = await harness.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'worker', instructions: 'round two' }, new AbortController().signal);

  assert.deepEqual(order, ['beginSpawn', 'sealResumePrompt', 'sendMessage', 'attachSpawn']);
  // The write-ahead intent was durable before delivery: previous run, child,
  // offset — and the sealed fingerprint of the exact prompt being delivered.
  const record = atSend.mission.worker;
  assert.equal(record.runId, result.runId);
  assert.deepEqual(record.resumeFrom, {
    runId: mission.worker.runId,
    childId,
    sessionSeq: 0,
    promptHash: sha256(atSend.prompt),
  });
  // Only the fingerprint is stored; the prompt text never reaches Tower state.
  assert.ok(!JSON.stringify(atSend.mission).includes('round two'), 'resume prompt text leaked into Tower state');
  assert.match(record.resumeFrom.promptHash, /^[0-9a-f]{64}$/);
  assert.equal(result.resumeFrom.promptHash, sha256(atSend.prompt));
  // Delivery correlation is attached after the fact.
  assert.equal(result.messageId, 'message-1');
  assert.equal(result.hostRunId, 'host-run-1');
  const settled = await core.mission(mission.id);
  assert.equal(settled.worker.resumeMessageId, 'message-1');
  assert.equal(settled.worker.resumeHostRunId, 'host-run-1');
});

test('resume reuses the recorded childId, never startActivation, and copies the original route', async (t) => {
  const { core, mission, childId } = await workerFixture(t, { route: { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' } });
  const harness = resumeHarness({ sessionLogs: [[childId, [assistantEvent(0, 'prior')]]] });
  await harness.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'worker' }, new AbortController().signal);
  assert.deepEqual(harness.sent.map((entry) => entry.childId), [childId]);
  assert.deepEqual(harness.startActivationCalls, []);
  const record = (await core.mission(mission.id)).worker;
  assert.equal(record.provider, 'zai-coding-cn');
  assert.equal(record.model, 'glm-5.3');
  assert.equal(record.reasoningEffort, 'max');
  assert.equal(record.resumeFrom.runId, mission.worker.runId);
});

test('resume rejects route overrides instead of silently re-routing the original agent', async (t) => {
  const { core, mission, childId } = await workerFixture(t);
  const harness = resumeHarness({ sessionLogs: [[childId, [assistantEvent(0, 'prior')]]] });
  await assert.rejects(
    harness.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'worker', provider: 'other', model: 'fast' }, new AbortController().signal),
    (error) => error.code === 'ARGUMENT_INVALID' && /cannot be overridden/.test(error.message),
  );
  assert.deepEqual(harness.sent, []);
});

test('a resumed reviewer prompt names the base and tip of THIS round, not the previous binding', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core);
  const old = await core.beginSpawn({ missionId: mission.id, role: 'reviewer' });
  await core.attachSpawn(old.runId, 'review-child');
  await core.failSpawn(old.runId, new Error('interrupted review'));
  commitFile(mission.worktree, 'src/feature.txt', 'changed after prior review\n');
  const harness = resumeHarness({ sessionLogs: [['review-child', [assistantEvent(0, 'prior review context')]]] });
  const result = await harness.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'reviewer' }, new AbortController().signal);
  const prompt = harness.sent[0].content[0].text;
  const binding = (await core.mission(mission.id)).review;
  assert.notEqual(binding.reviewedCommit, old.mission.review.reviewedCommit);
  assert.ok(prompt.includes(`base: ${binding.baseCommit}`), 'new base SHA missing from the delivered prompt');
  assert.ok(prompt.includes(`reviewed: ${binding.reviewedCommit}`), 'new tip SHA missing from the delivered prompt');
  assert.ok(!prompt.includes(`reviewed: ${old.mission.review.reviewedCommit}`), 'prompt still names the stale binding');
  assert.deepEqual(result.binding, { baseCommit: binding.baseCommit, reviewedCommit: binding.reviewedCommit });
});

// ---------------------------------------------------------------------------
// Epoch binding: only this round's host run may settle anything.
// ---------------------------------------------------------------------------

test('an end edge of another epoch never settles the resumed run', async (t) => {
  const { core, mission, childId } = await workerFixture(t);
  const harness = resumeHarness({ sessionLogs: [[childId, [assistantEvent(0, 'prior')]]] });
  const result = await harness.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'worker' }, new AbortController().signal);
  const entry = harness.runtime.active.get(result.runId);
  harness.emit('subagent/end', { id: childId, runId: 'host-run-old', stopReason: 'completed', lastAssistantMessage: blocks('stale output') });
  const outcome = await Promise.race([entry.activation.result, new Promise((resolve) => setTimeout(() => resolve('pending'), 30))]);
  assert.equal(outcome, 'pending');
  assert.equal((await core.mission(mission.id)).status, 'worker_running');
  await harness.runtime.dispose();
});

test('an end edge without this round\'s start is dropped even after the message was accepted', async (t) => {
  const { core, mission, childId } = await workerFixture(t);
  const harness = resumeHarness({
    sessionLogs: [[childId, [assistantEvent(0, 'prior')]]],
    sendMessage: async (parent, id) => {
      // Delivery accepted, but the epoch's start edge is never observed.
      harness.sent.push({ parent, childId: id, content: blocks('resume') });
      return 'message-1';
    },
  });
  const result = await harness.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'worker' }, new AbortController().signal);
  const entry = harness.runtime.active.get(result.runId);
  harness.emit('subagent/end', { id: childId, runId: 'host-run-unbound', stopReason: 'completed', lastAssistantMessage: blocks(JSON.stringify(validVerdict)) });
  const outcome = await Promise.race([entry.activation.result, new Promise((resolve) => setTimeout(() => resolve('pending'), 30))]);
  assert.equal(outcome, 'pending', 'an accepted message id must not substitute for this epoch\'s start binding');
  assert.equal((await core.mission(mission.id)).status, 'worker_running');
  await harness.runtime.dispose();
});

test('two resume rounds keep outputs, verdicts, diagnostics, and listeners separated', async (t) => {
  const { core, mission, childId } = await reviewerFixture(t);

  // Reviewer round 1: changes_requested.
  const harness = resumeHarness({
    sessionLogs: [
      [childId, [assistantEvent(0, 'prior review context')]],
      [`child-${mission.id}`, [assistantEvent(0, 'worker report')]],
    ],
  });
  let round = await harness.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'reviewer', instructions: 'round 1' }, new AbortController().signal);
  completeEpoch(harness, {
    childId,
    hostRunId: harness.lastStart().runId,
    prompt: 'round 1 prompt',
    assistant: JSON.stringify({ verdict: 'changes_requested', merge: false, summary: 'round-1 findings', findings: [{ severity: 'p2', path: 'a.txt', message: 'fix' }], checks: [] }),
  });
  await harness.runtime.active.get(round.runId).done;
  let record = (await core.mission(mission.id)).review;
  assert.equal(record.verdict, 'changes_requested');
  assert.equal(record.summary, 'round-1 findings');
  assert.equal(harness.listenerCount('subagent/end'), 0, 'round 1 listeners must be released');

  // Reviewer round 2 after rework: a fresh binding, no stale-epoch leakage.
  commitFile(mission.worktree, 'src/feature.txt', 'rework\n');
  round = await harness.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'reviewer', instructions: 'round 2' }, new AbortController().signal);
  const round2 = round;
  const round2Run = round2.runId;
  harness.emit('subagent/end', { id: childId, runId: 'host-run-1', stopReason: 'completed', lastAssistantMessage: blocks('stale round-1 message') });
  const pendingRound2 = await Promise.race([
    harness.runtime.active.get(round2Run).activation.result,
    new Promise((resolve) => setTimeout(() => resolve('pending'), 30)),
  ]);
  assert.equal(pendingRound2, 'pending', 'the old epoch\'s end must not settle round 2');
  completeEpoch(harness, {
    childId,
    hostRunId: harness.lastStart().runId,
    prompt: 'round 2 prompt',
    assistant: 'noise before the verdict',
    extra: [assistantEvent(0, JSON.stringify({ ...validVerdict, summary: 'round-2 clean' }))],
  });
  await harness.runtime.active.get(round2Run).done;
  record = (await core.mission(mission.id)).review;
  assert.equal(record.verdict, 'clean', 'the LAST assistant message of this epoch is the verdict');
  assert.equal(record.summary, 'round-2 clean');
  assert.equal((await core.mission(mission.id)).status, 'approved');

  // A worker round after that keeps its own output and diagnostic.
  const workerChild = `child-${mission.id}`;
  const workerRound = await harness.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'worker', instructions: 'worker round' }, new AbortController().signal);
  assert.notEqual(workerRound.runId, round2Run);
  completeEpoch(harness, {
    childId: workerChild,
    hostRunId: harness.lastStart().runId,
    prompt: 'worker round prompt',
    assistant: 'fresh worker output',
    stopReason: 'error',
    extra: [turnEndEvent(errorReason('boom', 'EMODEL'))],
  });
  await harness.runtime.active.get(workerRound.runId).done;
  const worker = (await core.mission(mission.id)).worker;
  assert.equal(worker.output, 'fresh worker output');
  assert.equal(worker.diagnostic, 'EMODEL: boom');
  assert.equal((await core.mission(mission.id)).status, 'worker_failed');
  assert.equal(harness.listenerCount('subagent/start'), 0);
  assert.equal(harness.listenerCount('subagent/end'), 0);
});

// ---------------------------------------------------------------------------
// Strict reviewer verdict parsing (REVIEW_OUTPUT_SCHEMA, zero violations).
// ---------------------------------------------------------------------------

/** Direct settleResumedRun harness observing one epoch suffix after seq 5. */
function verdictUnit(candidateText, fallback = []) {
  const events = [userEvent(6, 'resume prompt'), assistantEvent(7, candidateText)];
  const ctx = {
    sessionQuery: {
      async observeSession() {
        return { header: {}, events, cursor: 7, [Symbol.dispose]() {} };
      },
    },
    logger: { warn() {}, error() {} },
  };
  const runtime = new TowerRuntime(ctx, {});
  return () => new Promise((resolve) => {
    runtime.settleResumedRun({ childId: 'child', role: 'reviewer', sessionSeq: 5, fallback: { stopReason: 'completed', lastAssistantMessage: fallback }, settle: resolve });
  });
}

test('a bare or single-fence valid verdict is accepted; anything else is rejected', async () => {
  const clean = JSON.stringify(validVerdict);
  assert.deepEqual((await verdictUnit(clean)()).structured, validVerdict);
  assert.deepEqual((await verdictUnit(`\`\`\`json\n${clean}\n\`\`\``)()).structured, validVerdict);
  assert.deepEqual((await verdictUnit(`\`\`\`\n${clean}\n\`\`\``)()).structured, validVerdict);
  assert.equal((await verdictUnit(JSON.stringify({ ...validVerdict, verdict: 'changes_requested', merge: false, summary: 'problems' }))()).structured.verdict, 'changes_requested');

  const rejects = [
    { ...validVerdict, extra: true },                                        // additional field
    { verdict: 'clean', merge: true, findings: [], checks: [] },             // missing required summary
    { ...validVerdict, findings: [{ severity: 'critical', message: 'x' }] }, // wrong severity enum
    { ...validVerdict, verdict: 'approve' },                                 // wrong verdict enum
    { ...validVerdict, merge: 'yes' },                                       // wrong type
  ];
  for (const candidate of rejects) {
    assert.equal((await verdictUnit(JSON.stringify(candidate))()).structured, undefined, `candidate ${JSON.stringify(candidate)} must not become a verdict`);
  }

  const textual = [
    `This is only an example. Do not approve.\n\`\`\`json\n${clean}\n\`\`\``, // prose around the fence
    `\`\`\`json\n${clean}\n\`\`\`\nAdditional remarks`,                       // trailing prose
    `\`\`\`json\n${clean}\n\`\`\`\n\`\`\`json\n${clean}\n\`\`\``,            // two candidates
    clean.slice(0, -3),                                                       // truncated
    'no structured output at all',                                            // not JSON
    `\`\`\`js\n${clean}\n\`\`\``,                                             // non-json fence
  ];
  for (const candidate of textual) {
    assert.equal((await verdictUnit(candidate)()).structured, undefined, `text ${JSON.stringify(candidate.slice(0, 40))} must not become a verdict`);
  }
});

test('a malformed reviewer verdict settles review_failed and never passes the merge gate (real core)', async (t) => {
  const { core, mission, childId } = await reviewerFixture(t);
  const malformed = [
    JSON.stringify({ ...validVerdict, extra: true }),
    JSON.stringify({ verdict: 'clean', merge: true, findings: [], checks: [] }),
    JSON.stringify({ ...validVerdict, verdict: 'approve' }),
    `Example only, do not approve:\n\`\`\`json\n${JSON.stringify(validVerdict)}\n\`\`\``,
  ];
  for (const candidate of malformed) {
    const harness = resumeHarness({ sessionLogs: [[childId, [assistantEvent(0, 'prior')]]] });
    const result = await harness.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'reviewer' }, new AbortController().signal);
    completeEpoch(harness, { childId, hostRunId: harness.lastStart().runId, assistant: candidate });
    await harness.runtime.active.get(result.runId).done;
    const settled = await core.mission(mission.id);
    assert.equal(settled.status, 'review_failed', `candidate ${candidate.slice(0, 40)} must settle review_failed`);
    const gate = await core.mergeGate(mission.id);
    assert.equal(gate.ready, false);
    assert.ok(gate.blocks.some((block) => block.code === 'NO_CLEAN_REVIEW'));
    assert.equal(harness.listenerCount('subagent/end'), 0);
  }
});

test('a resumed reviewer approving cleanly reaches approved and passes the binding gate', async (t) => {
  const { core, mission, childId } = await reviewerFixture(t);
  const harness = resumeHarness({ sessionLogs: [[childId, [assistantEvent(0, 'prior')]]] });
  const result = await harness.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'reviewer' }, new AbortController().signal);
  completeEpoch(harness, {
    childId,
    hostRunId: harness.lastStart().runId,
    assistant: JSON.stringify({ ...validVerdict, checks: ['pnpm test'] }),
  });
  await harness.runtime.active.get(result.runId).done;
  const settled = await core.mission(mission.id);
  assert.equal(settled.status, 'approved');
  assert.deepEqual(settled.review.checks, ['pnpm test']);
  assert.equal((await core.mergeGate(mission.id)).ready, true);
});

// ---------------------------------------------------------------------------
// Refusals, rollback, and disposal.
// ---------------------------------------------------------------------------

test('an actively running mission is AGENT_BUSY even though the resume names the same run and child', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const added = await core.addMission({ title: 'Implement feature', description: 'Implement and test the feature.' });
  const begun = await core.beginSpawn({ missionId: added.id, role: 'worker' });
  await core.attachSpawn(begun.runId, 'child-M1');
  const harness = resumeHarness({ sessionLogs: [['child-M1', [assistantEvent(0, 'prior')]]] });
  await assert.rejects(
    harness.runtime.resume(core, controllerAgent(), { mission_id: added.id, role: 'worker' }, new AbortController().signal),
    (error) => error.code === 'AGENT_BUSY',
  );
  assert.equal((await core.mission(added.id)).status, 'worker_running');
});

test('a second resume of a role this runtime already runs in-flight is AGENT_BUSY', async (t) => {
  const { core, mission, childId } = await workerFixture(t);
  const harness = resumeHarness({ sessionLogs: [[childId, [assistantEvent(0, 'prior')]]] });
  await harness.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'worker' }, new AbortController().signal);
  await assert.rejects(
    harness.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'worker' }, new AbortController().signal),
    (error) => error.code === 'AGENT_BUSY',
  );
  assert.equal(harness.sent.length, 1);
  await harness.runtime.dispose();
});

test('a role record without any resumable child is AGENT_NOT_RUNNING and writes no run', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const added = await core.addMission({ title: 'Implement feature', description: 'Implement and test the feature.' });
  const begun = await core.beginSpawn({ missionId: added.id, role: 'worker' }); // never attached
  const harness = resumeHarness({});
  await assert.rejects(
    harness.runtime.resume(core, controllerAgent(), { mission_id: added.id, role: 'worker' }, new AbortController().signal),
    (error) => error.code === 'AGENT_NOT_RUNNING' && /no attached worker child/.test(error.message),
  );
  assert.equal((await core.mission(added.id)).worker.runId, begun.runId);
});

test('an unreadable child session or a foreign parent fails before any state change', async (t) => {
  const { core, mission, childId } = await workerFixture(t);
  const missing = resumeHarness({ sessionLogs: [] });
  await assert.rejects(
    missing.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'worker' }, new AbortController().signal),
    (error) => error.code === 'AGENT_NOT_RUNNING' && /not readable/.test(error.message),
  );
  const foreign = resumeHarness({ sessionLogs: [[childId, [assistantEvent(0, 'prior')]]], parentSession: 'someone-else' });
  await assert.rejects(
    foreign.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'worker' }, new AbortController().signal),
    (error) => error.code === 'AGENT_NOT_RUNNING' && /another parent session/.test(error.message),
  );
  const after = await core.mission(mission.id);
  assert.equal(after.worker.runId, mission.worker.runId);
  assert.equal(after.status, 'worker_completed');
});

test('a failed delivery rolls the run back: interrupt once started, failSpawn, no residue', async (t) => {
  const { core, mission, childId } = await workerFixture(t);
  const order = [];
  spyOrder(core, order);
  const withStart = resumeHarness({
    sessionLogs: [[childId, [assistantEvent(0, 'prior')]]],
    sendMessage: async (parent, id) => {
      withStart.emit('subagent/start', { id, runId: 'host-run-1' });
      throw new Error('delivery rejected');
    },
  });
  await assert.rejects(
    withStart.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'worker' }, new AbortController().signal),
    /delivery rejected/,
  );
  assert.deepEqual(order, ['beginSpawn', 'sealResumePrompt', 'failSpawn']);
  assert.deepEqual(withStart.interrupts.map((entry) => entry.id), [childId]);
  assert.equal(withStart.runtime.active.size, 0);
  assert.equal((await core.mission(mission.id)).status, 'worker_failed');

  // Without a started epoch there is nothing of ours to interrupt; the child
  // is reached through the failed run's resumeFrom fallback.
  const order2 = [];
  spyOrder(core, order2);
  const noStart = resumeHarness({
    sessionLogs: [[childId, [assistantEvent(0, 'prior')]]],
    sendMessage: async () => { throw new Error('cold resume failed'); },
  });
  await assert.rejects(
    noStart.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'worker' }, new AbortController().signal),
    /cold resume failed/,
  );
  assert.deepEqual(order2, ['beginSpawn', 'sealResumePrompt', 'failSpawn']);
  assert.deepEqual(noStart.interrupts, []);
  assert.equal(noStart.runtime.active.size, 0);
});

test('a failed attach rolls the run back the same way', async (t) => {
  const { core, mission, childId } = await workerFixture(t);
  const order = [];
  spyOrder(core, order);
  const spiedAttach = core.attachSpawn.bind(core);
  core.attachSpawn = async (...call) => {
    await spiedAttach(...call);
    throw new Error('attach recording failed');
  };
  const harness = resumeHarness({ sessionLogs: [[childId, [assistantEvent(0, 'prior')]]] });
  const realSend = harness.ctx.subagents.sendMessage.bind(harness.ctx.subagents);
  harness.ctx.subagents.sendMessage = async (...call) => {
    const value = await realSend(...call);
    order.push('sendMessage');
    return value;
  };
  await assert.rejects(
    harness.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'worker' }, new AbortController().signal),
    /attach recording failed/,
  );
  assert.deepEqual(order, ['beginSpawn', 'sealResumePrompt', 'sendMessage', 'attachSpawn', 'failSpawn']);
  assert.deepEqual(harness.interrupts.map((entry) => entry.id), [childId]);
  assert.equal(harness.runtime.active.size, 0);
  assert.equal((await core.mission(mission.id)).status, 'worker_failed');
});

test('dispose after a matched terminal edge never interrupts the child\'s next epoch', async (t) => {
  const { core, mission, childId } = await workerFixture(t);
  let releaseSettlement;
  const settlementGate = new Promise((resolve) => { releaseSettlement = resolve; });
  const harness = resumeHarness({ sessionLogs: [[childId, [assistantEvent(0, 'prior')]]] });
  let reads = 0;
  const walRead = harness.ctx.sessionQuery.observeSession.bind(harness.ctx.sessionQuery);
  harness.ctx.sessionQuery.observeSession = async (id) => {
    reads += 1;
    if (reads === 1) return walRead(id);
    await settlementGate; // the settlement read stays pending until released
    return walRead(id);
  };
  const agent = controllerAgent();
  const result = await harness.runtime.resume(core, agent, { mission_id: mission.id, role: 'worker' }, new AbortController().signal);
  const entry = harness.runtime.active.get(result.runId);
  completeEpoch(harness, { childId, hostRunId: harness.lastStart().runId, assistant: 'finished work' });
  harness.emit('subagent/start', { id: childId, runId: 'host-run-next' });
  try {
    // Release the gated settlement read concurrently with disposal: dispose
    // settles the epoch from its own terminal edge, while entry.done drains
    // the in-flight settlement read — awaiting dispose before releasing the
    // gate would deadlock the test against its own settlement observer.
    const disposing = harness.runtime.dispose();
    releaseSettlement();
    await disposing;
    assert.deepEqual(harness.interrupts, [], 'a settled epoch must not interrupt the child now running host-run-next');
  } finally {
    releaseSettlement();
  }
  await entry.done;
  const settled = await core.mission(mission.id);
  assert.equal(settled.status, 'worker_completed');
  assert.equal(settled.worker.output, 'finished work', 'dispose settles from the epoch\'s own terminal edge');
});

test('dispose before settlement interrupts the epoch and settles aborted without hanging', async (t) => {
  const { core, mission, childId } = await workerFixture(t);
  const harness = resumeHarness({ sessionLogs: [[childId, [assistantEvent(0, 'prior')]]] });
  await harness.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'worker' }, new AbortController().signal);
  harness.emit('subagent/start', { id: childId, runId: harness.lastStart().runId });
  await harness.runtime.dispose();
  assert.deepEqual(harness.interrupts.map((entry) => entry.id), [childId]);
  assert.equal(harness.runtime.active.size, 0);
  const settled = await core.mission(mission.id);
  assert.equal(settled.status, 'worker_failed');
  assert.equal(settled.worker.stopReason, 'aborted');
});

test('runtime dispose of a sent-and-started epoch settles promptly and never rejects entry.done', async (t) => {
  const { core, mission, childId } = await workerFixture(t);
  const harness = resumeHarness({ sessionLogs: [[childId, [assistantEvent(0, 'prior')]]] });
  const result = await harness.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'worker' }, new AbortController().signal);
  // The message was delivered and this epoch's subagent/start observed, but
  // no matching subagent/end will ever arrive: only runtime disposal can
  // settle the run, and it must do so without waiting for such an edge.
  const entry = harness.runtime.active.get(result.runId);
  assert.equal(typeof entry.disposeActivation, 'function', 'a resume entry must carry the spawn-style exactly-once disposal guard');
  // A start of some unrelated child must never turn disposal into its interrupt.
  harness.emit('subagent/start', { id: 'unrelated-child', runId: 'host-run-unrelated' });
  let hang;
  const bounded = new Promise((resolve, reject) => {
    hang = setTimeout(() => reject(new Error('runtime dispose hung on the pending resume epoch')), 5_000);
    hang.unref?.();
  });
  await Promise.race([harness.runtime.dispose(), bounded]);
  clearTimeout(hang);
  await assert.doesNotReject(entry.done, 'track() cleanup must find the guarded disposeActivation and fulfill entry.done');
  assert.deepEqual(harness.interrupts.map((call) => call.id), [childId], 'exactly one interrupt, aimed only at this epoch\'s child');
  assert.equal(harness.runtime.active.size, 0);
  assert.equal(harness.listenerCount('subagent/start'), 0);
  assert.equal(harness.listenerCount('subagent/end'), 0);
  const settled = await core.mission(mission.id);
  assert.equal(settled.status, 'worker_failed');
  assert.equal(settled.worker.stopReason, 'aborted');
});

test('a normally settled resumed epoch fulfills entry.done and steers its settlement notice', async (t) => {
  const { core, mission, childId } = await workerFixture(t);
  const harness = resumeHarness({ sessionLogs: [[childId, [assistantEvent(0, 'prior')]]] });
  const steered = [];
  const agent = { ...controllerAgent(), steer(message) { steered.push(message); } };
  const result = await harness.runtime.resume(core, agent, { mission_id: mission.id, role: 'worker' }, new AbortController().signal);
  const entry = harness.runtime.active.get(result.runId);
  completeEpoch(harness, { childId, hostRunId: harness.lastStart().runId, assistant: 'all done' });
  // entry.done must FULFILL through track()'s guarded cleanup; the notice is
  // steered only after that cleanup, so a disposal TypeError there would
  // reject entry.done and swallow the notice entirely.
  await assert.doesNotReject(entry.done);
  assert.equal(harness.runtime.active.size, 0);
  const settled = await core.mission(mission.id);
  assert.equal(settled.status, 'worker_completed');
  assert.equal(settled.worker.output, 'all done');
  assert.equal(steered.length, 1);
  assert.match(steered[0].content.at(-1).text, /Tower worker for \S+ completed: mission status worker_completed/);
  assert.match(steered[0].content.at(-1).text, /stopReason: completed/);
});

test('every session observation lease taken by a resume is disposed', async (t) => {
  const { core, mission, childId } = await workerFixture(t);
  const harness = resumeHarness({ sessionLogs: [[childId, [assistantEvent(0, 'prior')]]] });
  const result = await harness.runtime.resume(core, controllerAgent(), { mission_id: mission.id, role: 'worker' }, new AbortController().signal);
  completeEpoch(harness, { childId, hostRunId: harness.lastStart().runId, assistant: 'done' });
  await harness.runtime.active.get(result.runId).done;
  // Two reads total: the WAL read before beginSpawn and the settlement read.
  assert.equal(harness.observations.length, 2);
  assert.deepEqual(harness.observations.map((observation) => observation.disposed), [true, true]);
});

// ---------------------------------------------------------------------------
// Core resume bookkeeping.
// ---------------------------------------------------------------------------

test('sealResumePrompt only seals a resume run once and never touches plain spawns', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core);
  const plain = await core.beginSpawn({ missionId: mission.id, role: 'reviewer' });
  await core.attachSpawn(plain.runId, 'review-child');
  await core.failSpawn(plain.runId, new Error('stop'));
  const hash = sha256('prompt');
  await assert.rejects(core.sealResumePrompt(plain.runId, hash), (error) => error.code === 'ARGUMENT_INVALID' && /did not start as a resume run/.test(error.message));

  const resumed = await core.beginSpawn({ missionId: mission.id, role: 'reviewer', resume: { previousRunId: plain.runId, childId: 'review-child', sessionSeq: 3 } });
  await core.sealResumePrompt(resumed.runId, hash);
  assert.equal((await core.mission(mission.id)).review.resumeFrom.promptHash, hash);
  await assert.rejects(core.sealResumePrompt(resumed.runId, sha256('other')), (error) => error.code === 'ARGUMENT_INVALID' && /already sealed/.test(error.message));
  await assert.rejects(core.sealResumePrompt(resumed.runId, 'not-a-hash'), (error) => error.code === 'ARGUMENT_INVALID');
  const state = JSON.stringify(await core.status({ observe: false }));
  assert.ok(!state.includes('"prompt"'), 'no prompt material is stored, only fingerprints');
});

test('beginSpawn validates resume metadata without affecting plain spawns', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core);
  await assert.rejects(
    core.beginSpawn({ missionId: mission.id, role: 'reviewer', resume: { childId: 'c', sessionSeq: 0 } }),
    (error) => error.code === 'ARGUMENT_INVALID' && /previousRunId/.test(error.message),
  );
  await assert.rejects(
    core.beginSpawn({ missionId: mission.id, role: 'reviewer', resume: { previousRunId: 'r', childId: 'c', sessionSeq: 1.5 } }),
    (error) => error.code === 'ARGUMENT_INVALID' && /sessionSeq/.test(error.message),
  );
  await assert.rejects(
    core.beginSpawn({ missionId: mission.id, role: 'reviewer', resume: { previousRunId: 'r', childId: 'c', sessionSeq: 0, promptHash: 'zz' } }),
    (error) => error.code === 'ARGUMENT_INVALID' && /promptHash/.test(error.message),
  );
  const good = await core.beginSpawn({ missionId: mission.id, role: 'reviewer', resume: { previousRunId: 'r', childId: 'c', sessionSeq: 4 } });
  assert.equal((await core.mission(mission.id)).review.resumeFrom.childId, 'c');
  assert.equal(good.mission.review.resumeFrom.sessionSeq, 4);
});

// ---------------------------------------------------------------------------
// Public registration: schema enum, service injection, runtime dispatch.
// ---------------------------------------------------------------------------

test('resume is registered in the schema enum, the inject list, and the runtime dispatch', async () => {
  let definition;
  apply({
    tools: { register(value) { definition = value; } },
    root: { sessionProjections: { register() { return () => {}; } } },
    on: undefined,
    effect() {},
  });
  assert.ok(definition.parameters.properties.action.enum.includes('resume'));
  assert.ok(inject.includes('sessionQuery'));
  const runtime = new TowerRuntime({}, {});
  runtime.resolveRoot = async () => '/fixture';
  runtime.coreAt = async () => ({});
  runtime.publish = async () => {};
  let dispatched = 0;
  runtime.resume = async () => { dispatched += 1; return { resumed: true }; };
  const outcome = await runtime.execute({ action: 'resume', mission_id: 'M1', role: 'worker' }, { agent: controllerAgent(), signal: new AbortController().signal });
  assert.deepEqual(outcome, { resumed: true });
  assert.equal(dispatched, 1);
});

// ---------------------------------------------------------------------------
// Integration: the real SubagentManager.coldResume over a real persisted
// Session. Only the model-execution boundary (materialize/announce) is
// doubled; sendMessage, the cold session read, direct-parent authorization,
// descriptor folding, durable message creation, and delivery all run the
// real host code from @deepseek-ai/dsh-subagent and @deepseek-ai/dsh-session.
// ---------------------------------------------------------------------------

class FakeAgentsService extends Service {
  map = new Map();
  constructor(ctx) { super(ctx, 'agents'); }
  get(id) { return this.map.get(id); }
  list() { return [...this.map.values()]; }
}

class FakeWorkingDirectoryService extends Service {
  constructor(ctx) { super(ctx, 'workingDirectory'); }
  async ensure() { return '/tmp'; }
  async set() {}
}

/** Minimal faithful sessionQuery: a cold read of the persisted session file. */
class FileSessionQueryService extends Service {
  constructor(ctx, sessions, directory) {
    super(ctx, 'sessionQuery');
    this.sessions = sessions;
    this.directory = directory;
  }
  async observeSession(id) {
    const raw = JSON.parse(readFileSync(path.join(this.directory, `${id}.json`), 'utf8'));
    const session = this.sessions.prepare(id, {
      seed: raw.events,
      meta: raw.header,
      inheritedEventCount: raw.inheritedEventCount,
      eventState: 'shared-frozen',
    });
    const events = session.snapshotEvents();
    return {
      source: 'prepared',
      header: session.header,
      inheritedEventCount: session.inheritedEventCount,
      events,
      cursor: events.at(-1)?.seq ?? -1,
      [Symbol.dispose]: () => {},
    };
  }
}

/** Persist one real child session (descriptor included) to disk. */
function persistChildSession(sessions, directory, childId, parentId, descriptor) {
  const live = sessions.prepare(childId, { meta: { cwd: directory, parentSession: parentId, delegationDepth: 1 } });
  live.append('user/message', createUserMessage({ content: blocks('original tower worker brief'), source: { kind: 'user', form: 'prompt' } }), { surfaceOp: 'append' });
  live.append('assistant/message', {
    message: createAssistantMessage({ content: blocks('prior context: half the mission is implemented'), source: { provider: 'zai-coding-cn', model: 'glm-5.3' } }),
    stream: [],
    turn: 0,
    step: 0,
  }, { surfaceOp: 'append' });
  live.append('turn/end', { reason: { kind: 'stopped' } });
  live.append('subagent/descriptor', descriptor);
  writeFileSync(path.join(directory, `${childId}.json`), JSON.stringify({
    header: live.header,
    inheritedEventCount: live.inheritedEventCount,
    events: live.snapshotEvents(),
  }));
}

async function realSubagentHost(directory, parentId) {
  const ctx = new CordisContext({ implementations: {} });
  const sessions = new SessionStore(ctx);
  const agents = new FakeAgentsService(ctx);
  new FakeWorkingDirectoryService(ctx);
  const query = new FileSessionQueryService(ctx, sessions, directory);
  ctx.plugin(SubagentRuntime, {});
  let subagents;
  for (let attempt = 0; attempt < 200 && subagents?.manager === undefined; attempt += 1) {
    subagents = ctx.get('subagents');
    if (subagents?.manager !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { ctx, sessions, agents, query, subagents };
}

test('real SubagentManager.coldResume restores the original session, descriptor, route, and composition', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'dsh-tower-resume-'));
  t.after(() => { rmSync(directory, { recursive: true, force: true }); });
  const parentId = 'controller-1';
  const childId = 'tower-worker-child';
  const host = await realSubagentHost(directory, parentId);

  // Build the persisted child session with the real session store first.
  persistChildSession(host.sessions, directory, childId, parentId, {
    version: SUBAGENT_DESCRIPTOR_VERSION,
    mode: 'continuable',
    provider: 'spawn',
    label: 'tower:M1:worker',
    agentProvider: 'zai-coding-cn',
    agentModel: 'glm-5.3',
    agentReasoningEffort: 'max',
    persona: 'tower-worker',
    toolFilter: { deny: ['bash'] },
  });

  const steered = [];
  const parent = {
    id: parentId,
    session: { id: parentId, header: {} },
    options: {},
    steer(message) { steered.push(message); },
  };
  host.agents.map.set(parentId, parent);
  const manager = host.subagents.manager;
  assert.ok(manager, 'the real SubagentRuntime must expose its SubagentManager once agents is provided');

  // Capture doubles at the model-execution boundary only.
  const materialized = [];
  manager.materialize = async (inputs) => {
    materialized.push({ kind: 'materialize', inputs });
    const fakeAgent = {
      id: inputs.childId,
      inbox: { nextTurn: [], nextStep: [] },
      session: { seq: 5 },
      whenIdle: async () => {},
      steer(message) { steered.push({ to: inputs.childId, message }); },
      cancel() {},
    };
    return {
      kind: 'local',
      childId: inputs.childId,
      parent: inputs.parent,
      handle: { agent: fakeAgent, dispose: async () => {} },
      delivery: 'steer',
      result: Promise.withResolvers(),
      closing: undefined,
      ownedChildren: new Set(),
      poke: Promise.withResolvers(),
      failureAt: undefined,
      structured: undefined,
      announced: false,
      pool: { reserve: () => () => {} },
      releaseSlot: () => {},
      ancestry: new WeakSet([inputs.parent]),
      observer: { start() {}, end() {} },
    };
  };
  manager.announce = (activation) => { materialized.push({ kind: 'announce', childId: activation.childId }); };

  const messageId = await host.subagents.sendMessage(parent, childId, blocks('resume round instructions'), { signal: new AbortController().signal });
  assert.equal(materialized.length, 2, 'exactly one cold resume plus its announce');
  const inputs = materialized[0].inputs;
  // The original descriptor supplied every reconstruction input.
  assert.equal(inputs.childId, childId);
  assert.equal(inputs.provider, 'spawn');
  assert.deepEqual(inputs.agentOptions, { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' });
  assert.equal(inputs.composition.persona, 'tower-worker');
  assert.deepEqual(inputs.composition.toolFilter, { deny: ['bash'] });
  assert.equal(inputs.parent, parent);
  // The delivered message reached the resumed child as a durable user message.
  const delivered = steered.find((entry) => entry.to === childId).message;
  assert.equal(delivered.id, messageId);
  assert.equal(delivered.role, 'user');
  assert.equal(delivered.source.kind, 'agent-message');
  assert.equal(delivered.source.senderSessionId, parentId);
  assert.equal(delivered.content.at(-1).text, 'resume round instructions');
  // The cold read came from the persisted file, never a live session object.
  assert.equal(host.sessions.get(childId), undefined);

  // Direct-parent lineage is enforced by the real manager against the
  // persisted header: a foreign live agent cannot resume this child.
  const foreign = { id: 'foreign-controller', session: { id: 'foreign-controller', header: {} }, steer() {} };
  host.agents.map.set('foreign-controller', foreign);
  await assert.rejects(
    host.subagents.sendMessage(foreign, childId, blocks('hijack attempt'), { signal: new AbortController().signal }),
    (error) => error.code === 'UNAUTHORIZED' && /another parent session/.test(error.message),
  );
});

test('real coldResume refuses a session whose descriptor is not continuable', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'dsh-tower-resume-'));
  t.after(() => { rmSync(directory, { recursive: true, force: true }); });
  const parentId = 'controller-2';
  const childId = 'one-shot-child';
  const host = await realSubagentHost(directory, parentId);
  persistChildSession(host.sessions, directory, childId, parentId, {
    version: SUBAGENT_DESCRIPTOR_VERSION,
    mode: 'one-shot',
    provider: 'spawn',
    label: 'tower:M1:worker',
  });
  const parent = { id: parentId, session: { id: parentId, header: {} }, options: {}, steer() {} };
  host.agents.map.set(parentId, parent);
  const manager = host.subagents.manager;
  assert.ok(manager);
  manager.materialize = async () => { throw new Error('a one-shot descriptor must never be materialized'); };
  manager.announce = () => {};
  await assert.rejects(
    host.subagents.sendMessage(parent, childId, blocks('try to resume'), { signal: new AbortController().signal }),
    (error) => error.code === 'NOT_RESUMABLE',
  );
});

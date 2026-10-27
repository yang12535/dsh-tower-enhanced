import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceRoot = process.env.TOWER_M83_REVIEW_ROOT
  ? pathToFileURL(`${resolve(process.env.TOWER_M83_REVIEW_ROOT)}/`)
  : new URL('../../../.dsh-tower/worktrees/m83/', import.meta.url);
const { TowerRuntime } = await import(new URL('lib/runtime.js', sourceRoot));
const { inject, apply } = await import(new URL('lib/index.js', sourceRoot));
const { makeRepo, initializedCore, addAndRunWorker, commitFile } = await import(new URL('test/helpers.js', sourceRoot));

const valid = { verdict: 'clean', merge: true, summary: 'clean', findings: [], checks: [] };
const blocks = text => [{ type: 'text', text }];
const event = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: blocks(text) }, stream: [] } });
const controller = { id: 'parent', session: { id: 'parent', header: {} }, steer() {} };

function harness(observe = async () => ({ header: { parentSession: 'parent' }, cursor: 5, events: [], [Symbol.dispose]() {} })) {
  const callbacks = new Map();
  const interrupts = [];
  const warnings = [];
  const ctx = {
    on(name, fn) { const set = callbacks.get(name) ?? new Set(); callbacks.set(name, set); set.add(fn); return () => set.delete(fn); },
    sessionQuery: { observeSession: observe },
    subagents: { interrupt(id) { interrupts.push(id); } },
    sessions: { async flush() {} },
    logger: { warn(message) { warnings.push(message); }, error(message) { warnings.push(message); } },
  };
  const emit = (name, info) => { for (const fn of [...(callbacks.get(name) ?? [])]) fn(info); };
  return { runtime: new TowerRuntime(ctx), ctx, emit, interrupts };
}

async function reviewFixture(t) {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core);
  return { repo, core, mission };
}

test('invalid review JSON must settle as review_failed (real TowerCore)', async t => {
  const { core, mission } = await reviewFixture(t);
  const malformed = [
    { ...valid, extra: true },
    { verdict: 'clean', merge: true },
    { ...valid, findings: [{ severity: 'critical', message: 'bad severity enum' }] },
    { ...valid, verdict: 'approve' },
  ];
  const observed = [];
  for (const candidate of malformed) {
    const { runtime } = harness(async () => ({ events: [event(6, JSON.stringify(candidate))], [Symbol.dispose]() {} }));
    const begun = await core.beginSpawn({ missionId: mission.id, role: 'reviewer' });
    let result;
    await runtime.settleResumedRun({ childId: 'child', role: 'reviewer', sessionSeq: 5, fallback: { stopReason: 'completed' }, settle(value) { result = value; } });
    const settled = await core.completeSpawn(begun.runId, result);
    const gate = await core.mergeGate(mission.id);
    observed.push({ status: settled.status, gateReady: gate.ready });
  }
  assert.deepEqual(observed, malformed.map(() => ({ status: 'review_failed', gateReady: false })));
});

test('JSON quoted as an example in prose must not become review approval', async () => {
  const text = `This is an example only. Do not approve this change.\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``;
  const { runtime } = harness(async () => ({ events: [event(6, text)], [Symbol.dispose]() {} }));
  let result;
  await runtime.settleResumedRun({ childId: 'child', role: 'reviewer', sessionSeq: 5, fallback: { stopReason: 'completed' }, settle(value) { result = value; } });
  assert.equal(result.structured, undefined);
});

test('an end event without this resume start must not settle the activation', async t => {
  const { runtime, emit } = harness();
  const activation = runtime.resumeActivation(controller, { runId: 'tower-new', childId: 'child', role: 'reviewer', sessionSeq: 5 });
  t.after(() => activation.dispose());
  activation.accepted();
  emit('subagent/end', { id: 'child', runId: 'old-host-epoch', stopReason: 'completed', lastAssistantMessage: blocks(JSON.stringify(valid)) });
  const outcome = await Promise.race([activation.result, new Promise(resolve => setTimeout(() => resolve('pending'), 30))]);
  assert.equal(outcome, 'pending');
});

test('resumed reviewer prompt must name the newly bound base and tip', async t => {
  const { core, mission } = await reviewFixture(t);
  const old = await core.beginSpawn({ missionId: mission.id, role: 'reviewer' });
  await core.attachSpawn(old.runId, 'child');
  await core.failSpawn(old.runId, new Error('interrupted review'));
  commitFile(mission.worktree, 'src/feature.txt', 'changed after prior review\n');
  const { runtime, ctx, emit } = harness();
  t.after(() => runtime.dispose());
  let captured;
  ctx.subagents.sendMessage = async (_parent, _childId, content) => {
    captured = { prompt: content[0].text, mission: await core.mission(mission.id) };
    emit('subagent/start', { id: 'child', runId: 'host-new' });
    return 'message-new';
  };
  await runtime.resume(core, controller, { mission_id: mission.id, role: 'reviewer' }, new AbortController().signal);
  assert.notEqual(captured.mission.review.reviewedCommit, old.mission.review.reviewedCommit);
  assert.ok(captured.prompt.includes(captured.mission.review.baseCommit) && captured.prompt.includes(captured.mission.review.reviewedCommit), 'new SHA binding is absent from delivered prompt');
});

test('dispose after a matched terminal edge must not interrupt the next host epoch', async () => {
  let releaseObservation;
  const observation = new Promise(resolve => { releaseObservation = resolve; });
  const { runtime, emit, interrupts } = harness(() => observation);
  const activation = runtime.resumeActivation(controller, { runId: 'tower-old', childId: 'child', role: 'worker', sessionSeq: 5 });
  emit('subagent/start', { id: 'child', runId: 'host-old' });
  activation.accepted();
  emit('subagent/end', { id: 'child', runId: 'host-old', stopReason: 'completed' });
  emit('subagent/start', { id: 'child', runId: 'host-next' });
  try {
    await activation.dispose();
    assert.deepEqual(interrupts, [], 'old activation interrupted the child now running host-next');
  } finally {
    releaseObservation({ events: [], [Symbol.dispose]() {} });
  }
});

test('resume is registered in both the public schema and runtime dispatch', async () => {
  let definition;
  apply({
    tools: { register(value) { definition = value; } },
    root: { sessionProjections: { register() { return () => {}; } } },
    effect() {},
  });
  const runtime = new TowerRuntime({});
  runtime.resolveRoot = async () => '/fixture';
  runtime.coreAt = async () => ({});
  runtime.publish = async () => {};
  runtime.resume = async () => ({ resumed: true });
  let dispatch;
  try { dispatch = await runtime.execute({ action: 'resume' }, { agent: controller, signal: new AbortController().signal }); }
  catch (error) { dispatch = error.message; }
  const enumValues = definition.parameters?.properties?.action?.enum ?? definition.parameters?.action?.enum ?? [];
  assert.deepEqual({ schema: enumValues.includes('resume'), sessionQuery: inject.includes('sessionQuery'), dispatch }, { schema: true, sessionQuery: true, dispatch: { resumed: true } });
});

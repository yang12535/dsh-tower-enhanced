import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { initializedCore, makeRepo } from './helpers.js';

const MISSION_COUNT = 100;
const MAX_STATE_BYTES = 1.5 * 1024 * 1024;

async function measure(operation) {
  const startedAt = performance.now();
  const result = await operation();
  return { result, elapsed: performance.now() - startedAt };
}

function syntheticMission(template, id, status) {
  const number = Number(id.slice(1));
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, number)).toISOString();
  const mission = {
    ...template,
    id,
    title: `Scale mission ${id}`,
    description: `Synthetic but schema-valid scale fixture for ${id}.`,
    dependsOn: [],
    scope: ['src/**', 'test/**'],
    branch: `tower/${id.toLowerCase()}`,
    worktree: template.worktree.replace(/m1$/, id.toLowerCase()),
    status,
    revision: 2,
    createdAt: timestamp,
    worktreeRemoved: true,
  };
  if (status !== 'pending') {
    mission.worker = {
      runId: `worker-run-${id}`,
      startedAt: timestamp,
      completedAt: timestamp,
      stopReason: status === 'worker_running' ? undefined : 'completed',
      headCommit: template.baseCommit,
    };
  }
  if (['approved', 'review_running', 'review_failed', 'changes_requested', 'merge_blocked', 'merged'].includes(status)) {
    mission.review = {
      runId: `review-run-${id}`,
      startedAt: timestamp,
      completedAt: timestamp,
      baseCommit: template.baseCommit,
      reviewedCommit: template.baseCommit,
      verdict: status === 'review_failed' ? undefined : 'clean',
      merge: status !== 'review_failed',
      summary: 'Scale fixture review',
      findings: [],
      checks: ['scale smoke'],
    };
  }
  if (status === 'merged') {
    mission.merge = {
      mergedAt: timestamp,
      commit: template.baseCommit,
      reviewedCommit: template.baseCommit,
      baseCommit: template.baseCommit,
    };
  }
  return mission;
}

test('100-mission state remains responsive without unbounded growth', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ id: 'M1', title: 'Real mission one', description: 'A real mission and worktree.' });
  await core.addMission({ id: 'M2', title: 'Real mission two', description: 'A second real mission and worktree.' });

  const state = await core.store.read();
  const template = structuredClone(state.missions[0]);
  const statuses = [
    'worker_running',
    'review_running',
    'worker_completed',
    'worker_failed',
    'review_failed',
    'changes_requested',
    'rebase_blocked',
    'merge_blocked',
    'merged',
    'abandoned',
  ];
  for (let number = 3; number <= MISSION_COUNT; number += 1) {
    const id = `M${number}`;
    // Ten approved, removed-worktree missions exercise the complete state read
    // and real base-repository checks without requiring 100 actual worktrees.
    const status = number <= 12 ? 'approved' : statuses[(number - 13) % statuses.length];
    state.missions.push(syntheticMission(template, id, status));
  }
  state.events = Array.from({ length: 200 }, (_, index) => ({
    time: new Date(Date.UTC(2026, 0, 1, 0, 1, index)).toISOString(),
    type: 'scale-fixture',
    sequence: index,
  }));
  await core.store.write(state);

  // Warm every measured path once so JIT/process startup cannot turn this
  // anti-regression smoke test (not a performance benchmark) into a flaky test.
  await core.status();
  await core.summary();
  await core.mergeGate('M3');
  await core.store.write(await core.store.read());
  await core.editMission({ missionId: 'M1', title: 'Warmup edit' });

  // These deliberately loose limits are anti-regression smoke checks, not
  // performance benchmarks: they catch gross O(n^2) behavior, not small noise.
  const statusResult = await measure(() => core.status());
  assert.equal(statusResult.result.missions.length, MISSION_COUNT);
  assert.ok(statusResult.elapsed < 500, `status() took ${statusResult.elapsed.toFixed(1)}ms`);

  const summaryResult = await measure(() => core.summary());
  const count = (...names) => state.missions.filter((mission) => names.includes(mission.status)).length;
  assert.deepEqual(summaryResult.result.counts, {
    missions: MISSION_COUNT,
    workerRunning: count('worker_running'),
    reviewRunning: count('review_running'),
    approved: count('approved'),
    merged: count('merged'),
    blocked: count('rebase_blocked', 'merge_blocked'),
    abandoned: count('abandoned'),
  });
  assert.ok(summaryResult.elapsed < 500, `summary() took ${summaryResult.elapsed.toFixed(1)}ms`);

  const gateResult = await measure(async () => {
    const gates = [];
    for (let number = 3; number <= 12; number += 1) gates.push(await core.mergeGate(`M${number}`));
    return gates;
  });
  assert.equal(gateResult.result.length, 10);
  for (const gate of gateResult.result) {
    assert.equal(gate.ready, false);
    assert.ok(gate.blocks.some((block) => block.code === 'WORKTREE_REMOVED'));
  }
  assert.ok(gateResult.elapsed < 2_000, `10 mergeGate() calls took ${gateResult.elapsed.toFixed(1)}ms`);

  const writeResult = await measure(() => core.store.write(state));
  assert.ok(writeResult.elapsed < 200, `write() took ${writeResult.elapsed.toFixed(1)}ms`);
  const stateSize = (await stat(core.store.statePath)).size;
  assert.ok(stateSize < MAX_STATE_BYTES, `100-mission state.json is ${stateSize} bytes`);

  const editResult = await measure(() => core.editMission({ missionId: 'M2', title: 'Measured scale edit' }));
  assert.equal(editResult.result.title, 'Measured scale edit');
  assert.ok(editResult.elapsed < 200, `editMission() took ${editResult.elapsed.toFixed(1)}ms`);

  const persisted = await core.store.read();
  assert.equal(persisted.events.length, 200, 'the appendEvent cap must still bound event history');
  assert.equal(persisted.events.at(-1).type, 'mission-edited');
  assert.equal(persisted.events.at(-1).mission, 'M2');
});

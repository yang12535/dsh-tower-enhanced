import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { initializedCore, makeRepo } from './helpers.js';

const MISSION_COUNT = 100;
const MAX_STATE_BYTES = 1.5 * 1024 * 1024;
const EVENT_CAP = 200;
const CAP_EDITS = 205;
const PUBLIC_EVENT_WINDOW = 20;

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

test('a real 205-edit overflow proves appendEvent truncation and the 20-event public window', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ id: 'M1', title: 'Cap probe', description: 'Drives the appendEvent cap with real edits.' });

  // Pin the pre-overflow history instead of assuming it: exactly the init and
  // mission-added events exist before the overflow begins.
  const seededTypes = (await core.store.read()).events.map((event) => event.type);
  assert.deepEqual(seededTypes, ['initialized', 'mission-added']);
  const seedCount = seededTypes.length;

  // Really exceed the cap: 205 sequential edits of one pending mission, each a
  // genuine appendEvent path. Alternating the edited field stamps each event's
  // identity into `fields`, so the surviving window can be identified exactly.
  const overflow = await measure(async () => {
    for (let edit = 1; edit <= CAP_EDITS; edit += 1) {
      if (edit % 2 === 1) await core.editMission({ missionId: 'M1', title: `Cap probe edit ${edit}` });
      else await core.editMission({ missionId: 'M1', description: `Cap probe edit ${edit}.` });
    }
  });
  assert.ok(overflow.elapsed < 1_000, `205 capped edits took ${overflow.elapsed.toFixed(1)}ms`);

  const persisted = await core.store.read();
  assert.equal(persisted.events.length, EVENT_CAP, 'the persisted event history must be capped at 200');

  // The oldest events were really dropped: event #1 (initialized) and #2
  // (mission-added) no longer exist; only edit events remain.
  assert.ok(
    persisted.events.every((event) => event.type === 'mission-edited' && event.mission === 'M1'),
    'the overflow must have evicted the seeded events at the front of the history',
  );

  // Identify the window: seedCount + CAP_EDITS events were appended and 200
  // survive, so the evicted prefix is seedCount + 5 events and the first
  // survivor is edit #6 (an even, description-only edit).
  const evicted = seedCount + CAP_EDITS - EVENT_CAP;
  const firstSurvivingEdit = evicted - seedCount + 1;
  const fieldOf = (edit) => (edit % 2 === 1 ? 'title' : 'description');
  assert.ok(
    persisted.events.every((event, index) => event.fields.length === 1 && event.fields[0] === fieldOf(firstSurvivingEdit + index)),
    `surviving events must be exactly edits #${firstSurvivingEdit}..#${CAP_EDITS} in order`,
  );
  assert.deepEqual(persisted.events.at(-1).fields, ['title'], `edit #${CAP_EDITS} must be the newest persisted event`);

  // Event #201 — the first append that crossed the cap — is edit #199. It must
  // still be present (at index 200 - evicted), proving it entered the history
  // and pushed event #1 out rather than being dropped itself.
  assert.equal(persisted.events[200 - evicted].fields[0], fieldOf(201 - seedCount));

  // The public view only exposes the last 20 events of the capped history.
  const publicView = await core.status();
  assert.equal(publicView.events.length, PUBLIC_EVENT_WINDOW);
  assert.deepEqual(publicView.events, persisted.events.slice(-20));
});

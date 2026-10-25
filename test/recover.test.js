import assert from 'node:assert/strict';
import test from 'node:test';
import { TowerRuntime } from '../lib/runtime.js';
import { TowerError } from '../lib/errors.js';
import { addAndRunWorker, initializedCore, makeRepo } from './helpers.js';

/**
 * System tests for `tower action=recover`, the safety action a restarted
 * controller runs to clear zombie activations left by a dead process.
 *
 * Semantics pinned here (per lib/core.js TowerCore#recover and the recover
 * dispatch in lib/runtime.js TowerRuntime#execute):
 *
 * - A zombie is a mission whose persisted status is exactly `worker_running`
 *   (worker record) or `review_running` (review record) with a runId that this
 *   runtime does not own (`runtime.active`). Recover only marks such runs
 *   interrupted (`stopReason: 'aborted'`, bounded error, `review_failed`/
 *   `worker_failed` retryable status, reviewer records also flagged `stale`).
 * - Recover never adopts: the old runId stays recorded, `runtime.active` stays
 *   empty, and steering/interrupting the old run keeps failing with
 *   AGENT_NOT_RUNNING. Respawn is always a fresh run started by the controller.
 * - Recover never respawns on its own: no activation is started, no new runId
 *   appears, and only `activation-recovered` events are appended.
 * - Without zombies recover is a semantic no-op: missions, revisions, and
 *   events are untouched. (TowerStore#update always rewrites state.json, so
 *   only the store-level `updatedAt` timestamp may refresh.)
 * - A mission whose status already left the running states (e.g. manually
 *   abandoned) keeps a leftover running role record untouched: recover reports
 *   nothing for it and raises no error, and the leftover stays inert.
 * - The implementation does not refuse recover while this same runtime owns a
 *   genuinely live activation: the owned runId is exempted and stays running
 *   while unrelated zombies are still cleaned.
 */

/**
 * Real TowerRuntime harness over a real repository: a controller agent whose
 * working directory resolves to the repo, a subagent service whose activations
 * only settle when the test decides, and a counter proving whether recover
 * ever tried to start a new activation.
 */
function controllerHarness(repo) {
  const calls = { startActivation: 0 };
  const ctx = {
    workingDirectory: { async ensure() { return repo; } },
    sessions: { async flush() {} },
    llm: { async resolveCallConfig(config) { return config; } },
    subagents: {
      async startActivation() {
        calls.startActivation += 1;
        return {
          childId: `child-${calls.startActivation}`,
          result: new Promise(() => {}),
          async dispose() {},
        };
      },
    },
    logger: { warn() {}, error() {} },
  };
  const agent = {
    options: { provider: 'main-provider', model: 'main-smart' },
    session: { id: 'controller-session', header: {}, requestHeader: () => undefined },
    steer() {},
  };
  const runtime = new TowerRuntime(ctx, {});
  const run = (args) => runtime.execute(args, { agent, signal: new AbortController().signal });
  return { runtime, calls, run };
}

/** Every runId persisted across all worker/review records, in stable order. */
function persistedRunIds(state) {
  return state.missions.flatMap((mission) => [mission.worker?.runId, mission.review?.runId]).filter(Boolean).sort();
}

function recoveredEvents(state) {
  return (state.events ?? []).filter((event) => event.type === 'activation-recovered');
}

function missionIn(state, id) {
  return state.missions.find((mission) => mission.id === id);
}

test('recover without zombies is a semantic no-op on mission state', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ id: 'PENDING', title: 'Pending', description: 'Never spawned.' });
  const { mission: finished } = await addAndRunWorker(core, { title: 'Finished', description: 'Worker settled before the restart.' });
  const closed = await core.addMission({ id: 'GONE', title: 'Gone', description: 'Abandoned before the restart.' });
  await core.abandon(closed.id);
  assert.equal(finished.status, 'worker_completed');

  const harness = controllerHarness(repo);
  const before = await core.store.read();
  const result = await harness.run({ action: 'recover' });
  assert.deepEqual(result.recovered, [], 'nothing running in state means nothing to interrupt');
  const after = await core.store.read();
  assert.deepEqual(after.missions, before.missions, 'no mission, record, or revision may change');
  assert.deepEqual(after.events, before.events, 'no event may be appended');
  assert.deepEqual(result.state.missions, after.missions, 'the returned state mirrors the persisted one');
  // The store rewrites state.json on every update, so `updatedAt` is the only
  // field permitted to differ; that refresh carries no revision semantics.
  assert.equal(after.missions[0].revision, before.missions[0].revision);
  assert.equal(harness.runtime.active.size, 0);
  assert.equal(harness.calls.startActivation, 0);
});

test('recover marks worker and reviewer zombies retryable and never respawns them', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const workerZombie = await core.addMission({ id: 'ZW', title: 'Worker zombie', description: 'The previous controller died mid-run.' });
  const workerRun = await core.beginSpawn({ missionId: workerZombie.id, role: 'worker', controllerSessionId: 'old-controller' });
  await core.attachSpawn(workerRun.runId, 'old-worker-child');
  const { mission: reviewHost } = await addAndRunWorker(core, { title: 'Reviewer zombie', description: 'Worker settled, the reviewer did not.' });
  const reviewRun = await core.beginSpawn({ missionId: reviewHost.id, role: 'reviewer', controllerSessionId: 'old-controller' });
  await core.attachSpawn(reviewRun.runId, 'old-review-child');
  const before = await core.store.read();
  const workerCompletedAt = missionIn(before, reviewHost.id).worker.completedAt;

  // A restarted controller: a fresh runtime whose `active` map is empty.
  const harness = controllerHarness(repo);
  const result = await harness.run({ action: 'recover' });
  assert.deepEqual(result.recovered, [
    { mission: 'ZW', role: 'worker', runId: workerRun.runId },
    { mission: reviewHost.id, role: 'reviewer', runId: reviewRun.runId },
  ], 'exactly one interrupted entry per zombie mission, in mission order');

  const after = await core.store.read();
  const workerMission = missionIn(after, 'ZW');
  assert.equal(workerMission.status, 'worker_failed', 'an interrupted worker becomes retryable');
  assert.equal(workerMission.worker.runId, workerRun.runId, 'the old run is closed in place, not replaced');
  assert.equal(workerMission.worker.stopReason, 'aborted', 'the interrupted reason is recorded');
  assert.match(workerMission.worker.error, /not owned by this runtime/);
  assert.ok(workerMission.worker.completedAt, 'the interrupted run gets a completion timestamp');

  const reviewMission = missionIn(after, reviewHost.id);
  assert.equal(reviewMission.status, 'review_failed', 'an interrupted reviewer becomes retryable');
  assert.equal(reviewMission.review.runId, reviewRun.runId);
  assert.equal(reviewMission.review.stopReason, 'aborted');
  assert.equal(reviewMission.review.stale, true, 'a recovered review is marked stale');
  assert.match(reviewMission.review.error, /not owned by this runtime/);
  // Only the role record matching the running status is rewritten: the settled
  // worker record of the reviewer zombie keeps its own completion.
  assert.equal(reviewMission.worker.stopReason, 'completed');
  assert.equal(reviewMission.worker.completedAt, workerCompletedAt);

  // Interrupted bookkeeping only: two activation-recovered events, nothing else.
  const events = recoveredEvents(after);
  assert.deepEqual(events.map((event) => [event.mission, event.role, event.runId]), [
    ['ZW', 'worker', workerRun.runId],
    [reviewHost.id, 'reviewer', reviewRun.runId],
  ]);
  assert.equal(after.events.length - before.events.length, events.length - recoveredEvents(before).length, 'no other events may appear');

  // No automatic respawn: no activation started, no new runId anywhere.
  assert.equal(harness.calls.startActivation, 0, 'recover must not start a new activation');
  assert.deepEqual(persistedRunIds(after), persistedRunIds(before), 'no new runId may appear in state');
  assert.equal(harness.runtime.active.size, 0);

  // The marked missions are retryable by an explicit fresh spawn with a new run.
  const respawned = await core.beginSpawn({ missionId: 'ZW', role: 'worker' });
  assert.equal(respawned.mission.status, 'worker_running');
  assert.notEqual(respawned.runId, workerRun.runId, 'a retry is a fresh run, never the adopted old one');
});

test('recover never adopts the interrupted run into the new controller', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const mission = await core.addMission({ id: 'ADOPT', title: 'Adoption bait', description: 'Recover must mark this run, not own it.' });
  const begun = await core.beginSpawn({ missionId: mission.id, role: 'worker', controllerSessionId: 'old-controller' });
  await core.attachSpawn(begun.runId, 'old-worker-child');

  const harness = controllerHarness(repo);
  await harness.run({ action: 'recover' });
  assert.equal(harness.runtime.active.size, 0, 'recover must not register the old run as owned');
  assert.equal(harness.runtime.active.has(begun.runId), false);

  // The old runId is not re-taken: steering and cancelling it still refuse.
  await assert.rejects(
    harness.run({ action: 'send', mission_id: 'ADOPT', role: 'worker', message: 'try to steer the zombie' }),
    (error) => error instanceof TowerError && error.code === 'AGENT_NOT_RUNNING' && /worker_failed/.test(error.message),
  );
  await assert.rejects(
    harness.run({ action: 'interrupt', mission_id: 'ADOPT', role: 'worker' }),
    (error) => error instanceof TowerError && error.code === 'AGENT_NOT_RUNNING',
  );

  const after = await core.store.read();
  const closed = missionIn(after, 'ADOPT');
  assert.equal(closed.worker.runId, begun.runId, 'the interrupted runId stays recorded for forensics');
  assert.equal(closed.worker.childId, 'old-worker-child', 'the stale child binding is kept, not rewired');
});

test('recover leaves a mission that already reached a terminal state untouched', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const mission = await core.addMission({ id: 'CLOSED', title: 'Manually closed', description: 'A human closed the mission while a run was still recorded as running.' });
  await core.beginSpawn({ missionId: mission.id, role: 'worker', controllerSessionId: 'old-controller' });
  // Manual repair straight in state: the mission is closed but its worker
  // record still claims a live run.
  await core.store.update(async (state) => {
    missionIn(state, 'CLOSED').status = 'abandoned';
  });
  const before = await core.store.read();

  const harness = controllerHarness(repo);
  const result = await harness.run({ action: 'recover' });
  assert.deepEqual(result.recovered, [], 'a mission whose status left the running states is not a zombie');
  const after = await core.store.read();
  assert.deepEqual(after.missions, before.missions, 'the closed mission and its leftover record stay untouched');
  assert.deepEqual(after.events, before.events, 'no recovery event is appended for it');
  const closed = missionIn(after, 'CLOSED');
  assert.equal(closed.status, 'abandoned');
  assert.equal(closed.worker.stopReason, undefined, 'no interrupted marking is invented for a closed mission');
  assert.equal(closed.worker.completedAt, undefined);
  // The leftover running record stays inert: control of it is still refused.
  await assert.rejects(
    harness.run({ action: 'send', mission_id: 'CLOSED', role: 'worker', message: 'steer the leftover' }),
    (error) => error instanceof TowerError && error.code === 'AGENT_NOT_RUNNING',
  );
});

test('a second recover finds no zombies and changes nothing further', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const mission = await core.addMission({ id: 'ONCE', title: 'Recover once', description: 'The second recover must be a no-op.' });
  const begun = await core.beginSpawn({ missionId: mission.id, role: 'worker', controllerSessionId: 'old-controller' });

  const harness = controllerHarness(repo);
  const first = await harness.run({ action: 'recover' });
  assert.deepEqual(first.recovered, [{ mission: 'ONCE', role: 'worker', runId: begun.runId }]);
  const afterFirst = await core.store.read();
  assert.equal(missionIn(afterFirst, 'ONCE').status, 'worker_failed');

  const second = await harness.run({ action: 'recover' });
  assert.deepEqual(second.recovered, [], 'the interrupted run is no longer running, so nothing is left to recover');
  const afterSecond = await core.store.read();
  assert.deepEqual(afterSecond.missions, afterFirst.missions, 'no status or revision may move twice');
  assert.deepEqual(afterSecond.events, afterFirst.events, 'no duplicate activation-recovered event');
  assert.equal(recoveredEvents(afterSecond).length, 1);
  assert.equal(missionIn(afterSecond, 'ONCE').revision, missionIn(afterFirst, 'ONCE').revision);
  assert.equal(harness.calls.startActivation, 0);
});

test('recover exempts a run this controller genuinely owns instead of refusing', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const zombie = await core.addMission({ id: 'STALE', title: 'Zombie', description: 'Started by the previous controller.' });
  const zombieRun = await core.beginSpawn({ missionId: zombie.id, role: 'worker', controllerSessionId: 'old-controller' });
  const live = await core.addMission({ id: 'LIVE', title: 'Live', description: 'Owned by this runtime.' });

  const harness = controllerHarness(repo);
  const started = await harness.run({ action: 'spawn', role: 'worker', mission_id: live.id });
  assert.equal(harness.calls.startActivation, 1);
  assert.equal(harness.runtime.active.size, 1);
  assert.equal(harness.runtime.active.has(started.runId), true);

  // The implementation does not reject recover while a live activation exists
  // (no error code): the owned run is exempted and the zombie is still cleaned.
  const result = await harness.run({ action: 'recover' });
  assert.deepEqual(result.recovered, [{ mission: 'STALE', role: 'worker', runId: zombieRun.runId }]);

  const after = await core.store.read();
  assert.equal(missionIn(after, 'STALE').status, 'worker_failed');
  const liveMission = missionIn(after, 'LIVE');
  assert.equal(liveMission.status, 'worker_running', 'a genuinely live run is not interrupted');
  assert.equal(liveMission.worker.runId, started.runId);
  assert.equal(liveMission.worker.stopReason, undefined);
  assert.equal(liveMission.worker.completedAt, undefined);
  assert.equal(harness.runtime.active.size, 1, 'the owned activation stays owned');
  assert.equal(harness.calls.startActivation, 1, 'recover started no activation of its own');
});

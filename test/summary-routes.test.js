import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { commitFile, initializedCore, makeRepo } from './helpers.js';

/** Spawn a worker with an optional route and walk it to a finished record. */
async function runWorker(core, options = {}) {
  const mission = options.mission ?? await core.addMission({ title: options.title ?? 'Implement feature', description: 'Implement and test the feature.' });
  const begun = await core.beginSpawn({
    missionId: mission.id,
    role: 'worker',
    ...(options.provider === undefined ? {} : { provider: options.provider, model: options.model }),
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
  });
  if (options.commit !== false) commitFile(begun.mission.worktree, options.file ?? `src/${mission.id}.txt`, options.content ?? 'implemented\n', 'worker implementation');
  const completed = await core.completeSpawn(begun.runId, { stopReason: 'completed', output: 'worker report' });
  return completed;
}

/** Spawn a reviewer with an optional route and let it record a clean verdict. */
async function runReviewer(core, missionId, route = {}) {
  const begun = await core.beginSpawn({ missionId, role: 'reviewer', ...route });
  return core.completeSpawn(begun.runId, {
    stopReason: 'completed',
    output: 'clean review',
    structured: { verdict: 'clean', merge: true, summary: 'clean', findings: [], checks: [] },
  });
}

test('routes count worker and reviewer runs per provider/model across missions', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);

  // Same provider on two different models; the reviewer rides another route.
  const first = await runWorker(core, { title: 'First', provider: 'prov-a', model: 'model-a1', reasoningEffort: 'low' });
  await runReviewer(core, first.id, { provider: 'prov-r', model: 'model-r' });
  const second = await runWorker(core, { title: 'Second', provider: 'prov-a', model: 'model-a2' });
  await runReviewer(core, second.id, { provider: 'prov-r', model: 'model-r' });
  // A second mission on the first route must merge into the same bucket.
  await runWorker(core, { title: 'Third', provider: 'prov-a', model: 'model-a1', reasoningEffort: 'low' });
  // No route supplied at spawn time: null must be reported, not invented.
  await runWorker(core, { title: 'Fourth' });

  const summary = await core.summary();
  assert.deepEqual(summary.routes, [
    // total descending; ties break by provider then model lexicographically.
    { provider: 'prov-a', model: 'model-a1', reasoningEffort: 'low', workerCount: 2, reviewerCount: 0, total: 2 },
    { provider: 'prov-r', model: 'model-r', reasoningEffort: null, workerCount: 0, reviewerCount: 2, total: 2 },
    { provider: null, model: null, reasoningEffort: null, workerCount: 1, reviewerCount: 0, total: 1 },
    { provider: 'prov-a', model: 'model-a2', reasoningEffort: null, workerCount: 1, reviewerCount: 0, total: 1 },
  ]);
});

test('route ordering is total-descending with deterministic lexicographic tie-breaks', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);

  // One mission whose worker and reviewer share a route: total 2 beats every
  // total-1 route even though its provider sorts last lexicographically.
  const paired = await runWorker(core, { title: 'Paired', provider: 'prov-z', model: 'model-z' });
  await runReviewer(core, paired.id, { provider: 'prov-z', model: 'model-z' });
  await runWorker(core, { title: 'B route', provider: 'prov-b', model: 'model-s' });
  await runWorker(core, { title: 'A route', provider: 'prov-a', model: 'model-s' });
  await runWorker(core, { title: 'No route' });
  // Same provider and model: the effort dimension keeps the buckets apart.
  await runWorker(core, { title: 'Effort low', provider: 'prov-s', model: 'model-s', reasoningEffort: 'low' });
  await runWorker(core, { title: 'Effort high', provider: 'prov-s', model: 'model-s', reasoningEffort: 'high' });
  await runWorker(core, { title: 'Effort none', provider: 'prov-s', model: 'model-s' });

  const summary = await core.summary();
  assert.deepEqual(summary.routes, [
    { provider: 'prov-z', model: 'model-z', reasoningEffort: null, workerCount: 1, reviewerCount: 1, total: 2 },
    // Null sorts before any string, so the un-routed bucket leads the tie group.
    { provider: null, model: null, reasoningEffort: null, workerCount: 1, reviewerCount: 0, total: 1 },
    { provider: 'prov-a', model: 'model-s', reasoningEffort: null, workerCount: 1, reviewerCount: 0, total: 1 },
    { provider: 'prov-b', model: 'model-s', reasoningEffort: null, workerCount: 1, reviewerCount: 0, total: 1 },
    { provider: 'prov-s', model: 'model-s', reasoningEffort: null, workerCount: 1, reviewerCount: 0, total: 1 },
    { provider: 'prov-s', model: 'model-s', reasoningEffort: 'high', workerCount: 1, reviewerCount: 0, total: 1 },
    { provider: 'prov-s', model: 'model-s', reasoningEffort: 'low', workerCount: 1, reviewerCount: 0, total: 1 },
  ]);
  // The ordering must not drift between reads.
  assert.deepEqual((await core.summary()).routes, summary.routes);
  assert.deepEqual(JSON.parse(JSON.stringify(summary.routes)), summary.routes, 'routes must survive a JSON round trip');
});

test('missionId filtering narrows missions but keeps routes global', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);

  const first = await runWorker(core, { title: 'First', provider: 'prov-a', model: 'model-a' });
  await runWorker(core, { title: 'Second', provider: 'prov-b', model: 'model-b' });

  const filtered = await core.summary({ missionId: first.id });
  assert.equal(filtered.missions.length, 1);
  assert.equal(filtered.missions[0].id, first.id);
  assert.deepEqual(filtered.routes, (await core.summary()).routes, 'routes must describe the whole tower, not the filtered entry');
  assert.deepEqual(filtered.routes, [
    { provider: 'prov-a', model: 'model-a', reasoningEffort: null, workerCount: 1, reviewerCount: 0, total: 1 },
    { provider: 'prov-b', model: 'model-b', reasoningEffort: null, workerCount: 1, reviewerCount: 0, total: 1 },
  ]);
});

test('routes include the records of merged and abandoned missions', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);

  const merged = await runWorker(core, { title: 'Merge me', provider: 'prov-m', model: 'model-m' });
  await runReviewer(core, merged.id, { provider: 'prov-m', model: 'model-m' });
  assert.equal((await core.merge(merged.id)).merged, true);
  const abandoned = await runWorker(core, { title: 'Abandon me', provider: 'prov-x', model: 'model-x' });
  await core.abandon(abandoned.id);

  const summary = await core.summary();
  assert.deepEqual(summary.routes, [
    { provider: 'prov-m', model: 'model-m', reasoningEffort: null, workerCount: 1, reviewerCount: 1, total: 2 },
    { provider: 'prov-x', model: 'model-x', reasoningEffort: null, workerCount: 1, reviewerCount: 0, total: 1 },
  ]);
});

test('an empty tower reports no routes', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const summary = await core.summary();
  assert.deepEqual(summary.routes, []);
  assert.equal(summary.counts.missions, 0);
});

test('reading routes leaves state.json byte-for-byte unchanged', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const first = await runWorker(core, { title: 'First', provider: 'prov-a', model: 'model-a' });
  await runReviewer(core, first.id, { provider: 'prov-r', model: 'model-r' });

  const stateBefore = await core.store.read();
  const bytesBefore = await readFile(core.store.statePath);
  const global = await core.summary();
  const filtered = await core.summary({ missionId: first.id });
  assert.ok(global.routes.length > 0, 'the scenario must produce at least one route');
  assert.deepEqual(filtered.routes, global.routes);

  assert.deepEqual(await core.store.read(), stateBefore, 'summary reads must not change the state object');
  assert.deepEqual(await readFile(core.store.statePath), bytesBefore, 'summary reads must leave state.json byte-for-byte unchanged');
});

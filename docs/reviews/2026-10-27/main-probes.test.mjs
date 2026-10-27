import assert from 'node:assert/strict';
import test from 'node:test';
import { TowerRuntime } from '../../../lib/runtime.js';
import { TowerCore } from '../../../lib/core.js';
import { makeRepo, initializedCore, addAndRunWorker, approve } from '../../../test/helpers.js';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function parent(id) { return { id, options: { provider: 'fixture-provider', model: 'fixture-model' }, session: { id, header: {}, requestHeader() {} }, steer() {} }; }
function harness(repo) {
  const starting = deferred();
  const release = deferred();
  let nextId = 0;
  const runtime = new TowerRuntime({
    workingDirectory: { async ensure() { return repo; } },
    subagents: {
      async startActivation() {
        const index = ++nextId;
        const outcome = deferred();
        const activation = { childId: `fixture-child-${index}`, result: outcome.promise, async dispose() { outcome.resolve({ stopReason: 'aborted', output: [] }); } };
        if (index === 1) { starting.resolve(); await release.promise; }
        return activation;
      },
    },
    logger: { warn() {}, error() {} },
  });
  // This probe concerns core ownership, not host projection persistence.
  runtime.publish = async () => {};
  const run = (agent, args) => runtime.execute(args, { agent, signal: new AbortController().signal });
  return { runtime, run, starting, release };
}

test('a concurrent short call must not release its Session sibling startup claim', async t => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ id: 'M1', title: 'First', description: 'Starting in controller A.' });
  await core.addMission({ id: 'M2', title: 'Second', description: 'Must not start in controller B concurrently.' });
  const { runtime, run, starting, release } = harness(repo);
  const a = parent('controller-A');
  const first = run(a, { action: 'spawn', mission_id: 'M1', role: 'worker' });
  try {
    await starting.promise;
    await run(a, { action: 'summary' });
    const ownerAfterSummary = runtime.workspaceOwner(repo);
    let foreignAccepted = false;
    try { await run(parent('controller-B'), { action: 'spawn', mission_id: 'M2', role: 'worker' }); foreignAccepted = true; }
    catch (error) { assert.equal(error.code, 'WORKSPACE_BUSY'); }
    release.resolve();
    await first;
    const activeControllers = [...new Set([...runtime.active.values()].map(e => e.parent.session.id))];
    assert.deepEqual({ ownerAfterSummary, foreignAccepted, activeControllers }, { ownerAfterSummary: 'controller-A', foreignAccepted: false, activeControllers: ['controller-A'] });
  } finally { release.resolve(); await first.catch(() => {}); await runtime.dispose(); }
});

test('recover must not classify this runtime pending startup as a stale run', async t => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ id: 'M1', title: 'Starting', description: 'The host has not yet returned the activation handle.' });
  const { runtime, run, starting, release } = harness(repo);
  const a = parent('controller-A');
  const first = run(a, { action: 'spawn', mission_id: 'M1', role: 'worker' });
  try {
    await starting.promise;
    const recovered = await run(a, { action: 'recover' });
    release.resolve();
    await first;
    const mission = await core.mission('M1');
    assert.deepEqual({ recovered: recovered.recovered.map(r => r.mission), status: mission.status, tracked: runtime.active.size }, { recovered: [], status: 'worker_running', tracked: 1 });
  } finally { release.resolve(); await first.catch(() => {}); await runtime.dispose(); }
});

test('characterization: worker retry replaces latest record, removes review and reduces route count', async t => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission, runId: originalRun } = await addAndRunWorker(core);
  await approve(core, mission.id);
  const before = await core.summary();
  const retry = await core.beginSpawn({ missionId: mission.id, role: 'worker' });
  const after = await core.summary();
  const stored = await core.mission(mission.id);
  const total = summary => summary.routes.reduce((n, r) => n + r.total, 0);
  assert.notEqual(retry.runId, originalRun);
  assert.equal(stored.review, undefined);
  assert.deepEqual([total(before), total(after)], [2, 1]);
  assert.equal(stored.worker.childId, undefined);
  console.log('CHARACTERIZATION retry: current role count 2 -> 1; original worker child reference and review removed from mission current records');
});

test('characterization: abandonment resolves dependsOn without providing upstream artifacts', async t => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ id: 'UP', title: 'Upstream', description: 'Required API implementation.' });
  await core.addMission({ id: 'DOWN', title: 'Downstream', description: 'Uses upstream API.', dependsOn: ['UP'] });
  await core.abandon('UP');
  const begun = await core.beginSpawn({ missionId: 'DOWN', role: 'worker' });
  assert.equal(begun.mission.status, 'worker_running');
  console.log('CHARACTERIZATION dependency: upstream abandoned -> dependent worker admitted');
});

test('characterization: second core recover does not fence old core late completion', async t => {
  const repo = makeRepo(t);
  const oldCore = await initializedCore(repo);
  const mission = await oldCore.addMission({ title: 'Old controller', description: 'Not a supported multi-host deployment.' });
  const run = await oldCore.beginSpawn({ missionId: mission.id, role: 'worker' });
  const newCore = new TowerCore({ cwd: repo });
  await newCore.open();
  await newCore.recover();
  assert.equal((await newCore.mission(mission.id)).status, 'worker_failed');
  await oldCore.completeSpawn(run.runId, { stopReason: 'completed', output: 'late completion' });
  assert.equal((await newCore.mission(mission.id)).status, 'worker_completed');
  console.log('CHARACTERIZATION known boundary: recovered worker_failed -> old core late write -> worker_completed');
});

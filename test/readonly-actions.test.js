import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { addAndRunWorker, approve, commitFile, initializedCore, makeRepo } from './helpers.js';

function assertJsonRoundTrip(value, label) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label} must survive a JSON round trip`);
}

function blockCodes(gate) {
  return gate.blocks.map((block) => block.code);
}

test('status, summary, and gate agree across mission states without changing state', async (t) => {
  // makeRepo uses a real mkdtemp Git repository and registers t.after cleanup.
  // Every lifecycle transition and every gate query uses the real TowerCore/Git.
  const repo = makeRepo(t);
  const core = await initializedCore(repo);

  const running = await core.addMission({ title: 'Running', description: 'Keep a worker active.' });
  await core.beginSpawn({ missionId: running.id, role: 'worker' });
  const pending = await core.addMission({
    title: 'Pending dependency',
    description: 'Stay pending behind an unmerged dependency.',
    dependsOn: [running.id],
  });
  const completed = await addAndRunWorker(core, {
    title: 'Completed worker',
    file: 'src/completed.txt',
    content: 'completed\n',
  });

  // A real rebase conflict produces rebase_blocked without editing state.json.
  const rebaseBlocked = await addAndRunWorker(core, {
    title: 'Rebase blocked',
    file: 'README.md',
    content: '# worker version\n',
  });
  await approve(core, rebaseBlocked.mission.id);
  commitFile(repo, 'README.md', '# conflicting base\n', 'conflicting base change');
  const rebaseResult = await core.rebase(rebaseBlocked.mission.id);
  assert.equal(rebaseResult.rebased, false);
  assert.equal(rebaseResult.mission.status, 'rebase_blocked');

  const merged = await addAndRunWorker(core, {
    title: 'Merged',
    file: 'src/merged.txt',
    content: 'merged\n',
  });
  await approve(core, merged.mission.id);
  assert.equal((await core.merge(merged.mission.id)).merged, true);

  const approved = await addAndRunWorker(core, {
    title: 'Approved',
    file: 'src/approved.txt',
    content: 'approved\n',
  });
  await approve(core, approved.mission.id);

  // A real pre-merge-commit hook rejects an otherwise merge-ready branch,
  // exercising TowerCore's genuine merge_blocked transition (Git is not mocked).
  await writeFile(path.join(repo, '.git', 'hooks', 'pre-merge-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const mergeBlocked = await addAndRunWorker(core, {
    title: 'Merge blocked',
    file: 'src/merge-blocked.txt',
    content: 'retry merge\n',
  });
  await approve(core, mergeBlocked.mission.id);
  const mergeResult = await core.merge(mergeBlocked.mission.id);
  assert.equal(mergeResult.merged, false);
  assert.equal(mergeResult.mission.status, 'merge_blocked');
  assert.equal(mergeResult.gate.ready, true);

  const abandoned = await core.addMission({ title: 'Abandoned', description: 'Drop this mission.' });
  await core.abandon(abandoned.id);

  const stateBefore = await core.store.read();
  const bytesBefore = await readFile(core.store.statePath);
  const updatedAtBefore = stateBefore.updatedAt;
  const eventsBefore = structuredClone(stateBefore.events);
  const revisionsBefore = stateBefore.missions.map(({ id, revision }) => ({ id, revision }));

  const status = await core.status();
  const summary = await core.summary();
  const filtered = await core.summary({ missionId: pending.id });
  const gates = Object.fromEntries(await Promise.all(
    summary.missions.map(async (mission) => [mission.id, await core.mergeGate(mission.id)]),
  ));

  assert.deepEqual(status.missions.map(({ id, status }) => ({ id, status })), [
    { id: running.id, status: 'worker_running' },
    { id: pending.id, status: 'pending' },
    { id: completed.mission.id, status: 'worker_completed' },
    { id: rebaseBlocked.mission.id, status: 'rebase_blocked' },
    { id: merged.mission.id, status: 'merged' },
    { id: approved.mission.id, status: 'approved' },
    { id: mergeBlocked.mission.id, status: 'merge_blocked' },
    { id: abandoned.id, status: 'abandoned' },
  ]);

  const byStatus = Map.groupBy(status.missions, (mission) => mission.status);
  const count = (...statuses) => statuses.reduce((total, status) => total + (byStatus.get(status)?.length ?? 0), 0);
  assert.deepEqual(summary.counts, {
    missions: status.missions.length,
    workerRunning: count('worker_running'),
    reviewRunning: count('review_running'),
    approved: count('approved'),
    merged: count('merged'),
    // The blocked bucket combines both blocked states; pending and
    // worker_completed are represented only in the total mission count.
    blocked: count('rebase_blocked', 'merge_blocked'),
    abandoned: count('abandoned'),
  });
  assert.deepEqual(summary.counts, {
    missions: 8,
    workerRunning: 1,
    reviewRunning: 0,
    approved: 1,
    merged: 1,
    blocked: 2,
    abandoned: 1,
  });
  assert.equal(count('pending'), 1);
  assert.equal(count('worker_completed'), 1);
  assert.deepEqual(
    summary.missions.map(({ id, status }) => ({ id, status })),
    status.missions.map(({ id, status }) => ({ id, status })),
    'summary entries must use the same mission ids and status names as status',
  );

  assert.deepEqual(filtered.counts, summary.counts, 'filtering one entry must leave counts global');
  assert.equal(filtered.missions.length, 1);
  assert.deepEqual(filtered.missions[0], summary.missions.find((mission) => mission.id === pending.id));
  assert.equal(filtered.missions[0].status, 'pending');
  assert.deepEqual(filtered.missions[0].dependsOn, [running.id]);

  // Approved and merge_blocked are both merge-gate eligible. The latter is a
  // retryable outcome, not a NOT_APPROVED state.
  for (const id of [approved.mission.id, mergeBlocked.mission.id]) {
    assert.ok(['approved', 'merge_blocked'].includes(summary.missions.find((mission) => mission.id === id).status));
    assert.equal(gates[id].ready, true);
    assert.deepEqual(gates[id].blocks, []);
  }
  assert.equal(gates[merged.mission.id].ready, false);
  assert.equal(gates[merged.mission.id].alreadyMerged, true);
  assert.deepEqual(gates[merged.mission.id].blocks, []);
  assert.ok(gates[merged.mission.id].warnings.some((block) => block.code === 'NOT_APPROVED'));

  for (const mission of summary.missions) {
    const gate = gates[mission.id];
    if (!['approved', 'merge_blocked', 'merged'].includes(mission.status)) {
      assert.equal(gate.ready, false, `${mission.status} must not be merge-ready`);
      assert.ok(blockCodes(gate).includes('NOT_APPROVED'), `${mission.status} must report NOT_APPROVED`);
    }
  }
  assert.ok(blockCodes(gates[pending.id]).includes('DEPENDENCIES_NOT_MERGED'));
  assert.ok(blockCodes(gates[rebaseBlocked.mission.id]).includes('STALE_BASE'));
  assert.ok(blockCodes(gates[completed.mission.id]).includes('NO_CLEAN_REVIEW'));

  for (const [label, output] of [
    ['status', status],
    ['summary', summary],
    ['filtered summary', filtered],
    ...Object.entries(gates).map(([id, gate]) => [`gate ${id}`, gate]),
  ]) {
    assertJsonRoundTrip(output, label);
  }

  const stateAfter = await core.store.read();
  const bytesAfter = await readFile(core.store.statePath);
  assert.deepEqual(stateAfter, stateBefore, 'read actions must not change state returned by store.read()');
  assert.deepEqual(bytesAfter, bytesBefore, 'read actions must leave state.json byte-for-byte unchanged');
  assert.equal(stateAfter.updatedAt, updatedAtBefore);
  assert.deepEqual(stateAfter.events, eventsBefore);
  assert.deepEqual(stateAfter.missions.map(({ id, revision }) => ({ id, revision })), revisionsBefore);
});

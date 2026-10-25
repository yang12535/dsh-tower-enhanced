import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { recoverMergeFailure, recoverRebaseFailure, TowerCore } from '../lib/core.js';
import { addAndRunWorker, approve, commitFile, git, initializedCore, makeRepo, writeDirty } from './helpers.js';

test('worker -> exact review -> merge -> teardown lifecycle', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const store = core.store;
  await core.open();
  assert.equal(core.store, store, 'opening an existing core must preserve its per-repo queue');
  const { mission, worktree } = await addAndRunWorker(core, { scope: ['src/**'] });
  assert.equal(mission.status, 'worker_completed');
  const blocked = await core.mergeGate(mission.id);
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blocks.some((block) => block.code === 'NO_CLEAN_REVIEW'));
  const approved = await approve(core, mission.id);
  assert.equal(approved.mission.status, 'approved');
  assert.equal((await core.mergeGate(mission.id)).ready, true);
  const merged = await core.merge(mission.id);
  assert.equal(merged.merged, true);
  assert.equal(merged.advanced, false);
  assert.equal(merged.mission.status, 'merged');
  assert.equal(merged.mission.merge.reviewedCommit, approved.binding.reviewedCommit);
  assert.equal(git(repo, 'show', 'HEAD:src/feature.txt'), 'implemented');
  const legacy = await core.store.read();
  delete legacy.missions[0].merge;
  await core.store.write(legacy);
  const idempotent = await core.merge(mission.id);
  assert.equal(Object.hasOwn(idempotent, 'mergeCommit'), false);
  assert.deepEqual(validateJsonSchemaValue({}, idempotent), []);
  const torn = await core.teardown({ missionId: mission.id });
  assert.equal(torn.results[0].removed, true);
  assert.equal(existsSync(worktree), false);
  assert.equal(git(repo, 'rev-parse', '--verify', merged.mission.branch), approved.binding.reviewedCommit);
});

test('a tip moving during review invalidates the verdict', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission, worktree } = await addAndRunWorker(core);
  const begun = await core.beginSpawn({ missionId: mission.id, role: 'reviewer' });
  commitFile(worktree, 'src/late.txt', 'late change\n', 'tip moves during review');
  const completed = await core.completeSpawn(begun.runId, {
    stopReason: 'completed',
    structured: { verdict: 'clean', merge: true, summary: 'stale', findings: [], checks: [] },
  });
  assert.equal(completed.status, 'worker_completed');
  assert.equal(completed.review.stale, true);
  const gate = await core.mergeGate(mission.id);
  assert.equal(gate.ready, false);
  assert.ok(gate.blocks.some((block) => block.code === 'NOT_APPROVED'));
});

test('base movement requires rebase and a fresh review', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core);
  const first = await approve(core, mission.id);
  assert.equal(first.mission.status, 'approved');
  commitFile(repo, 'base-only.txt', 'base moved\n', 'advance base');
  const stale = await core.mergeGate(mission.id);
  assert.equal(stale.ready, false);
  assert.ok(stale.blocks.some((block) => block.code === 'STALE_BASE' || block.code === 'REVIEW_BASE_STALE'));
  const rebased = await core.rebase(mission.id);
  assert.equal(rebased.rebased, true);
  assert.equal(rebased.reviewRequired, true);
  assert.equal(rebased.mission.status, 'worker_completed');
  assert.equal(rebased.mission.review, undefined);
  await approve(core, mission.id);
  const merged = await core.merge(mission.id);
  assert.equal(merged.merged, true);
  assert.equal(git(repo, 'show', 'HEAD:src/feature.txt'), 'implemented');
  assert.equal(git(repo, 'show', 'HEAD:base-only.txt'), 'base moved');
});

test('scope violations survive a clean reviewer but fail the merge gate', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core, { scope: ['allowed/**'], file: 'forbidden.txt' });
  await approve(core, mission.id);
  const gate = await core.mergeGate(mission.id);
  assert.equal(gate.ready, false);
  assert.ok(gate.blocks.some((block) => block.code === 'OUT_OF_SCOPE'));
  const result = await core.merge(mission.id);
  assert.equal(result.merged, false);
  assert.equal(result.mission.status, 'approved');
});

test('a rename cannot hide its old path from the scope gate', async (t) => {
  const repo = makeRepo(t);
  commitFile(repo, 'forbidden.txt', 'original\n', 'add forbidden source');
  const core = await initializedCore(repo);
  const mission = await core.addMission({ title: 'Rename', description: 'Rename a file', scope: ['allowed/**'] });
  const begun = await core.beginSpawn({ missionId: mission.id, role: 'worker' });
  await core.attachSpawn(begun.runId, 'worker-rename');
  mkdirSync(path.join(begun.mission.worktree, 'allowed'));
  git(begun.mission.worktree, 'mv', 'forbidden.txt', 'allowed/new.txt');
  git(begun.mission.worktree, 'commit', '-m', 'rename into allowed scope');
  await core.completeSpawn(begun.runId, { stopReason: 'completed' });
  await approve(core, mission.id);
  const gate = await core.mergeGate(mission.id);
  assert.equal(gate.ready, false);
  assert.ok(gate.blocks.some((block) => block.code === 'OUT_OF_SCOPE'));
});

test('dirty worker output cannot enter review', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core, { change: false, dirty: 'uncommitted.txt' });
  assert.equal(mission.status, 'worker_failed');
  assert.ok(mission.worker.error.includes('uncommitted'));
  await assert.rejects(core.beginSpawn({ missionId: mission.id, role: 'reviewer' }), /must complete a worker/);
});

test('dependencies gate worker startup and abandoned dependencies are explicit', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const first = await core.addMission({ title: 'First', description: 'First mission' });
  const second = await core.addMission({ title: 'Second', description: 'Second mission', dependsOn: [first.id] });
  await assert.rejects(core.beginSpawn({ missionId: second.id, role: 'worker' }), /unmerged dependencies/);
  await core.abandon(first.id);
  const begun = await core.beginSpawn({ missionId: second.id, role: 'worker' });
  assert.equal(begun.mission.status, 'worker_running');
});

test('rebase conflict aborts and preserves a clean mission worktree', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission, worktree } = await addAndRunWorker(core, { file: 'README.md', content: '# worker version\n' });
  await approve(core, mission.id);
  commitFile(repo, 'README.md', '# conflicting base\n', 'conflicting base change');
  const result = await core.rebase(mission.id);
  assert.equal(result.rebased, false);
  assert.equal(result.recoveryRequired, false);
  assert.equal(result.mission.status, 'rebase_blocked');
  assert.equal(git(worktree, 'status', '--porcelain'), '');
  assert.equal(git(worktree, 'show', 'HEAD:README.md'), '# worker version');
});

test('observed status remains canonical JSON in detached HEAD', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ title: 'Detached', description: 'Inspect detached status' });
  git(repo, 'checkout', '--detach', 'HEAD');
  const observed = await core.status({ observe: true });
  assert.deepEqual(validateJsonSchemaValue({}, observed), []);
  assert.equal(Object.hasOwn(observed.observations, 'checkedOutBranch'), false);
  const gate = await core.mergeGate('M1');
  assert.deepEqual(validateJsonSchemaValue({}, gate), []);
  const blocked = await core.merge('M1');
  assert.deepEqual(validateJsonSchemaValue({}, blocked), []);
});

test('explicit recovery marks stale running activations without adopting them', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const mission = await core.addMission({ title: 'Recovery', description: 'Recover after restart' });
  await core.beginSpawn({ missionId: mission.id, role: 'worker' });
  const reopened = new TowerCore({ cwd: repo });
  await reopened.open();
  await assert.rejects(reopened.beginSpawn({ missionId: mission.id, role: 'worker' }), /wait or interrupt/);
  const recovered = await reopened.recover();
  assert.equal(recovered.recovered.length, 1);
  assert.equal(recovered.recovered[0].mission, mission.id);
  assert.equal(recovered.state.missions[0].status, 'worker_failed');
  const restarted = await reopened.beginSpawn({ missionId: mission.id, role: 'worker' });
  assert.equal(restarted.mission.status, 'worker_running');
});

test('a no-op rebase preserves a changes-requested verdict', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core);
  const begun = await core.beginSpawn({ missionId: mission.id, role: 'reviewer' });
  await core.completeSpawn(begun.runId, {
    stopReason: 'completed',
    structured: { verdict: 'changes_requested', merge: false, summary: 'needs work', findings: [{ severity: 'p2', message: 'fix this' }], checks: [] },
  });
  const result = await core.rebase(mission.id);
  assert.equal(result.rebased, true);
  assert.equal(result.reviewRequired, false);
  assert.equal(result.mission.status, 'changes_requested');
  assert.equal(result.mission.review.merge, false);
});

test('a no-op rebase keeps a failed review in worker_completed', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core);
  const begun = await core.beginSpawn({ missionId: mission.id, role: 'reviewer' });
  await core.completeSpawn(begun.runId, { stopReason: 'error', diagnostic: 'review transport failed' });
  const result = await core.rebase(mission.id);
  assert.equal(result.rebased, true);
  assert.equal(result.mission.status, 'worker_completed');
  assert.equal(result.mission.review.verdict, undefined);
});

test('rebase cleanup failure is reported as recovery-required', async () => {
  const recovery = await recoverRebaseFailure('/tmp/rebase-failure', 'previous-tip', undefined, {
    runGit: async (_cwd, args) => {
      if (args[0] === 'rebase') throw new Error('injected abort failure');
      return { code: 1 };
    },
    head: async () => 'different-tip',
    status: async () => ({ clean: false, entries: ['M conflict.txt'] }),
  });
  assert.equal(recovery.recoveryRequired, true);
  assert.equal(recovery.abortError, 'injected abort failure');
  assert.equal(recovery.clean, false);
});

test('mission creation write failure reconciles matching artifacts on identical retry', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const original = core.store.write;
  core.store.write = async () => { throw new Error('injected create write failure'); };
  await assert.rejects(core.addMission({ id: 'M1', title: 'Recover create', description: 'Recover created artifacts' }), /injected create write failure/);
  core.store.write = original;
  const mission = await core.addMission({ id: 'M1', title: 'Recover create', description: 'Recover created artifacts' });
  assert.equal(mission.id, 'M1');
  assert.equal(mission.reconciled, true);
  assert.equal(mission.status, 'pending');
  assert.equal((await core.status()).missions.length, 1);
});

test('post-merge inspection failure is unverified, not a verified merge', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core);
  await approve(core, mission.id);
  core.mergeOperations = {
    head: async () => { throw new Error('injected inspection failure'); },
    isAncestor: async () => { throw new Error('unreachable'); },
  };
  const result = await core.merge(mission.id);
  assert.equal(result.merged, false);
  assert.equal(result.mergeAttempted, true);
  assert.equal(result.verified, false);
  assert.equal(result.recoveryRequired, true);
  assert.match(result.error, /injected inspection failure/);
});

test('negative exact-SHA verification cannot report a verified merge', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core);
  await approve(core, mission.id);
  core.mergeOperations = {
    head: async () => 'merge-result',
    isAncestor: async () => false,
  };
  const result = await core.merge(mission.id);
  assert.equal(result.merged, false);
  assert.equal(result.mergeAttempted, true);
  assert.equal(result.verified, false);
  assert.equal(result.recoveryRequired, true);
});

test('merge abort failure with clean porcelain still reports ongoing merge recovery', async () => {
  let aborts = 0;
  const recovery = await recoverMergeFailure('/tmp/merge-failure', 'base-tip', undefined, {
    runGit: async (_cwd, args) => {
      if (args[0] === 'merge') {
        aborts += 1;
        throw new Error('injected merge abort failure');
      }
      return { code: 0 };
    },
    head: async () => 'base-tip',
    status: async () => ({ clean: true, entries: [] }),
  });
  assert.equal(aborts, 1);
  assert.equal(recovery.recoveryRequired, true);
  assert.equal(recovery.remainingMergeState, true);
  assert.equal(recovery.abortError, 'injected merge abort failure');
  assert.equal(recovery.clean, true);
});

test('merge write failure is recoverable through exact-SHA accounting', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core);
  const approved = await approve(core, mission.id);
  const original = core.store.write;
  core.store.write = async () => { throw new Error('injected merge write failure'); };
  const interrupted = await core.merge(mission.id);
  assert.equal(interrupted.merged, true);
  assert.equal(interrupted.recoveryRequired, true);
  assert.equal(interrupted.postMerge, true);
  core.store.write = original;
  const gate = await core.mergeGate(mission.id);
  assert.equal(gate.alreadyMerged, true);
  const recovered = await core.merge(mission.id);
  assert.equal(recovered.reconciled, true);
  assert.equal(recovered.mission.status, 'merged');
  assert.equal(recovered.mission.merge.reviewedCommit, approved.binding.reviewedCommit);
});

test('teardown write failure reconciles an already removed worktree on retry', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission, worktree } = await addAndRunWorker(core);
  await approve(core, mission.id);
  await core.merge(mission.id);
  const original = core.store.write;
  core.store.write = async () => { throw new Error('injected teardown write failure'); };
  await assert.rejects(core.teardown({ missionId: mission.id }), /injected teardown write failure/);
  core.store.write = original;
  assert.equal(existsSync(worktree), false);
  const retried = await core.teardown({ missionId: mission.id });
  assert.equal(retried.results[0].removed, true);
  assert.equal(retried.results[0].reconciled, true);
  assert.equal(retried.state.missions[0].worktreeRemoved, true);
});

test('teardown refuses live missions', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const mission = await core.addMission({ title: 'Live', description: 'Still running' });
  await core.beginSpawn({ missionId: mission.id, role: 'worker' });
  const result = await core.teardown();
  assert.equal(result.results[0].removed, false);
  assert.equal(result.results[0].reason, 'status-worker_running');
  assert.equal(existsSync(mission.worktree), true);
});

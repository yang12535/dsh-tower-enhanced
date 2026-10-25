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

test('editing a pending mission updates metadata, records the event, and bumps the revision', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const first = await core.addMission({ title: 'First', description: 'First mission' });
  const second = await core.addMission({ title: 'Second', description: 'Second mission', scope: ['docs/**'] });
  const edited = await core.editMission({ missionId: second.id, title: 'Second revised', scope: ['lib/**', 'test/**'], dependsOn: [first.id] });
  assert.equal(edited.id, second.id);
  assert.equal(edited.status, 'pending');
  assert.equal(edited.title, 'Second revised');
  assert.equal(edited.description, 'Second mission', 'unedited fields stay untouched');
  assert.deepEqual(edited.scope, ['lib/**', 'test/**']);
  assert.deepEqual(edited.dependsOn, [first.id]);
  assert.equal(edited.revision, second.revision + 1);
  const state = await core.status();
  assert.deepEqual(state.missions.find((mission) => mission.id === second.id), edited);
  const event = state.events.at(-1);
  assert.equal(event.type, 'mission-edited');
  assert.equal(event.mission, second.id);
  assert.deepEqual(event.fields, ['title', 'scope', 'dependsOn']);
});

test('missions that already spawned or settled are not editable', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const spawned = await core.addMission({ title: 'Spawned', description: 'Worker already started' });
  await core.beginSpawn({ missionId: spawned.id, role: 'worker' });
  await assert.rejects(core.editMission({ missionId: spawned.id, title: 'Too late' }), (error) => {
    assert.equal(error.code, 'MISSION_NOT_EDITABLE');
    assert.match(error.message, /worker_running/);
    return true;
  });
  const abandoned = await core.addMission({ title: 'Abandoned', description: 'Already abandoned' });
  await core.abandon(abandoned.id);
  await assert.rejects(core.editMission({ missionId: abandoned.id, title: 'Too late' }), (error) => {
    assert.equal(error.code, 'MISSION_NOT_EDITABLE');
    return true;
  });
});

test('edit rejects unknown dependencies, duplicate input, self-references, and cycles without mutating state', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const first = await core.addMission({ title: 'First', description: 'First mission' });
  const second = await core.addMission({ title: 'Second', description: 'Second mission', dependsOn: [first.id] });
  const third = await core.addMission({ title: 'Third', description: 'Third mission', dependsOn: [second.id] });
  await assert.rejects(core.editMission({ missionId: third.id, dependsOn: ['NOPE'] }), (error) => {
    assert.equal(error.code, 'MISSION_NOT_FOUND');
    return true;
  });
  await assert.rejects(core.editMission({ missionId: third.id, dependsOn: [first.id, first.id] }), (error) => {
    assert.equal(error.code, 'DEPENDENCY_INVALID');
    return true;
  });
  await assert.rejects(core.editMission({ missionId: third.id, dependsOn: [third.id] }), (error) => {
    assert.equal(error.code, 'DEPENDENCY_CYCLE');
    return true;
  });
  await assert.rejects(core.editMission({ missionId: first.id, dependsOn: [third.id] }), (error) => {
    assert.equal(error.code, 'DEPENDENCY_CYCLE');
    assert.match(error.message, /M1 -> M3 -> M2 -> M1/);
    return true;
  });
  const state = await core.status();
  assert.deepEqual(state.missions.map((mission) => mission.dependsOn), [[], [first.id], [second.id]]);
  assert.deepEqual(state.missions.map((mission) => mission.revision), [first.revision, second.revision, third.revision]);
});

test('edit validates field types before touching the mission', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const mission = await core.addMission({ title: 'Validated', description: 'Check edit arguments' });
  await assert.rejects(core.editMission({ missionId: mission.id, title: '   ' }), /title must be a non-empty string/);
  await assert.rejects(core.editMission({ missionId: mission.id, description: 42 }), /description must be a non-empty string/);
  await assert.rejects(core.editMission({ missionId: mission.id, scope: [''] }), /scope patterns must be non-empty strings/);
  await assert.rejects(core.editMission({ missionId: mission.id, scope: 'lib/**' }), /scope must be an array/);
  await assert.rejects(core.editMission({ missionId: mission.id, dependsOn: 'M1' }), /dependsOn must be a string array/);
  await assert.rejects(core.editMission({ missionId: 'NOPE', title: 'Missing' }), /mission NOPE does not exist/);
  const untouched = (await core.status()).missions[0];
  assert.equal(untouched.revision, mission.revision);
});

test('an edited dependency list gates worker startup', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const blocker = await core.addMission({ title: 'Blocker', description: 'Not merged yet' });
  const mission = await core.addMission({ title: 'Gated', description: 'Depends after edit' });
  await core.editMission({ missionId: mission.id, dependsOn: [blocker.id] });
  await assert.rejects(core.beginSpawn({ missionId: mission.id, role: 'worker' }), /unmerged dependencies/);
  await core.abandon(blocker.id);
  const begun = await core.beginSpawn({ missionId: mission.id, role: 'worker' });
  assert.equal(begun.mission.status, 'worker_running');
});

test('summary reports compact counts and one-line entries without mutating state', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const running = await core.addMission({ title: 'Running', description: 'Worker in flight with a very long description that must not leak into the summary' });
  await core.beginSpawn({ missionId: running.id, role: 'worker', provider: 'prov-a', model: 'model-a', reasoningEffort: 'low' });
  await core.addMission({ title: 'Gated', description: 'Waits for the running mission', dependsOn: [running.id] });
  const { mission: reviewing } = await addAndRunWorker(core, { title: 'Under review' });
  await core.beginSpawn({ missionId: reviewing.id, role: 'reviewer', provider: 'prov-b', model: 'model-b' });
  const { mission: approved } = await addAndRunWorker(core, { title: 'Approve me' });
  const approvedRun = await core.beginSpawn({ missionId: approved.id, role: 'reviewer', provider: 'prov-c', model: 'model-c' });
  await core.completeSpawn(approvedRun.runId, {
    stopReason: 'completed',
    structured: { verdict: 'clean', merge: true, summary: 'clean', findings: [], checks: [] },
  });
  const { mission: merged } = await addAndRunWorker(core, { title: 'Merge me' });
  await approve(core, merged.id);
  const mergeResult = await core.merge(merged.id);
  const { mission: blocked } = await addAndRunWorker(core, { title: 'Blocked', file: 'README.md', content: '# worker version\n' });
  await approve(core, blocked.id);
  commitFile(repo, 'README.md', '# conflicting base\n', 'conflicting base change');
  await core.rebase(blocked.id);
  const abandoned = await core.addMission({ title: 'Abandoned', description: 'Dropped from the plan' });
  await core.abandon(abandoned.id);

  const before = await core.store.read();
  const summary = await core.summary();
  assert.equal(summary.version, 1);
  assert.equal(summary.repoRoot, repo);
  assert.equal(summary.baseBranch, 'main');
  // After the merge, the conflicting commit moved main and the 'Abandoned' add
  // re-recorded that tip as the base, so the recorded base is the final main head.
  assert.equal(summary.baseCommit, git(repo, 'rev-parse', 'main'), 'summary mirrors the recorded base tip');
  assert.deepEqual(summary.counts, { missions: 7, workerRunning: 1, reviewRunning: 1, approved: 1, merged: 1, blocked: 1, abandoned: 1 });
  const entries = new Map(summary.missions.map((entry) => [entry.id, entry]));
  assert.deepEqual(entries.get(running.id), {
    id: running.id,
    title: 'Running',
    status: 'worker_running',
    dependsOn: [],
    worker: { provider: 'prov-a', model: 'model-a', reasoningEffort: 'low' },
    review: null,
    mergeCommit: null,
  });
  assert.deepEqual(entries.get('M2'), {
    id: 'M2',
    title: 'Gated',
    status: 'pending',
    dependsOn: [running.id],
    worker: null,
    review: null,
    mergeCommit: null,
  });
  assert.deepEqual(entries.get(reviewing.id), {
    id: reviewing.id,
    title: 'Under review',
    status: 'review_running',
    dependsOn: [],
    worker: { stopReason: 'completed' },
    review: { provider: 'prov-b', model: 'model-b' },
    mergeCommit: null,
  });
  assert.deepEqual(entries.get(approved.id), {
    id: approved.id,
    title: 'Approve me',
    status: 'approved',
    dependsOn: [],
    worker: { stopReason: 'completed' },
    review: { provider: 'prov-c', model: 'model-c', verdict: 'clean', merge: true },
    mergeCommit: null,
  });
  assert.deepEqual(entries.get(merged.id), {
    id: merged.id,
    title: 'Merge me',
    status: 'merged',
    dependsOn: [],
    worker: { stopReason: 'completed' },
    review: { verdict: 'clean', merge: true },
    mergeCommit: mergeResult.mergeCommit,
  });
  assert.deepEqual(entries.get(blocked.id), {
    id: blocked.id,
    title: 'Blocked',
    status: 'rebase_blocked',
    dependsOn: [],
    worker: { stopReason: 'completed' },
    review: null,
    mergeCommit: null,
  });
  assert.deepEqual(entries.get(abandoned.id), {
    id: abandoned.id,
    title: 'Abandoned',
    status: 'abandoned',
    dependsOn: [],
    worker: null,
    review: null,
    mergeCommit: null,
  });
  for (const entry of summary.missions) {
    for (const field of ['description', 'scope', 'branch', 'worktree', 'revision', 'createdAt', 'events', 'observations']) {
      assert.equal(Object.hasOwn(entry, field), false, `summary entry ${entry.id} must not carry ${field}`);
    }
  }
  assert.deepEqual(await core.store.read(), before, 'summary must not touch revisions, events, or updatedAt');

  const filtered = await core.summary({ missionId: 'M2' });
  assert.equal(filtered.missions.length, 1);
  assert.deepEqual(filtered.missions[0], entries.get('M2'));
  assert.deepEqual(filtered.counts, summary.counts, 'mission_id narrows entries but counts stay global');
  await assert.rejects(core.summary({ missionId: 'NOPE' }), (error) => {
    assert.equal(error.code, 'MISSION_NOT_FOUND');
    return true;
  });
  assert.deepEqual(await core.store.read(), before, 'filtering and failures stay read-only too');

  assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
  assert.deepEqual(validateJsonSchemaValue({}, summary), []);
  assert.deepEqual(validateJsonSchemaValue({}, filtered), []);
});

test('summary requires an initialized tower', async (t) => {
  const repo = makeRepo(t);
  const core = new TowerCore({ cwd: repo });
  await assert.rejects(core.summary(), /run tower with action init first/);
});

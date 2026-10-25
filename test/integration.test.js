import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { TowerCore } from '../lib/core.js';
import { addAndRunWorker, approve, commitFile, git, initializedCore, makeRepo } from './helpers.js';

// End-to-end integration coverage for the complete Tower mission lifecycle.
// Every test drives the public TowerCore API against a real temporary Git
// repository (real `git worktree add`, real commits, real merges); git is
// never mocked and nothing touches the network, ports, or host DSH sessions.
// Temp directories come from helpers.js makeRepo() (mkdtemp + t.after cleanup).
//
// Reviews are recorded through the public reviewer lifecycle only:
// beginSpawn(role "reviewer") + completeSpawn with a structured verdict.
// core.js exposes no other public review-recording method, and this exact
// path is what test/helpers.js approve() and test/core.test.js already use.

function branchContains(cwd, commit, ref) {
  try {
    git(cwd, 'merge-base', '--is-ancestor', commit, ref);
    return true;
  } catch {
    return false;
  }
}

test('full mission lifecycle: init, scoped add, worker commit, clean review, gate, merge, teardown', async (t) => {
  const repo = makeRepo(t);
  const core = new TowerCore({ cwd: repo });
  const initialized = await core.init();
  assert.equal(initialized.baseBranch, 'main');
  assert.equal(initialized.repoRoot, repo);
  assert.deepEqual(initialized.missions, []);

  const mission = await core.addMission({ title: 'End-to-end feature', description: 'Implement the feature end to end.', scope: ['src/**'] });
  assert.equal(mission.id, 'M1');
  assert.equal(mission.status, 'pending');
  assert.equal(mission.branch, 'tower/m1');
  assert.deepEqual(mission.scope, ['src/**']);
  assert.equal(existsSync(mission.worktree), true, 'addMission must create the worktree');

  const worker = await core.beginSpawn({ missionId: mission.id, role: 'worker' });
  assert.equal(worker.role, 'worker');
  assert.equal(worker.mission.status, 'worker_running');
  const worktree = worker.mission.worktree;
  const workerCommit = commitFile(worktree, 'src/feature.txt', 'implemented\n', 'worker implementation');

  const completed = await core.completeSpawn(worker.runId, { stopReason: 'completed', output: 'worker report' });
  assert.equal(completed.status, 'worker_completed');
  assert.equal(completed.worker.headCommit, workerCommit);

  const reviewer = await core.beginSpawn({ missionId: mission.id, role: 'reviewer' });
  assert.equal(reviewer.mission.status, 'review_running');
  assert.equal(reviewer.mission.review.reviewedCommit, workerCommit, 'review binds the exact worktree tip');
  assert.equal(reviewer.mission.review.baseCommit, mission.baseCommit, 'review binds the exact base tip');
  const reviewed = await core.completeSpawn(reviewer.runId, {
    stopReason: 'completed',
    output: 'clean review',
    structured: { verdict: 'clean', merge: true, summary: 'clean', findings: [], checks: ['unit tests'] },
  });
  assert.equal(reviewed.status, 'approved');

  const gate = await core.mergeGate(mission.id);
  assert.equal(gate.ready, true);
  assert.deepEqual(gate.blocks, []);
  assert.equal(gate.observations.reviewedCommit, workerCommit);

  const merged = await core.merge(mission.id);
  assert.equal(merged.merged, true);
  assert.equal(merged.advanced, false);
  assert.equal(merged.mission.status, 'merged');
  assert.equal(merged.mergeCommit, git(repo, 'rev-parse', 'HEAD'));
  assert.equal(git(repo, 'show', 'HEAD:src/feature.txt'), 'implemented');
  assert.equal(branchContains(repo, workerCommit, 'main'), true, 'main must contain the worker commit');

  const torn = await core.teardown({ missionId: mission.id });
  assert.equal(torn.results[0].removed, true);
  assert.equal(existsSync(worktree), false, 'teardown must remove the worktree');
  const after = await core.mission(mission.id);
  assert.equal(after.status, 'merged');
  assert.equal(after.worktreeRemoved, true);
  assert.equal(git(repo, 'rev-parse', '--verify', mission.branch), workerCommit, 'the mission branch ref survives teardown');
});

test('dependencies block the dependent worker until the dependency mission merges', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const foundation = await core.addMission({ title: 'Foundation', description: 'Lands the shared helper.' });
  const followUp = await core.addMission({ title: 'Follow-up', description: 'Builds on the foundation.', dependsOn: [foundation.id] });

  await assert.rejects(
    core.beginSpawn({ missionId: followUp.id, role: 'worker' }),
    (error) => {
      assert.equal(error.code, 'DEPENDENCIES_NOT_MERGED');
      assert.match(error.message, /unmerged dependencies/);
      assert.deepEqual(error.details.dependsOn, [foundation.id]);
      return true;
    },
  );

  // Land the dependency end to end: worker -> review -> merge.
  const worker = await core.beginSpawn({ missionId: foundation.id, role: 'worker' });
  commitFile(worker.mission.worktree, 'src/foundation.txt', 'foundation\n', 'foundation work');
  await core.completeSpawn(worker.runId, { stopReason: 'completed', output: 'foundation done' });
  await approve(core, foundation.id);
  assert.equal((await core.merge(foundation.id)).merged, true);

  // With the dependency merged the dependent worker may now start and finish.
  const begun = await core.beginSpawn({ missionId: followUp.id, role: 'worker' });
  assert.equal(begun.mission.status, 'worker_running');
  commitFile(begun.mission.worktree, 'src/follow-up.txt', 'follow-up\n', 'follow-up work');
  const completed = await core.completeSpawn(begun.runId, { stopReason: 'completed', output: 'follow-up done' });
  assert.equal(completed.status, 'worker_completed');
  assert.equal(git(repo, 'show', 'HEAD:src/foundation.txt'), 'foundation');
});

test('out-of-scope commits pass review but the gate refuses them with OUT_OF_SCOPE', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const mission = await core.addMission({ title: 'Scoped change', description: 'Only src/ may change.', scope: ['src/**'] });
  const worker = await core.beginSpawn({ missionId: mission.id, role: 'worker' });
  const rogueCommit = commitFile(worker.mission.worktree, 'docs/rogue.md', 'rogue\n', 'sneaky docs change');
  await core.completeSpawn(worker.runId, { stopReason: 'completed', output: 'done' });

  // A clean reviewer verdict cannot bypass the scope gate.
  await approve(core, mission.id);
  assert.equal((await core.mission(mission.id)).status, 'approved');

  const gate = await core.mergeGate(mission.id);
  assert.equal(gate.ready, false);
  const block = gate.blocks.find((candidate) => candidate.code === 'OUT_OF_SCOPE');
  assert.ok(block, 'gate must report OUT_OF_SCOPE');
  assert.deepEqual(block.files, ['docs/rogue.md']);
  assert.deepEqual(gate.observations.changedFiles, ['docs/rogue.md']);

  const baseTip = git(repo, 'rev-parse', 'HEAD');
  const result = await core.merge(mission.id);
  assert.equal(result.merged, false, 'merge must be refused');
  assert.equal(result.mission.status, 'approved');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), baseTip, 'main must stay untouched');
  assert.equal(branchContains(repo, rogueCommit, 'main'), false);
});

test('a merged sibling mission stales an approved review until rebase and a fresh review', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  // Both missions branch from the same initial base.
  const sibling = await core.addMission({ title: 'Sibling', description: 'Lands first.' });
  const dependent = await core.addMission({ title: 'Dependent', description: 'Reviewed before the sibling merges.' });

  // The dependent mission finishes and is reviewed against the original base.
  const dependentWorker = await core.beginSpawn({ missionId: dependent.id, role: 'worker' });
  commitFile(dependentWorker.mission.worktree, 'src/dependent.txt', 'dependent\n', 'dependent work');
  await core.completeSpawn(dependentWorker.runId, { stopReason: 'completed', output: 'done' });
  const approved = await approve(core, dependent.id);
  assert.equal(approved.mission.status, 'approved');

  // The sibling lands, advancing the base branch past the reviewed base.
  const siblingWorker = await core.beginSpawn({ missionId: sibling.id, role: 'worker' });
  commitFile(siblingWorker.mission.worktree, 'src/sibling.txt', 'sibling\n', 'sibling work');
  await core.completeSpawn(siblingWorker.runId, { stopReason: 'completed', output: 'done' });
  await approve(core, sibling.id);
  assert.equal((await core.merge(sibling.id)).merged, true);

  const gate = await core.mergeGate(dependent.id);
  assert.equal(gate.ready, false);
  assert.ok(gate.blocks.some((candidate) => candidate.code === 'STALE_BASE'), 'base advanced past the reviewed tip');
  assert.ok(gate.blocks.some((candidate) => candidate.code === 'REVIEW_BASE_STALE'), 'reviewed base is no longer current');
  assert.equal((await core.merge(dependent.id)).merged, false, 'the stale review must not merge');

  const rebased = await core.rebase(dependent.id);
  assert.equal(rebased.rebased, true);
  assert.equal(rebased.reviewRequired, true, 'a rebased tip always needs a fresh review');
  assert.equal(rebased.mission.status, 'worker_completed');
  assert.equal(rebased.mission.review, undefined, 'the old verdict is discarded');

  await approve(core, dependent.id);
  assert.equal((await core.mergeGate(dependent.id)).ready, true);
  const merged = await core.merge(dependent.id);
  assert.equal(merged.merged, true);
  assert.equal(git(repo, 'show', 'HEAD:src/sibling.txt'), 'sibling');
  assert.equal(git(repo, 'show', 'HEAD:src/dependent.txt'), 'dependent');
});

test('teardown refuses non-terminal missions and is idempotent once a worktree is removed', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const pending = await core.addMission({ title: 'Pending', description: 'Never spawned.' });
  const { mission } = await addAndRunWorker(core); // reaches worker_completed
  await approve(core, mission.id); // approved, but not merged: still not teardown-able

  const refused = await core.teardown();
  assert.deepEqual(refused.results, [
    { mission: pending.id, removed: false, reason: 'status-pending' },
    { mission: mission.id, removed: false, reason: 'status-approved' },
  ]);
  assert.equal(existsSync(pending.worktree), true);
  assert.equal(existsSync(mission.worktree), true);

  await core.merge(mission.id);
  await core.abandon(pending.id);
  const removed = await core.teardown();
  assert.deepEqual(removed.results.map((result) => result.removed), [true, true]);
  assert.equal(existsSync(pending.worktree), false);
  assert.equal(existsSync(mission.worktree), false);

  // Teardown over already-removed worktrees is an idempotent no-op.
  const again = await core.teardown();
  assert.deepEqual(again.results, [
    { mission: pending.id, removed: false, reason: 'already-removed' },
    { mission: mission.id, removed: false, reason: 'already-removed' },
  ]);
});

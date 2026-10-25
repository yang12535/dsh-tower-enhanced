import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { TowerCore } from '../lib/core.js';
import { addAndRunWorker, approve, commitFile, git, initializedCore, makeRepo, writeDirty } from './helpers.js';

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

// ---------------------------------------------------------------------------
// Pending baseline sync & stale review invalidation (post GPT-6A semantics).
//
// The scenarios below pin two end-to-end behaviors against real Git state:
//   * beginSpawn(worker) on a pending mission whose recorded base fell behind
//     fast-forwards the never-spawned worktree onto the current base (and only
//     then), refusing dirty worktrees, unique local commits, and ignored-file
//     collisions instead of overwriting local data.
//   * A base advance invalidates previously approved reviews on rebase, while a
//     rebase over an unchanged base and tip preserves a still-valid review.
// The base always advances through a real Tower mission merge, never through
// direct commits on the base checkout, so these are mission-to-mission flows.
// ---------------------------------------------------------------------------

/** Land a full sibling mission (worker -> clean review -> merge) and return its merge commit. */
async function landSiblingMission(core, options = {}) {
  const sibling = await core.addMission({ title: options.title ?? 'Sibling landing', description: 'Advances the base branch for the other mission.' });
  const worker = await core.beginSpawn({ missionId: sibling.id, role: 'worker' });
  const worktree = worker.mission.worktree;
  commitFile(worktree, options.file ?? 'src/sibling.txt', options.content ?? 'sibling\n', 'sibling work');
  if (options.afterCommit) await options.afterCommit(worktree);
  await core.completeSpawn(worker.runId, { stopReason: 'completed', output: 'sibling done' });
  await approve(core, sibling.id);
  const merged = await core.merge(sibling.id);
  assert.equal(merged.merged, true, 'the sibling mission must land so the base advances');
  return merged.mission.merge.commit;
}

test('a merged dependency fast-forwards a never-spawned pending worktree onto the new base', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const dependency = await core.addMission({ title: 'Foundation', description: 'Lands the shared helper.' });
  const dependent = await core.addMission({ title: 'Late client', description: 'Only spawns after the foundation merges.', dependsOn: [dependency.id] });
  const originalBase = dependent.baseCommit;

  // Land the dependency end to end; the base advances past the dependent
  // worktree, which still sits untouched at the original base.
  const worker = await core.beginSpawn({ missionId: dependency.id, role: 'worker' });
  commitFile(worker.mission.worktree, 'src/foundation.txt', 'foundation\n', 'foundation work');
  await core.completeSpawn(worker.runId, { stopReason: 'completed', output: 'foundation done' });
  await approve(core, dependency.id);
  const newBase = (await core.merge(dependency.id)).mission.merge.commit;
  assert.notEqual(newBase, originalBase, 'the dependency merge must advance the base');
  assert.equal(git(dependent.worktree, 'rev-parse', 'HEAD'), originalBase, 'the pending worktree still sits at the old base');

  const begun = await core.beginSpawn({ missionId: dependent.id, role: 'worker' });
  assert.equal(begun.mission.status, 'worker_running');
  assert.equal(begun.mission.baseCommit, newBase, 'beginSpawn re-anchors the mission base');
  assert.equal(git(dependent.worktree, 'rev-parse', 'HEAD'), newBase, 'the pending worktree fast-forwards to the new base');
  assert.equal(git(repo, 'rev-parse', dependent.branch), newBase, 'the ff-only refresh moves the mission branch itself');
  assert.equal(git(dependent.worktree, 'status', '--porcelain'), '', 'the refreshed worktree is clean');
  assert.equal(git(dependent.worktree, 'show', 'HEAD:src/foundation.txt'), 'foundation', 'the merged dependency content is visible in the worktree');
  assert.equal(branchContains(dependent.worktree, originalBase, 'HEAD'), true, 'the old base stays an ancestor: a fast-forward, not a rewrite');
});

test('a pending refresh refuses a dirty worktree and leaves its tip untouched', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const mission = await core.addMission({ title: 'Pending local edits', description: 'Holds uncommitted local work.' });
  const originalBase = mission.baseCommit;
  const newBase = await landSiblingMission(core, { title: 'Sibling advance' });
  assert.notEqual(newBase, originalBase);
  writeDirty(mission.worktree, 'uncommitted.txt', 'local scratch\n');

  await assert.rejects(
    core.beginSpawn({ missionId: mission.id, role: 'worker' }),
    (error) => {
      assert.equal(error.code, 'WORKTREE_DIRTY');
      assert.match(error.message, /uncommitted or untracked files/);
      assert.ok(error.details.entries.some((entry) => entry.includes('uncommitted.txt')), 'the rejection names the dirty file');
      return true;
    },
  );
  const after = await core.mission(mission.id);
  assert.equal(after.status, 'pending', 'the rejected spawn leaves the mission pending');
  assert.equal(after.baseCommit, originalBase, 'the recorded base is not advanced');
  assert.equal(git(mission.worktree, 'rev-parse', 'HEAD'), originalBase, 'the worktree tip is not rewritten');
  assert.equal(git(repo, 'rev-parse', mission.branch), originalBase, 'the mission branch stays at the old base');
});

test('a pending refresh reports STALE_BASE for unique worktree commits and preserves them', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const mission = await core.addMission({ title: 'Pending own commits', description: 'Drifted ahead of its recorded base.' });
  const originalBase = mission.baseCommit;
  await landSiblingMission(core, { title: 'Sibling advance' });
  const rogueTip = commitFile(mission.worktree, 'src/rogue.txt', 'unique local commit\n', 'local work outside Tower');

  await assert.rejects(
    core.beginSpawn({ missionId: mission.id, role: 'worker' }),
    (error) => {
      assert.equal(error.code, 'STALE_BASE');
      assert.match(error.message, /commits outside the current base/);
      return true;
    },
  );
  const after = await core.mission(mission.id);
  assert.equal(after.status, 'pending', 'the rejected spawn leaves the mission pending');
  assert.equal(after.baseCommit, originalBase, 'the recorded base is untouched');
  assert.equal(git(mission.worktree, 'rev-parse', 'HEAD'), rogueTip, 'the unique commit is not rebased away');
  assert.equal(git(mission.worktree, 'show', 'HEAD:src/rogue.txt'), 'unique local commit', 'the unique commit content survives');
  assert.equal(branchContains(repo, rogueTip, mission.branch), true, 'the commit stays reachable from the mission branch');
});

test('a pending refresh never overwrites an ignored local file during the fast-forward', async (t) => {
  const repo = makeRepo(t);
  commitFile(repo, '.gitignore', '*.cache\n', 'ignore local cache artifacts');
  const core = await initializedCore(repo);
  const mission = await core.addMission({ title: 'Pending ignored artifact', description: 'Keeps a local ignored file.' });
  const originalBase = mission.baseCommit;
  writeDirty(mission.worktree, 'data.cache', 'local artifact\n');
  assert.equal(git(mission.worktree, 'status', '--porcelain'), '', 'an ignored untracked file does not dirty the worktree');

  const newBase = await landSiblingMission(core, {
    title: 'Sibling tracks the artifact',
    afterCommit: (worktree) => {
      // The sibling force-adds the ignored path, so the advancing base now
      // carries a tracked file that exists (ignored) in the pending worktree.
      writeDirty(worktree, 'data.cache', 'incoming tracked artifact\n');
      git(worktree, 'add', '-f', 'data.cache');
      git(worktree, 'commit', '-m', 'track the previously ignored artifact');
    },
  });

  const localHash = git(mission.worktree, 'hash-object', 'data.cache');
  await assert.rejects(
    core.beginSpawn({ missionId: mission.id, role: 'worker' }),
    (error) => {
      assert.equal(error.code, 'GIT_FAILED');
      assert.match(error.details.stderr, /would be overwritten/i, 'git refuses to clobber the ignored local file');
      return true;
    },
  );
  assert.equal(git(mission.worktree, 'hash-object', 'data.cache'), localHash, 'the ignored local file is not overwritten');
  assert.equal(git(mission.worktree, 'rev-parse', 'HEAD'), originalBase, 'the refused fast-forward leaves the tip untouched');
  assert.equal((await core.mission(mission.id)).status, 'pending', 'the mission stays pending');

  // Without the local collision the same refresh succeeds and delivers the
  // tracked file, proving the refusal above is exactly --no-overwrite-ignore.
  rmSync(path.join(mission.worktree, 'data.cache'));
  const begun = await core.beginSpawn({ missionId: mission.id, role: 'worker' });
  assert.equal(begun.mission.status, 'worker_running');
  assert.equal(git(mission.worktree, 'rev-parse', 'HEAD'), newBase);
  assert.equal(git(mission.worktree, 'show', 'HEAD:data.cache'), 'incoming tracked artifact');
});

test('a merged sibling invalidates an approved review even though the mission tip had not moved', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const mission = await core.addMission({ title: 'Reviewed early', description: 'Approved against the original base.' });
  const worker = await core.beginSpawn({ missionId: mission.id, role: 'worker' });
  const worktree = worker.mission.worktree;
  commitFile(worktree, 'src/approved.txt', 'approved work\n', 'worker implementation');
  await core.completeSpawn(worker.runId, { stopReason: 'completed', output: 'done' });
  const approved = await approve(core, mission.id);
  const reviewedTip = approved.mission.review.reviewedCommit;
  const reviewedBase = approved.mission.review.baseCommit;
  const newBase = await landSiblingMission(core, { title: 'Sibling lands later' });

  // The mission tip is still exactly the reviewed commit; only the base moved.
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), reviewedTip);
  assert.notEqual(newBase, reviewedBase);

  const rebased = await core.rebase(mission.id);
  assert.equal(rebased.rebased, true);
  assert.equal(rebased.reviewRequired, true, 'a base change alone invalidates the recorded review');
  assert.equal(rebased.mission.status, 'worker_completed');
  assert.equal(rebased.mission.review, undefined, 'the stale verdict is discarded');
  assert.equal(rebased.tip, git(worktree, 'rev-parse', 'HEAD'), 'the returned tip matches the worktree');
  assert.equal(branchContains(worktree, newBase, 'HEAD'), true, 'the branch is replayed onto the new base');
  assert.equal(git(worktree, 'show', 'HEAD:src/sibling.txt'), 'sibling', 'the sibling change is merged into the refreshed branch');
  assert.equal(git(worktree, 'show', 'HEAD:src/approved.txt'), 'approved work', 'the original work is replayed intact');

  // The invalidated review no longer opens the gate; only a fresh review does.
  const gate = await core.mergeGate(mission.id);
  assert.equal(gate.ready, false);
  assert.ok(gate.blocks.some((block) => block.code === 'NO_CLEAN_REVIEW'));
  await approve(core, mission.id);
  assert.equal((await core.mergeGate(mission.id)).ready, true);
});

test('a rebase with unchanged base and tip is an idempotent no-op that keeps a valid review', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const mission = await core.addMission({ title: 'Standalone', description: 'Reviewed against a stable base.' });
  const worker = await core.beginSpawn({ missionId: mission.id, role: 'worker' });
  commitFile(worker.mission.worktree, 'src/feature.txt', 'implemented\n', 'worker implementation');
  await core.completeSpawn(worker.runId, { stopReason: 'completed', output: 'done' });
  const approved = await approve(core, mission.id);
  const recordedReview = approved.mission.review;
  const base = git(repo, 'rev-parse', 'main');
  const tip = git(worker.mission.worktree, 'rev-parse', 'HEAD');

  const rebased = await core.rebase(mission.id);
  assert.equal(rebased.rebased, true);
  assert.equal(rebased.reviewRequired, false, 'an unchanged base and tip must not invalidate a clean review');
  assert.equal(rebased.previousTip, rebased.tip);
  assert.equal(rebased.tip, tip, 'the mission tip is untouched');
  assert.equal(rebased.mission.status, 'approved', 'the approval stands');
  assert.deepEqual(rebased.mission.review, recordedReview, 'the recorded review survives the no-op rebase');
  assert.equal(git(repo, 'rev-parse', 'main'), base, 'the base branch did not move');

  assert.equal((await core.mergeGate(mission.id)).ready, true, 'the preserved review still opens the merge gate');
  assert.equal((await core.merge(mission.id)).merged, true);
});

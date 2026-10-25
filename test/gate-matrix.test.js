import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { addAndRunWorker, approve, commitFile, git, initializedCore, makeRepo, writeDirty } from './helpers.js';

// Merge-gate block matrix: every block code that `evaluateMergeGate` in
// lib/core.js can emit gets at least one real scenario built from a temporary
// git repository, real worktrees, and the public TowerCore API. For each code
// the tests assert (a) `ready === false` plus the code and a message fragment
// in `blocks`, (b) that co-existing problems are all reported (no masking),
// and (c) that removing the problem reopens the gate (`ready === true` with
// empty `blocks`). The final test parses the gate's source and asserts the
// scenarios above cover every `code: '...'` literal it contains, so a newly
// added block code fails the suite until a scenario is written for it.
//
// Codes that the state machine cannot produce in isolation through the public
// API are noted per test and constructed through a TowerStore transaction
// (real persisted state, never a git mock):
// - DEPENDENCIES_NOT_MERGED: `beginSpawn('worker')` refuses unmerged
//   dependencies, and `editMission` only accepts pending missions, so an
//   approved mission can never gain a dependency publicly.
// - WORKTREE_REMOVED: `teardown` only removes worktrees of terminal missions,
//   and a terminal mission is never gate-ready, so the flag is flipped in
//   state to prove it is the sole trigger (the reachable abandon+teardown
//   path is covered by a separate test).
// Structural couplings observed while designing the matrix (reported, lib
// intentionally left untouched): NO_CHANGE can never appear alone — with a
// clean review whose reviewed tip equals the base the gate returns the
// `alreadyMerged` reconciliation verdict instead, and without one,
// NOT_APPROVED and NO_CLEAN_REVIEW are always co-reported. Likewise STALE_BASE
// always drags REVIEW_BASE_STALE along when a review exists. Both couplings
// only make the gate more conservative; nothing wrongly passes.

const covered = new Set();
const covers = (...codes) => {
  for (const code of codes) covered.add(code);
};

const codesOf = (gate) => gate.blocks.map((block) => block.code);

/** Assert the gate is closed by exactly one block carrying `code` and a message fragment. */
function soleBlock(gate, code, messageFragment) {
  assert.equal(gate.ready, false, `gate must not be ready while ${code} is unresolved`);
  assert.deepEqual(codesOf(gate), [code], `${code} must be the only block`);
  const block = gate.blocks[0];
  assert.ok(block.message.includes(messageFragment), `message ${JSON.stringify(block.message)} must mention ${JSON.stringify(messageFragment)}`);
  return block;
}

/** Assert the gate is open: ready, no blocks, no alreadyMerged reconciliation. */
async function assertReady(core, missionId) {
  const gate = await core.mergeGate(missionId);
  assert.equal(gate.ready, true, `gate must be ready: ${JSON.stringify(gate.blocks)}`);
  assert.deepEqual(gate.blocks, []);
  assert.equal(gate.alreadyMerged, undefined, 'a ready gate must not carry the alreadyMerged reconciliation verdict');
  return gate;
}

/** Drive one worker run to completion in `worktree` (a commit-free variant of helpers.addAndRunWorker). */
async function runWorker(core, missionId, mutate) {
  const begun = await core.beginSpawn({ missionId, role: 'worker' });
  await core.attachSpawn(begun.runId, `worker-${missionId}`);
  mutate(begun.mission.worktree);
  await core.completeSpawn(begun.runId, { stopReason: 'completed', output: 'worker report' });
  return begun.mission.worktree;
}

/**
 * Build the common fixture: a repo with one commit below the Tower base (so
 * the base can also move backward), then a mission with a committed worker
 * change and a clean merge-approved review — i.e. a gate-ready mission.
 */
async function readyTower(t, options = {}) {
  const repo = makeRepo(t);
  const initial = git(repo, 'rev-parse', 'HEAD');
  const base = commitFile(repo, 'base.md', 'base\n', 'advance base below the tower');
  const core = await initializedCore(repo);
  const run = await addAndRunWorker(core, { scope: options.scope, file: options.file, content: options.content });
  const { mission } = await approve(core, run.mission.id);
  return { core, repo, initial, base, worktree: run.worktree, mission };
}

/** Flip mission fields through the store's own transaction (real persisted state). */
async function editMissionState(core, missionId, mutator) {
  await core.store.update(async (state) => {
    const mission = state.missions.find((candidate) => candidate.id === missionId);
    assert.ok(mission, `mission ${missionId} must exist in state`);
    mutator(mission);
  });
}

test('a fully approved, reviewed, in-scope mission opens the gate', async (t) => {
  const { core, repo, worktree, mission } = await readyTower(t);
  const gate = await core.mergeGate(mission.id);
  assert.equal(gate.ready, true);
  assert.deepEqual(gate.blocks, []);
  assert.equal(gate.observations.baseCommit, git(repo, 'rev-parse', 'main'));
  assert.equal(gate.observations.reviewedCommit, git(worktree, 'rev-parse', 'HEAD'));
  assert.equal(gate.observations.checkedOutBranch, 'main');
  assert.equal(gate.observations.baseDirty, false);
  assert.equal(gate.observations.worktreeDirty, false);
});

test('NOT_APPROVED and NO_CLEAN_REVIEW are reported together and both clear after a clean review', async (t) => {
  covers('NOT_APPROVED', 'NO_CLEAN_REVIEW');
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core);
  const gate = await core.mergeGate(mission.id);
  assert.equal(gate.ready, false);
  assert.deepEqual(codesOf(gate), ['NOT_APPROVED', 'NO_CLEAN_REVIEW'], 'worker completion without review reports both problems');
  assert.ok(gate.blocks[0].message.includes('worker_completed'));
  assert.ok(gate.blocks[1].message.includes('no clean merge-approved review is recorded'));
  await approve(core, mission.id);
  await assertReady(core, mission.id);
});

test('NOT_APPROVED alone blocks an abandoned mission whose clean review is intact', async (t) => {
  covers('NOT_APPROVED');
  const { core, mission } = await readyTower(t);
  await core.abandon(mission.id);
  soleBlock(await core.mergeGate(mission.id), 'NOT_APPROVED', 'mission is abandoned');
  // Abandon is terminal by design; the fix path (approve again) is proven by
  // the test above, so this scenario only pins the sole-trigger property.
});

test('DEPENDENCIES_NOT_MERGED blocks an approved mission until its dependency reaches a terminal state', async (t) => {
  covers('DEPENDENCIES_NOT_MERGED');
  const { core, mission } = await readyTower(t);
  const dependency = await core.addMission({ title: 'Dependency', description: 'A dependency that stays pending.' });
  // An approved mission cannot gain a dependency through the public API
  // (editMission rejects non-pending missions), so record the edge directly
  // in the persisted state through the store transaction.
  await editMissionState(core, mission.id, (record) => {
    record.dependsOn = [dependency.id];
  });
  soleBlock(await core.mergeGate(mission.id), 'DEPENDENCIES_NOT_MERGED', `dependencies are not merged: ${dependency.id}`);
  await core.abandon(dependency.id);
  await assertReady(core, mission.id);
});

test('WORKTREE_REMOVED is the sole block while only the removal flag is set', async (t) => {
  covers('WORKTREE_REMOVED');
  const { core, mission } = await readyTower(t);
  await editMissionState(core, mission.id, (record) => {
    record.worktreeRemoved = true;
  });
  soleBlock(await core.mergeGate(mission.id), 'WORKTREE_REMOVED', 'mission worktree has been removed');
  await editMissionState(core, mission.id, (record) => {
    record.worktreeRemoved = false;
  });
  await assertReady(core, mission.id);
});

test('WORKTREE_REMOVED coexists with NOT_APPROVED after a real abandon and teardown', async (t) => {
  covers('WORKTREE_REMOVED');
  const { core, mission } = await readyTower(t);
  await core.abandon(mission.id);
  const teardown = await core.teardown({ missionId: mission.id });
  assert.equal(teardown.results[0].removed, true, 'teardown must actually remove the abandoned worktree');
  const gate = await core.mergeGate(mission.id);
  assert.equal(gate.ready, false);
  assert.deepEqual(codesOf(gate), ['NOT_APPROVED', 'WORKTREE_REMOVED']);
  // The gate stops after WORKTREE_REMOVED by design: the worktree directory
  // no longer exists, so per-worktree checks would fail to run at all.
});

test('BASE_DIRTY blocks an untracked file in the main checkout and reopens once it is gone', async (t) => {
  covers('BASE_DIRTY');
  const { core, repo, mission } = await readyTower(t);
  writeDirty(repo, 'scratch.txt', 'uncommitted\n');
  const gate = await core.mergeGate(mission.id);
  const block = soleBlock(gate, 'BASE_DIRTY', 'main checkout has uncommitted or untracked files');
  assert.ok(block.entries.some((entry) => entry.includes('scratch.txt')), 'the block lists the dirty entries');
  assert.equal(gate.observations.baseDirty, true);
  await rm(path.join(repo, 'scratch.txt'));
  await assertReady(core, mission.id);
});

test('BASE_MISMATCH blocks a main checkout on another branch or detached HEAD', async (t) => {
  covers('BASE_MISMATCH');
  const { core, repo, mission } = await readyTower(t);
  git(repo, 'checkout', '-b', 'other-branch');
  const gate = await core.mergeGate(mission.id);
  assert.equal(gate.observations.checkedOutBranch, 'other-branch');
  soleBlock(gate, 'BASE_MISMATCH', 'main checkout is on other-branch, not main');
  git(repo, 'checkout', 'main');
  await assertReady(core, mission.id);

  git(repo, 'checkout', '--detach');
  const detached = await core.mergeGate(mission.id);
  assert.equal(detached.observations.checkedOutBranch, undefined);
  soleBlock(detached, 'BASE_MISMATCH', 'main checkout is on detached HEAD, not main');
  git(repo, 'checkout', 'main');
  await assertReady(core, mission.id);
});

test('WORKTREE_DIRTY blocks an untracked file in the mission worktree and reopens once it is gone', async (t) => {
  covers('WORKTREE_DIRTY');
  const { core, mission, worktree } = await readyTower(t);
  writeDirty(worktree, 'scratch.txt', 'uncommitted\n');
  const gate = await core.mergeGate(mission.id);
  const block = soleBlock(gate, 'WORKTREE_DIRTY', 'mission worktree has uncommitted or untracked files');
  assert.ok(block.entries.some((entry) => entry.includes('scratch.txt')), 'the block lists the dirty entries');
  assert.equal(gate.observations.worktreeDirty, true);
  await rm(path.join(worktree, 'scratch.txt'));
  await assertReady(core, mission.id);
});

test('NO_CHANGE blocks a mission tip that still equals the base', async (t) => {
  covers('NO_CHANGE');
  const repo = makeRepo(t);
  const base = commitFile(repo, 'base.md', 'base\n', 'advance base below the tower');
  const core = await initializedCore(repo);
  const mission = await core.addMission({ title: 'No change', description: 'A mission whose worker never commits.' });
  // A pending mission reports NO_CHANGE together with the unavoidable
  // NOT_APPROVED and NO_CLEAN_REVIEW: with a clean review bound to a tip that
  // equals the base, the gate returns the alreadyMerged reconciliation
  // verdict instead of blocks, so NO_CHANGE can never appear alone.
  const gate = await core.mergeGate(mission.id);
  assert.equal(gate.ready, false);
  assert.deepEqual(codesOf(gate), ['NOT_APPROVED', 'NO_CHANGE', 'NO_CLEAN_REVIEW']);
  assert.ok(gate.blocks[1].message.includes('mission branch has no commit beyond the current base'));
  assert.equal(gate.observations.reviewedCommit, base);
  assert.equal(gate.observations.baseCommit, base);
  await runWorker(core, mission.id, (worktree) => {
    commitFile(worktree, 'src/feature.txt', 'implemented\n', 'worker implementation');
  });
  await approve(core, mission.id);
  await assertReady(core, mission.id);
});

test('STALE_BASE and REVIEW_BASE_STALE are both reported when the base advances past the review', async (t) => {
  covers('STALE_BASE', 'REVIEW_BASE_STALE');
  const { core, repo, mission } = await readyTower(t);
  commitFile(repo, 'other.md', 'other\n', 'advance base independently');
  const gate = await core.mergeGate(mission.id);
  assert.equal(gate.ready, false);
  assert.deepEqual(codesOf(gate), ['STALE_BASE', 'REVIEW_BASE_STALE'], 'an advanced base must not mask the stale review binding');
  assert.ok(gate.blocks[0].message.includes('current base is not an ancestor of the mission tip'));
  assert.ok(gate.blocks[1].message.includes('is not current base'));
  await core.rebase(mission.id);
  await approve(core, mission.id);
  await assertReady(core, mission.id);
});

test('REVIEW_TIP_STALE alone blocks an approved mission whose tip moved past the review', async (t) => {
  covers('REVIEW_TIP_STALE');
  const { core, mission, worktree } = await readyTower(t);
  commitFile(worktree, 'src/extra.txt', 'extra\n', 'follow-up commit');
  soleBlock(await core.mergeGate(mission.id), 'REVIEW_TIP_STALE', 'is not current tip');
  await core.rebase(mission.id);
  await approve(core, mission.id);
  await assertReady(core, mission.id);
});

test('REVIEW_BASE_STALE alone blocks an approved mission when the base moves backward', async (t) => {
  covers('REVIEW_BASE_STALE');
  const { core, repo, initial, base, mission } = await readyTower(t);
  git(repo, 'reset', '--hard', initial);
  soleBlock(await core.mergeGate(mission.id), 'REVIEW_BASE_STALE', 'is not current base');
  git(repo, 'reset', '--hard', base);
  await assertReady(core, mission.id);
});

test('OUT_OF_SCOPE blocks approved changes outside the mission scope until they are removed and re-reviewed', async (t) => {
  covers('OUT_OF_SCOPE');
  const repo = makeRepo(t);
  commitFile(repo, 'base.md', 'base\n', 'advance base below the tower');
  const core = await initializedCore(repo);
  const run = await addAndRunWorker(core, { scope: ['src/**'], file: 'docs/notes.md', content: 'outside scope\n' });
  const { mission } = await approve(core, run.mission.id);
  const gate = await core.mergeGate(mission.id);
  const block = soleBlock(gate, 'OUT_OF_SCOPE', 'mission changed files outside its scope: docs/notes.md');
  assert.deepEqual(block.files, ['docs/notes.md']);
  assert.deepEqual(gate.observations.changedFiles, ['docs/notes.md']);
  git(run.worktree, 'rm', 'docs/notes.md');
  git(run.worktree, 'commit', '-m', 'remove the out-of-scope change');
  await core.rebase(mission.id);
  await approve(core, mission.id);
  const fixed = await assertReady(core, mission.id);
  assert.deepEqual(fixed.observations.changedFiles, [], 'the net diff no longer touches the removed file');
});

test('four independent problems are reported as four blocks without masking each other', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const dependency = await core.addMission({ title: 'Dependency', description: 'Stays pending to block the dependent mission.' });
  const dependent = await core.addMission({ title: 'Dependent', description: 'Waits for the dependency.', dependsOn: [dependency.id] });
  const gate = await core.mergeGate(dependent.id);
  assert.equal(gate.ready, false);
  assert.deepEqual(codesOf(gate), ['NOT_APPROVED', 'DEPENDENCIES_NOT_MERGED', 'NO_CHANGE', 'NO_CLEAN_REVIEW']);
  assert.ok(gate.blocks[1].message.includes(`dependencies are not merged: ${dependency.id}`));
  await core.abandon(dependency.id);
  await runWorker(core, dependent.id, (worktree) => {
    commitFile(worktree, 'src/feature.txt', 'implemented\n', 'worker implementation');
  });
  await approve(core, dependent.id);
  await assertReady(core, dependent.id);
});

test('the matrix covers every block code emitted by evaluateMergeGate', () => {
  // Block codes are not exported as constants, so parse the gate source and
  // collect every `code: '...'` literal inside evaluateMergeGate.
  const source = readFileSync(new URL('../lib/core.js', import.meta.url), 'utf8');
  const start = source.indexOf('async evaluateMergeGate(');
  assert.notEqual(start, -1, 'lib/core.js must define evaluateMergeGate');
  const nextMethod = /\n  (?:async )?[A-Za-z_$][\w$]*\(/g;
  nextMethod.lastIndex = start;
  const boundary = nextMethod.exec(source);
  const body = source.slice(start, boundary === null ? undefined : boundary.index);
  assert.ok(body.includes('ready: blocks.length === 0'), 'the extracted evaluateMergeGate body must reach its return statement');
  const parsed = new Set([...body.matchAll(/code:\s*'([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]));
  // Documentation of the codes known today; if lib grows a new code the
  // `uncovered` assertion below fails with an actionable list.
  const known = [
    'NOT_APPROVED', 'DEPENDENCIES_NOT_MERGED', 'WORKTREE_REMOVED', 'BASE_DIRTY',
    'BASE_MISMATCH', 'WORKTREE_DIRTY', 'NO_CHANGE', 'STALE_BASE', 'NO_CLEAN_REVIEW',
    'REVIEW_TIP_STALE', 'REVIEW_BASE_STALE', 'OUT_OF_SCOPE',
  ];
  assert.deepEqual([...parsed].sort(), [...known].sort(), 'the parsed block-code inventory must match the documented matrix');
  const uncovered = [...parsed].filter((code) => !covered.has(code));
  assert.deepEqual(uncovered, [], 'block codes emitted by evaluateMergeGate without a scenario in this file — add one: add a real-scenario test and register it via covers()');
  const stale = [...covered].filter((code) => !parsed.has(code));
  assert.deepEqual(stale, [], 'scenarios registered for codes that evaluateMergeGate no longer emits');
  assert.ok(covered.size >= known.length, 'every known block code must be exercised by at least one scenario');
});

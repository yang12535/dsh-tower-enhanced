import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectFindings, runDoctor } from '../scripts/tower-doctor.mjs';
import { approve, commitFile, git, initializedCore, makeRepo } from './helpers.js';

// Integration coverage: doctor verdicts vs state produced by the REAL TowerCore.
//
// Every test drives the public TowerCore API over a real mkdtemp Git repository
// (real `git worktree add`, real commits, real merges, real teardown) and then
// inspects that state with the doctor's exported functions. Git is never
// mocked: collectFindings always runs the real git binary. The only hand
// edits are deliberate state.json corruptions that simulate crash/forge
// scenarios the healthy Tower lifecycle never produces on its own.
// Temp directories come from helpers.js makeRepo() (mkdtemp + t.after cleanup).

const SCRIPT = fileURLToPath(new URL('../scripts/tower-doctor.mjs', import.meta.url));

function codes(findings) {
  return findings.map((item) => item.code);
}

function statePathOf(repo) {
  return path.join(repo, '.dsh-tower', 'state.json');
}

function readState(repo) {
  return JSON.parse(readFileSync(statePathOf(repo), 'utf8'));
}

/** Rewrite state.json in the exact on-disk format TowerStore.write() uses. */
function writeState(repo, state) {
  writeFileSync(statePathOf(repo), `${JSON.stringify(state, null, 2)}\n`);
}

/** Simulate crash/forge scenarios by mutating the real Tower-produced state. */
function patchState(repo, mutate) {
  const state = readState(repo);
  mutate(state);
  writeState(repo, state);
}

function isAncestor(cwd, commit, ref) {
  try {
    git(cwd, 'merge-base', '--is-ancestor', commit, ref);
    return true;
  } catch {
    return false;
  }
}

function registeredWorktrees(repo) {
  return git(repo, 'worktree', 'list', '--porcelain')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

/** Real CLI exit code for graded semantics (0 clean / 1 warnings / 2 errors). */
function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Land one mission end to end (worker -> clean review -> merge), public API only. */
async function landMission(core, options = {}) {
  const mission = await core.addMission({ title: options.title ?? 'Land feature', description: options.description ?? 'Implement the feature end to end.' });
  const spawned = await core.beginSpawn({ missionId: mission.id, role: 'worker' });
  await core.attachSpawn(spawned.runId, `child-${mission.id.toLowerCase()}`);
  commitFile(spawned.mission.worktree, options.file ?? 'src/feature.txt', options.content ?? 'implemented\n', 'worker implementation');
  await core.completeSpawn(spawned.runId, { stopReason: 'completed', output: 'worker report' });
  await approve(core, mission.id);
  const merged = await core.merge(mission.id);
  assert.equal(merged.merged, true, `mission ${mission.id} must merge for the fixture to be valid`);
  return { mission, merged, worktree: spawned.mission.worktree };
}

test('healthy real Tower state (merged, worker_completed, pending with dependency) is fully clean (exit 0)', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);

  // M1: full lifecycle — merged, then torn down.
  const landed = await landMission(core, { title: 'Land the feature' });
  const torn = await core.teardown({ missionId: landed.mission.id });
  assert.equal(torn.results[0].removed, true);
  assert.equal(existsSync(landed.worktree), false);

  // M2: worker finished, never reviewed.
  const second = await core.addMission({ title: 'Follow-up', description: 'Waiting for review.' });
  const worker = await core.beginSpawn({ missionId: second.id, role: 'worker' });
  commitFile(worker.mission.worktree, 'src/follow-up.txt', 'follow-up\n', 'follow-up work');
  const completed = await core.completeSpawn(worker.runId, { stopReason: 'completed', output: 'follow-up done' });
  assert.equal(completed.status, 'worker_completed');

  // M3: pending, blocked on the unmerged M2.
  const blocked = await core.addMission({ title: 'Blocked follow-up', description: 'Waits for the follow-up.', dependsOn: [second.id] });
  assert.equal(blocked.status, 'pending');

  // The real state Tower wrote matches what doctor expects, field by field.
  const state = readState(repo);
  assert.deepEqual(state.missions.map((mission) => [mission.id, mission.status]), [
    ['M1', 'merged'],
    ['M2', 'worker_completed'],
    ['M3', 'pending'],
  ]);
  assert.deepEqual(state.missions[2].dependsOn, ['M2']);
  assert.equal(state.missions[0].worktreeRemoved, true);
  assert.equal(state.baseBranch, 'main');
  assert.equal(state.baseCommit, git(repo, 'rev-parse', 'main'), 'merge must anchor state.baseCommit at the base tip');
  const registered = registeredWorktrees(repo);
  assert.ok(registered.includes(state.missions[1].worktree), 'the worker_completed mission worktree is registered');
  assert.ok(registered.includes(state.missions[2].worktree), 'the pending mission worktree is registered');
  assert.ok(!registered.includes(state.missions[0].worktree), 'the torn-down worktree is unregistered');

  const stateBefore = readFileSync(statePathOf(repo), 'utf8');
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.errors, 0);
  assert.equal(result.summary.warnings, 0);
  assert.ok(result.summary.checksPassed > 0);
  assert.equal(result.json.baseBranch, 'main');
  assert.equal(result.json.baseTip, state.baseCommit);

  // The real merge commit is reachable from main (positive ancestry case).
  assert.equal(isAncestor(repo, state.missions[0].merge.commit, 'main'), true);
  assert.equal(state.missions[0].merge.commit, landed.merged.mergeCommit);
  assert.equal(state.missions[0].merge.reviewedCommit, state.missions[0].worker.headCommit);

  // Real CLI exit code semantics, and doctor never mutates anything.
  const cli = runCli(['--repo', repo]);
  assert.equal(cli.status, 0);
  assert.equal(readFileSync(statePathOf(repo), 'utf8'), stateBefore);
});

test('a real merged mission checks out clean, and a forged mergeCommit outside main reports MERGE_COMMIT_NOT_IN_BASE (exit 2)', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission, merged, worktree } = await landMission(core, { title: 'Ancestry feature' });

  // The merge Tower recorded really is in main's ancestry: doctor stays silent.
  assert.equal(isAncestor(repo, merged.mergeCommit, 'main'), true);
  const clean = await runDoctor(['--repo', repo]);
  assert.equal(clean.exitCode, 0);
  assert.deepEqual(clean.findings, []);

  // Forge: commit outside Tower's merge on the mission branch, then point the
  // merged mission's merge record at that unreachable commit.
  const sideSha = commitFile(worktree, 'src/side.txt', 'never merged\n', 'unmerged side work');
  assert.equal(isAncestor(repo, sideSha, 'main'), false, 'fixture precondition: the side commit is outside main');
  patchState(repo, (state) => {
    state.missions.find((entry) => entry.id === mission.id).merge.commit = sideSha;
  });

  const broken = await runDoctor(['--repo', repo]);
  assert.equal(broken.exitCode, 2);
  assert.deepEqual(codes(broken.findings), ['MERGE_COMMIT_NOT_IN_BASE']);
  assert.equal(broken.findings[0].severity, 'error');
  assert.equal(broken.findings[0].mission, mission.id);
  assert.equal(broken.findings[0].mergeCommit, sideSha);
  assert.equal(broken.findings[0].baseBranch, 'main');
  assert.equal(broken.findings[0].baseTip, git(repo, 'rev-parse', 'main'));

  const cli = runCli(['--repo', repo]);
  assert.equal(cli.status, 2);
});

test('real teardown passes doctor; recreating the worktree directory reports TEARDOWN_INCOMPLETE and WORKTREE_STILL_REGISTERED (exit 2)', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission, worktree } = await landMission(core, { title: 'Torn down feature' });

  const torn = await core.teardown({ missionId: mission.id });
  assert.equal(torn.results[0].removed, true);
  assert.equal(existsSync(worktree), false);
  assert.ok(!registeredWorktrees(repo).includes(worktree), 'git worktree list must no longer mention it');
  assert.equal(readState(repo).missions[0].worktreeRemoved, true);

  const report = await collectFindings({ repo });
  assert.equal(report.repo, path.resolve(repo));
  assert.equal(report.statePath, statePathOf(repo));
  assert.deepEqual(report.findings, []);
  assert.ok(report.checksPassed > 0);
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.findings, []);

  // Recreate the plain directory at the recorded worktree path.
  mkdirSync(worktree, { recursive: true });
  const dirBack = await runDoctor(['--repo', repo]);
  assert.equal(dirBack.exitCode, 2);
  assert.deepEqual(codes(dirBack.findings), ['TEARDOWN_INCOMPLETE']);
  assert.equal(dirBack.findings[0].severity, 'error');
  assert.equal(dirBack.findings[0].mission, mission.id);
  assert.equal(dirBack.findings[0].path, worktree);

  // Escalate: re-register it as a real git worktree (the branch ref survived teardown).
  rmSync(worktree, { recursive: true, force: true });
  git(repo, 'worktree', 'add', worktree, mission.branch);
  const reRegistered = await runDoctor(['--repo', repo]);
  assert.equal(reRegistered.exitCode, 2);
  assert.deepEqual(codes(reRegistered.findings), ['TEARDOWN_INCOMPLETE', 'WORKTREE_STILL_REGISTERED']);
  assert.ok(reRegistered.findings.every((item) => item.severity === 'error' && item.mission === mission.id));
});

test('worker_running with a live run record passes; a finished or vanished record is only reported, never repaired', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const mission = await core.addMission({ title: 'Live worker', description: 'Runs while doctor inspects.' });

  // A genuinely live activation: real runId, started, attached, no end markers.
  const spawned = await core.beginSpawn({ missionId: mission.id, role: 'worker' });
  await core.attachSpawn(spawned.runId, `child-${mission.id.toLowerCase()}`);
  assert.equal((await core.mission(mission.id)).status, 'worker_running');
  const live = await runDoctor(['--repo', repo]);
  assert.equal(live.exitCode, 0);
  assert.deepEqual(live.findings, []);

  // Crash scenario: the run ended but the status was never reconciled.
  patchState(repo, (state) => {
    const record = state.missions.find((entry) => entry.id === mission.id).worker;
    record.completedAt = new Date().toISOString();
    record.stopReason = 'completed';
  });
  const before = readFileSync(statePathOf(repo), 'utf8');
  const stale = await runDoctor(['--repo', repo]);
  assert.equal(stale.exitCode, 1);
  assert.deepEqual(codes(stale.findings), ['RUNNING_RECORD_FINISHED']);
  assert.equal(stale.findings[0].severity, 'warning');
  assert.equal(stale.findings[0].mission, mission.id);
  assert.equal(stale.findings[0].role, 'worker');
  assert.equal(stale.findings[0].runId, spawned.runId, 'doctor reports the real Tower-issued runId');

  // Doctor only reports: the state file is byte-identical, still worker_running.
  const cli = runCli(['--repo', repo]);
  assert.equal(cli.status, 1);
  const after = readFileSync(statePathOf(repo), 'utf8');
  assert.equal(after, before);
  assert.equal(JSON.parse(after).missions[0].status, 'worker_running');

  // Worse corruption: the run record vanished entirely while still running.
  patchState(repo, (state) => {
    delete state.missions.find((entry) => entry.id === mission.id).worker;
  });
  const vanished = await runDoctor(['--repo', repo]);
  assert.equal(vanished.exitCode, 2);
  assert.deepEqual(codes(vanished.findings), ['RUNNING_RECORD_MISSING']);
  assert.equal(vanished.findings[0].severity, 'error');
  assert.equal(vanished.findings[0].role, 'worker');
});

test('aligned baseCommit passes; a forged diverged baseCommit is BASE_COMMIT_DIVERGED (exit 2); an advanced base is BASE_COMMIT_DRIFT (exit 1)', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const mission = await core.addMission({ title: 'Base watcher', description: 'Anchors the recorded base.' });
  const originalBase = readState(repo).baseCommit;
  assert.equal(originalBase, mission.baseCommit);

  // Aligned: the recorded base is exactly the real base branch tip.
  const aligned = await runDoctor(['--repo', repo]);
  assert.equal(aligned.exitCode, 0);
  assert.deepEqual(aligned.findings, []);
  assert.equal(aligned.json.baseTip, git(repo, 'rev-parse', 'main'));

  // Forged divergence: record a base Tower never put on main (mission branch tip).
  const sideSha = commitFile(mission.worktree, 'src/local.txt', 'local work\n', 'local work outside the base');
  assert.equal(isAncestor(repo, sideSha, 'main'), false, 'fixture precondition: main is behind the forged base');
  patchState(repo, (state) => {
    state.baseCommit = sideSha;
  });
  const diverged = await runDoctor(['--repo', repo]);
  assert.equal(diverged.exitCode, 2);
  assert.deepEqual(codes(diverged.findings), ['BASE_COMMIT_DIVERGED']);
  assert.equal(diverged.findings[0].severity, 'error');
  assert.equal(diverged.findings[0].baseBranch, 'main');
  assert.equal(diverged.findings[0].baseCommit, sideSha);
  assert.equal(diverged.findings[0].baseTip, git(repo, 'rev-parse', 'main'));

  // Real drift: restore the aligned base, then advance main outside Tower.
  patchState(repo, (state) => {
    state.baseCommit = originalBase;
  });
  const restored = await runDoctor(['--repo', repo]);
  assert.deepEqual(restored.findings, [], 'restoring the aligned base clears the finding');
  const advancedTip = commitFile(repo, 'docs/drift.txt', 'drift\n', 'advance base outside Tower');
  const drift = await runDoctor(['--repo', repo]);
  assert.equal(drift.exitCode, 1);
  assert.deepEqual(codes(drift.findings), ['BASE_COMMIT_DRIFT']);
  assert.equal(drift.findings[0].severity, 'warning');
  assert.equal(drift.findings[0].baseBranch, 'main');
  assert.equal(drift.findings[0].baseCommit, originalBase);
  assert.equal(drift.findings[0].baseTip, advancedTip);
});

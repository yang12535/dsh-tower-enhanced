import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TowerCore } from '../lib/core.js';

export function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  }).trim();
}

export function makeRepo(t) {
  const repo = mkdtempSync(path.join(tmpdir(), 'dsh-tower-test-'));
  t.after(() => {
    if (repo.startsWith(path.join(tmpdir(), 'dsh-tower-test-'))) rmSync(repo, { recursive: true, force: true });
  });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Tower Test');
  git(repo, 'config', 'user.email', 'tower@example.invalid');
  writeFileSync(path.join(repo, 'README.md'), '# Tower test\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'initial');
  return repo;
}

export function commitFile(cwd, relative, content, message = `update ${relative}`) {
  const target = path.resolve(cwd, relative);
  if (!target.startsWith(`${path.resolve(cwd)}${path.sep}`)) throw new Error('test file escapes repository');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  git(cwd, 'add', '--', relative);
  git(cwd, 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

export function writeDirty(cwd, relative, content) {
  const target = path.resolve(cwd, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

export async function initializedCore(repo) {
  const core = new TowerCore({ cwd: repo });
  await core.init();
  return core;
}

export async function addAndRunWorker(core, options = {}) {
  const mission = await core.addMission({ title: options.title ?? 'Implement feature', description: options.description ?? 'Implement and test the feature.', scope: options.scope ?? [], dependsOn: options.dependsOn });
  const begun = await core.beginSpawn({ missionId: mission.id, role: 'worker' });
  await core.attachSpawn(begun.runId, `child-${mission.id}`);
  const worktree = begun.mission.worktree;
  if (options.change !== false) commitFile(worktree, options.file ?? 'src/feature.txt', options.content ?? 'implemented\n', 'worker implementation');
  if (options.dirty) writeDirty(worktree, options.dirty, 'dirty\n');
  const completed = await core.completeSpawn(begun.runId, { stopReason: 'completed', output: 'worker report' });
  return { mission: completed, runId: begun.runId, worktree };
}

export async function approve(core, missionId) {
  const begun = await core.beginSpawn({ missionId, role: 'reviewer' });
  await core.attachSpawn(begun.runId, `review-${missionId}-${begun.runId}`);
  const binding = { baseCommit: begun.mission.review.baseCommit, reviewedCommit: begun.mission.review.reviewedCommit };
  const mission = await core.completeSpawn(begun.runId, {
    stopReason: 'completed',
    output: 'clean review',
    structured: { verdict: 'clean', merge: true, summary: 'clean', findings: [], checks: ['unit tests'] },
  });
  return { mission, binding, runId: begun.runId };
}

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectFindings, parseArgs, parseWorktreeList, runDoctor, validateStateStructure } from '../scripts/tower-doctor.mjs';
import { TowerCore } from '../lib/core.js';

const SCRIPT = fileURLToPath(new URL('../scripts/tower-doctor.mjs', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  }).trim();
}

/** Non-throwing Git capture with the same shape collectFindings expects. */
async function captureGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function makeRepo(t) {
  const repo = mkdtempSync(path.join(tmpdir(), 'dsh-tower-doctor-'));
  t.after(() => {
    if (repo.startsWith(path.join(tmpdir(), 'dsh-tower-doctor-'))) rmSync(repo, { recursive: true, force: true });
  });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Doctor Test');
  git(repo, 'config', 'user.email', 'doctor@example.invalid');
  return repo;
}

function commit(cwd, relative, content, message) {
  const target = path.join(cwd, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  git(cwd, 'add', '--', relative);
  git(cwd, 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

function statePathOf(repo) {
  return path.join(repo, '.dsh-tower', 'state.json');
}

function writeState(repo, state) {
  mkdirSync(path.dirname(statePathOf(repo)), { recursive: true });
  writeFileSync(statePathOf(repo), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * A realistic healthy fixture: M0 merged with a real merge commit and a torn
 * down worktree, M1 pending with a live registered worktree.
 */
function healthyState(repo) {
  const base = commit(repo, 'README.md', '# doctor\n', 'initial');
  const m0Path = path.join(repo, '.dsh-tower', 'worktrees', 'm0');
  git(repo, 'worktree', 'add', '-b', 'tower/m0', m0Path, base);
  const reviewed = commit(m0Path, 'feature.txt', 'm0 work\n', 'm0 work');
  git(repo, 'merge', '--no-ff', '-m', 'merge tower/m0', 'tower/m0');
  const mergeSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'remove', m0Path);
  const m1Path = path.join(repo, '.dsh-tower', 'worktrees', 'm1');
  git(repo, 'worktree', 'add', '-b', 'tower/m1', m1Path, base);
  const now = new Date().toISOString();
  return {
    version: 1,
    repoRoot: repo,
    baseBranch: 'main',
    baseCommit: mergeSha,
    createdAt: now,
    updatedAt: now,
    missions: [
      {
        id: 'M0',
        title: 'merged mission',
        branch: 'tower/m0',
        worktree: m0Path,
        baseCommit: base,
        status: 'merged',
        revision: 3,
        dependsOn: [],
        scope: [],
        createdAt: now,
        worktreeRemoved: true,
        merge: { mergedAt: now, commit: mergeSha, reviewedCommit: reviewed, baseCommit: base },
      },
      {
        id: 'M1',
        title: 'pending mission',
        branch: 'tower/m1',
        worktree: m1Path,
        baseCommit: base,
        status: 'pending',
        revision: 1,
        dependsOn: [],
        scope: [],
        createdAt: now,
        worktreeRemoved: false,
      },
    ],
  };
}

function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function codes(findings) {
  return findings.map((item) => item.code);
}

test('healthy repo: exit 0, no findings, and nothing is mutated', async (t) => {
  const repo = makeRepo(t);
  writeState(repo, healthyState(repo));
  const stateBefore = readFileSync(statePathOf(repo), 'utf8');
  const worktreesBefore = git(repo, 'worktree', 'list', '--porcelain');
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.findings, []);
  assert.ok(result.summary.checksPassed > 0);
  assert.equal(result.summary.errors, 0);
  assert.equal(result.summary.warnings, 0);
  assert.match(result.text, /no problems found/);
  assert.equal(readFileSync(statePathOf(repo), 'utf8'), stateBefore);
  assert.equal(git(repo, 'worktree', 'list', '--porcelain'), worktreesBefore);
});

test('corrupt state.json reports STATE_CORRUPT and exits 2', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  writeState(repo, state);
  writeFileSync(statePathOf(repo), '{"version": 1, "missions": [oops');
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(codes(result.findings), ['STATE_CORRUPT']);
  assert.equal(result.findings[0].severity, 'error');
});

test('missing state file reports STATE_MISSING and exits 2', async (t) => {
  const repo = makeRepo(t);
  commit(repo, 'README.md', '# x\n', 'initial');
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(codes(result.findings), ['STATE_MISSING']);
});

test('validateStateStructure flags version, fields, duplicates, and unknown deps', () => {
  const validMission = (seed = {}) => ({
    id: 'M1',
    title: 'title',
    branch: 'tower/m1',
    worktree: '/absolute/worktree',
    baseCommit: 'a'.repeat(40),
    status: 'pending',
    revision: 1,
    dependsOn: [],
    scope: [],
    worktreeRemoved: false,
    ...seed,
  });
  const validState = (seed = {}) => ({
    version: 1,
    repoRoot: '/absolute/repo',
    baseBranch: 'main',
    baseCommit: 'b'.repeat(40),
    missions: [],
    ...seed,
  });

  assert.deepEqual(validateStateStructure(validState()), { findings: [], valid: true });

  const version = validateStateStructure(validState({ version: 2 }));
  assert.equal(version.valid, false);
  assert.deepEqual(codes(version.findings), ['STATE_VERSION']);

  const fields = validateStateStructure(validState({ baseBranch: '' }));
  assert.equal(fields.valid, false);
  assert.ok(fields.findings.some((item) => item.code === 'STATE_FIELD_INVALID' && item.field === 'baseBranch'));

  const missionFields = validateStateStructure(validState({ missions: [validMission({ status: 'weird', worktree: 'relative/path' })] }));
  assert.equal(missionFields.valid, false);
  assert.ok(missionFields.findings.some((item) => item.code === 'MISSION_FIELD_INVALID' && item.field === 'status'));
  assert.ok(missionFields.findings.some((item) => item.code === 'MISSION_FIELD_INVALID' && item.field === 'worktree'));

  const duplicates = validateStateStructure(validState({ missions: [validMission(), validMission()] }));
  assert.equal(duplicates.valid, false);
  assert.ok(duplicates.findings.some((item) => item.code === 'MISSION_DUPLICATE'));

  const dependency = validateStateStructure(validState({ missions: [validMission({ dependsOn: ['M2'] })] }));
  assert.equal(dependency.valid, true);
  assert.deepEqual(codes(dependency.findings), ['MISSION_DEP_UNKNOWN']);
  assert.equal(dependency.findings[0].severity, 'warning');
});

test('parseArgs accepts flags, = values, and rejects bad usage', () => {
  assert.deepEqual(parseArgs([]), { repo: undefined, state: undefined, json: false, help: false, error: undefined });
  assert.deepEqual(parseArgs(['--repo', '/r', '--state', '/s', '--json']), { repo: '/r', state: '/s', json: true, help: false, error: undefined });
  assert.deepEqual(parseArgs(['--repo=/r', '--state=/s', '--help']), { repo: '/r', state: '/s', json: false, help: true, error: undefined });
  assert.match(parseArgs(['--repo']).error, /--repo/);
  assert.match(parseArgs(['--nope']).error, /unknown option/);
});

test('parseWorktreeList parses porcelain entries', () => {
  const text = [
    'worktree /repo/main',
    'HEAD 0123456789abcdef',
    'branch refs/heads/main',
    '',
    'worktree /repo/.dsh-tower/worktrees/m1',
    'HEAD fedcba9876543210',
    'branch refs/heads/tower/m1',
    'prunable',
    '',
    'worktree /repo/other',
    'HEAD 1111111111111111',
    'detached',
    '',
  ].join('\n');
  const worktrees = parseWorktreeList(text);
  assert.equal(worktrees.length, 3);
  assert.deepEqual(worktrees[0], { path: '/repo/main', head: '0123456789abcdef', branch: 'main', prunable: false });
  assert.equal(worktrees[1].branch, 'tower/m1');
  assert.equal(worktrees[1].prunable, true);
  assert.equal(worktrees[2].branch, undefined);
});

test('base branch advanced beyond baseCommit is a warning (exit 1)', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  commit(repo, 'extra.txt', 'drift\n', 'advance main');
  writeState(repo, state);
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(codes(result.findings), ['BASE_COMMIT_DRIFT']);
  assert.equal(result.findings[0].severity, 'warning');
});

test('baseCommit diverged from the base branch is an error (exit 2)', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  const sideSha = commit(state.missions[1].worktree, 'side.txt', 'side\n', 'side work');
  state.baseCommit = sideSha;
  writeState(repo, state);
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(codes(result.findings), ['BASE_COMMIT_DIVERGED']);
  assert.equal(result.findings[0].severity, 'error');
});

test('missing base branch is an error (exit 2)', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  state.baseBranch = 'nope';
  writeState(repo, state);
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(codes(result.findings), ['BASE_BRANCH_MISSING']);
});

test('mission branch missing on a terminal mission is a warning (exit 1)', async (t) => {
  const repo = makeRepo(t);
  const base = commit(repo, 'README.md', '# x\n', 'initial');
  const now = new Date().toISOString();
  writeState(repo, {
    version: 1,
    repoRoot: repo,
    baseBranch: 'main',
    baseCommit: base,
    createdAt: now,
    updatedAt: now,
    missions: [{
      id: 'M9',
      title: 'gone',
      branch: 'tower/ghost',
      worktree: path.join(repo, '.dsh-tower', 'worktrees', 'ghost'),
      baseCommit: base,
      status: 'abandoned',
      revision: 2,
      dependsOn: [],
      scope: [],
      createdAt: now,
      worktreeRemoved: true,
    }],
  });
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(codes(result.findings), ['MISSION_BRANCH_MISSING']);
  assert.equal(result.findings[0].severity, 'warning');
  assert.equal(result.findings[0].mission, 'M9');
});

test('orphan worktrees (registered and leftover directory) are warnings (exit 1)', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  writeState(repo, state);
  const orphanPath = path.join(repo, '.dsh-tower', 'worktrees', 'orphan');
  git(repo, 'worktree', 'add', '-b', 'tower/orphan', orphanPath, state.baseCommit);
  const leftoverPath = path.join(repo, '.dsh-tower', 'worktrees', 'leftover');
  mkdirSync(leftoverPath);
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(codes(result.findings), ['ORPHAN_WORKTREE', 'ORPHAN_WORKTREE']);
  assert.ok(result.findings.some((item) => item.path === orphanPath && item.registered === true));
  assert.ok(result.findings.some((item) => item.path === leftoverPath && item.registered === false));
});

test('merged mission whose mergeCommit is not in main is an error (exit 2)', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  const sideSha = commit(state.missions[1].worktree, 'side.txt', 'side\n', 'side work');
  state.missions[0].merge.commit = sideSha;
  writeState(repo, state);
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(codes(result.findings), ['MERGE_COMMIT_NOT_IN_BASE']);
  assert.equal(result.findings[0].mission, 'M0');
});

test('merged mission without a merge record is an error (exit 2)', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  delete state.missions[0].merge;
  writeState(repo, state);
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(codes(result.findings), ['MERGE_RECORD_MISSING']);
});

test('worktreeRemoved set but worktree still exists and registered is two errors (exit 2)', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  writeState(repo, state);
  git(repo, 'worktree', 'add', state.missions[0].worktree, 'tower/m0');
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(codes(result.findings), ['TEARDOWN_INCOMPLETE', 'WORKTREE_STILL_REGISTERED']);
  assert.ok(result.findings.every((item) => item.severity === 'error' && item.mission === 'M0'));
});

test('active mission with a missing worktree directory is an error (exit 2)', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  writeState(repo, state);
  git(repo, 'worktree', 'remove', state.missions[1].worktree);
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(codes(result.findings), ['WORKTREE_DIR_MISSING']);
  assert.equal(result.findings[0].mission, 'M1');
});

test('worktree directory present but unregistered is a warning (exit 1)', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  writeState(repo, state);
  git(repo, 'worktree', 'remove', state.missions[1].worktree);
  mkdirSync(state.missions[1].worktree);
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(codes(result.findings), ['WORKTREE_UNREGISTERED']);
});

test('registered worktree on the wrong branch is a warning (exit 1)', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  writeState(repo, state);
  git(state.missions[1].worktree, 'checkout', '-b', 'tower/other');
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(codes(result.findings), ['WORKTREE_BRANCH_MISMATCH']);
  assert.equal(result.findings[0].branch, 'tower/other');
  assert.equal(result.findings[0].expected, 'tower/m1');
});

test('worker_running with an already-finished record is a stale warning (exit 1)', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  const now = new Date().toISOString();
  state.missions[1].status = 'worker_running';
  state.missions[1].worker = { runId: 'run-stale', startedAt: now, completedAt: now, stopReason: 'completed' };
  writeState(repo, state);
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(codes(result.findings), ['RUNNING_RECORD_FINISHED']);
  assert.equal(result.findings[0].severity, 'warning');
  assert.equal(result.findings[0].runId, 'run-stale');
  assert.equal(result.findings[0].mission, 'M1');
});

test('review_running without any run record is an error (exit 2)', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  state.missions[1].status = 'review_running';
  writeState(repo, state);
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(codes(result.findings), ['RUNNING_RECORD_MISSING']);
  assert.equal(result.findings[0].role, 'reviewer');
});

test('errors take precedence over warnings in the exit code', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  const sideSha = commit(state.missions[1].worktree, 'side.txt', 'side\n', 'side work');
  state.baseCommit = sideSha;
  writeState(repo, state);
  git(repo, 'worktree', 'add', '-b', 'tower/orphan', path.join(repo, '.dsh-tower', 'worktrees', 'orphan'), state.missions[1].baseCommit);
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(codes(result.findings), ['BASE_COMMIT_DIVERGED', 'ORPHAN_WORKTREE']);
});

test('state.repoRoot mismatch is a warning', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  state.repoRoot = '/somewhere/else';
  writeState(repo, state);
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(codes(result.findings), ['REPO_MISMATCH']);
});

test('--state reads an alternate state file path', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  const custom = path.join(repo, 'custom-state.json');
  writeFileSync(custom, `${JSON.stringify(state, null, 2)}\n`);
  const result = await runDoctor(['--repo', repo, '--state', custom]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.findings, []);
  assert.equal(result.json.statePath, custom);
});

test('collectFindings is idempotent', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  writeState(repo, state);
  git(repo, 'worktree', 'add', '-b', 'tower/orphan', path.join(repo, '.dsh-tower', 'worktrees', 'orphan'), state.baseCommit);
  const first = await collectFindings({ repo });
  const second = await collectFindings({ repo });
  assert.deepEqual(second, first);
  assert.deepEqual(codes(first.findings), ['ORPHAN_WORKTREE']);
});

test('CLI --json emits a structured report with graded exit codes', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  writeState(repo, state);
  git(repo, 'worktree', 'add', '-b', 'tower/orphan', path.join(repo, '.dsh-tower', 'worktrees', 'orphan'), state.baseCommit);

  const healthyRepo = makeRepo(t);
  writeState(healthyRepo, healthyState(healthyRepo));
  const clean = runCli(['--repo', healthyRepo, '--json']);
  assert.equal(clean.status, 0);
  const cleanPayload = JSON.parse(clean.stdout);
  assert.deepEqual(cleanPayload.findings, []);
  assert.equal(cleanPayload.summary.exitCode, 0);
  assert.equal(cleanPayload.repo, path.resolve(healthyRepo));
  assert.equal(cleanPayload.statePath, statePathOf(healthyRepo));
  assert.equal(cleanPayload.baseBranch, 'main');
  assert.equal(typeof cleanPayload.baseTip, 'string');
  assert.equal(cleanPayload.summary.checksPassed > 0, true);

  const dirty = runCli(['--repo', repo, '--json']);
  assert.equal(dirty.status, 1);
  const payload = JSON.parse(dirty.stdout);
  assert.equal(payload.summary.exitCode, 1);
  assert.equal(payload.summary.warnings, 1);
  assert.equal(payload.summary.errors, 0);
  assert.deepEqual(codes(payload.findings), ['ORPHAN_WORKTREE']);
  assert.equal(payload.findings[0].severity, 'warning');
  assert.ok(payload.findings[0].message.length > 0);
});

test('CLI human output prints severity, code, and message', async (t) => {
  const repo = makeRepo(t);
  const state = healthyState(repo);
  writeState(repo, state);
  git(repo, 'worktree', 'remove', state.missions[1].worktree);
  const result = runCli(['--repo', repo]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /\[error\] WORKTREE_DIR_MISSING: /);
  assert.match(result.stdout, /mission M1/);
});

test('CLI --help, bad options, and non-repo paths', async (t) => {
  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--repo/);
  assert.match(help.stdout, /--state/);

  const unknown = runCli(['--nope']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option/);

  const missingValue = runCli(['--repo']);
  assert.equal(missingValue.status, 2);

  const outside = mkdtempSync(path.join(tmpdir(), 'dsh-tower-doctor-plain-'));
  t.after(() => {
    if (outside.startsWith(path.join(tmpdir(), 'dsh-tower-doctor-plain-'))) rmSync(outside, { recursive: true, force: true });
  });
  const notARepo = runCli(['--repo', outside]);
  assert.equal(notARepo.status, 2);
  assert.match(notARepo.stdout, /REPO_INVALID/);
});

test('a real review_failed mission is recognized and fully Git-checked (exit 0)', async (t) => {
  const repo = makeRepo(t);
  commit(repo, 'README.md', '# doctor\n', 'initial');
  const core = new TowerCore({ cwd: repo });
  await core.init();
  const mission = await core.addMission({ id: 'M1', title: 'review error', description: 'The reviewer run fails.' });
  const worker = await core.beginSpawn({ missionId: mission.id, role: 'worker' });
  commit(worker.mission.worktree, 'work.txt', 'work\n', 'worker work');
  await core.completeSpawn(worker.runId, { stopReason: 'completed', output: 'done' });
  const review = await core.beginSpawn({ missionId: mission.id, role: 'reviewer' });
  const failed = await core.completeSpawn(review.runId, { stopReason: 'error', diagnostic: '429 rate limited' });
  assert.equal(failed.status, 'review_failed');

  // Structural validation must accept the status and let Git diagnostics run.
  const commands = [];
  const report = await collectFindings({
    repo,
    execGit: async (cwd, args) => {
      commands.push(args.join(' '));
      return await captureGit(cwd, args);
    },
  });
  assert.deepEqual(report.findings, []);
  assert.ok(commands.some((command) => command.startsWith('worktree list')), 'worktree registration is checked');
  assert.ok(commands.some((command) => command.startsWith('rev-parse')), 'Git revisions are checked');

  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.findings, []);
  assert.ok(result.summary.checksPassed > 0);
  assert.equal(result.json.baseTip, git(repo, 'rev-parse', 'HEAD'));

  // review_failed is non-terminal, so its worktree is still required.
  git(repo, 'worktree', 'remove', failed.worktree);
  const missing = await runDoctor(['--repo', repo]);
  assert.equal(missing.exitCode, 2);
  assert.deepEqual(codes(missing.findings), ['WORKTREE_DIR_MISSING']);
  assert.equal(missing.findings[0].mission, 'M1');
});

// —— git metadata ownership / writability (GIT_METADATA_*) ——

/** POSIX uid of the test process, or undefined on platforms without one. */
function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

test('repo with consistent owners and writable metadata produces no GIT_METADATA findings', async (t) => {
  const repo = makeRepo(t);
  writeState(repo, healthyState(repo));
  const result = await runDoctor(['--repo', repo]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.findings, []);
  assert.ok(result.findings.every((item) => !item.code.startsWith('GIT_METADATA_')));
  assert.ok(result.summary.checksPassed > 0);

  // Also clean next to an unrelated warning: metadata checks stay silent.
  git(repo, 'worktree', 'add', '-b', 'tower/orphan', path.join(repo, '.dsh-tower', 'worktrees', 'orphan'), git(repo, 'rev-parse', 'HEAD'));
  const warned = await runDoctor(['--repo', repo]);
  assert.equal(warned.exitCode, 1);
  assert.deepEqual(codes(warned.findings), ['ORPHAN_WORKTREE']);
  assert.ok(warned.findings.every((item) => !item.code.startsWith('GIT_METADATA_')));
});

test('foreign-owned git metadata entries are a GIT_METADATA_FOREIGN_OWNER warning (exit 1)', async (t) => {
  // Skipped on non-POSIX platforms: without process.getuid() the doctor
  // cannot compare owners and skips the ownership scan entirely.
  const uid = currentUid();
  if (uid === undefined) return;

  const repo = makeRepo(t);
  writeState(repo, healthyState(repo));
  // chown to another user needs root, so simulate by injecting the uid the
  // scan compares against: with uid+1 every real entry counts as foreign.
  const result = await runDoctor(['--repo', repo], { currentUid: uid + 1 });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(codes(result.findings), ['GIT_METADATA_FOREIGN_OWNER']);
  const item = result.findings[0];
  assert.equal(item.severity, 'warning');
  assert.ok(item.count > 0);
  assert.ok(item.sample.length <= 10);
  assert.equal(item.sample.length, Math.min(item.count, 10));
  assert.ok(item.sample.every((sample) => path.isAbsolute(sample) && sample.startsWith(repo)));
  assert.deepEqual(item.ownerUids, [uid]);
  assert.equal(item.truncated, false);
  assert.match(item.message, /sudo chown -R \$\(id -u\):\$\(id -g\)/);
  assert.match(item.message, new RegExp(`\\b${item.count}\\b`));

  // Real (non-injected) run stays clean: the entries are truly ours.
  const real = await runDoctor(['--repo', repo]);
  assert.equal(real.exitCode, 0);
  assert.deepEqual(real.findings, []);
});

test('unwritable .git/objects is a GIT_METADATA_NOT_WRITABLE error (exit 2)', async (t) => {
  // Skipped on non-POSIX platforms (chmod semantics differ) and under root
  // (uid 0): root bypasses permission checks, so 0o500 still looks writable.
  const uid = currentUid();
  if (uid === undefined || uid === 0) return;

  const repo = makeRepo(t);
  writeState(repo, healthyState(repo));
  const objects = path.join(repo, '.git', 'objects');
  chmodSync(objects, 0o500);
  try {
    const result = await runDoctor(['--repo', repo]);
    assert.equal(result.exitCode, 2);
    assert.deepEqual(codes(result.findings), ['GIT_METADATA_NOT_WRITABLE']);
    const item = result.findings[0];
    assert.equal(item.severity, 'error');
    assert.equal(item.path, objects);
    assert.equal(item.label, 'git object store');
    assert.match(item.message, /sudo chown -R \$\(id -u\):\$\(id -g\)/);
    assert.match(item.message, /chmod u\+w/);
    assert.equal(result.summary.errors, 1);
    assert.equal(result.summary.warnings, 0);

    // The doctor never "fixes" anything: the mode we broke is still broken.
    assert.equal(statSync(objects).mode & 0o777, 0o500);
  } finally {
    chmodSync(objects, 0o755); // restore so the tmpdir cleanup can unlink
  }
});

test('ownership scan caps its budget and reports truncation', async (t) => {
  // Skipped on non-POSIX platforms (see the foreign-owner test above).
  const uid = currentUid();
  if (uid === undefined) return;

  const repo = makeRepo(t);
  writeState(repo, healthyState(repo));
  const result = await runDoctor(['--repo', repo], { currentUid: uid + 1, gitMetadataScanLimit: 3 });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(codes(result.findings), ['GIT_METADATA_FOREIGN_OWNER']);
  const item = result.findings[0];
  assert.equal(item.count, 3);
  assert.equal(item.sample.length, 3);
  assert.equal(item.truncated, true);
  assert.match(item.message, /truncated after 3 entries/);
  assert.equal(result.summary.warnings, 1);
  assert.equal(result.summary.errors, 0);
});

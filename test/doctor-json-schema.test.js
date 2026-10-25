import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runDoctor } from '../scripts/tower-doctor.mjs';
import { git, makeRepo } from './helpers.js';

const SCRIPT = fileURLToPath(new URL('../scripts/tower-doctor.mjs', import.meta.url));
const TOP_LEVEL_KEYS = ['baseBranch', 'baseTip', 'findings', 'repo', 'statePath', 'summary'];
const SUMMARY_KEYS = ['checksPassed', 'errors', 'exitCode', 'warnings'];
const KNOWN_FINDING_CODES = new Set([
  'BASE_BRANCH_MISSING',
  'BASE_COMMIT_UNKNOWN',
  'BASE_COMMIT_DRIFT',
  'BASE_COMMIT_DIVERGED',
  'BASE_COMPARE_FAILED',
  'GIT_METADATA_FOREIGN_OWNER',
  'GIT_METADATA_NOT_WRITABLE',
  'MERGE_COMMIT_NOT_IN_BASE',
  'MERGE_COMMIT_UNKNOWN',
  'MERGE_RECORD_MISSING',
  'MISSION_BASE_UNKNOWN',
  'MISSION_BRANCH_MISSING',
  'MISSION_DEP_UNKNOWN',
  'MISSION_DUPLICATE',
  'MISSION_FIELD_INVALID',
  'ORPHAN_WORKTREE',
  'REPO_INVALID',
  'REPO_MISMATCH',
  'RUNNING_RECORD_FINISHED',
  'RUNNING_RECORD_MISSING',
  'STATE_CORRUPT',
  'STATE_FIELD_INVALID',
  'STATE_MISSING',
  'STATE_READ_FAILED',
  'STATE_VERSION',
  'TEARDOWN_INCOMPLETE',
  'WORKTREE_BRANCH_MISMATCH',
  'WORKTREE_DIR_MISSING',
  'WORKTREE_LIST_FAILED',
  'WORKTREE_SCAN_FAILED',
  'WORKTREE_STILL_REGISTERED',
  'WORKTREE_UNREGISTERED',
]);

function makeFixture(t, mutate = () => {}) {
  const repo = makeRepo(t);
  const statePath = path.join(repo, '.dsh-tower', 'state.json');
  const baseCommit = git(repo, 'rev-parse', 'HEAD');
  const state = {
    version: 1,
    repoRoot: repo,
    baseBranch: 'main',
    baseCommit,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    missions: [],
  };
  mutate(state, { repo, baseCommit });
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { repo, statePath };
}

function runCli(repo) {
  const result = spawnSync(process.execPath, [SCRIPT, '--repo', repo, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

function assertFindingSchema(item) {
  assert.equal(item === null || typeof item !== 'object' || Array.isArray(item), false, 'finding must be an object');
  assert.equal(typeof item.code, 'string');
  assert.ok(KNOWN_FINDING_CODES.has(item.code), `unknown doctor finding code: ${item.code}`);
  assert.ok(item.severity === 'warning' || item.severity === 'error');
  assert.equal(typeof item.message, 'string');
  assert.ok(item.message.length > 0);
  if (Object.hasOwn(item, 'mission')) assert.equal(typeof item.mission, 'string');
  if (Object.hasOwn(item, 'role')) assert.ok(item.role === 'worker' || item.role === 'reviewer');
  if (Object.hasOwn(item, 'path')) assert.equal(typeof item.path, 'string');
  // p3: no current finding emits `details`; pin its intended object shape if present.
  if (Object.hasOwn(item, 'details')) {
    assert.equal(item.details === null || typeof item.details !== 'object' || Array.isArray(item.details), false);
  }
}

function assertJsonContract(payload, expectedExitCode) {
  // p3: the current payload has no top-level version/ok/checksPassed fields;
  // checksPassed is part of summary. Keep this key set exact for consumers.
  assert.deepEqual(Object.keys(payload).sort(), [...TOP_LEVEL_KEYS].sort());
  assert.equal(typeof payload.repo, 'string');
  assert.ok(path.isAbsolute(payload.repo));
  assert.equal(typeof payload.statePath, 'string');
  assert.ok(path.isAbsolute(payload.statePath));
  assert.equal(typeof payload.baseBranch, 'string');
  assert.ok(payload.baseTip === null || typeof payload.baseTip === 'string');
  assert.ok(Array.isArray(payload.findings));

  assert.deepEqual(Object.keys(payload.summary).sort(), [...SUMMARY_KEYS].sort());
  for (const field of SUMMARY_KEYS) {
    assert.ok(Number.isSafeInteger(payload.summary[field]), `summary.${field} must be a safe integer`);
    assert.ok(payload.summary[field] >= 0, `summary.${field} must be non-negative`);
  }
  assert.ok(payload.summary.checksPassed > 0);
  assert.ok([0, 1, 2].includes(payload.summary.exitCode));

  const warnings = payload.findings.filter((item) => item.severity === 'warning').length;
  const errors = payload.findings.filter((item) => item.severity === 'error').length;
  assert.equal(payload.summary.warnings, warnings);
  assert.equal(payload.summary.errors, errors);
  assert.equal(payload.findings.length, warnings + errors);
  const derivedExitCode = errors > 0 ? 2 : warnings > 0 ? 1 : 0;
  assert.equal(payload.summary.exitCode, derivedExitCode);
  assert.equal(payload.summary.exitCode, expectedExitCode);
  if (errors > 0) assert.equal(payload.summary.exitCode, 2, 'errors must mark the run as failed');
  for (const item of payload.findings) assertFindingSchema(item);
}

const cases = [
  {
    name: 'clean findings exit 0',
    expectedExitCode: 0,
    expectedCodes: [],
    mutate: undefined,
  },
  {
    name: 'warning-only findings exit 1',
    expectedExitCode: 1,
    expectedCodes: ['REPO_MISMATCH'],
    mutate(state, { repo }) {
      state.repoRoot = path.join(repo, 'recorded-elsewhere');
    },
  },
  {
    name: 'errors take precedence and exit 2',
    expectedExitCode: 2,
    expectedCodes: ['REPO_MISMATCH', 'BASE_BRANCH_MISSING', 'WORKTREE_DIR_MISSING', 'RUNNING_RECORD_MISSING'],
    mutate(state, { repo, baseCommit }) {
      state.repoRoot = path.join(repo, 'recorded-elsewhere');
      state.baseBranch = 'missing-base';
      state.missions.push({
        id: 'M1',
        title: 'missing review record',
        branch: 'main',
        worktree: path.join(repo, '.dsh-tower', 'worktrees', 'm1'),
        baseCommit,
        status: 'review_running',
        revision: 1,
        dependsOn: [],
        scope: [],
        worktreeRemoved: false,
      });
    },
  },
];

for (const fixture of cases) {
  test(`--json schema and exit-code contract: ${fixture.name}`, async (t) => {
    const { repo, statePath } = makeFixture(t, fixture.mutate);
    const stateBefore = readFileSync(statePath, 'utf8');
    const result = await runDoctor(['--repo', repo, '--json']);

    assert.equal(result.usageError, false);
    assert.equal(result.exitCode, fixture.expectedExitCode);
    assert.equal(result.summary.exitCode, result.exitCode);
    assert.deepEqual(result.findings, result.json.findings);
    assert.deepEqual(result.findings.map((item) => item.code), fixture.expectedCodes);
    assert.equal(result.output, `${JSON.stringify(result.json, null, 2)}\n`);
    assertJsonContract(result.json, fixture.expectedExitCode);

    const cli = runCli(repo);
    assert.equal(cli.status, fixture.expectedExitCode);
    assert.equal(cli.stderr, '', 'valid --json runs keep diagnostics inside the JSON payload');
    const cliPayload = JSON.parse(cli.stdout);
    assert.deepEqual(cliPayload, result.json);
    assertJsonContract(cliPayload, fixture.expectedExitCode);
    assert.equal(readFileSync(statePath, 'utf8'), stateBefore, 'doctor must not modify state');

    if (fixture.expectedExitCode === 2) {
      const roles = cliPayload.findings.flatMap((item) => item.role === undefined ? [] : [item.role]);
      assert.deepEqual(roles, ['reviewer']);
      assert.ok(cliPayload.findings.some((item) => typeof item.mission === 'string'));
      assert.ok(cliPayload.findings.some((item) => typeof item.path === 'string'));
    }
  });
}

test('--json output is byte-stable across repeated read-only runs', async (t) => {
  const { repo, statePath } = makeFixture(t, (state, { repo: root }) => {
    state.repoRoot = path.join(root, 'recorded-elsewhere');
  });
  const stateBefore = readFileSync(statePath, 'utf8');
  const args = ['--repo', repo, '--json'];
  const first = await runDoctor(args);
  const second = await runDoctor(args);
  assert.deepEqual(second.json, first.json);
  assert.equal(second.output, first.output);

  const firstCli = runCli(repo);
  const secondCli = runCli(repo);
  assert.equal(firstCli.status, 1);
  assert.equal(secondCli.status, 1);
  assert.equal(firstCli.stderr, '');
  assert.equal(secondCli.stderr, '');
  assert.equal(secondCli.stdout, firstCli.stdout);
  assert.deepEqual(JSON.parse(secondCli.stdout), first.json);
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);
});

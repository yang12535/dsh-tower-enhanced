/**
 * Error-code contract tests.
 *
 * Closes the coverage gap from the consistency audit
 * (docs/review-consistency-0.3.1.md, section B): before this file, the
 * `errorDetails` export was never executed by any test, and dozens of
 * error/finding codes were only asserted behaviorally — never by their
 * literal value. Renaming a code (say `MISSION_NOT_FOUND` ->
 * `MISSION_MISSING`) left the whole suite green while every caller that
 * branches on `error.code` silently broke.
 *
 * This file pins the contract three ways:
 *
 * 1. **Inventory guard (bidirectional).** `extractCodeInventory()` parses
 *    lib/core.js, lib/errors.js, lib/git.js, lib/projection.js,
 *    lib/runtime.js, and lib/store.js at test time and collects every code
 *    literal that lib *originates*: the first argument of `TowerError(...)`,
 *    the second argument of `assertTower(...)`, the third argument (and the
 *    default parameter) of `assertClean(...)`, the merge-gate finding codes
 *    pushed as blocks, and the two documented fallback codes (`INTERNAL_ERROR`
 *    in errorDetails, `MODEL_CATALOG_FAILED` in providerCatalogError). That
 *    set must equal `PINNED_LIB_CODES` exactly — a new or renamed lib code
 *    without a matching list entry fails here, and a stale list entry fails
 *    too. lib/client.js and lib/index.js are not scanned: they only render
 *    codes that originate in the six modules above.
 *
 * 2. **Per-value triggers.** Every pinned code is produced by a real call
 *    through the public API (`TowerCore`, `TowerRuntime`, `TowerStore`, the
 *    git helpers, and the release script), and the literal value is asserted:
 *    `error.code === '<CODE>'` for thrown codes, `block.code === '<CODE>'`
 *    for merge-gate finding codes (they are reported, not thrown), and the
 *    `code` field for the two diagnostic-fallback results. Codes that cannot
 *    be produced through the public API live in `UNREACHABLE` with a written
 *    reason — nothing is skipped silently.
 *
 * 3. **Coverage guard.** The final test compares the codes actually asserted
 *    against the pinned list: a code without a trigger (or whitelist entry)
 *    fails, and so does a trigger for a code that no longer exists.
 */

import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TowerCore } from '../lib/core.js';
import { errorDetails, TowerError } from '../lib/errors.js';
import { currentBranch, gitOut, runGit } from '../lib/git.js';
import { TowerRuntime } from '../lib/runtime.js';
import { TowerStore } from '../lib/store.js';
import { acquireReleaseLock, applyPlan, computePlan, ReleaseError } from '../scripts/release.mjs';
import { addAndRunWorker, approve, commitFile, git, initializedCore, makeRepo, writeDirty } from './helpers.js';

// ---------------------------------------------------------------------------
// The pinned inventory. This list MUST stay in lockstep with lib: the first
// test below fails in both directions the moment either side drifts.
// ---------------------------------------------------------------------------

const PINNED_LIB_CODES = [
  'AGENT_BUSY',
  'AGENT_NOT_RUNNING',
  'ARGUMENT_INVALID',
  'BASE_CONFLICT',
  'BASE_DIRTY',
  'BASE_MISMATCH',
  'CALLING_AGENT_REQUIRED',
  'CONFIG_INVALID',
  'DEPENDENCIES_NOT_MERGED',
  'DEPENDENCY_CYCLE',
  'DEPENDENCY_INVALID',
  'DETACHED_HEAD',
  'GIT_ABORTED',
  'GIT_ANCESTRY_FAILED',
  'GIT_FAILED',
  'GIT_UNEXPECTED_EXIT',
  'INTERNAL_ERROR',
  'MAX_TOKENS_INVALID',
  'MISSION_ARTIFACT_CONFLICT',
  'MISSION_EXISTS',
  'MISSION_ID_INVALID',
  'MISSION_MERGED',
  'MISSION_NOT_EDITABLE',
  'MISSION_NOT_FOUND',
  'MISSION_TERMINAL',
  'MODEL_CATALOG_FAILED',
  'MODEL_ROUTE_INCOMPLETE',
  'MODEL_ROUTE_NOT_ALLOWED',
  'MODEL_ROUTE_REQUIRED',
  'RUN_NOT_FOUND',
  'NO_CHANGE',
  'NO_CLEAN_REVIEW',
  'NOT_APPROVED',
  'OUT_OF_SCOPE',
  'REPO_CHANGED',
  'REPO_MISMATCH',
  'REPO_ROOT_INVALID',
  'REVIEW_BASE_STALE',
  'REVIEW_START_BLOCKED',
  'REVIEW_TIP_STALE',
  'RUNTIME_DISPOSED',
  'SCOPE_INVALID',
  'STATE_DIRECTORY_INVALID',
  'STATE_INVALID',
  'STALE_BASE',
  'TOWER_NOT_INITIALIZED',
  'WORKER_START_BLOCKED',
  'WORKSPACE_BUSY',
  'WORKTREE_BRANCH_MISMATCH',
  'WORKTREE_DIRTY',
  'WORKTREE_PATH_INVALID',
  'WORKTREE_REMOVED',
];

/**
 * Codes thrown by scripts/release.mjs's ReleaseError that the audit named
 * explicitly. They are outside the lib inventory guard (the release script
 * has its own error class and its codes are guarded value-by-value by
 * test/release*.test.js); they are still triggered for real below so the
 * two literals named by the audit are pinned by this file too.
 */
const SCRIPT_PINNED_CODES = ['RELEASE_LOCKED', 'RELEASE_PLAN_STALE'];

/**
 * Pinned codes with no reachable public-API trigger. Every entry needs a
 * concrete reason; the final guard fails if an entry goes stale.
 */
const UNREACHABLE = new Map([
  ['WORKER_START_BLOCKED', 'beginSpawn rejects TERMINAL_STATUSES as MISSION_TERMINAL and ACTIVE_STATUSES as AGENT_BUSY before this guard, and WORKER_RESTARTABLE lists every remaining mission status core/store can assign (pending, worker_completed, worker_failed, review_failed, changes_requested, approved, rebase_blocked, merge_blocked), so the guard is unreachable defense'],
  ['GIT_ANCESTRY_FAILED', 'isAncestor resolves runGit only for exit codes {0,1} and returns on both; runGit rejects every other exit code earlier as GIT_FAILED (or GIT_ABORTED when the signal is aborted), so the throw site after resolution is unreachable defense'],
]);

// ---------------------------------------------------------------------------
// Source extraction for the inventory guard.
// ---------------------------------------------------------------------------

const LIB_FILES = ['core.js', 'errors.js', 'git.js', 'projection.js', 'runtime.js', 'store.js'];
const LIB_DIRECTORY = fileURLToPath(new URL('../lib', import.meta.url));
const CODE_LITERAL = /'([A-Z][A-Z0-9_]+)'/g;

const libSource = (name) => readFileSync(path.join(LIB_DIRECTORY, name), 'utf8');

/**
 * Bodies (the text between the outer parentheses) of every `name(...)` call
 * site in `source`. Function definitions count as call sites, which is what
 * makes assertClean's `code = 'WORKTREE_DIRTY'` default visible to the scan.
 * Quoted regions ('...'/"..."/`...`) are skipped opaquely, so parentheses and
 * commas inside messages or template literals never break the balance.
 */
function callBodies(source, name) {
  const bodies = [];
  const opener = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
  for (let match = opener.exec(source); match !== null; match = opener.exec(source)) {
    let depth = 1;
    let quote = null;
    const start = match.index + match[0].length;
    let end = start;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if (quote !== null) {
        if (character === '\\') end += 1;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === "'" || character === '"' || character === '`') quote = character;
      else if (character === '(' || character === '[' || character === '{') depth += 1;
      else if (character === ')' || character === ']' || character === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(source.slice(start, end));
    opener.lastIndex = end + 1;
  }
  return bodies;
}

/** Split one call body on its top-level commas, ignoring quoted regions. */
function topLevelArguments(body) {
  const arguments_ = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote !== null) {
      current += character;
      if (character === '\\') {
        current += body[index + 1] ?? '';
        index += 1;
      } else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      current += character;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') depth -= 1;
    if (character === ',' && depth === 0) {
      arguments_.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  arguments_.push(current);
  return arguments_;
}

const literalsIn = (text) => [...text.matchAll(CODE_LITERAL)].map((match) => match[1]);

/** code -> lib sites that originate it (throw sites, gate blocks, fallbacks). */
function extractCodeInventory() {
  const sites = new Map();
  const record = (code, site) => {
    const at = sites.get(code) ?? [];
    at.push(site);
    sites.set(code, at);
  };
  for (const name of LIB_FILES) {
    const source = libSource(name);
    for (const body of callBodies(source, 'TowerError')) {
      for (const code of literalsIn(topLevelArguments(body)[0] ?? '')) record(code, `${name}: TowerError`);
    }
    for (const body of callBodies(source, 'assertTower')) {
      for (const code of literalsIn(topLevelArguments(body)[1] ?? '')) record(code, `${name}: assertTower`);
    }
    for (const body of callBodies(source, 'assertClean')) {
      for (const code of literalsIn(topLevelArguments(body)[2] ?? '')) record(code, `${name}: assertClean code`);
    }
    for (const match of source.matchAll(/blocks\.push\(\s*(?:'([A-Z][A-Z0-9_]+)'|\{\s*code:\s*'([A-Z][A-Z0-9_]+)')/g)) {
      record(match[1] ?? match[2], `${name}: merge-gate block`);
    }
  }
  // Documented fallback codes that lib returns instead of throwing.
  for (const match of libSource('errors.js').matchAll(/return \{ code: '([A-Z][A-Z0-9_]+)'/g)) {
    record(match[1], 'errors.js: errorDetails fallback');
  }
  for (const match of libSource('runtime.js').matchAll(/\? error\.code : '([A-Z][A-Z0-9_]+)'/g)) {
    record(match[1], 'runtime.js: providerCatalogError fallback');
  }
  return sites;
}

// ---------------------------------------------------------------------------
// Trigger registry. Every test below registers the codes it pinned by value;
// the final guard compares that registry against the pinned inventory.
// ---------------------------------------------------------------------------

const asserted = new Map();

/** Run a real call that must reject with a TowerError carrying exactly `code`. */
async function expectCode(code, how, run) {
  let error;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  const seen = error === undefined ? 'no error at all' : `${error?.name}(${error?.code ?? 'no code'}): ${error?.message}`;
  assert.ok(error instanceof TowerError, `${how}: must throw a TowerError, saw ${seen}`);
  assert.equal(error.code, code, `${how}: error.code must be pinned by value`);
  assert.equal(error.name, 'TowerError');
  assert.ok(typeof error.message === 'string' && error.message.length > 0, `${how}: the TowerError must carry a message`);
  asserted.set(code, how);
}

/** Run a real call that must reject with the release script's ReleaseError. */
async function expectReleaseCode(code, how, run) {
  let error;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  const seen = error === undefined ? 'no error at all' : `${error?.name}(${error?.code ?? 'no code'}): ${error?.message}`;
  assert.ok(error instanceof ReleaseError, `${how}: must throw a ReleaseError, saw ${seen}`);
  assert.equal(error.code, code, `${how}: error.code must be pinned by value`);
  asserted.set(code, how);
}

/** Pin a merge-gate finding code: gate.blocks must carry a block with that code. */
function expectBlock(code, gate, how) {
  const block = gate.blocks.find((candidate) => candidate.code === code);
  assert.ok(block, `${how}: gate must report a ${code} block; got ${JSON.stringify(gate.blocks.map((entry) => entry.code))}`);
  assert.ok(typeof block.message === 'string' && block.message.length > 0, `${code} block must carry a message`);
  asserted.set(code, how);
}

/** Pin a code that lib returns as a diagnostic field instead of throwing. */
function expectField(code, actual, how) {
  assert.equal(actual, code, `${how}: the reported code must be pinned by value`);
  asserted.set(code, how);
}

const statePath = (repo) => path.join(repo, '.dsh-tower', 'state.json');

function overwriteState(repo, state) {
  writeFileSync(statePath(repo), `${JSON.stringify(state, null, 2)}\n`);
}

const readState = (repo) => JSON.parse(readFileSync(statePath(repo), 'utf8'));

// ---------------------------------------------------------------------------
// Guard 1: the pinned list mirrors lib, in both directions.
// ---------------------------------------------------------------------------

test('inventory guard: PINNED_LIB_CODES mirrors every code literal lib throws or reports', () => {
  const extracted = [...extractCodeInventory().keys()].sort();
  const pinned = [...PINNED_LIB_CODES].sort();
  const onlyInLib = extracted.filter((code) => !pinned.includes(code));
  const onlyPinned = pinned.filter((code) => !extracted.includes(code));
  assert.deepEqual(extracted, pinned, [
    'lib error/finding codes and PINNED_LIB_CODES drifted apart:',
    `- only in lib (add to PINNED_LIB_CODES and trigger them below, or whitelist with a reason): ${onlyInLib.join(', ') || '(none)'}`,
    `- only pinned (stale entries to remove): ${onlyPinned.join(', ') || '(none)'}`,
  ].join('\n'));
  assert.equal(new Set(PINNED_LIB_CODES).size, PINNED_LIB_CODES.length, 'PINNED_LIB_CODES must not repeat');
});

// ---------------------------------------------------------------------------
// errorDetails: direct branch coverage (audit: the export had zero coverage).
// ---------------------------------------------------------------------------

test('errorDetails returns the exact shape for every error form it accepts', async (t) => {
  // Branch 1: a TowerError carrying details keeps them under a details key.
  assert.deepEqual(
    errorDetails(new TowerError('MISSION_NOT_FOUND', 'mission M9 does not exist', { dependsOn: ['M1'] })),
    { code: 'MISSION_NOT_FOUND', message: 'mission M9 does not exist', details: { dependsOn: ['M1'] } },
  );
  // Branch 2: a TowerError without details has no details key at all.
  assert.deepEqual(
    errorDetails(new TowerError('RUN_NOT_FOUND', 'Tower run r-1 does not exist')),
    { code: 'RUN_NOT_FOUND', message: 'Tower run r-1 does not exist' },
  );
  // Branch 3: a plain Error degrades to the INTERNAL_ERROR fallback code.
  assert.deepEqual(errorDetails(new Error('plain failure')), { code: 'INTERNAL_ERROR', message: 'plain failure' });
  expectField('INTERNAL_ERROR', errorDetails(new Error('plain failure')).code, 'errorDetails(plain Error) degrades to INTERNAL_ERROR');
  // Branch 4: a non-error value is stringified, still with the fallback code.
  assert.deepEqual(errorDetails('a raw string'), { code: 'INTERNAL_ERROR', message: 'a raw string' });
  // Integration: a TowerError really thrown by the core flows through unchanged.
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  let thrown;
  try {
    await core.mission('MISSING');
  } catch (caught) {
    thrown = caught;
  }
  assert.ok(thrown instanceof TowerError);
  assert.deepEqual(errorDetails(thrown), { code: 'MISSION_NOT_FOUND', message: 'mission MISSING does not exist' });
});

// ---------------------------------------------------------------------------
// Trigger groups. Store construction and the git layer need no tower state.
// ---------------------------------------------------------------------------

test('store construction pins REPO_ROOT_INVALID and STATE_DIRECTORY_INVALID', async () => {
  await expectCode('REPO_ROOT_INVALID', 'new TowerStore with a relative repoRoot', () => new TowerStore('relative/state'));
  await expectCode('STATE_DIRECTORY_INVALID', 'new TowerStore with an absolute stateDirectory', () => new TowerStore('/tmp/error-codes-not-a-repo', '/absolute/state'));
});

test('git helpers pin GIT_FAILED, GIT_ABORTED, DETACHED_HEAD, and GIT_UNEXPECTED_EXIT', async (t) => {
  const repo = makeRepo(t);
  await expectCode('GIT_FAILED', 'runGit with a failing reference', () => runGit(repo, ['rev-parse', '--verify', 'refs/heads/missing-branch']));
  await expectCode('GIT_ABORTED', 'runGit with an already-aborted signal', () => runGit(repo, ['status'], { signal: AbortSignal.abort() }));
  git(repo, 'checkout', '--detach');
  await expectCode('DETACHED_HEAD', 'currentBranch in a detached HEAD checkout', () => currentBranch(repo));
  await expectCode(
    'GIT_UNEXPECTED_EXIT',
    'gitOut when an allowed exit code still means failure',
    () => gitOut(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowedExitCodes: [0, 1] }),
  );
});

// ---------------------------------------------------------------------------
// init/open lifecycle codes.
// ---------------------------------------------------------------------------

test('init/open lifecycle pins TOWER_NOT_INITIALIZED, BASE_*, STATE_INVALID, and REPO_MISMATCH', async (t) => {
  const repo = makeRepo(t);
  await expectCode('TOWER_NOT_INITIALIZED', 'mission() before init', () => new TowerCore({ cwd: repo }).mission('M1'));
  const core = await initializedCore(repo); // anchors the tower to main
  await expectCode('BASE_MISMATCH', 'init({baseBranch}) while a different branch is checked out', () => core.init({ baseBranch: 'feature-x' }));
  writeDirty(repo, 'dirty.txt', 'uncommitted\n');
  await expectCode('BASE_DIRTY', 'init() with uncommitted files in the base checkout', () => new TowerCore({ cwd: repo }).init());
  rmSync(path.join(repo, 'dirty.txt'));
  git(repo, 'checkout', '-b', 'other-base');
  await expectCode('BASE_CONFLICT', 'init({baseBranch}) against a tower anchored to another branch', () => new TowerCore({ cwd: repo }).init({ baseBranch: 'other-base' }));
  const pristine = readState(repo);
  writeFileSync(statePath(repo), '{ this is not json');
  await expectCode('STATE_INVALID', 'status() with an unparseable state file', () => core.status());
  overwriteState(repo, { ...pristine, repoRoot: '/tmp/error-codes-foreign-repository' });
  await expectCode('REPO_MISMATCH', 'open() when the state belongs to another repository', () => new TowerCore({ cwd: repo }).open());
});

test('a repointed cwd symlink pins REPO_CHANGED', async (t) => {
  const first = makeRepo(t);
  const second = makeRepo(t);
  // TowerCore freezes `cwd` at construction, but every init()/open() call
  // re-resolves it through `git rev-parse --show-toplevel`. A symlink is the
  // one way to make an unchanged `cwd` point at a different repository: the
  // store is anchored to the first root, then the link is repointed at a
  // second live repo, so the identity check must fire instead of silently
  // operating on the wrong repository.
  const holder = mkdtempSync(path.join(tmpdir(), 'dsh-tower-symlink-'));
  const link = path.join(holder, 'current');
  t.after(() => {
    // Exact cleanup: drop the symlink itself, then the empty holder. Neither
    // step recurses into either repository.
    if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() === true) unlinkSync(link);
    rmSync(holder, { recursive: true, force: true });
  });
  symlinkSync(first, link, 'dir');
  const core = new TowerCore({ cwd: link });
  const initialized = await core.init();
  assert.equal(realpathSync(link), realpathSync(first), 'the setup must resolve cwd through the symlink before init');
  assert.equal(initialized.repoRoot, realpathSync(first), 'init() must anchor the store to the first repository');
  unlinkSync(link);
  symlinkSync(second, link, 'dir');
  assert.equal(realpathSync(link), realpathSync(second), 'the setup must repoint cwd at the second repository');
  await expectCode('REPO_CHANGED', 'open() after the cwd symlink was repointed at another repository', () => core.open());
});

// ---------------------------------------------------------------------------
// addMission / editMission validation codes.
// ---------------------------------------------------------------------------

test('mission metadata edits pin the validation codes by value', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await expectCode('ARGUMENT_INVALID', 'addMission with a blank description', () => core.addMission({ title: 'Title', description: '   ' }));
  await expectCode('SCOPE_INVALID', 'addMission with an absolute scope pattern', () => core.addMission({ title: 'Title', description: 'Description.', scope: ['/absolute/path'] }));
  await core.addMission({ id: 'M1', title: 'First', description: 'Exists.' });
  await expectCode('DEPENDENCY_INVALID', 'addMission with a repeated dependency', () => core.addMission({ title: 'Second', description: 'Depends twice.', dependsOn: ['M1', 'M1'] }));
  await expectCode('MISSION_ID_INVALID', 'addMission with a lowercase id', () => core.addMission({ id: 'm4', title: 'Third', description: 'Bad id.' }));
  await expectCode('MISSION_EXISTS', 'addMission with an id that already exists', () => core.addMission({ id: 'M1', title: 'Duplicate', description: 'Same id.' }));
  await core.addMission({ id: 'M2', title: 'Second', description: 'Depends on M1.', dependsOn: ['M1'] });
  await expectCode('DEPENDENCY_CYCLE', 'editMission closing the cycle M1 -> M2 -> M1', () => core.editMission({ missionId: 'M1', dependsOn: ['M2'] }));
  await expectCode('MISSION_NOT_FOUND', 'mission() for an unknown id', () => core.mission('MISSING'));
  await expectCode('RUN_NOT_FOUND', 'attachSpawn for an unknown run', () => core.attachSpawn('run-that-never-was', 'child-1'));
  await expectCode('AGENT_NOT_RUNNING', 'agentAddress when no worker run is attached', () => core.agentAddress('M1', 'worker'));
  // A pre-existing branch without a registered worktree cannot be reconciled.
  git(repo, 'branch', 'tower/m9');
  git(repo, 'checkout', 'tower/m9');
  commitFile(repo, 'stray.txt', 'pre-existing artifact\n', 'artifact commit');
  git(repo, 'checkout', 'main');
  await expectCode('MISSION_ARTIFACT_CONFLICT', 'addMission over a pre-existing unregistered branch', () => core.addMission({ id: 'M9', title: 'Conflict', description: 'Branch already exists.' }));
});

// ---------------------------------------------------------------------------
// Spawn-guard codes (beginSpawn) and the rebase dirty check.
// ---------------------------------------------------------------------------

test('spawn guards pin DEPENDENCIES_NOT_MERGED, MISSION_NOT_EDITABLE, AGENT_BUSY, REVIEW_START_BLOCKED, and MISSION_TERMINAL', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ id: 'M1', title: 'Lifecycle', description: 'Exercises the spawn guards.' });
  await core.addMission({ id: 'M2', title: 'Blocked dependency', description: 'Waits for M1.', dependsOn: ['M1'] });
  await expectCode('DEPENDENCIES_NOT_MERGED', 'beginSpawn(worker) while dependency M1 is still pending', () => core.beginSpawn({ missionId: 'M2', role: 'worker' }));
  const begun = await core.beginSpawn({ missionId: 'M1', role: 'worker' });
  await expectCode('MISSION_NOT_EDITABLE', 'editMission while the worker is running', () => core.editMission({ missionId: 'M1', title: 'Not allowed' }));
  await expectCode('AGENT_BUSY', 'beginSpawn while the worker is running', () => core.beginSpawn({ missionId: 'M1', role: 'worker' }));
  const failed = await core.completeSpawn(begun.runId, { stopReason: 'error', output: 'worker crashed' });
  assert.equal(failed.status, 'worker_failed');
  await expectCode('REVIEW_START_BLOCKED', 'beginSpawn(reviewer) for a mission whose worker failed', () => core.beginSpawn({ missionId: 'M1', role: 'reviewer' }));
  await core.abandon('M1');
  await expectCode('MISSION_TERMINAL', 'beginSpawn for an abandoned mission', () => core.beginSpawn({ missionId: 'M1', role: 'worker' }));
});

test('a zero-commit worker pins NO_CHANGE on the reviewer spawn', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ id: 'M1', title: 'No changes', description: 'Worker finishes without committing.' });
  const begun = await core.beginSpawn({ missionId: 'M1', role: 'worker' });
  const finished = await core.completeSpawn(begun.runId, { stopReason: 'completed', output: 'nothing to do' });
  assert.equal(finished.status, 'worker_completed');
  await expectCode('NO_CHANGE', 'beginSpawn(reviewer) when the tip equals the base', () => core.beginSpawn({ missionId: 'M1', role: 'reviewer' }));
});

test('a diverged pending mission pins STALE_BASE on the worker restart', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const mission = await core.addMission({ id: 'M1', title: 'Diverged', description: 'Tip leaves the advanced base behind.' });
  commitFile(mission.worktree, 'src/feature.txt', 'worker implementation\n');
  commitFile(repo, 'base-only.txt', 'base advanced\n');
  await expectCode('STALE_BASE', 'beginSpawn(worker) with commits outside the advanced base', () => core.beginSpawn({ missionId: 'M1', role: 'worker' }));
});

test('a stray branch in the worktree pins WORKTREE_BRANCH_MISMATCH', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const mission = await core.addMission({ id: 'M1', title: 'Stray', description: 'Worktree checked out elsewhere.' });
  commitFile(repo, 'base-only.txt', 'base advanced\n');
  git(mission.worktree, 'checkout', '-b', 'stray-branch');
  await expectCode('WORKTREE_BRANCH_MISMATCH', 'beginSpawn(worker) with the worktree on a foreign branch', () => core.beginSpawn({ missionId: 'M1', role: 'worker' }));
});

test('uncommitted worktree files pin WORKTREE_DIRTY on rebase', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core);
  writeDirty(mission.worktree, 'uncommitted.txt', 'dirt\n');
  await expectCode('WORKTREE_DIRTY', 'rebase() with uncommitted files in the worktree', () => core.rebase(mission.id));
});

// ---------------------------------------------------------------------------
// Merge-gate finding codes (reported on gate.blocks, not thrown) plus the
// terminal-mission codes.
// ---------------------------------------------------------------------------

test('an unreviewed completion pins NOT_APPROVED and NO_CLEAN_REVIEW gate blocks', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core);
  const gate = await core.mergeGate(mission.id);
  expectBlock('NOT_APPROVED', gate, 'mergeGate before any review');
  expectBlock('NO_CLEAN_REVIEW', gate, 'mergeGate before any review');
});

test('out-of-scope changes pin the OUT_OF_SCOPE gate block', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core, { scope: ['docs/**'], file: 'lib/outside-scope.js' });
  const gate = await core.mergeGate(mission.id);
  expectBlock('OUT_OF_SCOPE', gate, 'mergeGate with changes outside the declared scope');
});

test('a tip that moved past the review pins REVIEW_TIP_STALE', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core);
  await approve(core, mission.id);
  commitFile(mission.worktree, 'docs/extra.md', 'committed after approval\n');
  const gate = await core.mergeGate(mission.id);
  expectBlock('REVIEW_TIP_STALE', gate, 'mergeGate after the tip moved past the reviewed commit');
});

test('an advanced base pins REVIEW_BASE_STALE', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core);
  await approve(core, mission.id);
  commitFile(repo, 'base-moved.txt', 'base advanced\n');
  const gate = await core.mergeGate(mission.id);
  expectBlock('REVIEW_BASE_STALE', gate, 'mergeGate after the base advanced past the reviewed base');
});

test('an abandoned and torn-down mission pins the WORKTREE_REMOVED gate block', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ id: 'M1', title: 'Removed', description: 'Abandoned and torn down.' });
  await core.abandon('M1');
  await core.teardown({ missionId: 'M1' });
  const gate = await core.mergeGate('M1');
  // Both throw sites for this code (beginSpawn/rebase) are shadowed by
  // MISSION_TERMINAL: teardown only removes worktrees of terminal missions,
  // and terminal missions are rejected first. The gate finding is the one
  // form a caller can actually observe, so that is what is pinned here.
  expectBlock('WORKTREE_REMOVED', gate, 'mergeGate after abandon and teardown removed the worktree');
});

test('a merged mission pins MISSION_MERGED on abandon', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const { mission } = await addAndRunWorker(core);
  await approve(core, mission.id);
  const merged = await core.merge(mission.id);
  assert.equal(merged.merged, true);
  await expectCode('MISSION_MERGED', 'abandon() after a real merge', () => core.abandon(mission.id));
});

test('a corrupted worktree path pins WORKTREE_PATH_INVALID on teardown', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ id: 'M1', title: 'Corrupted', description: 'Worktree path replaced on disk.' });
  await core.abandon('M1');
  const state = readState(repo);
  state.missions[0].worktree = '/tmp/error-codes-outside-the-worktrees';
  overwriteState(repo, state);
  // Only reachable with a corrupted (or hostile) state file: store validation
  // requires just a non-empty string, and the guard exists precisely so
  // teardown refuses paths outside .dsh-tower/worktrees.
  await expectCode('WORKTREE_PATH_INVALID', 'teardown() with a worktree path outside the tower worktrees', () => core.teardown({ missionId: 'M1' }));
});

// ---------------------------------------------------------------------------
// Runtime-level codes (routing, configuration, ownership, disposal).
// ---------------------------------------------------------------------------

test('route resolution pins MODEL_ROUTE_*, MAX_TOKENS_INVALID, CONFIG_INVALID, and CALLING_AGENT_REQUIRED', async () => {
  const llm = { async resolveCallConfig(config) { return config; } };
  const signal = () => new AbortController().signal;
  const routed = { options: { provider: 'main-provider', model: 'main-smart', reasoningEffort: 'high', maxTokens: 4096 }, session: { header: {}, requestHeader: () => undefined } };
  const routeless = { options: {}, session: { header: {}, requestHeader: () => undefined } };
  await expectCode('MODEL_ROUTE_INCOMPLETE', 'resolveRoute with a provider but no model', () => new TowerRuntime({ llm }, {}).resolveRoute(routed, 'worker', { provider: 'solo' }, signal()));
  await expectCode('MAX_TOKENS_INVALID', 'resolveRoute with max_tokens 0', () => new TowerRuntime({ llm }, {}).resolveRoute(routed, 'worker', { max_tokens: 0 }, signal()));
  await expectCode('MODEL_ROUTE_REQUIRED', 'resolveRoute with agent options overridden but no route anywhere', () => new TowerRuntime({ llm }, {}).resolveRoute(routeless, 'worker', { max_tokens: 128 }, signal()));
  await expectCode(
    'MODEL_ROUTE_NOT_ALLOWED',
    'resolveRoute with a route outside tower.allowedModels',
    () => new TowerRuntime({ llm }, { allowedModels: [{ provider: 'allowed', model: 'one' }] }).resolveRoute(routed, 'worker', { provider: 'denied', model: 'two' }, signal()),
  );
  await expectCode('CONFIG_INVALID', 'TowerRuntime constructor with a non-array allowedModels', () => new TowerRuntime({}, { allowedModels: 'nope' }));
  await expectCode('CALLING_AGENT_REQUIRED', 'execute() without a calling agent', () => new TowerRuntime({ llm }, {}).execute({ action: 'status' }, { agent: null, signal: signal() }));
});

test('a failing provider catalog pins MODEL_CATALOG_FAILED', async () => {
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'broken-provider', name: 'Broken' }],
      async listModels() { throw new Error('adapter exploded'); },
      async resolveCallConfig(config) { return config; },
    },
  };
  const runtime = new TowerRuntime(ctx, {});
  const listing = await runtime.models({}, new AbortController().signal);
  expectField('MODEL_CATALOG_FAILED', listing.providers[0].error.code, 'models() aggregate listing with a failing provider catalog');
});

test('workspace ownership pins WORKSPACE_BUSY and disposal pins RUNTIME_DISPOSED', async (t) => {
  const repo = makeRepo(t);
  await initializedCore(repo);
  const ctx = {
    workingDirectory: { async ensure() { return repo; } },
    sessions: { async flush() {} },
    llm: { async resolveCallConfig(config) { return config; } },
    subagents: {},
    logger: { warn() {} },
  };
  const runtime = new TowerRuntime(ctx, {});
  const agent = { options: {}, session: { id: 'second-session', header: {}, requestHeader: () => undefined } };
  runtime.inFlight.set(repo, 'owner-session');
  await expectCode('WORKSPACE_BUSY', 'execute() from a second Session while another owns the workspace', () => runtime.execute({ action: 'status' }, { agent, signal: new AbortController().signal }));
  runtime.inFlight.delete(repo);
  await runtime.dispose();
  await expectCode('RUNTIME_DISPOSED', 'execute() after dispose()', () => runtime.execute({ action: 'status' }, { agent, signal: new AbortController().signal }));
});

// ---------------------------------------------------------------------------
// Release script codes named by the audit (ReleaseError, not TowerError).
// ---------------------------------------------------------------------------

test('the release script pins RELEASE_LOCKED and RELEASE_PLAN_STALE', async (t) => {
  const repo = makeRepo(t);
  writeFileSync(path.join(repo, 'package.json'), '{"name":"error-codes-test","version":"0.2.0"}\n');
  writeFileSync(path.join(repo, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n- feature\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'release fixture');
  // A lock owned by a live process (this one) must never be taken over.
  const lockPath = path.join(repo, '.git', 'release-apply.lock');
  const stale = Date.now() / 1000 - 600;
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() - 600_000, token: 'live-holder' }));
  utimesSync(lockPath, stale, stale);
  await expectReleaseCode('RELEASE_LOCKED', 'acquireReleaseLock with a live foreign holder', () => acquireReleaseLock(repo));
  const plan = computePlan({ repo, version: '0.3.0', date: '2026-02-03' });
  writeFileSync(path.join(repo, 'package.json'), '{"name":"error-codes-test","version":"0.2.1"}\n');
  await expectReleaseCode('RELEASE_PLAN_STALE', 'applyPlan after package.json drifted from the computed plan', () => applyPlan(plan));
});

// ---------------------------------------------------------------------------
// Guard 2: every pinned code was triggered by a real call or whitelisted.
// ---------------------------------------------------------------------------

test('coverage guard: every pinned code has a real trigger above or a documented whitelist entry', () => {
  for (const [code, reason] of UNREACHABLE) {
    assert.ok(typeof reason === 'string' && reason.length > 40, `whitelist entry ${code} must explain why it cannot be triggered`);
  }
  const pinnedSet = new Set(PINNED_LIB_CODES);
  for (const code of UNREACHABLE.keys()) {
    assert.ok(pinnedSet.has(code), `whitelisted ${code} no longer exists in lib; remove the stale whitelist entry`);
  }
  const expected = new Set([...PINNED_LIB_CODES.filter((code) => !UNREACHABLE.has(code)), ...SCRIPT_PINNED_CODES]);
  const triggered = [...asserted.keys()].sort();
  assert.deepEqual(triggered, [...expected].sort(), [
    'pinned codes and real triggers drifted apart:',
    `- pinned but never triggered (add a real trigger or a whitelist entry with a reason): ${[...expected].filter((code) => !asserted.has(code)).sort().join(', ') || '(none)'}`,
    `- triggered but not pinned (stale trigger to remove): ${triggered.filter((code) => !expected.has(code)).join(', ') || '(none)'}`,
  ].join('\n'));
});

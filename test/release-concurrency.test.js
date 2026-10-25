import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'release.mjs');
const VERSION = '0.3.0';
const DATE = '2026-02-03';
const RACE_ERROR_CODES = new Set([
  'RELEASE_LOCKED',
  'DIRTY_WORKTREE',
  'VERSION_NOT_GREATER',
  'VERSION_ALREADY_RELEASED',
]);

const PACKAGE_JSON = `${JSON.stringify({ name: 'release-concurrency-test-pkg', version: '0.2.0', type: 'module' }, null, 2)}\n`;
const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '- new feature',
  '',
  '## [0.2.0] - 2026-01-10',
  '',
  '### Fixed',
  '',
  '- old fix',
  '',
].join('\n');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  }).trim();
}

function makeRepo(t) {
  const repo = mkdtempSync(path.join(tmpdir(), 'dsh-release-concurrency-test-'));
  t.after(() => {
    if (repo.startsWith(path.join(tmpdir(), 'dsh-release-concurrency-test-'))) {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Release Concurrency Test');
  git(repo, 'config', 'user.email', 'release-concurrency@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(packagePath(repo), PACKAGE_JSON);
  writeFileSync(changelogPath(repo), CHANGELOG);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'initial');
  return repo;
}

function runCli(repo, { apply = true } = {}) {
  const args = [SCRIPT, '--repo', repo, '--version', VERSION, '--date', DATE, '--json'];
  if (apply) args.push('--apply');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function packagePath(repo) {
  return path.join(repo, 'package.json');
}

function changelogPath(repo) {
  return path.join(repo, 'CHANGELOG.md');
}

function tempArtifacts(repo) {
  const temporaryFiles = readdirSync(repo).filter((entry) => entry.includes('release-tmp') || entry.endsWith('.tmp'));
  const lockFiles = readdirSync(path.join(repo, '.git'))
    .filter((entry) => entry.startsWith('release-apply.'))
    .map((entry) => path.join('.git', entry));
  return [...temporaryFiles, ...lockFiles];
}

function parseError(result) {
  assert.notEqual(result.status, 0, 'the release process must fail');
  assert.equal(result.signal, null, 'the release process must exit normally rather than be killed');
  assert.equal(result.stdout, '', 'errors must not be mixed with success output');
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.ok, false);
  assert.equal(typeof payload.code, 'string');
  assert.notEqual(payload.code, '');
  assert.equal(typeof payload.message, 'string');
  assert.notEqual(payload.message, '');
  return payload;
}

function assertReleasedFiles(repo) {
  const packageRaw = readFileSync(packagePath(repo), 'utf8');
  const pkg = JSON.parse(packageRaw);
  assert.equal(pkg.version, VERSION, 'the version must be bumped exactly to the target');
  assert.equal(pkg.name, 'release-concurrency-test-pkg');
  assert.equal(pkg.type, 'module');

  const changelog = readFileSync(changelogPath(repo), 'utf8');
  const lines = changelog.split('\n');
  const unreleased = lines.indexOf('## [Unreleased]');
  const promoted = lines.indexOf(`## [${VERSION}] - ${DATE}`);
  const previous = lines.indexOf('## [0.2.0] - 2026-01-10');
  assert.notEqual(unreleased, -1);
  assert.notEqual(promoted, -1);
  assert.notEqual(previous, -1);
  assert.ok(unreleased < promoted && promoted < previous, 'Markdown release sections must remain ordered');
  assert.equal(lines.filter((line) => line === '## [Unreleased]').length, 1);
  assert.equal(lines.filter((line) => line === `## [${VERSION}] - ${DATE}`).length, 1, 'no duplicate release sections');
  assert.ok(lines.slice(promoted, previous).includes('- new feature'), 'the promoted Markdown content must survive');
  assert.ok(lines.slice(previous).includes('- old fix'), 'the previous Markdown release must survive');
  assert.deepEqual(tempArtifacts(repo), [], 'no temporary or half-written artifacts may remain');
}

test('two simultaneous apply processes have exactly one winner', async (t) => {
  const repo = makeRepo(t);

  // Start both children in the same turn and await them together. No sleeps or
  // retries: the loser must deterministically report a structured release error
  // when it observes the apply lock, dirty tree, or already-updated version.
  const results = await Promise.all([runCli(repo), runCli(repo)]);
  const successes = results.filter((result) => result.status === 0);
  const failures = results.filter((result) => result.status !== 0);
  assert.equal(
    successes.length,
    1,
    `exactly one apply may succeed; results=${JSON.stringify(results)}`,
  );
  assert.equal(failures.length, 1, 'exactly one apply must be rejected');
  const error = parseError(failures[0]);
  assert.ok(
    RACE_ERROR_CODES.has(error.code),
    `losing racer must report RELEASE_LOCKED or a legacy race error; actual=${error.code}; results=${JSON.stringify(results)}`,
  );
  const success = JSON.parse(successes[0].stdout);
  assert.equal(success.ok, true);
  assert.equal(success.dryRun, false);
  assert.equal(success.currentVersion, '0.2.0');
  assert.equal(success.nextVersion, VERSION);
  assertReleasedFiles(repo);
});

test('repeated apply of the same version is VERSION_NOT_GREATER and byte-preserving', async (t) => {
  const repo = makeRepo(t);
  const first = await runCli(repo);
  assert.equal(first.status, 0, first.stderr);
  const packageAfterFirst = readFileSync(packagePath(repo));
  const changelogAfterFirst = readFileSync(changelogPath(repo));

  const second = await runCli(repo);
  const error = parseError(second);
  assert.equal(error.code, 'VERSION_NOT_GREATER');
  assert.match(error.message, /already the current version/);
  assert.deepEqual(readFileSync(packagePath(repo)), packageAfterFirst);
  assert.deepEqual(readFileSync(changelogPath(repo)), changelogAfterFirst);
  assert.deepEqual(tempArtifacts(repo), []);
});

test('a dirty work tree is rejected with a structured error and zero writes', async (t) => {
  const repo = makeRepo(t);
  const packageBefore = readFileSync(packagePath(repo));
  const changelogBefore = readFileSync(changelogPath(repo));
  const dirtyPath = path.join(repo, 'dirty.txt');
  const dirtyBefore = Buffer.from('uncommitted change\n');
  writeFileSync(dirtyPath, dirtyBefore);

  const result = await runCli(repo);
  const error = parseError(result);
  assert.equal(error.code, 'DIRTY_WORKTREE');
  assert.match(error.message, /dirty\.txt/);
  assert.deepEqual(readFileSync(packagePath(repo)), packageBefore);
  assert.deepEqual(readFileSync(changelogPath(repo)), changelogBefore);
  assert.deepEqual(readFileSync(dirtyPath), dirtyBefore);
  assert.deepEqual(tempArtifacts(repo), []);
});

test('a simultaneous dry run never writes or leaves a half-written release', async (t) => {
  const repo = makeRepo(t);
  const [dry, applied] = await Promise.all([runCli(repo, { apply: false }), runCli(repo)]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(applied.status, 0, applied.stderr);
  const dryPayload = JSON.parse(dry.stdout);
  const applyPayload = JSON.parse(applied.stdout);
  assert.equal(dryPayload.ok, true);
  assert.equal(dryPayload.dryRun, true);
  assert.equal(applyPayload.ok, true);
  assert.equal(applyPayload.dryRun, false);
  assertReleasedFiles(repo);
});

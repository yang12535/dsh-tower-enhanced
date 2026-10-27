import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyPlan, compareSemver, computePlan, parseSemver } from '../scripts/release.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'release.mjs');

const PACKAGE_JSON = `${JSON.stringify({ name: 'release-test-pkg', version: '0.2.0', type: 'module' }, null, 2)}\n`;

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

function makeRepo(t, { changelog = CHANGELOG, commit = true } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'dsh-release-test-'));
  t.after(() => {
    if (repo.startsWith(path.join(tmpdir(), 'dsh-release-test-'))) rmSync(repo, { recursive: true, force: true });
  });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Release Test');
  git(repo, 'config', 'user.email', 'release@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repo, 'package.json'), PACKAGE_JSON);
  if (changelog !== null) writeFileSync(path.join(repo, 'CHANGELOG.md'), changelog);
  if (commit) {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'initial');
  }
  return repo;
}

function runCli(args, { cwd = PROJECT_ROOT } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd });
}

const packagePath = (repo) => path.join(repo, 'package.json');
const changelogPath = (repo) => path.join(repo, 'CHANGELOG.md');
const tempArtifacts = (repo) => readdirSync(repo).filter((entry) => entry.includes('release-tmp'));

test('parseSemver and compareSemver implement semver precedence', () => {
  assert.deepEqual(parseSemver('v0.3.0-rc.1'), { major: 0, minor: 3, patch: 0, prerelease: 'rc.1', raw: '0.3.0-rc.1' });
  assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: null, raw: '1.2.3' });
  assert.ok(compareSemver('0.2.0', '0.3.0') < 0, '0.2.0 < 0.3.0');
  assert.equal(compareSemver('0.3.0', '0.3.0'), 0);
  assert.ok(compareSemver('0.3.0-rc.1', '0.3.0') < 0, 'prerelease < release');
  assert.ok(compareSemver('0.3.0-rc.1', '0.3.0-rc.2') < 0, 'rc.1 < rc.2');
  assert.ok(compareSemver('0.3.0-rc.2', '0.3.0-rc.10') < 0, 'numeric identifiers compare numerically');
  assert.ok(compareSemver('0.3.0-alpha', '0.3.0-beta') < 0, 'alphabetic identifiers compare lexically');
  assert.throws(() => parseSemver('1.2'), (error) => error.code === 'INVALID_SEMVER');
  assert.throws(() => parseSemver('0.3.0-rc.1!'), (error) => error.code === 'INVALID_SEMVER');
  assert.throws(() => parseSemver(''), (error) => error.code === 'INVALID_SEMVER');
});

test('dry run prints the planned diff, keeps every byte, exits 0', (t) => {
  const repo = makeRepo(t);
  const packageBefore = readFileSync(packagePath(repo));
  const changelogBefore = readFileSync(changelogPath(repo));
  const result = runCli(['--repo', repo, '--version', '0.3.0', '--date', '2026-02-03']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run: no files were modified/);
  assert.match(result.stdout, /release-test-pkg: 0\.2\.0 -> 0\.3\.0 \(2026-02-03\)/);
  assert.match(result.stdout, /\+\+\+ b\/package\.json/);
  assert.match(result.stdout, /-  "version": "0\.2\.0",/);
  assert.match(result.stdout, /\+  "version": "0\.3\.0",/);
  assert.match(result.stdout, /\+\+\+ b\/CHANGELOG\.md/);
  assert.match(result.stdout, /\+## \[0\.3\.0\] - 2026-02-03/);
  assert.deepEqual(readFileSync(packagePath(repo)), packageBefore, 'package.json must stay byte-identical');
  assert.deepEqual(readFileSync(changelogPath(repo)), changelogBefore, 'CHANGELOG.md must stay byte-identical');
  assert.deepEqual(tempArtifacts(repo), [], 'dry run must not leave temporary files');
});

test('dry run without --date defaults to today and --repo defaults to cwd', (t) => {
  const repo = makeRepo(t);
  const result = runCli(['--version', '0.3.0'], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /## \[0\.3\.0\] - \d{4}-\d{2}-\d{2}/);
});

test('apply bumps package.json and promotes the Unreleased section', (t) => {
  const repo = makeRepo(t);
  const result = runCli(['--repo', repo, '--version', '0.3.0', '--date', '2026-02-03', '--apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Dry run/);
  assert.match(result.stdout, /never runs git commit, tag, or push/);

  const pkg = JSON.parse(readFileSync(packagePath(repo), 'utf8'));
  assert.equal(pkg.version, '0.3.0');
  assert.equal(pkg.name, 'release-test-pkg');
  assert.equal(pkg.type, 'module');

  const lines = readFileSync(changelogPath(repo), 'utf8').split('\n');
  const unreleased = lines.indexOf('## [Unreleased]');
  const promoted = lines.indexOf('## [0.3.0] - 2026-02-03');
  const previous = lines.indexOf('## [0.2.0] - 2026-01-10');
  assert.notEqual(unreleased, -1, 'a new Unreleased section is kept');
  assert.notEqual(promoted, -1, 'the promoted section exists');
  assert.notEqual(previous, -1, 'the previous release section survives');
  assert.ok(unreleased < promoted && promoted < previous, 'section order is Unreleased, promoted, previous');
  assert.equal(
    lines.slice(unreleased + 1).find((line) => line.trim() !== ''),
    '## [0.3.0] - 2026-02-03',
    'the new Unreleased section stays empty',
  );
  assert.equal(lines.filter((line) => line === '## [Unreleased]').length, 1, 'exactly one Unreleased heading');
  const promotedBlock = lines.slice(promoted, previous);
  assert.ok(promotedBlock.includes('### Added'), 'promoted section keeps the old Unreleased groups');
  assert.ok(promotedBlock.includes('- new feature'), 'promoted section keeps the old Unreleased entries');
  const previousBlock = lines.slice(previous);
  assert.ok(previousBlock.includes('### Fixed') && previousBlock.includes('- old fix'), 'older release section is untouched');

  // The script never commits: both files are left dirty for manual review.
  const status = git(repo, 'status', '--porcelain')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(status, ['M CHANGELOG.md', 'M package.json']);
  assert.deepEqual(tempArtifacts(repo), [], 'no temporary artifacts remain');
});

test('equal or lower target versions are rejected without writing anything', (t) => {
  const repo = makeRepo(t);
  const packageBefore = readFileSync(packagePath(repo));
  const changelogBefore = readFileSync(changelogPath(repo));
  for (const version of ['0.2.0', '0.1.9']) {
    const result = runCli(['--repo', repo, '--version', version, '--date', '2026-02-03', '--apply']);
    assert.notEqual(result.status, 0, `${version} must be rejected`);
    assert.match(result.stderr, /must be greater than the current version 0\.2\.0/);
  }
  assert.deepEqual(readFileSync(packagePath(repo)), packageBefore);
  assert.deepEqual(readFileSync(changelogPath(repo)), changelogBefore);
});

test('invalid semver, invalid date, and missing --version are rejected without writing', (t) => {
  const repo = makeRepo(t);
  const before = readFileSync(packagePath(repo));
  for (const version of ['1.2', 'not-a-version', '0.3.0.0-rc']) {
    const result = runCli(['--repo', repo, '--version', version, '--apply']);
    assert.notEqual(result.status, 0, `${version} must be rejected`);
    assert.match(result.stderr, /invalid semver version/);
    assert.deepEqual(readFileSync(packagePath(repo)), before);
  }
  const badDate = runCli(['--repo', repo, '--version', '0.3.0', '--date', '2026-02-30', '--apply']);
  assert.notEqual(badDate.status, 0);
  assert.match(badDate.stderr, /invalid --date/);
  const missing = runCli(['--repo', repo, '--date', '2026-02-03', '--apply']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /missing required option --version/);
  assert.deepEqual(readFileSync(packagePath(repo)), before, 'no error path may write package.json');
});

test('a missing CHANGELOG.md is a hard error unless --create-changelog is passed', (t) => {
  const repo = makeRepo(t, { changelog: null });
  const packageBefore = readFileSync(packagePath(repo));
  const refused = runCli(['--repo', repo, '--version', '0.3.0', '--date', '2026-02-03', '--apply']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /CHANGELOG\.md not found/);
  assert.equal(existsSync(changelogPath(repo)), false, 'nothing may be created without --create-changelog');
  assert.deepEqual(readFileSync(packagePath(repo)), packageBefore);

  const created = runCli(['--repo', repo, '--version', '0.3.0', '--date', '2026-02-03', '--apply', '--create-changelog', '--json']);
  assert.equal(created.status, 0, created.stderr);
  const payload = JSON.parse(created.stdout);
  assert.equal(payload.dryRun, false);
  assert.deepEqual(
    payload.files.map((file) => [file.path, file.action]).sort(),
    [['CHANGELOG.md', 'create'], ['package.json', 'update']],
  );
  assert.equal(payload.files.find((file) => file.path === 'CHANGELOG.md').bytesBefore, null);
  assert.equal(JSON.parse(readFileSync(packagePath(repo), 'utf8')).version, '0.3.0');
  const changelog = readFileSync(changelogPath(repo), 'utf8');
  assert.match(changelog, /## \[Unreleased\]/);
  assert.match(changelog, /## \[0\.3\.0\] - 2026-02-03/);
});

test('a CHANGELOG without an Unreleased section is always an error, even with --create-changelog', (t) => {
  const changelog = ['# Changelog', '', '## [0.2.0] - 2026-01-10', '', '- old fix', ''].join('\n');
  const repo = makeRepo(t, { changelog });
  const packageBefore = readFileSync(packagePath(repo));
  const changelogBefore = readFileSync(changelogPath(repo));
  for (const extra of [[], ['--create-changelog']]) {
    const result = runCli(['--repo', repo, '--version', '0.3.0', '--date', '2026-02-03', '--apply', ...extra]);
    assert.notEqual(result.status, 0, JSON.stringify(extra));
    assert.match(result.stderr, /no "## \[Unreleased\]" section/);
  }
  assert.deepEqual(readFileSync(packagePath(repo)), packageBefore);
  assert.deepEqual(readFileSync(changelogPath(repo)), changelogBefore);
});

test('apply refuses a dirty work tree and leaves every file unchanged', (t) => {
  const repo = makeRepo(t);
  const packageBefore = readFileSync(packagePath(repo));
  const changelogBefore = readFileSync(changelogPath(repo));
  writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted change\n');
  const result = runCli(['--repo', repo, '--version', '0.3.0', '--date', '2026-02-03', '--apply']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /the work tree is not clean/);
  assert.match(result.stderr, /dirty\.txt/);
  assert.deepEqual(readFileSync(packagePath(repo)), packageBefore);
  assert.deepEqual(readFileSync(changelogPath(repo)), changelogBefore);
  assert.deepEqual(tempArtifacts(repo), []);

  // A dirty work tree only blocks --apply; dry runs stay read-only and keep working.
  const dry = runCli(['--repo', repo, '--version', '0.3.0', '--date', '2026-02-03']);
  assert.equal(dry.status, 0, dry.stderr);
});

test('a target replaced by a directory is rejected before the first write', (t) => {
  const repo = makeRepo(t, { commit: false });
  const packageBefore = readFileSync(packagePath(repo));
  const plan = computePlan({ repo, version: '0.3.0', date: '2026-02-03' });
  rmSync(changelogPath(repo));
  mkdirSync(changelogPath(repo));
  assert.throws(
    () => applyPlan(plan),
    (error) => {
      assert.equal(error.code, 'RELEASE_PLAN_STALE');
      assert.match(error.message, /CHANGELOG\.md/);
      return true;
    },
  );
  assert.deepEqual(readFileSync(packagePath(repo)), packageBefore);
  assert.deepEqual(tempArtifacts(repo), []);
});

test('a failure during the second atomic write rolls the first one back and unlocks', (t) => {
  const repo = makeRepo(t);
  const packageBefore = readFileSync(packagePath(repo));
  const changelogBefore = readFileSync(changelogPath(repo));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const originalRename = fs.renameSync;
    const packagePath = ${JSON.stringify(packagePath(repo))};
    const changelogPath = ${JSON.stringify(changelogPath(repo))};
    let injected = false;
    fs.renameSync = (from, to) => {
      if (to === changelogPath) {
        assert.equal(JSON.parse(fs.readFileSync(packagePath, 'utf8')).version, '0.3.0');
        assert.ok(fs.existsSync(from), 'the second temporary file was actually written');
        injected = true;
        throw Object.assign(new Error('injected second rename failure'), { code: 'EIO' });
      }
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    const { cliMain } = await import(${JSON.stringify(new URL('../scripts/release.mjs', import.meta.url).href)});
    process.exitCode = cliMain(['--repo', ${JSON.stringify(repo)}, '--version', '0.3.0', '--apply', '--json']);
    assert.ok(injected, 'the failure must happen after validation and the first write');
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'WRITE_FAILED');
  assert.match(error.message, /failed to write CHANGELOG\.md/);
  assert.match(error.message, /rolled back package\.json/);
  assert.deepEqual(readFileSync(packagePath(repo)), packageBefore);
  assert.deepEqual(readFileSync(changelogPath(repo)), changelogBefore);
  assert.deepEqual(tempArtifacts(repo), []);
  assert.deepEqual(readdirSync(path.join(repo, '.git')).filter((name) => name.startsWith('release-apply')), []);
  const retried = runCli(['--repo', repo, '--version', '0.3.0', '--apply']);
  assert.equal(retried.status, 0, retried.stderr);
});

test('applying the same version twice is rejected', (t) => {
  const repo = makeRepo(t);
  const first = runCli(['--repo', repo, '--version', '0.3.0', '--date', '2026-02-03', '--apply']);
  assert.equal(first.status, 0, first.stderr);
  const packageAfterFirst = readFileSync(packagePath(repo));
  const changelogAfterFirst = readFileSync(changelogPath(repo));
  const second = runCli(['--repo', repo, '--version', '0.3.0', '--date', '2026-02-03', '--apply']);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /must be greater than the current version 0\.3\.0/);
  assert.match(second.stderr, /already the current version/);
  assert.deepEqual(readFileSync(packagePath(repo)), packageAfterFirst);
  assert.deepEqual(readFileSync(changelogPath(repo)), changelogAfterFirst);
});

test('--json success output is a single machine-readable object', (t) => {
  const repo = makeRepo(t);
  const result = runCli(['--repo', repo, '--version', '0.3.0', '--date', '2026-02-03', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.repo, path.resolve(repo));
  assert.equal(payload.packageName, 'release-test-pkg');
  assert.equal(payload.currentVersion, '0.2.0');
  assert.equal(payload.nextVersion, '0.3.0');
  assert.equal(payload.date, '2026-02-03');
  assert.deepEqual(
    payload.files.map((file) => [file.path, file.action]),
    [['package.json', 'update'], ['CHANGELOG.md', 'update']],
  );
  for (const file of payload.files) {
    assert.equal(typeof file.bytesBefore, 'number');
    assert.equal(typeof file.bytesAfter, 'number');
  }
});

test('--json errors are machine-readable on stderr', (t) => {
  const repo = makeRepo(t);
  const result = runCli(['--repo', repo, '--version', '0.2.0', '--json']);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.trim(), '');
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'VERSION_NOT_GREATER');
  assert.equal(typeof payload.message, 'string');
});

test('--help documents every option and unknown flags are rejected', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  for (const flag of ['--version', '--date', '--apply', '--repo', '--json', '--create-changelog', '--help']) {
    assert.ok(result.stdout.includes(flag), `--help must document ${flag}`);
  }
  assert.ok(result.stdout.includes('--create-changelog') && result.stdout.includes('Unreleased'), '--create-changelog semantics are explained');
  assert.match(result.stdout, /ESRCH/);
  assert.match(result.stdout, /regardless of lock age/);
  assert.match(result.stdout, /RELEASE_PLAN_STALE/);
  assert.doesNotMatch(result.stdout, /at least 10 minutes old/);

  const unknown = runCli(['--bogus']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown argument: --bogus/);
});

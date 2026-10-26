import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { acquireReleaseLock, applyPlan, computePlan } from '../scripts/release.mjs';

const SCRIPT = new URL('../scripts/release.mjs', import.meta.url);
const PACKAGE = '{"name":"release-lock-test","version":"0.2.0"}\n';
const CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n- new feature\n';
const OLD = Date.now() - 11 * 60 * 1000;
const options = (repo) => ({ repo, version: '0.3.0', date: '2026-02-03' });
const lockPath = (repo, reclaim = false) => path.join(repo, '.git', `release-apply${reclaim ? '.reclaim' : ''}.lock`);
const files = (repo) => ['package.json', 'CHANGELOG.md'].map((name) => readFileSync(path.join(repo, name)));
const lockArtifacts = (repo) => readdirSync(path.join(repo, '.git')).filter((name) => name.startsWith('release-apply'));

function makeRepo(t, { changelog = true } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'dsh-release-stale-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repo, 'package.json'), PACKAGE);
  if (changelog) writeFileSync(path.join(repo, 'CHANGELOG.md'), CHANGELOG);
  git('add', '-A');
  git('commit', '-m', 'initial');
  return repo;
}

function writeLock(repo, data, reclaim = false) {
  const raw = typeof data === 'string' ? data : JSON.stringify(data);
  writeFileSync(lockPath(repo, reclaim), raw);
  utimesSync(lockPath(repo, reclaim), OLD / 1000, OLD / 1000);
  return raw;
}

function deadPid() {
  const result = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
  return result.pid;
}

function cli(repo, extra = []) {
  return spawnSync(process.execPath, [fileURLToPath(SCRIPT), '--repo', repo, '--version', '0.3.0', '--date', '2026-02-03', '--json', ...extra], { encoding: 'utf8', timeout: 10000 });
}

function injected(repo, setup, body) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const repo = ${JSON.stringify(repo)};
    ${setup}
    syncBuiltinESMExports();
    const release = await import(${JSON.stringify(SCRIPT.href)});
    ${body}
  `], { encoding: 'utf8', timeout: 10000 });
}

function assertLocked(result) {
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stdout, '');
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'RELEASE_LOCKED');
  return payload.message;
}

test('an old live holder is never stolen and dry runs do not acquire locks', (t) => {
  const repo = makeRepo(t);
  const before = files(repo);
  const lock = acquireReleaseLock(repo);
  t.after(() => lock.release());
  const plan = computePlan(options(repo));
  const owner = JSON.parse(readFileSync(lockPath(repo), 'utf8'));
  const raw = writeLock(repo, { ...owner, timestamp: OLD });
  const message = assertLocked(cli(repo, ['--apply']));
  assert.ok(message.includes(`pid ${process.pid}`));
  assert.ok(message.includes(lockPath(repo)));
  assert.match(message, /age \d+ ms/);
  assert.match(message, /slow|long.running/i);
  assert.match(message, /manually|manual/i);
  assert.deepEqual(files(repo), before);
  assert.equal(readFileSync(lockPath(repo), 'utf8'), raw);
  const dry = cli(repo);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).dryRun, true);
  assert.equal(readFileSync(lockPath(repo), 'utf8'), raw);
  assert.deepEqual(files(repo), before);
  assert.deepEqual(lockArtifacts(repo), ['release-apply.lock']);
  applyPlan(plan);
  lock.release();
  assert.equal(JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version, '0.3.0');
  assert.deepEqual(lockArtifacts(repo), []);
});

test('a confirmed dead holder is reclaimed without waiting for an age threshold', (t) => {
  const repo = makeRepo(t);
  writeLock(repo, { pid: deadPid(), timestamp: Date.now(), token: 'dead-holder' });
  const result = cli(repo, ['--apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version, '0.3.0');
  assert.deepEqual(lockArtifacts(repo), []);
});

test('an old live reclaim holder blocks recovery without changing either lock', (t) => {
  const repo = makeRepo(t);
  const before = files(repo);
  const mainRaw = writeLock(repo, { pid: deadPid(), timestamp: OLD, token: 'dead-main' });
  const reclaimRaw = writeLock(repo, { pid: process.pid, timestamp: OLD, token: 'live-reclaimer' }, true);
  assert.ok(assertLocked(cli(repo, ['--apply'])).includes(lockPath(repo, true)));
  assert.equal(readFileSync(lockPath(repo), 'utf8'), mainRaw);
  assert.equal(readFileSync(lockPath(repo, true), 'utf8'), reclaimRaw);
  assert.deepEqual(files(repo), before);
});

test('confirmed dead main and reclaim holders can both be recovered', (t) => {
  const repo = makeRepo(t);
  const pid = deadPid();
  writeLock(repo, { pid, timestamp: Date.now(), token: 'dead-main' });
  writeLock(repo, { pid, timestamp: Date.now(), token: 'dead-reclaimer' }, true);
  const result = cli(repo, ['--apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version, '0.3.0');
  assert.deepEqual(lockArtifacts(repo), []);
});

for (const [name, data] of [
  ['malformed JSON', '{'],
  ['null JSON', 'null'],
  ['missing pid', { timestamp: OLD }],
  ['string pid', { pid: String(process.pid), timestamp: OLD }],
  ['zero pid', { pid: 0, timestamp: OLD }],
  ['negative pid', { pid: -1, timestamp: OLD }],
  ['fractional pid', { pid: 1.5, timestamp: OLD }],
  ['out-of-range pid', { pid: Number.MAX_SAFE_INTEGER, timestamp: OLD }],
]) {
  test(`old locks with ${name} are not automatically reclaimed`, (t) => {
    const repo = makeRepo(t);
    const before = files(repo);
    const raw = writeLock(repo, data);
    assertLocked(cli(repo, ['--apply']));
    assert.equal(readFileSync(lockPath(repo), 'utf8'), raw);
    assert.deepEqual(files(repo), before);
    assert.deepEqual(lockArtifacts(repo), ['release-apply.lock']);
  });
}

for (const code of ['EPERM', 'EIO']) {
  test(`a ${code} liveness probe never permits takeover of an old lock`, (t) => {
    const repo = makeRepo(t);
    const before = files(repo);
    const raw = writeLock(repo, { pid: process.pid, timestamp: OLD, token: 'unknown-liveness' });
    const result = injected(repo, `
      process.kill = (pid, signal) => {
        assert.equal(pid, ${process.pid});
        assert.equal(signal, 0);
        throw Object.assign(new Error('injected probe failure'), { code: '${code}' });
      };
    `, `process.exitCode = release.cliMain(['--repo', repo, '--version', '0.3.0', '--apply', '--json']);`);
    assertLocked(result);
    assert.equal(readFileSync(lockPath(repo), 'utf8'), raw);
    assert.deepEqual(files(repo), before);
  });
}

test('an old plan cannot overwrite a newer successful release', (t) => {
  const repo = makeRepo(t);
  const plan = computePlan(options(repo));
  const newer = cli(repo, ['--version', '0.4.0', '--apply']);
  assert.equal(newer.status, 0, newer.stderr);
  const before = files(repo);
  assert.throws(() => applyPlan(plan), { code: 'RELEASE_PLAN_STALE' });
  assert.deepEqual(files(repo), before);
  assert.match(before[1].toString(), /## \[0\.4\.0\]/);
  assert.deepEqual(lockArtifacts(repo), []);
});

for (const [name, target, content] of [
  ['same-version package edits', 'package.json', PACKAGE.replace('release-lock-test', 'renamed-package')],
  ['package whitespace edits', 'package.json', `${PACKAGE}\n`],
  ['changelog edits', 'CHANGELOG.md', `${CHANGELOG}- concurrent edit\n`],
  ['a missing package', 'package.json', null],
  ['a missing changelog', 'CHANGELOG.md', null],
]) {
  test(`plan validation rejects ${name} before writing any target`, (t) => {
    const repo = makeRepo(t);
    const plan = computePlan(options(repo));
    const targetPath = path.join(repo, target);
    if (content === null) rmSync(targetPath);
    else writeFileSync(targetPath, content);
    assert.throws(() => applyPlan(plan), (error) => {
      assert.equal(error.code, 'RELEASE_PLAN_STALE');
      assert.ok(error.message.includes(target));
      return true;
    });
    assert.equal(existsSync(targetPath), content !== null);
    if (content !== null) assert.equal(readFileSync(targetPath, 'utf8'), content);
    const other = target === 'package.json' ? 'CHANGELOG.md' : 'package.json';
    assert.equal(readFileSync(path.join(repo, other), 'utf8'), other === 'package.json' ? PACKAGE : CHANGELOG);
    assert.deepEqual(readdirSync(repo).filter((name) => name.includes('release-tmp')), []);
  });
}

for (const symlink of [false, true]) {
  test(`a create plan cannot overwrite a newly appeared ${symlink ? 'dangling symlink' : 'changelog'}`, (t) => {
    const repo = makeRepo(t, { changelog: false });
    const plan = computePlan({ ...options(repo), createChangelog: true });
    const target = path.join(repo, 'CHANGELOG.md');
    if (symlink) symlinkSync('missing-target', target);
    else writeFileSync(target, CHANGELOG);
    assert.throws(() => applyPlan(plan), { code: 'RELEASE_PLAN_STALE' });
    assert.equal(readFileSync(path.join(repo, 'package.json'), 'utf8'), PACKAGE);
    if (symlink) assert.equal(lstatSync(target).isSymbolicLink(), true);
    else assert.equal(readFileSync(target, 'utf8'), CHANGELOG);
  });
}

for (const replaceToken of [false, true]) {
  test(`CLI stale-plan failure ${replaceToken ? 'preserves a foreign token' : 'releases its own lock'}`, (t) => {
    const repo = makeRepo(t);
    const changed = `${CHANGELOG}- changed after clean git status\n`;
    const result = injected(repo, `
      const originalSpawn = cp.spawnSync;
      cp.spawnSync = (command, args, ...rest) => {
        const result = originalSpawn(command, args, ...rest);
        if (command === 'git' && args.includes('--porcelain')) {
          assert.equal(result.status, 0);
          assert.equal(result.stdout, '');
          fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), ${JSON.stringify(changed)});
          if (${replaceToken}) fs.writeFileSync(path.join(repo, '.git', 'release-apply.lock'), JSON.stringify({ pid: process.pid, token: 'foreign-token' }));
        }
        return result;
      };
    `, `process.exitCode = release.cliMain(['--repo', repo, '--version', '0.3.0', '--apply', '--json']);`);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, 'RELEASE_PLAN_STALE');
    assert.equal(readFileSync(path.join(repo, 'package.json'), 'utf8'), PACKAGE);
    assert.equal(readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8'), changed);
    assert.deepEqual(lockArtifacts(repo), replaceToken ? ['release-apply.lock'] : []);
    if (replaceToken) assert.equal(JSON.parse(readFileSync(lockPath(repo), 'utf8')).token, 'foreign-token');
  });
}

for (const createChangelog of [false, true]) {
  test(`a ${createChangelog ? 'create' : 'update'} plan fails closed when the target cannot be inspected`, (t) => {
    const repo = makeRepo(t, { changelog: !createChangelog });
    const result = injected(repo, '', `
      const plan = release.computePlan({ repo, version: '0.3.0', createChangelog: ${createChangelog} });
      const method = ${JSON.stringify(createChangelog ? 'lstatSync' : 'readFileSync')};
      const original = fs[method];
      let probed = false;
      fs[method] = (target, ...args) => {
        if (target === path.join(repo, 'CHANGELOG.md')) {
          probed = true;
          throw Object.assign(new Error('injected inspection denial'), { code: 'EACCES' });
        }
        return original(target, ...args);
      };
      syncBuiltinESMExports();
      assert.throws(() => release.applyPlan(plan), { code: 'RELEASE_PLAN_STALE' });
      assert.ok(probed);
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(repo, 'package.json'), 'utf8'), PACKAGE);
    assert.equal(existsSync(path.join(repo, 'CHANGELOG.md')), !createChangelog);
    if (!createChangelog) assert.equal(readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8'), CHANGELOG);
    assert.deepEqual(readdirSync(repo).filter((name) => name.includes('release-tmp')), []);
  });
}

test('releasing an acquired lock never removes a replacement token', (t) => {
  const repo = makeRepo(t);
  const lock = acquireReleaseLock(repo);
  const replacement = writeLock(repo, { pid: process.pid, timestamp: Date.now(), token: 'replacement' });
  lock.release();
  assert.equal(readFileSync(lockPath(repo), 'utf8'), replacement);
  assert.deepEqual(lockArtifacts(repo), ['release-apply.lock']);
});

#!/usr/bin/env node
// Local release helper: bumps package.json and promotes the CHANGELOG
// "[Unreleased]" section into a dated version section.
//
// Safety model: the default mode is a dry run that only prints the planned
// diff and never writes a file. --apply additionally requires a clean work
// tree (`git status --porcelain`), writes each file atomically (temporary
// file + rename) only after every validation has passed, and rolls back the
// first file best effort when writing the second one fails. The script never
// commits, tags, pushes, or touches the network.

import { spawnSync } from 'node:child_process';
import { closeSync, linkSync, lstatSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PACKAGE_FILE = 'package.json';
export const CHANGELOG_FILE = 'CHANGELOG.md';

const UNRELEASED_HEADING = /^##\s*\[Unreleased\]\s*$/;

export class ReleaseError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'ReleaseError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Semver (subset: MAJOR.MINOR.PATCH with an optional prerelease suffix)
// ---------------------------------------------------------------------------

export function parseSemver(input) {
  const value = typeof input === 'string' ? input.trim() : '';
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) {
    throw new ReleaseError(
      'INVALID_SEMVER',
      `invalid semver version ${JSON.stringify(input ?? '')}: expected MAJOR.MINOR.PATCH with an optional prerelease suffix, for example 0.3.0 or 0.3.0-rc.1`,
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    raw: value.replace(/^v/, ''),
  };
}

function comparePrerelease(a, b) {
  const partsA = a.split('.');
  const partsB = b.split('.');
  const length = Math.min(partsA.length, partsB.length);
  for (let index = 0; index < length; index++) {
    const x = partsA[index];
    const y = partsB[index];
    const xNumeric = /^[0-9]+$/.test(x);
    const yNumeric = /^[0-9]+$/.test(y);
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y);
      if (difference !== 0) return difference < 0 ? -1 : 1;
    } else if (xNumeric !== yNumeric) {
      // Numeric identifiers always have lower precedence than alphanumeric ones.
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (partsA.length !== partsB.length) return partsA.length < partsB.length ? -1 : 1;
  return 0;
}

export function compareSemver(a, b) {
  const pa = typeof a === 'string' ? parseSemver(a) : a;
  const pb = typeof b === 'string' ? parseSemver(b) : b;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  if (pa.prerelease === null && pb.prerelease === null) return 0;
  if (pa.prerelease === null) return 1; // a release outranks any prerelease
  if (pb.prerelease === null) return -1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export function isValidReleaseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function todayLocal() {
  const now = new Date();
  const pad = (part) => String(part).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ---------------------------------------------------------------------------
// CHANGELOG rewriting
// ---------------------------------------------------------------------------

export function promoteChangelog(content, version, date) {
  const lines = content.split('\n');
  const index = lines.findIndex((line) => UNRELEASED_HEADING.test(line));
  if (index === -1) {
    throw new ReleaseError('NO_UNRELEASED', `${CHANGELOG_FILE} has no "## [Unreleased]" section to promote`);
  }
  let restStart = index + 1;
  while (restStart < lines.length && lines[restStart].trim() === '') restStart++;
  return [
    ...lines.slice(0, index),
    '## [Unreleased]',
    '',
    `## [${version}] - ${date}`,
    '',
    ...lines.slice(restStart),
  ].join('\n');
}

function changelogSkeleton(packageName, version, date) {
  return [
    '# Changelog',
    '',
    `All notable changes to ${packageName} are documented in this file.`,
    '',
    'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).',
    '',
    '## [Unreleased]',
    '',
    `## [${version}] - ${date}`,
    '',
  ].join('\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Planning (validation only — never writes)
// ---------------------------------------------------------------------------

export function computePlan(options = {}) {
  const repo = path.resolve(options.repo ?? process.cwd());
  let repoStat;
  try {
    repoStat = statSync(repo);
  } catch {
    throw new ReleaseError('REPO_NOT_FOUND', `repository directory not found: ${repo}`);
  }
  if (!repoStat.isDirectory()) throw new ReleaseError('REPO_NOT_FOUND', `--repo is not a directory: ${repo}`);

  if (!options.version) {
    throw new ReleaseError('MISSING_VERSION', 'missing required option --version <semver>, for example --version 0.3.0 (see --help)');
  }
  const next = parseSemver(options.version);
  const date = options.date ?? todayLocal();
  if (!isValidReleaseDate(date)) {
    throw new ReleaseError('INVALID_DATE', `invalid --date ${JSON.stringify(options.date)}: expected a real calendar date formatted YYYY-MM-DD`);
  }

  const packagePath = path.join(repo, PACKAGE_FILE);
  let packageRaw;
  try {
    packageRaw = readFileSync(packagePath, 'utf8');
  } catch {
    throw new ReleaseError('MISSING_PACKAGE_JSON', `${PACKAGE_FILE} not found in ${repo}`);
  }
  let pkg;
  try {
    pkg = JSON.parse(packageRaw);
  } catch (error) {
    throw new ReleaseError('INVALID_PACKAGE_JSON', `${PACKAGE_FILE} is not valid JSON: ${error.message}`);
  }
  if (typeof pkg.name !== 'string' || pkg.name.trim() === '') {
    throw new ReleaseError('INVALID_PACKAGE_JSON', `${PACKAGE_FILE} has no non-empty string "name"`);
  }
  let current;
  try {
    current = parseSemver(pkg.version);
  } catch {
    throw new ReleaseError('INVALID_CURRENT_VERSION', `${PACKAGE_FILE} "version" ${JSON.stringify(pkg.version)} is not valid semver`);
  }
  if (compareSemver(next, current) <= 0) {
    const hint = next.raw === current.raw ? ` (${next.raw} is already the current version; nothing to release)` : '';
    throw new ReleaseError('VERSION_NOT_GREATER', `target version ${next.raw} must be greater than the current version ${current.raw} in ${PACKAGE_FILE}${hint}`);
  }

  const files = [
    {
      path: PACKAGE_FILE,
      absolute: packagePath,
      action: 'update',
      before: packageRaw,
      after: `${JSON.stringify({ ...pkg, version: next.raw }, null, 2)}\n`,
    },
  ];

  const changelogPath = path.join(repo, CHANGELOG_FILE);
  let changelogRaw = null;
  try {
    changelogRaw = readFileSync(changelogPath, 'utf8');
  } catch {
    // handled below: a missing CHANGELOG is only tolerated with --create-changelog
  }
  if (changelogRaw === null) {
    if (!options.createChangelog) {
      throw new ReleaseError('CHANGELOG_MISSING', `${CHANGELOG_FILE} not found in ${repo}; pass --create-changelog to create a minimal skeleton instead`);
    }
    files.push({
      path: CHANGELOG_FILE,
      absolute: changelogPath,
      action: 'create',
      before: null,
      after: changelogSkeleton(pkg.name, next.raw, date),
    });
  } else {
    if (new RegExp(`^##\\s*\\[${escapeRegExp(next.raw)}\\]`, 'm').test(changelogRaw)) {
      throw new ReleaseError('VERSION_ALREADY_RELEASED', `${CHANGELOG_FILE} already contains a section for ${next.raw}`);
    }
    files.push({
      path: CHANGELOG_FILE,
      absolute: changelogPath,
      action: 'update',
      before: changelogRaw,
      after: promoteChangelog(changelogRaw, next.raw, date),
    });
  }

  return {
    repo,
    packageName: pkg.name,
    currentVersion: current.raw,
    nextVersion: next.raw,
    date,
    files,
  };
}

// ---------------------------------------------------------------------------
// Atomic writes with best-effort rollback
// ---------------------------------------------------------------------------

let tempFileCounter = 0;

export function atomicWrite(filePath, content) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.release-tmp-${process.pid}-${Date.now()}-${tempFileCounter++}`);
  try {
    writeFileSync(tempPath, content, 'utf8');
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // best-effort cleanup of the temporary file
    }
    throw error;
  }
}

function validatePlan(plan) {
  for (const file of plan.files) {
    let unchanged = false;
    try {
      if (file.action === 'create') {
        try {
          lstatSync(file.absolute);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          unchanged = true;
        }
      } else {
        unchanged = readFileSync(file.absolute).equals(Buffer.from(file.before, 'utf8'));
      }
    } catch (error) {
      throw new ReleaseError('RELEASE_PLAN_STALE', `cannot verify ${file.path} against the release plan: ${error.message}; no files were written. Inspect the files and compute a new plan before retrying.`, { cause: error });
    }
    if (!unchanged) {
      throw new ReleaseError('RELEASE_PLAN_STALE', `${file.path} changed since the release plan was computed; no files were written. Inspect the files and compute a new plan before retrying.`);
    }
  }
}

export function applyPlan(plan) {
  validatePlan(plan);
  const written = [];
  try {
    for (const file of plan.files) {
      atomicWrite(file.absolute, file.after);
      written.push(file);
    }
  } catch (error) {
    const failed = plan.files[written.length];
    const rollbackErrors = [];
    for (const file of written.reverse()) {
      try {
        if (file.action === 'create') rmSync(file.absolute, { force: true });
        else atomicWrite(file.absolute, file.before);
      } catch (rollbackError) {
        rollbackErrors.push(`${file.path}: ${rollbackError.message}`);
      }
    }
    let rollbackNote;
    if (written.length === 0) rollbackNote = 'no files had been written yet';
    else if (rollbackErrors.length === 0) rollbackNote = `rolled back ${written.map((file) => file.path).join(', ')} to their previous content`;
    else rollbackNote = `best-effort rollback failed for ${rollbackErrors.join('; ')}`;
    throw new ReleaseError('WRITE_FAILED', `failed to write ${failed.path}: ${error.message}; ${rollbackNote}`, { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Cross-process apply lock
// ---------------------------------------------------------------------------

function resolveGitDirectory(repo) {
  const result = spawnSync('git', ['-C', repo, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' });
  if (result.error) {
    throw new ReleaseError('GIT_UNAVAILABLE', `cannot run git to locate the Git directory: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr).trim() || `exit code ${result.status}`;
    throw new ReleaseError('GIT_CHECK_FAILED', `git rev-parse failed in ${repo}: ${detail}`);
  }
  return result.stdout.trim();
}

function newLockToken() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function lockToken(raw) {
  try {
    return JSON.parse(raw).token;
  } catch {
    return null;
  }
}

function lockedError(lockPath, raw, modifiedAt, createdAt = modifiedAt) {
  let holder = null;
  try {
    const parsed = JSON.parse(raw);
    if (Number.isInteger(parsed?.pid) && parsed.pid > 0) holder = parsed.pid;
  } catch {
    // Malformed locks require manual inspection, regardless of age.
  }
  const owner = holder === null ? 'an unknown pid' : `pid ${holder}`;
  const age = Math.max(0, Math.floor(Date.now() - createdAt));
  return new ReleaseError(
    'RELEASE_LOCKED',
    `RELEASE_LOCKED: another release apply or stale-lock recovery may be in progress (${owner}); lock: ${lockPath} (age ${age} ms; modified ${new Date(modifiedAt).toISOString()}). A slow or long-running holder must not be displaced based on lock age. Automatic takeover requires a confirmed missing pid (ESRCH); unknown liveness is not proof of exit. Wait for that process to finish before retrying; never wait or retry automatically. Do not remove a live lock. Manually verify the process and lock ownership before considering cleanup.`,
  );
}

function lockChangedError(lockPath) {
  return new ReleaseError(
    'RELEASE_LOCKED',
    `RELEASE_LOCKED: lock ${lockPath} changed or was claimed by another process during acquisition. Retry after the other release process finishes; inspect the lock and its pid before considering manual cleanup.`,
  );
}

function inspectStaleLock(lockPath) {
  const lockStat = statSync(lockPath);
  const raw = readFileSync(lockPath, 'utf8');
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // Fall back to the file mtime for malformed or partially written locks.
  }
  const timestamp = typeof data?.timestamp === 'number'
    ? data.timestamp
    : typeof data?.timestamp === 'string'
      ? Date.parse(data.timestamp)
      : typeof data?.acquiredAt === 'string'
        ? Date.parse(data.acquiredAt)
        : Number.NaN;
  const createdAt = Number.isFinite(timestamp) ? timestamp : lockStat.mtimeMs;
  const pid = Number.isInteger(data?.pid) && data.pid > 0 ? data.pid : null;
  let processGone = false;
  if (pid !== null) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      // EPERM and other probe failures do not prove the holder has exited.
      processGone = error.code === 'ESRCH';
    }
  }
  if (!processGone) throw lockedError(lockPath, raw, lockStat.mtimeMs, createdAt);
  return { raw, notice: `Taking over stale release lock ${lockPath}: holder pid ${pid} no longer exists.` };
}

function createLock(lockPath) {
  // EEXIST is deliberately left unwrapped so callers can distinguish normal
  // contention from an actual filesystem failure.
  let handle;
  try {
    handle = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw error;
    throw new ReleaseError('RELEASE_LOCK_FAILED', `cannot create release lock ${lockPath}: ${error.message}`, { cause: error });
  }
  const token = newLockToken();
  try {
    writeFileSync(handle, `${JSON.stringify({ pid: process.pid, timestamp: Date.now(), token })}\n`, 'utf8');
  } catch (error) {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // Preserve the original write error.
    }
    throw new ReleaseError('RELEASE_LOCK_FAILED', `cannot initialize release lock ${lockPath}: ${error.message}`, { cause: error });
  } finally {
    closeSync(handle);
  }
  return token;
}

function currentLockedError(lockPath) {
  try {
    return lockedError(lockPath, readFileSync(lockPath, 'utf8'), statSync(lockPath).mtimeMs);
  } catch {
    return lockChangedError(lockPath);
  }
}

function restoreQuarantinedLock(quarantinePath, lockPath) {
  // A hard link restores only if the destination is absent; rename() could
  // overwrite a third process's newer lock. The unique quarantine is removed
  // either way, and the current path remains the authority if linking loses.
  try {
    linkSync(quarantinePath, lockPath);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    rmSync(quarantinePath, { force: true });
  }
}

function quarantineStaleLock(lockPath, stale) {
  // rename() atomically removes exactly one directory entry. Verifying the
  // moved bytes before deleting them closes the old read/check/unlink TOCTOU:
  // if a newer lock was moved instead, restore it and do not create a main lock.
  const quarantinePath = `${lockPath}.reclaim-${newLockToken()}`;
  try {
    renameSync(lockPath, quarantinePath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new ReleaseError('RELEASE_LOCK_FAILED', `cannot quarantine stale lock ${lockPath}: ${error.message}`, { cause: error });
  }
  let movedRaw;
  try {
    movedRaw = readFileSync(quarantinePath, 'utf8');
  } catch (error) {
    try {
      restoreQuarantinedLock(quarantinePath, lockPath);
    } catch {
      // Preserve the original read error.
    }
    throw new ReleaseError('RELEASE_LOCK_FAILED', `cannot verify quarantined lock ${lockPath}: ${error.message}`, { cause: error });
  }
  if (movedRaw !== stale.raw) {
    restoreQuarantinedLock(quarantinePath, lockPath);
    throw lockChangedError(lockPath);
  }
  rmSync(quarantinePath);
  return true;
}

function releaseOwnedLock(lockPath, token) {
  try {
    // Rename rather than check-then-unlink: the moved file is authoritative.
    // If a stale holder was replaced, a different token is restored, never
    // deleted. Only this process's own token is finally removed.
    const currentRaw = readFileSync(lockPath, 'utf8');
    if (lockToken(currentRaw) !== token) return;
    const quarantinePath = `${lockPath}.release-${token}`;
    try {
      renameSync(lockPath, quarantinePath);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (lockToken(readFileSync(quarantinePath, 'utf8')) !== token) {
      restoreQuarantinedLock(quarantinePath, lockPath);
      return;
    }
    rmSync(quarantinePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new ReleaseError('RELEASE_UNLOCK_FAILED', `cannot release lock ${lockPath}: ${error.message}`, { cause: error });
  }
}

function acquireReclaimLock(reclaimPath) {
  let notice = null;
  try {
    return { token: createLock(reclaimPath), notice };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  let stale;
  try {
    stale = inspectStaleLock(reclaimPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw lockChangedError(reclaimPath);
    throw error;
  }
  notice = stale.notice;
  // A stale reclaim lock is itself claimed by an atomic rename to a unique
  // path. If a delayed reclaimer moves a newer reclaim lock, the token/content
  // check above makes it restore that lock and abort before touching the main
  // lock. If the old reclaim lock vanished, fail rather than race its reclaimer.
  if (!quarantineStaleLock(reclaimPath, stale)) throw lockChangedError(reclaimPath);
  try {
    return { token: createLock(reclaimPath), notice };
  } catch (error) {
    if (error.code === 'EEXIST') throw currentLockedError(reclaimPath);
    throw error;
  }
}

function acquiredLock(lockPath, token, notice) {
  return {
    notice,
    release() {
      releaseOwnedLock(lockPath, token);
    },
  };
}

export function acquireReleaseLock(repo) {
  // Keep both locks in the actual Git directory (which also handles linked
  // worktrees), never in the work tree: they must not dirty `git status`, which
  // --apply checks, and no .gitignore change is needed. R serializes stale-L
  // recovery; L's final open('wx') remains the atomic ownership decision even
  // if two processes race to recover R itself.
  const gitDirectory = resolveGitDirectory(repo);
  const lockPath = path.join(gitDirectory, 'release-apply.lock');
  const reclaimPath = path.join(gitDirectory, 'release-apply.reclaim.lock');

  try {
    return acquiredLock(lockPath, createLock(lockPath), null);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  let stale;
  try {
    stale = inspectStaleLock(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw lockChangedError(lockPath);
    throw error;
  }

  const reclaim = acquireReclaimLock(reclaimPath);
  try {
    // Re-read only after owning R. Any replacement, even another stale-looking
    // generation, belongs to another recovery and is refused rather than
    // deleted. If L vanished, createLock('wx') below safely arbitrates the race.
    let current = null;
    try {
      current = inspectStaleLock(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current !== null) {
      if (current.raw !== stale.raw) throw lockChangedError(lockPath);
      quarantineStaleLock(lockPath, current);
    }

    let token;
    try {
      token = createLock(lockPath);
    } catch (error) {
      if (error.code === 'EEXIST') throw currentLockedError(lockPath);
      throw error;
    }
    const notice = [reclaim.notice, current?.notice ?? stale.notice].filter(Boolean).join(' ');
    return acquiredLock(lockPath, token, notice);
  } finally {
    releaseOwnedLock(reclaimPath, reclaim.token);
  }
}

// ---------------------------------------------------------------------------
// Clean work tree check (read-only; used before --apply writes anything)
// ---------------------------------------------------------------------------

export function dirtyWorktreeEntries(repo) {
  const result = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  if (result.error) {
    throw new ReleaseError('GIT_UNAVAILABLE', `cannot run git to check the work tree: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr).trim() || `exit code ${result.status}`;
    throw new ReleaseError('GIT_CHECK_FAILED', `git status failed in ${repo}: ${detail}`);
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export function runRelease(options = {}) {
  if (!options.apply) return { plan: computePlan(options), applied: false };
  // Serialize the entire apply operation, including validation, so a competing
  // process cannot act on a plan computed before the current holder's writes.
  const lock = acquireReleaseLock(path.resolve(options.repo ?? process.cwd()));
  try {
    const plan = computePlan(options);
    const dirty = dirtyWorktreeEntries(plan.repo);
    if (dirty.length > 0) {
      const shown = dirty.slice(0, 10).join('\n  ');
      const more = dirty.length > 10 ? `\n  ... and ${dirty.length - 10} more` : '';
      throw new ReleaseError('DIRTY_WORKTREE', `refusing --apply: the work tree is not clean (git status --porcelain is not empty)\n  ${shown}${more}\ncommit or stash your changes first`);
    }
    applyPlan(plan);
    return { plan, applied: true, lockNotice: lock.notice };
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function splitLines(text) {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffOps(aLines, bLines) {
  const n = aLines.length;
  const m = bLines.length;
  if ((n + 1) * (m + 1) > 4_000_000) {
    // Safety valve for pathologically large files: fall back to a full replace.
    return [
      ...aLines.map((text) => ({ type: '-', text })),
      ...bLines.map((text) => ({ type: '+', text })),
    ];
  }
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = aLines[i] === bLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      ops.push({ type: ' ', text: aLines[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: '-', text: aLines[i] });
      i++;
    } else {
      ops.push({ type: '+', text: bLines[j] });
      j++;
    }
  }
  for (; i < n; i++) ops.push({ type: '-', text: aLines[i] });
  for (; j < m; j++) ops.push({ type: '+', text: bLines[j] });
  return ops;
}

function unifiedHunks(ops, context) {
  const changed = [];
  ops.forEach((op, index) => {
    if (op.type !== ' ') changed.push(index);
  });
  if (changed.length === 0) return [];
  const groups = [];
  let group = [changed[0]];
  for (let k = 1; k < changed.length; k++) {
    if (changed[k] - group[group.length - 1] <= context * 2 + 1) group.push(changed[k]);
    else {
      groups.push(group);
      group = [changed[k]];
    }
  }
  groups.push(group);
  return groups.map((indices) => {
    const start = Math.max(0, indices[0] - context);
    const end = Math.min(ops.length - 1, indices[indices.length - 1] + context);
    const slice = ops.slice(start, end + 1);
    let aStart = 0;
    let bStart = 0;
    for (let index = 0; index < start; index++) {
      if (ops[index].type !== '+') aStart++;
      if (ops[index].type !== '-') bStart++;
    }
    let aCount = 0;
    let bCount = 0;
    for (const op of slice) {
      if (op.type !== '+') aCount++;
      if (op.type !== '-') bCount++;
    }
    const aLine = aCount === 0 ? aStart : aStart + 1;
    const bLine = bCount === 0 ? bStart : bStart + 1;
    return {
      header: `@@ -${aLine},${aCount} +${bLine},${bCount} @@`,
      body: slice.map((op) => `${op.type}${op.text}`),
    };
  });
}

function renderFileDiff(file) {
  const aLines = file.before === null ? [] : splitLines(file.before);
  const bLines = splitLines(file.after);
  const fromName = file.action === 'create' ? '/dev/null' : `a/${file.path}`;
  const hunks = unifiedHunks(diffOps(aLines, bLines), 3);
  const lines = [`diff --git ${fromName} b/${file.path}`, `--- ${fromName}`, `+++ b/${file.path}`];
  if (hunks.length === 0) lines.push('(no textual changes)');
  for (const hunk of hunks) lines.push(hunk.header, ...hunk.body);
  return lines.join('\n');
}

function renderHuman(result) {
  const { plan, applied, lockNotice } = result;
  const lines = [
    `${applied ? 'Applying' : 'Planning'} release of ${plan.packageName}: ${plan.currentVersion} -> ${plan.nextVersion} (${plan.date})`,
    `Repository: ${plan.repo}`,
  ];
  if (lockNotice) lines.push(lockNotice);
  for (const file of plan.files) lines.push(renderFileDiff(file));
  if (applied) {
    lines.push(
      `Applied changes to ${plan.files.map((file) => file.path).join(' and ')} (atomic tmp file + rename).`,
      'The work tree is now dirty on purpose: review the result, then commit and tag manually.',
      'This script never runs git commit, tag, or push.',
    );
  } else {
    lines.push('Dry run: no files were modified. Re-run with --apply to write these changes.');
  }
  return `${lines.join('\n')}\n`;
}

function jsonSummary({ plan, applied, lockNotice }) {
  return {
    ok: true,
    dryRun: !applied,
    ...(lockNotice ? { lockNotice } : {}),
    repo: plan.repo,
    packageName: plan.packageName,
    currentVersion: plan.currentVersion,
    nextVersion: plan.nextVersion,
    date: plan.date,
    files: plan.files.map((file) => ({
      path: file.path,
      action: file.action,
      bytesBefore: file.before === null ? null : Buffer.byteLength(file.before, 'utf8'),
      bytesAfter: Buffer.byteLength(file.after, 'utf8'),
    })),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/release.mjs --version <semver> [options]

Local release helper: bump the package.json version and promote the CHANGELOG
"## [Unreleased]" section into a "## [<version>] - <date>" section while keeping
a fresh empty Unreleased section on top. Never commits, tags, pushes, or uses
the network.

Options:
  --version <semver>   Target version, for example 0.3.0. Must be strictly
                       greater than the current package.json version
                       (semver precedence; prerelease suffixes such as
                       0.3.0-rc.1 are supported).
  --date <YYYY-MM-DD>  Release date recorded in the CHANGELOG section
                       (default: today, local time).
  --apply              Write the files. Without this flag the script is a
                       dry run that only prints the planned diff and never
                       writes anything.
  --repo <path>        Repository directory to operate on (default: cwd).
  --json               Print machine-readable JSON (errors go to stderr as
                       JSON with ok:false, code, and message).
  --create-changelog   When CHANGELOG.md is missing, create a minimal
                       skeleton instead of failing. An existing CHANGELOG.md
                       without a "## [Unreleased]" section is always an error.
  --help               Show this help.

Safety:
  - Dry run never writes any file or acquires the apply lock.
  - --apply is serialized with <git-dir>/release-apply.lock. Automatic takeover
    requires the holder pid to be confirmed gone (ESRCH). Live or unknown
    holders fail with RELEASE_LOCKED, regardless of lock age; inspect unknown
    holders manually. The same rule protects the stale-lock recovery lock.
  - --apply refuses a dirty work tree (git status --porcelain must be empty).
  - Before any write, all targets are checked against the plan's original
    contents (new files must still be absent). A mismatch or unreadable target
    fails with RELEASE_PLAN_STALE without writing any files.
  - Files are written atomically (temporary file + rename) and the first file
    is rolled back best effort if writing the second one fails. This is not
    a multi-file transaction and cannot serialize non-cooperating writers.

Exit codes: 0 on success (including dry run), 1 on any validation or write error.`;

const FLAG_NAMES = new Set(['--help', '-h', '--apply', '--json', '--create-changelog']);
const VALUE_NAMES = new Set(['--version', '--date', '--repo']);

export function parseArgs(argv) {
  const options = { apply: false, json: false, createChangelog: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const equals = argument.indexOf('=');
    const name = argument.startsWith('--') && equals !== -1 ? argument.slice(0, equals) : argument;
    if (FLAG_NAMES.has(name)) {
      if (name !== argument) throw new ReleaseError('INVALID_ARG', `flag ${name} does not take a value: ${argument}`);
      if (name === '-h' || name === '--help') options.help = true;
      else if (name === '--apply') options.apply = true;
      else if (name === '--json') options.json = true;
      else options.createChangelog = true;
    } else if (VALUE_NAMES.has(name)) {
      const value = name !== argument ? argument.slice(equals + 1) : argv[++index];
      if (value === undefined) throw new ReleaseError('MISSING_VALUE', `${name} requires a value, for example ${name} 0.3.0`);
      const key = name.slice(2);
      options[key] = value;
    } else {
      throw new ReleaseError('UNKNOWN_ARG', `unknown argument: ${argument} (see --help)`);
    }
  }
  return options;
}

export function cliMain(argv = process.argv.slice(2), io = process) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (argv.includes('--json')) {
      io.stderr.write(`${JSON.stringify({ ok: false, code: error.code ?? 'ERROR', message: error.message })}\n`);
    } else {
      io.stderr.write(`release: error: ${error.message}\n`);
    }
    return 1;
  }
  if (options.help) {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const result = runRelease(options);
    if (options.json) io.stdout.write(`${JSON.stringify(jsonSummary(result))}\n`);
    else io.stdout.write(renderHuman(result));
    return 0;
  } catch (error) {
    if (options.json) {
      io.stderr.write(`${JSON.stringify({ ok: false, code: error.code ?? 'ERROR', message: error.message })}\n`);
    } else {
      io.stderr.write(`release: error: ${error.message}\n`);
    }
    return 1;
  }
}

const isCliEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCliEntry) {
  process.exitCode = cliMain();
}

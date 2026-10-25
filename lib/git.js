import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { TowerError } from './errors.js';

const MAX_BUFFER = 8 * 1024 * 1024;
const DIAGNOSTIC_LIMIT = 8192;

function bounded(value) {
  return String(value ?? '').slice(0, DIAGNOSTIC_LIMIT);
}

/** Run git without a shell. Only literal argument arrays are accepted. */
export async function runGit(cwd, args, options = {}) {
  const { signal, timeoutMs = 120_000, allowedExitCodes = [0] } = options;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('git arguments must be a string array');
  }
  return await new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        timeout: timeoutMs,
        signal,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        const code = typeof error?.code === 'number' ? error.code : 0;
        const result = { code, stdout: String(stdout).trimEnd(), stderr: String(stderr).trimEnd() };
        if (error === null || (typeof error.code === 'number' && allowedExitCodes.includes(code))) {
          resolve(result);
          return;
        }
        reject(new TowerError(
          signal?.aborted ? 'GIT_ABORTED' : 'GIT_FAILED',
          `git ${args.join(' ')} failed${typeof error.code === 'number' ? ` (${error.code})` : ''}: ${bounded(stderr || error.message)}`,
          { args: [...args], exitCode: error.code, stderr: bounded(stderr) },
          { cause: error },
        ));
      },
    );
  });
}

export async function gitOut(cwd, args, options = {}) {
  const result = await runGit(cwd, args, options);
  if (result.code !== 0) {
    throw new TowerError('GIT_UNEXPECTED_EXIT', `git ${args.join(' ')} returned ${result.code}`, result);
  }
  return result.stdout;
}

export async function repoRoot(cwd, signal) {
  return await gitOut(cwd, ['rev-parse', '--show-toplevel'], { signal });
}

export async function head(cwd, signal, ref = 'HEAD') {
  return await gitOut(cwd, ['rev-parse', '--verify', `${ref}^{commit}`], { signal });
}

export async function currentBranch(cwd, signal) {
  const result = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { signal, allowedExitCodes: [0, 1] });
  if (result.code === 1 || !result.stdout) throw new TowerError('DETACHED_HEAD', 'the main checkout is in detached HEAD; check out a local base branch first');
  return result.stdout;
}

export async function status(cwd, signal) {
  const raw = await gitOut(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '-z'], { signal });
  const entries = raw.split('\0').filter(Boolean);
  return { clean: entries.length === 0, entries };
}

export async function assertClean(cwd, signal, code = 'WORKTREE_DIRTY') {
  const state = await status(cwd, signal);
  if (!state.clean) {
    throw new TowerError(code, `${cwd} has uncommitted or untracked files`, { entries: state.entries.slice(0, 50) });
  }
}

export async function isAncestor(cwd, ancestor, descendant, signal) {
  const result = await runGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], {
    signal,
    allowedExitCodes: [0, 1],
  });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new TowerError('GIT_ANCESTRY_FAILED', `could not compare ${ancestor} and ${descendant}`, result);
}

export async function changedFiles(cwd, base, tip, signal) {
  const raw = await gitOut(cwd, ['diff', '--name-only', '--no-renames', '-z', `${base}...${tip}`], { signal });
  return raw.split('\0').filter(Boolean);
}

export async function rebaseInProgress(cwd, signal) {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const value = await gitOut(cwd, ['rev-parse', '--git-path', name], { signal });
    try {
      await stat(path.resolve(cwd, value));
      return true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return false;
}

export async function localExcludeFile(cwd, signal) {
  const value = await gitOut(cwd, ['rev-parse', '--git-path', 'info/exclude'], { signal });
  return value;
}

#!/usr/bin/env node
/**
 * tower-doctor — read-only diagnostics for Tower state (`.dsh-tower/state.json`).
 *
 * Cross-checks the Tower state file against the actual Git repository using
 * read-only git commands (`worktree list`, `rev-parse`, `log`) plus filesystem
 * presence tests. It performs no writes of any kind: no state edits, no git
 * mutations. Problems are only reported.
 *
 * Exit codes: 0 = all checks passed, 1 = warnings found, 2 = errors found.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const KNOWN_STATUSES = new Set([
  'pending',
  'worker_running',
  'worker_completed',
  'worker_failed',
  'review_running',
  'changes_requested',
  'approved',
  'rebase_blocked',
  'merge_blocked',
  'merged',
  'abandoned',
]);

/** Statuses whose branch/worktree artifacts are still required to exist. */
const ACTIVE_STATUSES = new Set([
  'pending',
  'worker_running',
  'worker_completed',
  'worker_failed',
  'review_running',
  'changes_requested',
  'approved',
  'rebase_blocked',
  'merge_blocked',
]);

const USAGE = `Usage: node scripts/tower-doctor.mjs [options]

Read-only diagnostics for Tower state (.dsh-tower/state.json) vs the repository.

Options:
  --repo <path>    Repository to inspect (default: current working directory)
  --state <path>   Tower state file (default: <repo>/.dsh-tower/state.json)
  --json           Print machine-readable JSON instead of human-readable text
  --help, -h       Show this help

Checks: state structure (version, required fields, missions), repo identity,
base branch vs recorded baseCommit, mission branches, worktree registration
and existence, orphan worktrees, merged missions' mergeCommit ancestry on the
base branch, teardown consistency, and running activations whose records look
finished (reported only — the doctor never repairs anything).

Exit codes: 0 = all checks passed, 1 = warnings found, 2 = errors found
(or invalid usage). This tool performs no writes of any kind.`;

function finding(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

function short(hash) {
  return String(hash).slice(0, 10);
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/, 1)[0];
}

/** Run git capturing output; never throws on non-zero exits (read-only usage). */
async function runGitCapture(cwd, args) {
  return await new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : (typeof error?.code === 'number' ? error.code : -1);
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

async function isDirectory(candidate) {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `git log -n 1 --format=%H <from>..<to>` — true when `to` has commits that
 * `from` cannot reach. Returns undefined when git could not answer.
 */
async function rangeHasCommits(execGit, cwd, from, to) {
  const result = await execGit(cwd, ['log', '-n', '1', '--format=%H', `${from}..${to}`]);
  if (result.code !== 0) return undefined;
  return result.stdout.trim().length > 0;
}

export function parseArgs(argv) {
  const options = { repo: undefined, state: undefined, json: false, help: false, error: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    const match = /^--(repo|state)(?:=(.*))?$/.exec(argument);
    if (match) {
      const value = match[2] !== undefined ? match[2] : argv[index + 1];
      if (value === undefined) {
        options.error = `missing value for --${match[1]}`;
        return options;
      }
      if (match[2] === undefined) index += 1;
      options[match[1]] = value;
      continue;
    }
    options.error = `unknown option: ${argument}`;
    return options;
  }
  return options;
}

/**
 * Structural validation of a parsed state object (mirrors lib/store.js rules).
 * Returns findings plus whether the state is trustworthy enough for git
 * cross-checks (no error-severity structural findings).
 */
export function validateStateStructure(state) {
  const findings = [];
  const fail = (code, message, extra) => findings.push(finding(code, 'error', message, extra));
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    fail('STATE_CORRUPT', 'state must be a JSON object');
    return { findings, valid: false };
  }
  if (state.version !== 1) {
    fail('STATE_VERSION', `unsupported state version ${JSON.stringify(state.version)} (expected 1)`, { field: 'version' });
  }
  if (typeof state.repoRoot !== 'string' || !path.isAbsolute(state.repoRoot)) {
    fail('STATE_FIELD_INVALID', 'repoRoot must be an absolute path', { field: 'repoRoot' });
  }
  if (typeof state.baseBranch !== 'string' || state.baseBranch.length === 0) {
    fail('STATE_FIELD_INVALID', 'baseBranch must be a non-empty string', { field: 'baseBranch' });
  }
  if (typeof state.baseCommit !== 'string' || state.baseCommit.length === 0) {
    fail('STATE_FIELD_INVALID', 'baseCommit must be a non-empty string', { field: 'baseCommit' });
  }
  if (!Array.isArray(state.missions)) {
    fail('STATE_FIELD_INVALID', 'missions must be an array', { field: 'missions' });
    return { findings, valid: false };
  }

  const ids = new Set();
  for (const [index, mission] of state.missions.entries()) {
    const label = mission?.id ?? `#${index}`;
    if (mission === null || typeof mission !== 'object' || Array.isArray(mission)) {
      fail('MISSION_FIELD_INVALID', `mission ${label} must be an object`, { mission: label });
      continue;
    }
    for (const field of ['id', 'title', 'branch', 'worktree', 'status']) {
      if (typeof mission[field] !== 'string' || mission[field].length === 0) {
        fail('MISSION_FIELD_INVALID', `mission ${label}: field ${field} must be a non-empty string`, { mission: label, field });
      }
    }
    if (typeof mission.worktree === 'string' && mission.worktree.length > 0 && !path.isAbsolute(mission.worktree)) {
      fail('MISSION_FIELD_INVALID', `mission ${mission.id}: worktree must be an absolute path`, { mission: mission.id, field: 'worktree' });
    }
    if (typeof mission.baseCommit !== 'string' || mission.baseCommit.length === 0) {
      fail('MISSION_FIELD_INVALID', `mission ${label}: baseCommit must be a non-empty string`, { mission: label, field: 'baseCommit' });
    }
    if (typeof mission.status === 'string' && !KNOWN_STATUSES.has(mission.status)) {
      fail('MISSION_FIELD_INVALID', `mission ${mission.id}: unknown status ${JSON.stringify(mission.status)}`, { mission: mission.id, field: 'status' });
    }
    if (!Array.isArray(mission.dependsOn) || mission.dependsOn.some((id) => typeof id !== 'string')) {
      fail('MISSION_FIELD_INVALID', `mission ${label}: dependsOn must be a string array`, { mission: label, field: 'dependsOn' });
    }
    if (!Array.isArray(mission.scope) || mission.scope.some((pattern) => typeof pattern !== 'string')) {
      fail('MISSION_FIELD_INVALID', `mission ${label}: scope must be a string array`, { mission: label, field: 'scope' });
    }
    if (!Number.isSafeInteger(mission.revision) || mission.revision <= 0) {
      fail('MISSION_FIELD_INVALID', `mission ${label}: revision must be a positive integer`, { mission: label, field: 'revision' });
    }
    if (typeof mission.id === 'string' && mission.id.length > 0) {
      if (ids.has(mission.id)) {
        fail('MISSION_DUPLICATE', `duplicate mission id ${mission.id}`, { mission: mission.id });
      } else {
        ids.add(mission.id);
      }
    }
  }
  for (const mission of state.missions) {
    if (mission === null || typeof mission !== 'object' || !Array.isArray(mission.dependsOn)) continue;
    for (const dependency of mission.dependsOn) {
      if (!ids.has(dependency)) {
        findings.push(finding('MISSION_DEP_UNKNOWN', 'warning', `mission ${mission.id}: depends on unknown mission ${dependency}`, { mission: mission.id, dependsOn: dependency }));
      }
    }
  }
  return { findings, valid: findings.every((item) => item.severity !== 'error') };
}

/** Parse `git worktree list --porcelain` output into worktree descriptors. */
export function parseWorktreeList(text) {
  const worktrees = [];
  let current;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line === '') {
      current = undefined;
      continue;
    }
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), head: undefined, branch: undefined, prunable: false };
      worktrees.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line.startsWith('prunable')) {
      current.prunable = true;
    }
  }
  return worktrees;
}

/**
 * Collect all diagnostic findings for one repository + state file.
 * Read-only: runs `git rev-parse`, `git worktree list`, and `git log`
 * (all query-only) plus fs reads. Returns a report object:
 * { repo, statePath, baseBranch?, baseTip?, checksPassed, findings }.
 */
export async function collectFindings(options = {}) {
  const execGit = options.execGit ?? runGitCapture;
  const findings = [];
  const report = { repo: undefined, statePath: undefined, baseBranch: undefined, baseTip: undefined, checksPassed: 0, findings };

  const repoInput = options.repo ?? process.cwd();
  const root = await execGit(repoInput, ['rev-parse', '--show-toplevel']);
  if (root.code !== 0) {
    findings.push(finding('REPO_INVALID', 'error', `could not resolve a Git repository at ${repoInput}: ${firstLine(root.stderr) || `git exited ${root.code}`}`, { repo: repoInput }));
    return report;
  }
  const repoRoot = root.stdout.trim();
  report.repo = repoRoot;
  const statePath = path.resolve(options.statePath ?? path.join(repoRoot, '.dsh-tower', 'state.json'));
  report.statePath = statePath;

  let raw;
  try {
    raw = await readFile(statePath, 'utf8');
  } catch (error) {
    const code = error?.code === 'ENOENT' ? 'STATE_MISSING' : 'STATE_READ_FAILED';
    findings.push(finding(code, 'error', code === 'STATE_MISSING' ? `Tower state file not found: ${statePath}` : `could not read ${statePath}: ${error?.message ?? error}`, { statePath }));
    return report;
  }

  let state;
  try {
    state = JSON.parse(raw);
  } catch (error) {
    findings.push(finding('STATE_CORRUPT', 'error', `state.json is not valid JSON: ${error?.message ?? error}`, { statePath }));
    return report;
  }

  const structure = validateStateStructure(state);
  findings.push(...structure.findings);
  if (!structure.valid) return report;
  report.checksPassed += 1;
  report.baseBranch = state.baseBranch;

  if (path.resolve(state.repoRoot) !== repoRoot) {
    findings.push(finding('REPO_MISMATCH', 'warning', `state.repoRoot (${state.repoRoot}) does not match this repository (${repoRoot})`, { recorded: state.repoRoot, actual: repoRoot }));
  } else {
    report.checksPassed += 1;
  }

  let baseTip;
  const baseRef = await execGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${state.baseBranch}^{commit}`]);
  if (baseRef.code !== 0) {
    findings.push(finding('BASE_BRANCH_MISSING', 'error', `base branch ${state.baseBranch} does not exist`, { baseBranch: state.baseBranch }));
  } else {
    baseTip = baseRef.stdout.trim();
    report.baseTip = baseTip;
    report.checksPassed += 1;
  }

  const baseCommitRef = await execGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${state.baseCommit}^{commit}`]);
  if (baseCommitRef.code !== 0) {
    findings.push(finding('BASE_COMMIT_UNKNOWN', 'error', `recorded baseCommit ${state.baseCommit} does not resolve to a commit`, { baseCommit: state.baseCommit }));
  } else {
    report.checksPassed += 1;
    if (baseTip === state.baseCommit) {
      report.checksPassed += 1;
    } else if (baseTip !== undefined) {
      const tipAhead = await rangeHasCommits(execGit, repoRoot, state.baseCommit, baseTip);
      const recordedAhead = await rangeHasCommits(execGit, repoRoot, baseTip, state.baseCommit);
      const detail = { baseBranch: state.baseBranch, baseCommit: state.baseCommit, ...(baseTip === undefined ? {} : { baseTip }) };
      if (tipAhead === undefined || recordedAhead === undefined) {
        findings.push(finding('BASE_COMPARE_FAILED', 'error', `could not compare baseCommit ${short(state.baseCommit)} with base branch ${state.baseBranch}`, detail));
      } else if (tipAhead && !recordedAhead) {
        findings.push(finding('BASE_COMMIT_DRIFT', 'warning', `base branch ${state.baseBranch} has advanced beyond recorded baseCommit ${short(state.baseCommit)} (tip ${short(baseTip)})`, detail));
      } else if (!tipAhead && recordedAhead) {
        findings.push(finding('BASE_COMMIT_DIVERGED', 'error', `base branch ${state.baseBranch} (${short(baseTip)}) is behind recorded baseCommit ${short(state.baseCommit)}; was the base branch reset?`, detail));
      } else if (tipAhead && recordedAhead) {
        findings.push(finding('BASE_COMMIT_DIVERGED', 'error', `recorded baseCommit ${short(state.baseCommit)} diverges from base branch ${state.baseBranch} (tip ${short(baseTip)})`, detail));
      }
    }
  }

  let worktrees = [];
  const worktreeList = await execGit(repoRoot, ['worktree', 'list', '--porcelain']);
  if (worktreeList.code !== 0) {
    findings.push(finding('WORKTREE_LIST_FAILED', 'error', `git worktree list failed: ${firstLine(worktreeList.stderr) || `git exited ${worktreeList.code}`}`));
  } else {
    worktrees = parseWorktreeList(worktreeList.stdout);
  }
  const registeredByPath = new Map(worktrees.map((entry) => [path.resolve(entry.path), entry]));

  for (const mission of state.missions) {
    const active = ACTIVE_STATUSES.has(mission.status);

    const branchRef = await execGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${mission.branch}^{commit}`]);
    if (branchRef.code !== 0) {
      findings.push(finding('MISSION_BRANCH_MISSING', active ? 'error' : 'warning', `mission ${mission.id}: branch ${mission.branch} does not exist`, { mission: mission.id, branch: mission.branch }));
    } else {
      report.checksPassed += 1;
    }

    const missionBaseRef = await execGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${mission.baseCommit}^{commit}`]);
    if (missionBaseRef.code !== 0) {
      findings.push(finding('MISSION_BASE_UNKNOWN', 'error', `mission ${mission.id}: baseCommit ${mission.baseCommit} does not resolve to a commit`, { mission: mission.id, baseCommit: mission.baseCommit }));
    } else {
      report.checksPassed += 1;
    }

    const worktreePath = path.resolve(mission.worktree);
    const registered = registeredByPath.get(worktreePath);
    const exists = await isDirectory(worktreePath);
    if (mission.worktreeRemoved) {
      let consistent = true;
      if (exists) {
        consistent = false;
        findings.push(finding('TEARDOWN_INCOMPLETE', 'error', `mission ${mission.id}: worktreeRemoved is true but ${worktreePath} still exists`, { mission: mission.id, path: worktreePath }));
      }
      if (registered !== undefined) {
        consistent = false;
        findings.push(finding('WORKTREE_STILL_REGISTERED', 'error', `mission ${mission.id}: worktreeRemoved is true but ${worktreePath} is still a registered git worktree`, { mission: mission.id, path: worktreePath }));
      }
      if (consistent) report.checksPassed += 1;
    } else if (!exists) {
      findings.push(finding('WORKTREE_DIR_MISSING', active ? 'error' : 'warning', `mission ${mission.id}: worktree ${worktreePath} does not exist but worktreeRemoved is false`, { mission: mission.id, path: worktreePath }));
    } else if (registered === undefined) {
      findings.push(finding('WORKTREE_UNREGISTERED', 'warning', `mission ${mission.id}: directory ${worktreePath} exists but is not a registered git worktree`, { mission: mission.id, path: worktreePath }));
    } else if (registered.branch !== undefined && registered.branch !== mission.branch) {
      findings.push(finding('WORKTREE_BRANCH_MISMATCH', 'warning', `mission ${mission.id}: worktree ${worktreePath} is on branch ${registered.branch}, expected ${mission.branch}`, { mission: mission.id, path: worktreePath, branch: registered.branch, expected: mission.branch }));
    } else {
      report.checksPassed += 1;
    }

    if (mission.status === 'merged') {
      const mergeCommit = mission.merge?.commit;
      if (typeof mergeCommit !== 'string' || mergeCommit.length === 0) {
        findings.push(finding('MERGE_RECORD_MISSING', 'error', `mission ${mission.id}: status is merged but merge.commit is missing`, { mission: mission.id }));
      } else if (baseTip === undefined) {
        // Base branch missing is already reported; ancestry cannot be checked.
      } else {
        const mergeRef = await execGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${mergeCommit}^{commit}`]);
        if (mergeRef.code !== 0) {
          findings.push(finding('MERGE_COMMIT_UNKNOWN', 'error', `mission ${mission.id}: mergeCommit ${mergeCommit} does not resolve to a commit`, { mission: mission.id, mergeCommit }));
        } else {
          const outsideBase = await rangeHasCommits(execGit, repoRoot, baseTip, mergeCommit);
          if (outsideBase === undefined) {
            findings.push(finding('MERGE_COMMIT_UNKNOWN', 'error', `mission ${mission.id}: could not compare mergeCommit ${short(mergeCommit)} with base branch ${state.baseBranch}`, { mission: mission.id, mergeCommit }));
          } else if (outsideBase) {
            findings.push(finding('MERGE_COMMIT_NOT_IN_BASE', 'error', `mission ${mission.id}: mergeCommit ${short(mergeCommit)} is not reachable from base branch ${state.baseBranch} (${short(baseTip)})`, { mission: mission.id, mergeCommit, baseBranch: state.baseBranch, baseTip }));
          } else {
            report.checksPassed += 1;
          }
        }
      }
    }

    if (mission.status === 'worker_running' || mission.status === 'review_running') {
      const role = mission.status === 'worker_running' ? 'worker' : 'reviewer';
      const record = role === 'worker' ? mission.worker : mission.review;
      if (record === null || typeof record !== 'object' || typeof record.runId !== 'string' || record.runId.length === 0) {
        findings.push(finding('RUNNING_RECORD_MISSING', 'error', `mission ${mission.id}: status is ${mission.status} but the ${role} run record is missing (possible leaked or corrupted activation; doctor only reports)`, { mission: mission.id, role }));
      } else if (record.completedAt !== undefined || record.stopReason !== undefined || record.error !== undefined || record.stale === true) {
        findings.push(finding('RUNNING_RECORD_FINISHED', 'warning', `mission ${mission.id}: ${role} run ${record.runId} already ended but status is still ${mission.status}; run tower recover to reconcile (doctor only reports)`, { mission: mission.id, role, runId: record.runId }));
      } else {
        report.checksPassed += 1;
      }
    }
  }

  // Orphan worktrees: paths under the tower worktrees directory (derived from
  // mission worktree paths, falling back to <state dir>/worktrees) that no
  // mission references — registered with git or leftover on disk.
  const worktreesDir = state.missions.length > 0
    ? path.dirname(path.resolve(state.missions[0].worktree))
    : path.join(path.dirname(statePath), 'worktrees');
  const referenced = new Set(state.missions.map((mission) => path.resolve(mission.worktree)));
  const underWorktreesDir = (candidate) => candidate.startsWith(`${worktreesDir}${path.sep}`);
  for (const entry of worktrees) {
    const entryPath = path.resolve(entry.path);
    if (!underWorktreesDir(entryPath) || referenced.has(entryPath)) continue;
    findings.push(finding('ORPHAN_WORKTREE', 'warning', `git worktree ${entryPath} is registered but not referenced by any mission`, { path: entryPath, registered: true }));
  }
  let diskEntries = [];
  try {
    diskEntries = await readdir(worktreesDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      findings.push(finding('WORKTREE_SCAN_FAILED', 'warning', `could not scan ${worktreesDir}: ${error?.message ?? error}`, { path: worktreesDir }));
    }
  }
  for (const entry of diskEntries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(worktreesDir, entry.name);
    if (referenced.has(entryPath) || registeredByPath.has(entryPath)) continue;
    findings.push(finding('ORPHAN_WORKTREE', 'warning', `directory ${entryPath} exists under the tower worktrees directory but is neither referenced by a mission nor registered as a git worktree`, { path: entryPath, registered: false }));
  }

  return report;
}

function renderHuman(report, summary) {
  const lines = [
    'tower-doctor — read-only Tower state diagnostics',
    `repo:  ${report.repo ?? '(unresolved)'}`,
    `state: ${report.statePath ?? '(unresolved)'}`,
    '',
  ];
  if (report.findings.length === 0) {
    lines.push(`no problems found (${summary.checksPassed} checks passed)`);
  } else {
    for (const item of report.findings) {
      lines.push(`[${item.severity}] ${item.code}: ${item.message}`);
    }
    lines.push('');
    lines.push(`${summary.checksPassed} checks passed, ${summary.warnings} warning(s), ${summary.errors} error(s)`);
  }
  return lines.join('\n');
}

/**
 * Full doctor run for an argv. Returns
 * { exitCode, usageError, findings, summary, text, output, json }.
 * `output` is what the CLI should print (JSON text when --json was given).
 */
export async function runDoctor(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    const text = `${USAGE}\n\nerror: ${parsed.error}\n`;
    return { exitCode: 2, usageError: true, findings: [], summary: { checksPassed: 0, warnings: 0, errors: 0, exitCode: 2 }, text, output: text, json: null };
  }
  if (parsed.help) {
    return { exitCode: 0, usageError: false, findings: [], summary: { checksPassed: 0, warnings: 0, errors: 0, exitCode: 0 }, text: USAGE, output: `${USAGE}\n`, json: null };
  }
  const report = await collectFindings({ repo: parsed.repo, statePath: parsed.state });
  const errors = report.findings.filter((item) => item.severity === 'error').length;
  const warnings = report.findings.filter((item) => item.severity === 'warning').length;
  const exitCode = errors > 0 ? 2 : warnings > 0 ? 1 : 0;
  const summary = { checksPassed: report.checksPassed, warnings, errors, exitCode };
  const json = {
    repo: report.repo ?? null,
    statePath: report.statePath ?? null,
    ...(report.baseBranch === undefined ? {} : { baseBranch: report.baseBranch, baseTip: report.baseTip ?? null }),
    findings: report.findings,
    summary,
  };
  const text = renderHuman(report, summary);
  const output = parsed.json ? `${JSON.stringify(json, null, 2)}\n` : `${text}\n`;
  return { exitCode, usageError: false, findings: report.findings, summary, text, output, json };
}

const invokedAsScript = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  const result = await runDoctor(process.argv.slice(2));
  if (result.usageError) {
    process.stderr.write(result.output);
  } else {
    process.stdout.write(result.output);
  }
  process.exitCode = result.exitCode;
}

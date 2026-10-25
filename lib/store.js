import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertTower, TowerError } from './errors.js';

const STATUSES = new Set([
  'pending',
  'worker_running',
  'worker_completed',
  'worker_failed',
  'review_failed',
  'review_running',
  'changes_requested',
  'approved',
  'rebase_blocked',
  'merge_blocked',
  'merged',
  'abandoned',
]);

function validateMission(mission) {
  assertTower(mission && typeof mission === 'object', 'STATE_INVALID', 'mission must be an object');
  for (const field of ['id', 'title', 'branch', 'worktree', 'status']) {
    assertTower(typeof mission[field] === 'string' && mission[field].length > 0, 'STATE_INVALID', `mission ${field} is required`);
  }
  assertTower(STATUSES.has(mission.status), 'STATE_INVALID', `unknown mission status ${mission.status}`);
  assertTower(Array.isArray(mission.dependsOn) && mission.dependsOn.every((id) => typeof id === 'string'), 'STATE_INVALID', 'mission dependsOn must be a string array');
  assertTower(Array.isArray(mission.scope) && mission.scope.every((pattern) => typeof pattern === 'string'), 'STATE_INVALID', 'mission scope must be a string array');
  assertTower(Number.isSafeInteger(mission.revision) && mission.revision > 0, 'STATE_INVALID', 'mission revision must be positive');
}

export function validateState(state) {
  assertTower(state && typeof state === 'object', 'STATE_INVALID', 'Tower state must be an object');
  assertTower(state.version === 1, 'STATE_INVALID', `unsupported Tower state version ${state.version}`);
  assertTower(typeof state.repoRoot === 'string' && path.isAbsolute(state.repoRoot), 'STATE_INVALID', 'Tower repoRoot must be absolute');
  assertTower(typeof state.baseBranch === 'string' && state.baseBranch.length > 0, 'STATE_INVALID', 'Tower baseBranch is required');
  assertTower(typeof state.baseCommit === 'string' && state.baseCommit.length > 0, 'STATE_INVALID', 'Tower baseCommit is required');
  assertTower(Array.isArray(state.missions), 'STATE_INVALID', 'Tower missions must be an array');
  const ids = new Set();
  for (const mission of state.missions) {
    validateMission(mission);
    assertTower(!ids.has(mission.id), 'STATE_INVALID', `duplicate mission ${mission.id}`);
    ids.add(mission.id);
  }
  return state;
}

export class TowerStore {
  constructor(repoRoot, stateDirectory = '.dsh-tower') {
    assertTower(path.isAbsolute(repoRoot), 'REPO_ROOT_INVALID', 'repoRoot must be absolute');
    assertTower(typeof stateDirectory === 'string' && stateDirectory.length > 0 && !path.isAbsolute(stateDirectory), 'STATE_DIRECTORY_INVALID', 'stateDirectory must be a relative path inside the repository');
    this.repoRoot = repoRoot;
    this.directory = path.resolve(repoRoot, stateDirectory);
    const relative = path.relative(repoRoot, this.directory);
    assertTower(relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`), 'STATE_DIRECTORY_INVALID', 'stateDirectory must stay inside the repository');
    this.worktrees = path.join(this.directory, 'worktrees');
    this.statePath = path.join(this.directory, 'state.json');
    this.queue = Promise.resolve();
  }

  async ensureLayout() {
    await mkdir(this.worktrees, { recursive: true });
  }

  async exists() {
    try {
      await readFile(this.statePath, 'utf8');
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async read() {
    let raw;
    try {
      raw = await readFile(this.statePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new TowerError('TOWER_NOT_INITIALIZED', 'Tower is not initialized for this repository; run tower with action init first');
      }
      throw error;
    }
    try {
      return validateState(JSON.parse(raw));
    } catch (error) {
      if (error instanceof TowerError) throw error;
      throw new TowerError('STATE_INVALID', `could not parse ${this.statePath}: ${error.message}`, undefined, { cause: error });
    }
  }

  async write(state) {
    validateState(state);
    state.updatedAt = new Date().toISOString();
    await this.ensureLayout();
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.statePath);
    } catch (error) {
      // Best-effort cleanup: a cleanup failure must not replace the original error.
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async update(mutator) {
    const run = this.queue.then(async () => {
      const state = await this.read();
      const result = await mutator(state);
      await this.write(state);
      return result;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

export async function ensureLocalExclude(excludeFile, repoRoot, stateDirectory) {
  const absolute = path.resolve(repoRoot, excludeFile);
  let text = '';
  try {
    text = await readFile(absolute, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const entry = `${stateDirectory.replaceAll('\\', '/').replace(/\/$/, '')}/`;
  const lines = text.split(/\r?\n/);
  if (lines.includes(entry)) return;
  await mkdir(path.dirname(absolute), { recursive: true });
  const prefix = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
  await writeFile(absolute, `${text}${prefix}${entry}\n`, 'utf8');
}

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path, { matchesGlob } from 'node:path';
import { assertTower, TowerError, errorMessage } from './errors.js';
import {
  assertClean,
  changedFiles,
  currentBranch,
  gitOut,
  head,
  isAncestor,
  localExcludeFile,
  rebaseInProgress,
  repoRoot,
  runGit,
  status as gitStatus,
} from './git.js';
import { ensureLocalExclude, TowerStore } from './store.js';

const ACTIVE_STATUSES = new Set(['worker_running', 'review_running']);
const TERMINAL_STATUSES = new Set(['merged', 'abandoned']);
const BLOCKED_STATUSES = new Set(['rebase_blocked', 'merge_blocked']);
const WORKER_RESTARTABLE = new Set([
  'pending',
  'worker_completed',
  'worker_failed',
  'review_failed',
  'changes_requested',
  'approved',
  'rebase_blocked',
  'merge_blocked',
]);
// A reviewer may start from these statuses: a finished worker run, a failed
// review worth retrying, or a recorded verdict needing a fresh pass.
const REVIEW_RESTARTABLE = new Set(['worker_completed', 'review_failed', 'approved', 'changes_requested']);

function now() {
  return new Date().toISOString();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function text(value, field, maximum = 20_000) {
  assertTower(typeof value === 'string' && value.trim().length > 0, 'ARGUMENT_INVALID', `${field} must be a non-empty string`);
  assertTower(value.length <= maximum, 'ARGUMENT_INVALID', `${field} exceeds ${maximum} characters`);
  return value.trim();
}

function missionOf(state, id) {
  const mission = state.missions.find((candidate) => candidate.id === id);
  assertTower(mission, 'MISSION_NOT_FOUND', `mission ${id} does not exist`);
  return mission;
}

function runOf(state, runId) {
  for (const mission of state.missions) {
    for (const [role, record] of [['worker', mission.worker], ['reviewer', mission.review]]) {
      if (record?.runId === runId) return { mission, role, record };
    }
  }
  throw new TowerError('RUN_NOT_FOUND', `Tower run ${runId} does not exist`);
}

function appendEvent(state, event) {
  state.events ??= [];
  state.events.push({ time: now(), ...event });
  if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
}

function dependenciesReady(state, mission) {
  return mission.dependsOn.every((id) => {
    const dependency = state.missions.find((candidate) => candidate.id === id);
    return dependency && TERMINAL_STATUSES.has(dependency.status);
  });
}

/**
 * Reject dependsOn values that would make `missionId` participate in a
 * dependency cycle (including a direct self-reference). Only the edited
 * mission's edges are new, so any fresh cycle must be reachable from it.
 * @param state - current Tower state.
 * @param missionId - id of the mission being edited.
 * @param dependsOn - the prospective dependency ids for that mission.
 */
function assertNoDependencyCycle(state, missionId, dependsOn) {
  const trail = [missionId];
  const visited = new Set([missionId]);
  const walk = (id) => {
    for (const dependency of id === missionId ? dependsOn : missionOf(state, id).dependsOn) {
      if (dependency === missionId) {
        throw new TowerError('DEPENDENCY_CYCLE', `mission dependencies form a cycle: ${[...trail, missionId].join(' -> ')}`);
      }
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      trail.push(dependency);
      walk(dependency);
      trail.pop();
    }
  };
  walk(missionId);
}

function publicMission(mission) {
  return clone(mission);
}

/** Copy only the named fields that actually exist on a worker/review record. */
function compactRecord(record, fields) {
  const entry = {};
  for (const field of fields) {
    if (record[field] !== undefined) entry[field] = record[field];
  }
  return entry;
}

/** Locale-independent ascending order for optional route fields; null sorts first. */
function compareOptionalText(a, b) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

/**
 * Route aggregation for the compact summary: how many worker and reviewer runs
 * each provider/model/reasoning-effort route served across the whole tower.
 * Records of merged and abandoned missions still count — their runs consumed
 * quota like any other. A route field that was never supplied is reported as
 * null instead of being invented.
 */
function summaryRoutes(state) {
  const buckets = new Map();
  const bucketOf = (record) => {
    const provider = record.provider ?? null;
    const model = record.model ?? null;
    const reasoningEffort = record.reasoningEffort ?? null;
    const key = JSON.stringify([provider, model, reasoningEffort]);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { provider, model, reasoningEffort, workerCount: 0, reviewerCount: 0, total: 0 };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  for (const mission of state.missions) {
    if (mission.worker) {
      const bucket = bucketOf(mission.worker);
      bucket.workerCount += 1;
      bucket.total += 1;
    }
    if (mission.review) {
      const bucket = bucketOf(mission.review);
      bucket.reviewerCount += 1;
      bucket.total += 1;
    }
  }
  return [...buckets.values()].sort((a, b) => b.total - a.total
    || compareOptionalText(a.provider, b.provider)
    || compareOptionalText(a.model, b.model)
    || compareOptionalText(a.reasoningEffort, b.reasoningEffort));
}

/** One-line mission entry for the compact summary: no description, scope, worktree, or history. */
function summaryMission(mission) {
  return {
    id: mission.id,
    title: mission.title,
    status: mission.status,
    dependsOn: [...mission.dependsOn],
    worker: mission.worker ? compactRecord(mission.worker, ['provider', 'model', 'reasoningEffort', 'stopReason']) : null,
    review: mission.review ? compactRecord(mission.review, ['provider', 'model', 'verdict', 'merge']) : null,
    mergeCommit: mission.merge?.commit ?? null,
  };
}

function publicState(state, observations = undefined) {
  return {
    version: state.version,
    repoRoot: state.repoRoot,
    baseBranch: state.baseBranch,
    baseCommit: state.baseCommit,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    missions: state.missions.map(publicMission),
    events: clone(state.events?.slice(-20) ?? []),
    ...(observations === undefined ? {} : { observations: clone(observations) }),
  };
}

function validateScope(patterns) {
  assertTower(Array.isArray(patterns), 'ARGUMENT_INVALID', 'scope must be an array of glob patterns');
  for (const pattern of patterns) {
    assertTower(typeof pattern === 'string' && pattern.length > 0 && !pattern.includes('\0'), 'SCOPE_INVALID', 'scope patterns must be non-empty strings');
    assertTower(!path.isAbsolute(pattern) && !pattern.split(/[\\/]/).includes('..'), 'SCOPE_INVALID', `scope pattern must be repository-relative: ${pattern}`);
    try {
      matchesGlob('scope-probe', pattern);
    } catch (error) {
      throw new TowerError('SCOPE_INVALID', `invalid scope pattern: ${pattern}`, undefined, { cause: error });
    }
  }
  return [...new Set(patterns)];
}

export async function recoverRebaseFailure(worktree, previousTip, signal, operations = undefined) {
  const ops = operations ?? { runGit, head, status: gitStatus, rebaseInProgress };
  let abortError;
  try {
    await ops.runGit(worktree, ['rebase', '--abort'], { signal });
  } catch (error) {
    abortError = errorMessage(error);
  }
  const restoredTip = await ops.head(worktree, signal).catch(() => undefined);
  const restoredStatus = await ops.status(worktree, signal).catch(() => undefined);
  const inProgress = ops.rebaseInProgress ? await ops.rebaseInProgress(worktree, signal).catch(() => true) : false;
  const recoveryRequired = abortError !== undefined || restoredTip !== previousTip || restoredStatus?.clean !== true || inProgress;
  return {
    recoveryRequired,
    ...(abortError === undefined ? {} : { abortError }),
    ...(restoredTip === undefined ? {} : { restoredTip }),
    ...(restoredStatus === undefined ? {} : { clean: restoredStatus.clean }),
  };
}

export async function recoverMergeFailure(repoRoot, previousTip, signal, operations = undefined) {
  const ops = operations ?? { runGit, head, status: gitStatus };
  const before = await ops.runGit(repoRoot, ['rev-parse', '--verify', 'MERGE_HEAD'], { allowedExitCodes: [0, 1], signal }).catch(() => ({ code: 0 }));
  let abortError;
  if (before.code === 0) {
    try {
      await ops.runGit(repoRoot, ['merge', '--abort'], { signal });
    } catch (error) {
      abortError = errorMessage(error);
    }
  }
  const after = await ops.runGit(repoRoot, ['rev-parse', '--verify', 'MERGE_HEAD'], { allowedExitCodes: [0, 1], signal }).catch(() => ({ code: 0 }));
  const restoredHead = await ops.head(repoRoot, signal).catch(() => undefined);
  const restoredStatus = await ops.status(repoRoot, signal).catch(() => undefined);
  const remainingMergeState = after.code === 0;
  const recoveryRequired = abortError !== undefined || remainingMergeState || restoredHead !== previousTip || restoredStatus?.clean !== true;
  return {
    recoveryRequired,
    remainingMergeState,
    ...(abortError === undefined ? {} : { abortError }),
    ...(restoredHead === undefined ? {} : { restoredHead }),
    ...(restoredStatus === undefined ? {} : { clean: restoredStatus.clean }),
  };
}

function routeRecord(args) {
  return {
    ...(args.provider === undefined ? {} : { provider: args.provider }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
  };
}

export class TowerCore {
  constructor(options) {
    this.cwd = options.cwd;
    this.stateDirectory = options.stateDirectory ?? '.dsh-tower';
    this.branchPrefix = options.branchPrefix ?? 'tower';
    this.mergeOperations = options.mergeOperations ?? { head, isAncestor };
    this.store = undefined;
  }

  async init(args = {}) {
    const signal = args.signal;
    const root = await repoRoot(this.cwd, signal);
    const checkedOut = await currentBranch(root, signal);
    const baseBranch = args.baseBranch ?? checkedOut;
    assertTower(baseBranch === checkedOut, 'BASE_MISMATCH', `check out the requested base branch "${baseBranch}" before initializing Tower; current branch is "${checkedOut}"`);
    await assertClean(root, signal, 'BASE_DIRTY');
    const baseCommit = await head(root, signal, baseBranch);
    if (!this.store) this.store = new TowerStore(root, this.stateDirectory);
    assertTower(this.store.repoRoot === root, 'REPO_CHANGED', 'Tower controller repository changed while it was open');
    await this.store.ensureLayout();
    const exclude = await localExcludeFile(root, signal);
    await ensureLocalExclude(exclude, root, this.stateDirectory);
    if (await this.store.exists()) {
      const state = await this.store.read();
      assertTower(state.baseBranch === baseBranch, 'BASE_CONFLICT', `Tower is already anchored to "${state.baseBranch}", not "${baseBranch}"`);
      return publicState(state);
    }
    const state = {
      version: 1,
      repoRoot: root,
      baseBranch,
      baseCommit,
      createdAt: now(),
      updatedAt: now(),
      missions: [],
      events: [{ time: now(), type: 'initialized', baseBranch, baseCommit }],
    };
    await this.store.write(state);
    return publicState(state);
  }

  async open(signal) {
    const root = await repoRoot(this.cwd, signal);
    if (!this.store) this.store = new TowerStore(root, this.stateDirectory);
    assertTower(this.store.repoRoot === root, 'REPO_CHANGED', 'Tower controller repository changed while it was open');
    const state = await this.store.read();
    assertTower(state.repoRoot === root, 'REPO_MISMATCH', `Tower state belongs to ${state.repoRoot}, not ${root}`);
    return this.store;
  }

  requireStore() {
    assertTower(this.store, 'TOWER_NOT_INITIALIZED', 'run tower with action init first');
    return this.store;
  }

  async status(args = {}) {
    const state = await this.requireStore().read();
    if (!args.observe) return publicState(state);
    const observations = {
      checkedOutBranch: await currentBranch(state.repoRoot, args.signal).catch((error) => {
        if (error?.code === 'DETACHED_HEAD') return undefined;
        throw error;
      }),
      baseTip: await head(state.repoRoot, args.signal, state.baseBranch),
      baseStatus: await gitStatus(state.repoRoot, args.signal),
      missions: {},
    };
    for (const mission of state.missions) {
      const tip = mission.worktreeRemoved ? undefined : await head(mission.worktree, args.signal).catch(() => undefined);
      observations.missions[mission.id] = {
        ...(tip === undefined ? {} : { tip }),
        ...(mission.worktreeRemoved ? {} : {
          status: await gitStatus(mission.worktree, args.signal).catch((error) => ({ error: errorMessage(error) })),
        }),
      };
    }
    return publicState(state, observations);
  }

  async mission(id) {
    const state = await this.requireStore().read();
    return publicMission(missionOf(state, id));
  }

  /**
   * Compact read-only overview: global status counts, a global per-route
   * aggregate, plus one-line entries per mission. Pure read like
   * `mission`/`status` — no event, no revision bump, no `updatedAt` change.
   * `args.missionId` narrows the entries to that one mission; the counts and
   * routes always describe the whole tower.
   */
  async summary(args = {}) {
    const state = await this.requireStore().read();
    const count = (...statuses) => state.missions.filter((mission) => statuses.includes(mission.status)).length;
    const selected = args.missionId === undefined ? state.missions : [missionOf(state, args.missionId)];
    return {
      version: state.version,
      repoRoot: state.repoRoot,
      baseBranch: state.baseBranch,
      baseCommit: state.baseCommit,
      counts: {
        missions: state.missions.length,
        workerRunning: count('worker_running'),
        reviewRunning: count('review_running'),
        approved: count('approved'),
        merged: count('merged'),
        blocked: count(...BLOCKED_STATUSES),
        abandoned: count('abandoned'),
      },
      routes: summaryRoutes(state),
      missions: selected.map(summaryMission),
    };
  }

  async addMission(args) {
    const store = this.requireStore();
    return await store.update(async (state) => {
      const title = text(args.title, 'title', 200);
      const description = text(args.description, 'description');
      const dependsOn = args.dependsOn ?? [];
      assertTower(Array.isArray(dependsOn) && dependsOn.every((id) => typeof id === 'string'), 'ARGUMENT_INVALID', 'dependsOn must be a string array');
      for (const dependency of dependsOn) missionOf(state, dependency);
      assertTower(new Set(dependsOn).size === dependsOn.length, 'DEPENDENCY_INVALID', 'mission dependencies must not repeat');
      const scope = validateScope(args.scope === undefined ? [] : args.scope);
      let id = args.id;
      if (id !== undefined) {
        assertTower(/^[A-Z][A-Z0-9_-]{0,31}$/.test(id), 'MISSION_ID_INVALID', 'mission id must start with an uppercase letter and contain only uppercase letters, digits, _, or -');
      } else {
        const maximum = state.missions.reduce((value, mission) => {
          const match = /^M(\d+)$/.exec(mission.id);
          return match ? Math.max(value, Number(match[1])) : value;
        }, 0);
        id = `M${maximum + 1}`;
      }
      assertTower(!state.missions.some((mission) => mission.id === id), 'MISSION_EXISTS', `mission ${id} already exists`);
      const branch = `${this.branchPrefix}/${id.toLowerCase()}`;
      await gitOut(state.repoRoot, ['check-ref-format', '--branch', branch], { signal: args.signal });
      const worktree = path.join(store.worktrees, id.toLowerCase());
      const baseCommit = await head(state.repoRoot, args.signal, state.baseBranch);
      const branchRef = await runGit(state.repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowedExitCodes: [0, 1], signal: args.signal });
      const worktreeList = await gitOut(state.repoRoot, ['worktree', 'list', '--porcelain'], { signal: args.signal });
      const registered = worktreeList.split(/\r?\n/).some((line) => line === `worktree ${worktree}`);
      if (branchRef.code === 0 || registered) {
        let compatible = branchRef.code === 0 && registered;
        if (compatible) {
          await assertClean(worktree, args.signal).catch(() => { compatible = false; });
          compatible = compatible && await currentBranch(worktree, args.signal).then((value) => value === branch).catch(() => false);
          const tip = compatible ? await head(worktree, args.signal) : undefined;
          compatible = compatible && await isAncestor(state.repoRoot, tip, baseCommit, args.signal);
          if (compatible) {
            appendEvent(state, { type: 'mission-artifacts-reconciled', mission: id, branch, baseCommit: tip });
            const mission = {
              id,
              title,
              description,
              dependsOn: [...dependsOn],
              scope,
              branch,
              worktree,
              baseCommit: tip,
              status: 'pending',
              revision: 1,
              createdAt: now(),
              worktreeRemoved: false,
              reconciled: true,
            };
            state.missions.push(mission);
            state.baseCommit = baseCommit;
            mission.revision += 1;
            return publicMission(mission);
          }
        }
        throw new TowerError('MISSION_ARTIFACT_CONFLICT', `mission ${id} has existing branch/worktree artifacts that cannot be reconciled safely`, { branch, worktree });
      }
      await gitOut(state.repoRoot, ['worktree', 'add', '-b', branch, worktree, baseCommit], { signal: args.signal });
      const mission = {
        id,
        title,
        description,
        dependsOn: [...dependsOn],
        scope,
        branch,
        worktree,
        baseCommit,
        status: 'pending',
        revision: 1,
        createdAt: now(),
        worktreeRemoved: false,
      };
      state.missions.push(mission);
      state.baseCommit = baseCommit;
      mission.revision += 1;
      appendEvent(state, { type: 'mission-added', mission: id, branch, baseCommit });
      return publicMission(mission);
    });
  }

  /**
   * Correct the metadata of a mission that has not spawned anything yet.
   * Only pending missions are editable; every other status (a spawned worker,
   * review, merge, or abandon) is rejected so history stays trustworthy.
   */
  async editMission(args) {
    const store = this.requireStore();
    return await store.update(async (state) => {
      const mission = missionOf(state, args.missionId);
      assertTower(mission.status === 'pending', 'MISSION_NOT_EDITABLE', `mission ${mission.id} is ${mission.status}; only a pending mission can be edited`);
      const fields = [];
      const next = { title: mission.title, description: mission.description, scope: mission.scope, dependsOn: mission.dependsOn };
      if (args.title !== undefined) {
        next.title = text(args.title, 'title', 200);
        fields.push('title');
      }
      if (args.description !== undefined) {
        next.description = text(args.description, 'description');
        fields.push('description');
      }
      if (args.scope !== undefined) {
        assertTower(Array.isArray(args.scope), 'ARGUMENT_INVALID', 'scope must be an array of glob patterns');
        next.scope = validateScope(args.scope);
        fields.push('scope');
      }
      if (args.dependsOn !== undefined) {
        const dependsOn = args.dependsOn;
        assertTower(Array.isArray(dependsOn) && dependsOn.every((id) => typeof id === 'string'), 'ARGUMENT_INVALID', 'dependsOn must be a string array');
        assertTower(new Set(dependsOn).size === dependsOn.length, 'DEPENDENCY_INVALID', 'mission dependencies must not repeat');
        for (const dependency of dependsOn) missionOf(state, dependency);
        next.dependsOn = [...dependsOn];
        fields.push('dependsOn');
      }
      assertNoDependencyCycle(state, mission.id, next.dependsOn);
      mission.title = next.title;
      mission.description = next.description;
      mission.scope = next.scope;
      mission.dependsOn = next.dependsOn;
      mission.revision += 1;
      appendEvent(state, { type: 'mission-edited', mission: mission.id, fields });
      return publicMission(mission);
    });
  }

  /**
   * Resolve the set of run ids a recover must exempt, inside the store's
   * serialized section: `activeRunIds` may be a plain iterable (precomputed,
   * for direct callers) or a zero-argument function whose value is read only
   * once the recover mutation actually runs. The function form is the
   * synchronization contract with the runtime: a snapshot taken when the call
   * was dispatched can predate a beginSpawn whose write is still queued ahead
   * of this mutation, so the ownership decision must be made in the same
   * serialized order the writes themselves commit in.
   */
  async recover(activeRunIds = new Set()) {
    const store = this.requireStore();
    return await store.update(async (state) => {
      const owned = typeof activeRunIds === 'function' ? activeRunIds() : activeRunIds;
      const recovered = [];
      for (const mission of state.missions) {
        for (const [role, record] of [['worker', mission.worker], ['reviewer', mission.review]]) {
          const expectedStatus = role === 'worker' ? 'worker_running' : 'review_running';
          if (mission.status !== expectedStatus || !record?.runId || owned.has(record.runId)) continue;
          record.completedAt = now();
          record.stopReason = 'aborted';
          record.error = 'activation is not owned by this runtime; start a fresh agent after confirming the previous controller stopped';
          if (role === 'reviewer') record.stale = true;
          mission.status = role === 'worker' ? 'worker_failed' : 'review_failed';
          mission.revision += 1;
          recovered.push({ mission: mission.id, role, runId: record.runId });
          appendEvent(state, { type: 'activation-recovered', mission: mission.id, role, runId: record.runId });
        }
      }
      return { recovered, state: publicState(state) };
    });
  }

  /**
   * Start one run for a mission role. A plain spawn creates a fresh record;
   * - passing `args.resume = { previousRunId, childId, sessionSeq }` starts a
   *   run that continues the previous agent of that role instead: the
   *   write-ahead intent (`resumeFrom`) is persisted on the new record BEFORE
   *   the caller delivers any resume message — the prompt fingerprint itself
   *   is sealed afterwards with {@link sealResumePrompt}, because a reviewer
   *   resume prompt must first be generated from the run binding this call
   *   just created — so a crash anywhere between this call and delivery
   *   leaves an inspectable failed/runnable record, never a silent gap.
   *   Resumes target only settled records — an actively running mission
   *   (including one left behind by a dead controller) stays AGENT_BUSY
   *   exactly like a plain spawn; run `recover` first to mark the stale run
   *   interrupted, then resume its recorded child.
   *
   * - every other guard (terminal, worktree, restartability, review binding,
   *   dependency readiness) applies to resumes exactly as it does to spawns.
   *
   * `args.onRunning(runId)` is the run-ownership boundary: when supplied it
   * is invoked synchronously INSIDE this store update, at the exact moment
   * the running record is placed and just before the queue commits it, so a
   * caller's ownership registration and the durable `worker_running`/
   * `review_running` write are one critical section. A recover that queued
   * behind this update then observes the registration when it takes its own
   * snapshot inside the store, and can never reap the run this write
   * persists; a recover that queued ahead of it runs before the record
   * exists at all. If the store write itself fails after the hook ran, the
   * call rejects and the caller must drop what it registered.
   *
   * Only the SHA-256 fingerprint of the resume prompt is ever stored; the
   * prompt text itself never reaches Tower state.
   */
  async beginSpawn(args) {
    const store = this.requireStore();
    assertTower(args.onRunning === undefined || typeof args.onRunning === 'function', 'ARGUMENT_INVALID', 'onRunning must be a function');
    return await store.update(async (state) => {
      const mission = missionOf(state, args.missionId);
      const role = args.role;
      assertTower(role === 'worker' || role === 'reviewer', 'ARGUMENT_INVALID', 'role must be worker or reviewer');
      const resume = args.resume;
      if (resume !== undefined) {
        assertTower(resume !== null && typeof resume === 'object', 'ARGUMENT_INVALID', 'resume metadata must be an object');
        assertTower(typeof resume.previousRunId === 'string' && resume.previousRunId.length > 0, 'ARGUMENT_INVALID', 'resume.previousRunId must be a non-empty string');
        assertTower(typeof resume.childId === 'string' && resume.childId.length > 0, 'ARGUMENT_INVALID', 'resume.childId must be a non-empty string');
        assertTower(Number.isSafeInteger(resume.sessionSeq) && resume.sessionSeq >= -1, 'ARGUMENT_INVALID', 'resume.sessionSeq must be a session event offset');
        assertTower(resume.promptHash === undefined || (typeof resume.promptHash === 'string' && /^[0-9a-f]{64}$/.test(resume.promptHash)), 'ARGUMENT_INVALID', 'resume.promptHash must be a sha256 hex fingerprint');
      }
      assertTower(!TERMINAL_STATUSES.has(mission.status), 'MISSION_TERMINAL', `cannot spawn ${role} for ${mission.status} mission ${mission.id}`);
      assertTower(!ACTIVE_STATUSES.has(mission.status), 'AGENT_BUSY', `mission ${mission.id} is ${mission.status}; wait or interrupt before spawning again`);
      assertTower(!mission.worktreeRemoved, 'WORKTREE_REMOVED', `mission ${mission.id} worktree was removed`);
      const runId = randomUUID();
      const route = routeRecord(args);
      const resumeFrom = resume === undefined ? undefined : {
        runId: resume.previousRunId,
        childId: resume.childId,
        sessionSeq: resume.sessionSeq,
        ...(resume.promptHash === undefined ? {} : { promptHash: resume.promptHash }),
      };
      if (role === 'worker') {
        assertTower(WORKER_RESTARTABLE.has(mission.status), 'WORKER_START_BLOCKED', `cannot start a worker while mission is ${mission.status}`);
        assertTower(dependenciesReady(state, mission), 'DEPENDENCIES_NOT_MERGED', `mission ${mission.id} has unmerged dependencies`, { dependsOn: mission.dependsOn });
        if (mission.status === 'pending') {
          const baseCommit = await head(state.repoRoot, args.signal, state.baseBranch);
          const tip = await head(mission.worktree, args.signal);
          if (!(await isAncestor(state.repoRoot, baseCommit, tip, args.signal))) {
            await assertClean(mission.worktree, args.signal);
            assertTower(await currentBranch(mission.worktree, args.signal) === mission.branch, 'WORKTREE_BRANCH_MISMATCH', `mission ${mission.id} worktree is not on ${mission.branch}`);
            assertTower(tip === mission.baseCommit && await isAncestor(state.repoRoot, tip, baseCommit, args.signal), 'STALE_BASE', `mission ${mission.id} has commits outside the current base; rebase explicitly before starting its worker`);
            await gitOut(mission.worktree, ['merge', '--ff-only', '--no-overwrite-ignore', baseCommit], { signal: args.signal });
          }
          mission.baseCommit = baseCommit;
        }
        mission.worker = {
          runId,
          startedAt: now(),
          ...(args.controllerSessionId === undefined ? {} : { controllerSessionId: args.controllerSessionId }),
          ...route,
          ...(resumeFrom === undefined ? {} : { resumeFrom }),
        };
        mission.review = undefined;
        mission.status = 'worker_running';
      } else {
        assertTower(REVIEW_RESTARTABLE.has(mission.status), 'REVIEW_START_BLOCKED', `mission ${mission.id} must complete a worker before review; current status is ${mission.status}`);
        await assertClean(mission.worktree, args.signal);
        const reviewedCommit = await head(mission.worktree, args.signal);
        const baseCommit = await head(state.repoRoot, args.signal, state.baseBranch);
        assertTower(reviewedCommit !== baseCommit, 'NO_CHANGE', `mission ${mission.id} has no commit beyond the current base`);
        assertTower(await isAncestor(state.repoRoot, baseCommit, reviewedCommit, args.signal), 'STALE_BASE', `mission ${mission.id} must be rebased onto the current base before review`);
        mission.review = {
          runId,
          startedAt: now(),
          baseCommit,
          reviewedCommit,
          ...(args.controllerSessionId === undefined ? {} : { controllerSessionId: args.controllerSessionId }),
          ...route,
          ...(resumeFrom === undefined ? {} : { resumeFrom }),
        };
        mission.status = 'review_running';
      }
      mission.revision += 1;
      appendEvent(state, resume === undefined
        ? { type: 'spawn-started', mission: mission.id, role, runId }
        : { type: 'spawn-started', mission: mission.id, role, runId, resumedFrom: resume.previousRunId, childId: resume.childId });
      // Ownership boundary: register the run the caller is about to own in
      // the same serialized section that persists its running state, ahead of
      // the committing write (see the method doc).
      args.onRunning?.(runId);
      return { mission: publicMission(mission), role, runId };
    });
  }

  /**
   * Attach one started run to its child agent. `resume` optionally records how
   * the resumed epoch was bound: the durable message id returned by the
   * subagent manager and the `subagent/start` host run id observed for this
   * epoch. Both are plain correlation handles — omitted for plain spawns and
   * whenever the host did not publish the edge.
   */
  async attachSpawn(runId, childId, resume = undefined) {
    const store = this.requireStore();
    return await store.update(async (state) => {
      const { mission, role, record } = runOf(state, runId);
      assertTower(resume === undefined || (resume !== null && typeof resume === 'object'), 'ARGUMENT_INVALID', 'resume attachment metadata must be an object');
      if (resume?.messageId !== undefined) {
        assertTower(typeof resume.messageId === 'string' && resume.messageId.length > 0, 'ARGUMENT_INVALID', 'resume.messageId must be a non-empty string');
      }
      if (resume?.hostRunId !== undefined) {
        assertTower(typeof resume.hostRunId === 'string' && resume.hostRunId.length > 0, 'ARGUMENT_INVALID', 'resume.hostRunId must be a non-empty string');
      }
      record.childId = childId;
      if (resume?.messageId !== undefined) record.resumeMessageId = resume.messageId;
      if (resume?.hostRunId !== undefined) record.resumeHostRunId = resume.hostRunId;
      mission.revision += 1;
      appendEvent(state, {
        type: 'spawn-attached',
        mission: mission.id,
        role,
        runId,
        childId,
        ...(resume?.messageId === undefined && resume?.hostRunId === undefined ? {} : { resumed: true }),
      });
      return { missionId: mission.id, childId };
    });
  }

  /**
   * Seal one resume run's write-ahead intent with the SHA-256 fingerprint of
   * the FINAL prompt — the one generated from the review binding this resume
   * round's own `beginSpawn` created — before that prompt is delivered to the
   * child. Delivery without a sealed fingerprint is a WAL violation the caller
   * must never commit; sealing twice or after the run settled is rejected so
   * the recorded fingerprint always names exactly one delivered prompt.
   */
  async sealResumePrompt(runId, promptHash) {
    const store = this.requireStore();
    return await store.update(async (state) => {
      const { mission, role, record } = runOf(state, runId);
      assertTower(record.resumeFrom !== undefined, 'ARGUMENT_INVALID', `run ${runId} did not start as a resume run`);
      assertTower(typeof promptHash === 'string' && /^[0-9a-f]{64}$/.test(promptHash), 'ARGUMENT_INVALID', 'promptHash must be a sha256 hex fingerprint');
      assertTower(record.resumeFrom.promptHash === undefined, 'ARGUMENT_INVALID', `the resume prompt for run ${runId} is already sealed`);
      assertTower(record.completedAt === undefined, 'ARGUMENT_INVALID', `run ${runId} already settled; its resume prompt cannot change`);
      record.resumeFrom.promptHash = promptHash;
      mission.revision += 1;
      appendEvent(state, { type: 'resume-prompt-sealed', mission: mission.id, role, runId, promptHash });
      return { missionId: mission.id, runId, promptHash };
    });
  }

  async failSpawn(runId, error) {
    const store = this.requireStore();
    return await store.update(async (state) => {
      const { mission, role, record } = runOf(state, runId);
      record.completedAt = now();
      record.error = errorMessage(error);
      mission.status = role === 'worker' ? 'worker_failed' : 'review_failed';
      mission.revision += 1;
      appendEvent(state, { type: 'spawn-failed', mission: mission.id, role, runId, status: mission.status, error: record.error });
      return publicMission(mission);
    });
  }

  async completeSpawn(runId, result) {
    const store = this.requireStore();
    return await store.update(async (state) => {
      const { mission, role, record } = runOf(state, runId);
      record.completedAt = now();
      record.stopReason = result.stopReason;
      record.output = result.output;
      if (result.structured !== undefined) record.structured = result.structured;
      if (result.diagnostic !== undefined) record.diagnostic = result.diagnostic;
      if (role === 'worker') {
        if (result.stopReason !== 'completed') {
          record.error = result.diagnostic ?? `worker ended with ${result.stopReason}`;
          mission.status = 'worker_failed';
        } else {
          const worktreeStatus = await gitStatus(mission.worktree);
          record.headCommit = await head(mission.worktree);
          if (!worktreeStatus.clean) {
            record.error = 'worker finished with uncommitted or untracked files; commit or clean them before review';
            record.dirtyEntries = worktreeStatus.entries.slice(0, 50);
            mission.status = 'worker_failed';
          } else {
            mission.status = 'worker_completed';
          }
        }
      } else {
        const currentTip = await head(mission.worktree);
        const currentBase = await head(state.repoRoot, undefined, state.baseBranch);
        const bindingMatches = currentTip === record.reviewedCommit && currentBase === record.baseCommit;
        const review = result.structured;
        if (result.stopReason !== 'completed' || !review || typeof review !== 'object') {
          record.error = result.diagnostic ?? (result.stopReason !== 'completed' ? `reviewer ended with ${result.stopReason}` : 'reviewer did not return a structured verdict');
          mission.status = 'review_failed';
        } else if (!bindingMatches) {
          record.error = 'review binding became stale while the reviewer was running; spawn a fresh reviewer';
          record.stale = true;
          mission.status = 'worker_completed';
        } else {
          record.verdict = review.verdict;
          record.merge = review.merge;
          record.summary = review.summary;
          record.findings = review.findings;
          record.checks = review.checks;
          mission.status = review.verdict === 'clean' && review.merge === true ? 'approved' : 'changes_requested';
        }
      }
      mission.revision += 1;
      const failed = mission.status === 'worker_failed' || mission.status === 'review_failed';
      appendEvent(state, failed
        ? { type: 'spawn-failed', mission: mission.id, role, runId, status: mission.status, error: record.error }
        : { type: 'spawn-completed', mission: mission.id, role, runId, status: mission.status });
      return publicMission(mission);
    });
  }

  async agentAddress(missionId, role) {
    const state = await this.requireStore().read();
    const mission = missionOf(state, missionId);
    const record = role === 'worker' ? mission.worker : mission.review;
    assertTower(record?.childId, 'AGENT_NOT_RUNNING', `mission ${missionId} has no attached ${role}`);
    const expectedStatus = role === 'worker' ? 'worker_running' : 'review_running';
    assertTower(mission.status === expectedStatus, 'AGENT_NOT_RUNNING', `mission ${missionId} is ${mission.status}, not ${expectedStatus}`);
    return { childId: record.childId, runId: record.runId };
  }

  async evaluateMergeGate(state, mission, signal) {
    const blocks = [];
    const observations = {};
    if (!['approved', 'merge_blocked'].includes(mission.status)) blocks.push({ code: 'NOT_APPROVED', message: `mission is ${mission.status}; a clean merge-approved review is required` });
    if (!dependenciesReady(state, mission)) blocks.push({ code: 'DEPENDENCIES_NOT_MERGED', message: `dependencies are not merged: ${mission.dependsOn.join(', ')}` });
    if (mission.worktreeRemoved) blocks.push({ code: 'WORKTREE_REMOVED', message: 'mission worktree has been removed' });
    const baseStatus = await gitStatus(state.repoRoot, signal);
    observations.baseDirty = !baseStatus.clean;
    if (!baseStatus.clean) blocks.push({ code: 'BASE_DIRTY', message: 'main checkout has uncommitted or untracked files', entries: baseStatus.entries.slice(0, 50) });
    const checkedOutBranch = await currentBranch(state.repoRoot, signal).catch((error) => {
      if (error?.code === 'DETACHED_HEAD') return undefined;
      throw error;
    });
    if (checkedOutBranch !== undefined) observations.checkedOutBranch = checkedOutBranch;
    if (checkedOutBranch !== state.baseBranch) blocks.push({ code: 'BASE_MISMATCH', message: `main checkout is on ${checkedOutBranch ?? 'detached HEAD'}, not ${state.baseBranch}` });
    if (blocks.some((block) => block.code === 'WORKTREE_REMOVED')) return { ready: false, blocks, observations };
    const worktreeStatus = await gitStatus(mission.worktree, signal);
    observations.worktreeDirty = !worktreeStatus.clean;
    if (!worktreeStatus.clean) blocks.push({ code: 'WORKTREE_DIRTY', message: 'mission worktree has uncommitted or untracked files', entries: worktreeStatus.entries.slice(0, 50) });
    const baseCommit = await head(state.repoRoot, signal, state.baseBranch);
    const reviewedCommit = await head(mission.worktree, signal);
    observations.baseCommit = baseCommit;
    observations.reviewedCommit = reviewedCommit;
    if (baseCommit === reviewedCommit) blocks.push({ code: 'NO_CHANGE', message: 'mission branch has no commit beyond the current base' });
    if (baseCommit !== reviewedCommit && !(await isAncestor(state.repoRoot, baseCommit, reviewedCommit, signal))) {
      blocks.push({ code: 'STALE_BASE', message: 'current base is not an ancestor of the mission tip; rebase and review again' });
    }
    const review = mission.review;
    if (!review || review.verdict !== 'clean' || review.merge !== true) {
      blocks.push({ code: 'NO_CLEAN_REVIEW', message: 'no clean merge-approved review is recorded' });
    } else {
      if (review.reviewedCommit !== reviewedCommit) blocks.push({ code: 'REVIEW_TIP_STALE', message: `reviewed tip ${review.reviewedCommit} is not current tip ${reviewedCommit}` });
      if (review.baseCommit !== baseCommit) blocks.push({ code: 'REVIEW_BASE_STALE', message: `reviewed base ${review.baseCommit} is not current base ${baseCommit}` });
    }
    if (mission.scope.length > 0 && baseCommit !== reviewedCommit) {
      const files = await changedFiles(state.repoRoot, baseCommit, reviewedCommit, signal);
      observations.changedFiles = files;
      const outside = files.filter((file) => !mission.scope.some((pattern) => matchesGlob(file, pattern)));
      if (outside.length > 0) blocks.push({ code: 'OUT_OF_SCOPE', message: `mission changed files outside its scope: ${outside.join(', ')}`, files: outside });
    }
    const alreadyMerged = review?.verdict === 'clean' && review.merge === true && review.reviewedCommit === reviewedCommit
      && await isAncestor(state.repoRoot, reviewedCommit, baseCommit, signal);
    if (alreadyMerged) return { ready: false, alreadyMerged: true, blocks: [], warnings: blocks, observations };
    return { ready: blocks.length === 0, blocks, observations };
  }

  async mergeGate(missionId, signal) {
    const state = await this.requireStore().read();
    return await this.evaluateMergeGate(state, missionOf(state, missionId), signal);
  }

  async merge(missionId, signal) {
    const store = this.requireStore();
    try {
      return await store.update(async (state) => {
        const mission = missionOf(state, missionId);
        if (mission.status === 'merged') {
          return { merged: true, advanced: false, alreadyMerged: true, mission: publicMission(mission), ...(mission.merge?.commit === undefined ? {} : { mergeCommit: mission.merge.commit }) };
        }
        const gate = await this.evaluateMergeGate(state, mission, signal);
        if (gate.alreadyMerged) {
          const mergeCommit = gate.observations.baseCommit;
          mission.status = 'merged';
          mission.merge = { mergedAt: now(), commit: mergeCommit, reviewedCommit: mission.review.reviewedCommit, baseCommit: mission.review.baseCommit, reconciled: true };
          state.baseCommit = mergeCommit;
          mission.revision += 1;
          appendEvent(state, { type: 'mission-merge-reconciled', mission: mission.id, mergeCommit });
          return { merged: true, advanced: false, reconciled: true, mission: publicMission(mission), gate, mergeCommit };
        }
        if (!gate.ready) return { merged: false, mission: publicMission(mission), gate };
        const message = `Tower: ${mission.title} (${mission.id})`;
        const reviewedCommit = gate.observations.reviewedCommit;
        try {
          await gitOut(state.repoRoot, ['merge', '--no-ff', '--no-edit', '-m', message, reviewedCommit], { signal });
        } catch (error) {
          const recovery = await recoverMergeFailure(state.repoRoot, gate.observations.baseCommit, signal);
          mission.status = 'merge_blocked';
          mission.revision += 1;
          appendEvent(state, { type: 'merge-failed', mission: mission.id, error: errorMessage(error), recoveryRequired: recovery.recoveryRequired });
          return { merged: false, mission: publicMission(mission), gate, error: errorMessage(error), ...recovery };
        }
        let mergeCommit;
        let branchTip;
        let containsReviewedCommit;
        try {
          mergeCommit = await this.mergeOperations.head(state.repoRoot, signal);
          branchTip = await this.mergeOperations.head(mission.worktree, signal);
          containsReviewedCommit = await this.mergeOperations.isAncestor(state.repoRoot, reviewedCommit, mergeCommit, signal);
        } catch (error) {
          mission.revision += 1;
          appendEvent(state, { type: 'merge-accounting-required', mission: mission.id, reviewedCommit, error: errorMessage(error) });
          return { merged: false, mergeAttempted: true, verified: false, recoveryRequired: true, postMerge: true, mission: publicMission(mission), gate, reviewedCommit, error: errorMessage(error) };
        }
        state.baseCommit = mergeCommit;
        if (!containsReviewedCommit) {
          mission.revision += 1;
          appendEvent(state, { type: 'merge-verification-failed', mission: mission.id, mergeCommit, reviewedCommit });
          return { merged: false, mergeAttempted: true, verified: false, recoveryRequired: true, postMerge: true, mission: publicMission(mission), gate, mergeCommit, error: 'merge completed but the resulting base does not contain the reviewed commit' };
        }
        if (branchTip !== reviewedCommit) {
          mission.status = 'worker_completed';
          mission.review = undefined;
          mission.revision += 1;
          appendEvent(state, { type: 'mission-merge-advanced', mission: mission.id, mergeCommit, reviewedCommit, branchTip });
          return { merged: true, advanced: true, mission: publicMission(mission), gate, mergeCommit, branchTip };
        }
        mission.status = 'merged';
        mission.merge = { mergedAt: now(), commit: mergeCommit, reviewedCommit, baseCommit: gate.observations.baseCommit };
        mission.revision += 1;
        appendEvent(state, { type: 'mission-merged', mission: mission.id, mergeCommit });
        return { merged: true, advanced: false, mission: publicMission(mission), gate, mergeCommit };
      });
    } catch (error) {
      const state = await store.read().catch(() => undefined);
      if (state) {
        const mission = missionOf(state, missionId);
        const gate = await this.evaluateMergeGate(state, mission).catch(() => undefined);
        if (gate?.alreadyMerged) {
          return { merged: true, recoveryRequired: true, postMerge: true, mission: publicMission(mission), gate, error: errorMessage(error) };
        }
      }
      throw error;
    }
  }

  async rebase(missionId, signal) {
    const store = this.requireStore();
    return await store.update(async (state) => {
      const mission = missionOf(state, missionId);
      assertTower(!TERMINAL_STATUSES.has(mission.status), 'MISSION_TERMINAL', `cannot rebase ${mission.status} mission`);
      assertTower(!ACTIVE_STATUSES.has(mission.status), 'AGENT_BUSY', `cannot rebase while mission is ${mission.status}`);
      assertTower(!mission.worktreeRemoved, 'WORKTREE_REMOVED', 'cannot rebase a removed worktree');
      await assertClean(mission.worktree, signal);
      const previousTip = await head(mission.worktree, signal);
      try {
        await gitOut(mission.worktree, ['rebase', state.baseBranch], { signal });
      } catch (error) {
        const recovery = await recoverRebaseFailure(mission.worktree, previousTip, signal);
        mission.status = 'rebase_blocked';
        mission.review = undefined;
        mission.revision += 1;
        appendEvent(state, { type: 'rebase-failed', mission: mission.id, error: errorMessage(error), recoveryRequired: recovery.recoveryRequired });
        return { rebased: false, mission: publicMission(mission), error: errorMessage(error), ...recovery };
      }
      const tip = await head(mission.worktree, signal);
      const baseCommit = await head(state.repoRoot, signal, state.baseBranch);
      mission.baseCommit = baseCommit;
      const reviewRequired = tip !== previousTip || Boolean(mission.review
        && (mission.review.baseCommit !== baseCommit || mission.review.reviewedCommit !== tip));
      if (reviewRequired) {
        mission.review = undefined;
        mission.status = 'worker_completed';
      } else if (mission.status !== 'review_failed') {
        const approved = mission.review?.verdict === 'clean' && mission.review?.merge === true;
        mission.status = mission.review?.verdict === undefined ? 'worker_completed' : (approved ? 'approved' : 'changes_requested');
      }
      mission.revision += 1;
      appendEvent(state, { type: 'mission-rebased', mission: mission.id, previousTip, tip, baseCommit });
      return { rebased: true, reviewRequired, previousTip, tip, mission: publicMission(mission) };
    });
  }

  async abandon(missionId) {
    const store = this.requireStore();
    return await store.update(async (state) => {
      const mission = missionOf(state, missionId);
      assertTower(mission.status !== 'merged', 'MISSION_MERGED', 'a merged mission cannot be abandoned');
      assertTower(!ACTIVE_STATUSES.has(mission.status), 'AGENT_BUSY', `cannot abandon while mission is ${mission.status}`);
      mission.status = 'abandoned';
      mission.revision += 1;
      appendEvent(state, { type: 'mission-abandoned', mission: mission.id });
      return publicMission(mission);
    });
  }

  async teardown(args = {}) {
    const store = this.requireStore();
    return await store.update(async (state) => {
      const selected = args.missionId ? [missionOf(state, args.missionId)] : state.missions;
      const results = [];
      const registered = await gitOut(state.repoRoot, ['worktree', 'list', '--porcelain'], { signal: args.signal });
      const registeredPaths = registered.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).map((line) => path.resolve(line.slice('worktree '.length)));
      for (const mission of selected) {
        if (mission.worktreeRemoved) {
          results.push({ mission: mission.id, removed: false, reason: 'already-removed' });
          continue;
        }
        if (!TERMINAL_STATUSES.has(mission.status) || ACTIVE_STATUSES.has(mission.status)) {
          results.push({ mission: mission.id, removed: false, reason: `status-${mission.status}` });
          continue;
        }
        const resolved = path.resolve(mission.worktree);
        assertTower(resolved.startsWith(`${path.resolve(store.worktrees)}${path.sep}`), 'WORKTREE_PATH_INVALID', `refusing to remove unexpected worktree path ${resolved}`);
        if (!registeredPaths.includes(resolved)) {
          const exists = await stat(resolved).then(() => true, (error) => error?.code === 'ENOENT' ? false : Promise.reject(error));
          if (!exists) {
            mission.worktreeRemoved = true;
            mission.revision += 1;
            appendEvent(state, { type: 'worktree-remove-reconciled', mission: mission.id });
            results.push({ mission: mission.id, removed: true, reconciled: true });
          } else {
            results.push({ mission: mission.id, removed: false, reason: 'not-a-registered-worktree' });
          }
          continue;
        }
        const worktreeStatus = await gitStatus(resolved, args.signal);
        if (!worktreeStatus.clean) {
          results.push({ mission: mission.id, removed: false, reason: 'dirty', entries: worktreeStatus.entries.slice(0, 50) });
          continue;
        }
        await gitOut(state.repoRoot, ['worktree', 'remove', resolved], { signal: args.signal });
        mission.worktreeRemoved = true;
        mission.revision += 1;
        appendEvent(state, { type: 'worktree-removed', mission: mission.id });
        results.push({ mission: mission.id, removed: true });
      }
      return { results, state: publicState(state) };
    });
  }
}

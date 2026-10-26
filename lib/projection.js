import { pluginRecordOf } from '@deepseek-ai/dsh-session';
import { z } from 'zod';

export const TOWER_RECORD_TYPE = 'plugin:tower/state';

const agentRecordSchema = z.object({
  runId: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  childId: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  stopReason: z.string().optional(),
  output: z.string().optional(),
  headCommit: z.string().optional(),
  baseCommit: z.string().optional(),
  reviewedCommit: z.string().optional(),
  verdict: z.string().optional(),
  merge: z.boolean().optional(),
  summary: z.string().optional(),
  findings: z.array(z.unknown()).optional(),
  checks: z.array(z.string()).optional(),
  error: z.string().optional(),
  stale: z.boolean().optional(),
}).passthrough();

const missionSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  dependsOn: z.array(z.string()),
  scope: z.array(z.string()),
  branch: z.string(),
  worktree: z.string(),
  baseCommit: z.string(),
  status: z.string(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  worktreeRemoved: z.boolean(),
  worker: agentRecordSchema.optional(),
  review: agentRecordSchema.optional(),
  merge: z.object({
    mergedAt: z.string(),
    commit: z.string(),
    reviewedCommit: z.string(),
    baseCommit: z.string(),
    reconciled: z.boolean().optional(),
  }).passthrough().optional(),
}).passthrough();

export const towerStateSchema = z.object({
  version: z.literal(1),
  repoRoot: z.string(),
  baseBranch: z.string(),
  baseCommit: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  missions: z.array(missionSchema),
  events: z.array(z.unknown()).optional(),
}).passthrough();

const recordSchema = z.object({
  version: z.literal(1),
  state: towerStateSchema,
}).strict();

const projectionStateSchema = z.object({
  value: towerStateSchema.nullable(),
  failure: z.string().nullable(),
}).strict();

// Read-only derivation of merge-gate block codes from the published state.
// It mirrors the state-checkable checks of `evaluateMergeGate` in lib/core.js
// (same codes, same order) without running a single git command:
// - NOT_APPROVED: status is neither 'approved' nor 'merge_blocked';
// - DEPENDENCIES_NOT_MERGED: a dependsOn entry is missing or not yet
//   merged/abandoned (core treats both as resolved for depends_on);
// - WORKTREE_REMOVED: the mission worktree has been removed;
// - NO_CLEAN_REVIEW: no review record with verdict 'clean' and merge === true.
// Git-dependent checks (dirty checkouts, base branch mismatch, stale base,
// out-of-scope files) remain in `tower gate`. Terminal missions (merged or
// abandoned) can no longer merge, so they report no blocks — the same empty
// `blocks` core returns for a mission it detects as already merged.
const GATE_MERGEABLE_STATUSES = new Set(['approved', 'merge_blocked']);
const GATE_RESOLVED_STATUSES = new Set(['merged', 'abandoned']);

export function deriveMissionGateBlocks(mission, missions = []) {
  if (!mission || GATE_RESOLVED_STATUSES.has(mission.status)) return [];
  const blocks = [];
  if (!GATE_MERGEABLE_STATUSES.has(mission.status)) blocks.push('NOT_APPROVED');
  const byId = new Map((missions ?? []).map((candidate) => [candidate?.id, candidate]));
  const unresolvedDependency = (mission.dependsOn ?? []).some((id) => {
    const dependency = byId.get(id);
    return !dependency || !GATE_RESOLVED_STATUSES.has(dependency.status);
  });
  if (unresolvedDependency) blocks.push('DEPENDENCIES_NOT_MERGED');
  if (mission.worktreeRemoved === true) blocks.push('WORKTREE_REMOVED');
  const review = mission.review;
  if (!review || review.verdict !== 'clean' || review.merge !== true) blocks.push('NO_CLEAN_REVIEW');
  return blocks;
}

// Locale-independent ascending order for optional route fields; null sorts
// first. Kept identical to `compareOptionalText` in lib/core.js.
function compareRouteText(a, b) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

// Read-only derivation of per-route usage: how many worker and reviewer runs
// each provider/model/reasoning-effort route served across the whole tower.
// This is a DELIBERATE COPY of `summaryRoutes` in lib/core.js (the M64
// `summary` aggregate) with identical semantics:
// - same bucket key: provider/model/reasoningEffort, missing fields as null;
// - same counting: one mission contributes its worker record as a worker run
//   and its review record as a reviewer run (merged/abandoned included);
// - same ordering: total descending, then provider → model → effort
//   ascending with null first.
// RISK: the two implementations must be kept in sync by hand — a change to
// the bucketing, counting, or ordering in one place drifts the panel away
// from `tower summary` until the other is updated too.
// test/client-routes.test.js asserts field-by-field equality between this
// derivation and core's `summary().routes` on the same state, so drift fails
// the suite instead of reaching users.
export function deriveRouteUsage(input) {
  const missions = Array.isArray(input) ? input : input?.missions;
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
  for (const mission of missions ?? []) {
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
    || compareRouteText(a.provider, b.provider)
    || compareRouteText(a.model, b.model)
    || compareRouteText(a.reasoningEffort, b.reasoningEffort));
}

// Attach the derived summaries to the wire view. The stored `value` stays the
// verbatim record content; only what consumers see gains the read-only
// per-mission `gateBlocks` field and the tower-wide `routes` aggregate.
function withDerived(state) {
  if (!state) return state;
  return {
    ...state,
    missions: state.missions.map((mission) => ({ ...mission, gateBlocks: deriveMissionGateBlocks(mission, state.missions) })),
    routes: deriveRouteUsage(state.missions),
  };
}

export const towerProjectionDefinition = {
  key: 'tower',
  stateSchema: projectionStateSchema,
  init: () => ({ value: null, failure: null }),
  apply(state, event) {
    const record = pluginRecordOf(event);
    if (record?.type !== TOWER_RECORD_TYPE) return state;
    try {
      const payload = recordSchema.parse(record.data);
      return { value: payload.state, failure: null };
    } catch (error) {
      return { ...state, failure: error instanceof Error ? error.message : String(error) };
    }
  },
  wire: {
    viewSchema: towerStateSchema.nullable(),
    view: (state) => withDerived(state.value),
  },
  stateVersion: 1,
};

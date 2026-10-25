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
    view: (state) => state.value,
  },
  stateVersion: 1,
};

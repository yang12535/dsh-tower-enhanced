import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from '@deepseek-ai/dsh-session';
import { towerProjectionDefinition, TOWER_RECORD_TYPE } from '../lib/projection.js';
import { TowerRuntime } from '../lib/runtime.js';

export function sampleTowerState() {
  return {
    version: 1,
    repoRoot: '/tmp/tower-panel',
    baseBranch: 'main',
    baseCommit: 'base-sha',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    missions: [{
      id: 'M1',
      title: 'Different models',
      description: 'Show worker and reviewer models',
      dependsOn: [],
      scope: ['answer.js'],
      branch: 'tower/m1',
      worktree: '/tmp/tower-panel/.dsh-tower/worktrees/m1',
      baseCommit: 'base-sha',
      status: 'merged',
      revision: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
      worktreeRemoved: false,
      worker: {
        runId: 'worker-run',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        reasoningEffort: 'max',
        childId: 'worker-child',
      },
      review: {
        runId: 'review-run',
        provider: 'deepseek-official',
        model: 'deepseek-reasoner',
        reasoningEffort: 'high',
        childId: 'review-child',
        verdict: 'clean',
        merge: true,
      },
      merge: {
        mergedAt: '2026-01-01T00:01:00.000Z',
        commit: 'merge-sha',
        reviewedCommit: 'reviewed-sha',
        baseCommit: 'base-sha',
      },
    }],
    events: [],
  };
}

test('Tower projection folds full state with per-role model routes', () => {
  const state = sampleTowerState();
  const initial = towerProjectionDefinition.init();
  const next = towerProjectionDefinition.apply(initial, { type: TOWER_RECORD_TYPE, ignorable: true, data: { version: 1, state } });
  assert.equal(next.failure, null);
  assert.equal(next.value.missions[0].worker.model, 'deepseek-flash');
  assert.equal(next.value.missions[0].review.model, 'deepseek-reasoner');
  assert.equal(towerProjectionDefinition.wire.view(next).missions[0].merge.commit, 'merge-sha');
});

test('publish appends a plugin record and flushes the owning Session', async () => {
  const state = sampleTowerState();
  const flushed = [];
  const runtime = new TowerRuntime({
    sessions: { async flush(session) { flushed.push(session); } },
    logger: { warn() { throw new Error('publish must not fail'); } },
  }, {});
  const agent = { session: Session.create('tower-projection-test') };
  await runtime.publish(agent, { status: async () => state });
  const appended = agent.session.snapshotEvents();
  assert.equal(appended.length, 1);
  assert.equal(appended[0].type, TOWER_RECORD_TYPE);
  assert.equal(appended[0].data.state.missions[0].review.model, 'deepseek-reasoner');
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0], agent.session);
});

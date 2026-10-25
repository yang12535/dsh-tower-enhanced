import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { addAndRunWorker, approve, commitFile, initializedCore, makeRepo } from './helpers.js';

const ACTIONS = ['spawnWorker', 'spawnReviewer', 'merge', 'rebase', 'teardown', 'editMission', 'addDependent'];

const allow = (status, note, extra = {}) => ({ kind: 'allow', status, note, ...extra });
const reject = (code, message, note) => ({ kind: 'reject', code, message, note });
const refuse = (code, message, note) => ({ kind: 'refuse', code, message, note });
const busySpawn = (status, note) => reject('AGENT_BUSY', `mission M1 is ${status}; wait or interrupt before spawning again`, note);
const busyRebase = (status, note) => reject('AGENT_BUSY', `cannot rebase while mission is ${status}`, note);
const terminalSpawn = (status, role, note) => reject('MISSION_TERMINAL', `cannot spawn ${role} for ${status} mission M1`, note);
const terminalRebase = (status, note) => reject('MISSION_TERMINAL', `cannot rebase ${status} mission`, note);
const notEditable = (status, note) => reject('MISSION_NOT_EDITABLE', `mission M1 is ${status}; only a pending mission can be edited`, note);
const notApproved = (status, note) => refuse('NOT_APPROVED', `mission is ${status}; a clean merge-approved review is required`, note);
const noTeardown = (status, note) => refuse('TEARDOWN_STATUS', `status-${status}`, note);
const addDependent = (status, note) => allow(status, note);

// Every cell records the expected outcome for one status × action pair. Spawn,
// rebase, and edit reject with TowerError; merge and non-terminal teardown use
// their structured refusal results. `allow` means the guard accepts the action;
// a genuine Git conflict may still keep a blocked mission in its blocked state.
const MATRIX = [
  {
    status: 'pending',
    cells: {
      spawnWorker: allow('worker_running', 'a dependency-free pending mission may start its worker'),
      spawnReviewer: reject('REVIEW_START_BLOCKED', 'mission M1 must complete a worker before review; current status is pending', 'review cannot precede the first worker'),
      merge: notApproved('pending', 'pending work has no merge-approved review'),
      rebase: allow('worker_completed', 'a no-op pending rebase completes baseline reconciliation'),
      teardown: noTeardown('pending', 'pending worktrees must be preserved'),
      editMission: allow('pending', 'pending metadata remains editable'),
      addDependent: addDependent('pending', 'a pending mission may be referenced by a new dependent'),
    },
  },
  {
    status: 'worker_running',
    cells: {
      spawnWorker: busySpawn('worker_running', 'a second worker cannot overlap the active worker'),
      spawnReviewer: busySpawn('worker_running', 'review cannot overlap the active worker'),
      merge: notApproved('worker_running', 'an active worker cannot be merged'),
      rebase: busyRebase('worker_running', 'rebase cannot move a worktree in use by a worker'),
      teardown: noTeardown('worker_running', 'an active worker worktree must be preserved'),
      editMission: notEditable('worker_running', 'worker history makes metadata immutable'),
      addDependent: addDependent('worker_running', 'dependency declaration does not require a terminal dependency'),
    },
  },
  {
    status: 'worker_completed',
    cells: {
      spawnWorker: allow('worker_running', 'a completed worker may be rerun'),
      spawnReviewer: allow('review_running', 'a committed worker result may enter review'),
      merge: notApproved('worker_completed', 'worker completion alone does not approve a merge'),
      rebase: allow('worker_completed', 'a no-op rebase preserves the completed-worker state'),
      teardown: noTeardown('worker_completed', 'unmerged worker output must be preserved'),
      editMission: notEditable('worker_completed', 'completed worker history makes metadata immutable'),
      addDependent: addDependent('worker_completed', 'a new mission may depend on completed but unmerged work'),
    },
  },
  {
    status: 'worker_failed',
    cells: {
      spawnWorker: allow('worker_running', 'a failed worker may be retried'),
      spawnReviewer: reject('REVIEW_START_BLOCKED', 'mission M1 must complete a worker before review; current status is worker_failed', 'a failed worker has no reviewable result'),
      merge: notApproved('worker_failed', 'a failed worker cannot be merged'),
      rebase: allow('worker_completed', 'rebase reconciles a failed run and requires a fresh worker'),
      teardown: noTeardown('worker_failed', 'failed worker diagnostics and worktree must be preserved'),
      editMission: notEditable('worker_failed', 'failed worker history makes metadata immutable'),
      addDependent: addDependent('worker_failed', 'a dependency may be declared before the failed work is resolved'),
    },
  },
  {
    status: 'review_running',
    cells: {
      spawnWorker: busySpawn('review_running', 'worker rework cannot overlap the active reviewer'),
      spawnReviewer: busySpawn('review_running', 'a second reviewer cannot overlap the active reviewer'),
      merge: notApproved('review_running', 'an unfinished review cannot approve a merge'),
      rebase: busyRebase('review_running', 'rebase cannot invalidate an active review binding'),
      teardown: noTeardown('review_running', 'an active reviewer worktree must be preserved'),
      editMission: notEditable('review_running', 'review history makes metadata immutable'),
      addDependent: addDependent('review_running', 'dependency declaration is allowed during review'),
    },
  },
  {
    status: 'review_failed',
    cells: {
      spawnWorker: allow('worker_running', 'failed review may be followed by worker rework'),
      spawnReviewer: allow('review_running', 'failed review may be retried directly'),
      merge: notApproved('review_failed', 'failed review cannot approve a merge'),
      rebase: allow('review_failed', 'a no-op rebase preserves the failed-review state'),
      teardown: noTeardown('review_failed', 'failed review worktree must be preserved'),
      editMission: notEditable('review_failed', 'review history makes metadata immutable'),
      addDependent: addDependent('review_failed', 'dependency declaration is allowed after review failure'),
    },
  },
  {
    status: 'changes_requested',
    cells: {
      spawnWorker: allow('worker_running', 'requested changes may start a worker rework round'),
      spawnReviewer: allow('review_running', 'a fresh reviewer pass may be requested'),
      merge: notApproved('changes_requested', 'a changes-requested verdict blocks merge'),
      rebase: allow('changes_requested', 'a no-op rebase preserves the recorded verdict'),
      teardown: noTeardown('changes_requested', 'work needing changes must be preserved'),
      editMission: notEditable('changes_requested', 'a recorded verdict makes metadata immutable'),
      addDependent: addDependent('changes_requested', 'dependency declaration is allowed while changes are pending'),
    },
  },
  {
    status: 'approved',
    cells: {
      spawnWorker: allow('worker_running', 'approved work may explicitly restart worker rework'),
      spawnReviewer: allow('review_running', 'approved work may receive a fresh review'),
      merge: allow('merged', 'a clean approved review passes the merge gate'),
      rebase: allow('approved', 'a no-op rebase preserves a still-valid approval'),
      teardown: noTeardown('approved', 'approved but unmerged work must be preserved'),
      editMission: notEditable('approved', 'approval makes metadata immutable'),
      addDependent: addDependent('approved', 'a new mission may depend on approved but unmerged work'),
    },
  },
  {
    status: 'rebase_blocked',
    cells: {
      spawnWorker: allow('worker_running', 'worker rework is restartable after a rebase conflict'),
      spawnReviewer: reject('REVIEW_START_BLOCKED', 'mission M1 must complete a worker before review; current status is rebase_blocked', 'conflicted work cannot bypass rework and enter review'),
      merge: notApproved('rebase_blocked', 'a rebase conflict discards approval and blocks merge'),
      rebase: allow('rebase_blocked', 'rebase retry is accepted but the real conflict keeps it blocked', { rebased: false }),
      teardown: noTeardown('rebase_blocked', 'conflicted worktree must be preserved for recovery'),
      editMission: notEditable('rebase_blocked', 'blocked history makes metadata immutable'),
      addDependent: addDependent('rebase_blocked', 'dependency declaration is allowed while rebase is blocked'),
    },
  },
  {
    status: 'merge_blocked',
    cells: {
      spawnWorker: allow('worker_running', 'worker rework is restartable after a merge failure'),
      spawnReviewer: reject('REVIEW_START_BLOCKED', 'mission M1 must complete a worker before review; current status is merge_blocked', 'merge-blocked work cannot start review without a worker round'),
      merge: allow('merge_blocked', 'merge retry is accepted but the real hook keeps it blocked', { merged: false }),
      rebase: allow('approved', 'a clean no-op rebase restores the retained approval'),
      teardown: noTeardown('merge_blocked', 'merge-blocked worktree must be preserved for retry'),
      editMission: notEditable('merge_blocked', 'merge history makes metadata immutable'),
      addDependent: addDependent('merge_blocked', 'dependency declaration is allowed while merge is blocked'),
    },
  },
  {
    status: 'merged',
    cells: {
      spawnWorker: terminalSpawn('merged', 'worker', 'merged missions are terminal for workers'),
      spawnReviewer: terminalSpawn('merged', 'reviewer', 'merged missions are terminal for reviewers'),
      merge: allow('merged', 'merging an already merged mission is idempotent', { alreadyMerged: true }),
      rebase: terminalRebase('merged', 'merged history cannot be rebased'),
      teardown: allow('merged', 'terminal merged worktrees may be removed', { worktreeRemoved: true }),
      editMission: notEditable('merged', 'merged history is immutable'),
      addDependent: addDependent('merged', 'merged missions satisfy new dependency declarations'),
    },
  },
  {
    status: 'abandoned',
    cells: {
      spawnWorker: terminalSpawn('abandoned', 'worker', 'abandoned missions are terminal for workers'),
      spawnReviewer: terminalSpawn('abandoned', 'reviewer', 'abandoned missions are terminal for reviewers'),
      merge: notApproved('abandoned', 'abandoned work cannot be merged'),
      rebase: terminalRebase('abandoned', 'abandoned history cannot be rebased'),
      teardown: allow('abandoned', 'terminal abandoned worktrees may be removed', { worktreeRemoved: true }),
      editMission: notEditable('abandoned', 'abandonment makes metadata immutable'),
      addDependent: addDependent('abandoned', 'abandonment explicitly satisfies dependency readiness'),
    },
  },
];

async function createFixture(t, status) {
  // makeRepo creates a real mkdtemp Git repository and registers t.after cleanup.
  // No Git operation or TowerCore method is mocked anywhere in this file.
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  let mission;
  if (status === 'pending' || status === 'worker_running' || status === 'worker_failed' || status === 'abandoned') {
    mission = await core.addMission({ title: `Fixture ${status}`, description: `Exercise ${status} transitions` });
  }
  if (status === 'worker_running') {
    await core.beginSpawn({ missionId: mission.id, role: 'worker' });
  } else if (status === 'worker_failed') {
    const begun = await core.beginSpawn({ missionId: mission.id, role: 'worker' });
    await core.failSpawn(begun.runId, new Error('worker failed for the matrix'));
  } else if (status === 'abandoned') {
    await core.abandon(mission.id);
  } else if (!['pending', 'worker_running'].includes(status)) {
    const worker = await addAndRunWorker(core, {
      title: `Fixture ${status}`,
      file: status === 'rebase_blocked' ? 'README.md' : 'src/feature.txt',
      content: status === 'rebase_blocked' ? '# worker version\n' : `${status}\n`,
    });
    mission = worker.mission;
    if (status === 'review_running') {
      await core.beginSpawn({ missionId: mission.id, role: 'reviewer' });
    } else if (status === 'review_failed') {
      const begun = await core.beginSpawn({ missionId: mission.id, role: 'reviewer' });
      await core.failSpawn(begun.runId, new Error('review failed for the matrix'));
    } else if (status === 'changes_requested') {
      const begun = await core.beginSpawn({ missionId: mission.id, role: 'reviewer' });
      await core.completeSpawn(begun.runId, {
        stopReason: 'completed',
        structured: { verdict: 'changes_requested', merge: false, summary: 'rework', findings: [], checks: [] },
      });
    } else if (['approved', 'rebase_blocked', 'merge_blocked', 'merged'].includes(status)) {
      await approve(core, mission.id);
      if (status === 'rebase_blocked') {
        commitFile(repo, 'README.md', '# conflicting base\n', 'conflicting base change');
        const result = await core.rebase(mission.id);
        assert.equal(result.rebased, false);
      } else if (status === 'merge_blocked') {
        // A real pre-merge-commit hook rejects an otherwise merge-ready branch.
        await writeFile(path.join(repo, '.git', 'hooks', 'pre-merge-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        const result = await core.merge(mission.id);
        assert.equal(result.merged, false);
        assert.equal(result.gate.ready, true);
      } else if (status === 'merged') {
        assert.equal((await core.merge(mission.id)).merged, true);
      }
    }
  }
  const current = await core.mission('M1');
  assert.equal(current.status, status, `fixture must genuinely reach ${status}`);
  return { core, repo, mission: current };
}

function perform(core, action, missionId = 'M1') {
  switch (action) {
    case 'spawnWorker': return core.beginSpawn({ missionId, role: 'worker' });
    case 'spawnReviewer': return core.beginSpawn({ missionId, role: 'reviewer' });
    case 'merge': return core.merge(missionId);
    case 'rebase': return core.rebase(missionId);
    case 'teardown': return core.teardown({ missionId });
    case 'editMission': return core.editMission({ missionId, title: 'Edited matrix mission' });
    case 'addDependent': return core.addMission({ title: 'Dependent matrix mission', description: 'Declare a dependency', dependsOn: [missionId] });
    default: throw new Error(`unknown matrix action ${action}`);
  }
}

async function snapshot(core) {
  const state = await core.status();
  return { mission: state.missions.find((mission) => mission.id === 'M1'), events: state.events };
}

async function assertUnchanged(core, before, note) {
  assert.deepEqual(await snapshot(core), before, `${note}: refusal must not change the mission, revision, or events`);
}

async function assertRejected(core, action, cell) {
  const before = await snapshot(core);
  await assert.rejects(perform(core, action), (error) => {
    assert.equal(error.name, 'TowerError');
    assert.equal(error.code, cell.code);
    assert.equal(error.message, cell.message);
    return true;
  });
  await assertUnchanged(core, before, cell.note);
}

async function assertStructuredRefusal(core, action, cell) {
  const before = await snapshot(core);
  const result = await perform(core, action);
  if (action === 'merge') {
    assert.equal(result.merged, false);
    assert.equal(result.gate.ready, false);
    assert.ok(result.gate.blocks.some((block) => block.code === cell.code && block.message === cell.message), `missing exact ${cell.code} gate block`);
  } else {
    assert.equal(action, 'teardown');
    assert.deepEqual(result.results, [{ mission: 'M1', removed: false, reason: cell.message }]);
  }
  await assertUnchanged(core, before, cell.note);
}

async function assertAllowed(core, action, cell) {
  const result = await perform(core, action);
  if (action === 'addDependent') {
    assert.equal(result.id, 'M2');
    assert.equal(result.status, 'pending');
    assert.deepEqual(result.dependsOn, ['M1']);
    assert.equal((await core.mission('M1')).status, cell.status, 'adding a dependent must not transition its dependency');
    return;
  }
  const mission = await core.mission('M1');
  assert.equal(mission.status, cell.status, cell.note);
  if (action === 'spawnWorker' || action === 'spawnReviewer') {
    assert.equal(result.mission.status, cell.status);
    assert.match(result.runId, /^[0-9a-f-]{36}$/);
  } else if (action === 'merge') {
    assert.equal(result.mission.status, cell.status);
    if (cell.merged !== undefined) assert.equal(result.merged, cell.merged);
    else assert.equal(result.merged, true);
    if (cell.alreadyMerged) assert.equal(result.alreadyMerged, true);
  } else if (action === 'rebase') {
    assert.equal(result.mission.status, cell.status);
    assert.equal(result.rebased, cell.rebased ?? true);
  } else if (action === 'teardown') {
    assert.deepEqual(result.results, [{ mission: 'M1', removed: true }]);
    assert.equal(mission.worktreeRemoved, cell.worktreeRemoved);
  } else if (action === 'editMission') {
    assert.equal(result.title, 'Edited matrix mission');
    assert.equal(result.status, cell.status);
  }
}

for (const row of MATRIX) {
  for (const action of ACTIONS) {
    const cell = row.cells[action];
    assert.ok(cell, `missing matrix cell ${row.status} × ${action}`);
    test(`state matrix: ${row.status} × ${action} — ${cell.note}`, async (t) => {
      const { core } = await createFixture(t, row.status);
      if (cell.kind === 'reject') await assertRejected(core, action, cell);
      else if (cell.kind === 'refuse') await assertStructuredRefusal(core, action, cell);
      else await assertAllowed(core, action, cell);
    });
  }
}

test('state matrix guard: unmerged dependencies block worker startup without mutation', async (t) => {
  const { core } = await createFixture(t, 'pending');
  const dependent = await core.addMission({ title: 'Gated', description: 'Wait for M1', dependsOn: ['M1'] });
  const before = await core.status();
  await assert.rejects(core.beginSpawn({ missionId: dependent.id, role: 'worker' }), (error) => {
    assert.equal(error.name, 'TowerError');
    assert.equal(error.code, 'DEPENDENCIES_NOT_MERGED');
    assert.equal(error.message, 'mission M2 has unmerged dependencies');
    assert.deepEqual(error.details, { dependsOn: ['M1'] });
    return true;
  });
  const after = await core.status();
  assert.deepEqual(after.missions, before.missions);
  assert.deepEqual(after.events, before.events);
});

for (const role of ['worker', 'reviewer']) {
  test(`state matrix guard: removed worktree blocks ${role} startup without mutation`, async (t) => {
    const { core } = await createFixture(t, 'abandoned');
    await core.teardown({ missionId: 'M1' });
    // Terminal status is checked before worktreeRemoved. Seed a non-terminal
    // record with the real removed-worktree marker to isolate that guard branch.
    const state = await core.store.read();
    state.missions[0].status = 'pending';
    await core.store.write(state);
    const before = await snapshot(core);
    await assert.rejects(core.beginSpawn({ missionId: 'M1', role }), (error) => {
      assert.equal(error.name, 'TowerError');
      assert.equal(error.code, 'WORKTREE_REMOVED');
      assert.equal(error.message, 'mission M1 worktree was removed');
      return true;
    });
    await assertUnchanged(core, before, 'removed worktree spawn guard');
  });
}

test('state matrix guard: reviewer rejects no-change work without mutation', async (t) => {
  const { core } = await createFixture(t, 'worker_failed');
  // A no-op rebase reaches worker_completed without adding a commit.
  await core.rebase('M1');
  const before = await snapshot(core);
  await assert.rejects(core.beginSpawn({ missionId: 'M1', role: 'reviewer' }), (error) => {
    assert.equal(error.code, 'NO_CHANGE');
    assert.equal(error.message, 'mission M1 has no commit beyond the current base');
    return true;
  });
  await assertUnchanged(core, before, 'no-change review guard');
});

test('state matrix guard: reviewer rejects a stale base without mutation', async (t) => {
  const { core, repo } = await createFixture(t, 'worker_completed');
  commitFile(repo, 'base-only.txt', 'base moved\n', 'advance base beyond reviewed work');
  const before = await snapshot(core);
  await assert.rejects(core.beginSpawn({ missionId: 'M1', role: 'reviewer' }), (error) => {
    assert.equal(error.code, 'STALE_BASE');
    assert.equal(error.message, 'mission M1 must be rebased onto the current base before review');
    return true;
  });
  await assertUnchanged(core, before, 'stale-base review guard');
});

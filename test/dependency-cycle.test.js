import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { git, initializedCore, makeRepo } from './helpers.js';

function mission(id, dependsOn = []) {
  return {
    id,
    title: `Mission ${id}`,
    description: `Exercise dependency validation for ${id}`,
    dependsOn,
  };
}

async function snapshot(core, repo) {
  return {
    state: await core.status(),
    stateBytes: await readFile(path.join(repo, '.dsh-tower', 'state.json')),
    branches: git(repo, 'branch', '--format=%(refname:short)'),
    worktrees: git(repo, 'worktree', 'list', '--porcelain'),
  };
}

async function assertRejectedWithoutSideEffects(core, repo, operation, code, message) {
  const before = await snapshot(core, repo);
  await assert.rejects(operation(), (error) => {
    assert.equal(error.name, 'TowerError');
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    return true;
  });
  const after = await snapshot(core, repo);
  assert.deepEqual(after.state, before.state, 'rejection must not change missions, dependencies, revisions, or events');
  assert.deepEqual(after.stateBytes, before.stateBytes, 'rejection must leave state.json byte-for-byte unchanged');
  assert.equal(after.branches, before.branches, 'rejection must not create a branch');
  assert.equal(after.worktrees, before.worktrees, 'rejection must not create or register a worktree');
}

test('edit rejects a self-dependency without leaving state or Git artifacts', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission(mission('M1'));

  await assertRejectedWithoutSideEffects(
    core,
    repo,
    () => core.editMission({ missionId: 'M1', dependsOn: ['M1'] }),
    'DEPENDENCY_CYCLE',
    'mission dependencies form a cycle: M1 -> M1',
  );
});

test('edit rejects a two-node dependency cycle without changing either mission', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission(mission('M2'));
  await core.addMission(mission('M1', ['M2']));

  await assertRejectedWithoutSideEffects(
    core,
    repo,
    () => core.editMission({ missionId: 'M2', dependsOn: ['M1'] }),
    'DEPENDENCY_CYCLE',
    'mission dependencies form a cycle: M2 -> M1 -> M2',
  );
});

test('edit rejects a three-node dependency cycle and preserves the original chain', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission(mission('M3'));
  await core.addMission(mission('M2', ['M3']));
  await core.addMission(mission('M1', ['M2']));

  await assertRejectedWithoutSideEffects(
    core,
    repo,
    () => core.editMission({ missionId: 'M3', dependsOn: ['M1'] }),
    'DEPENDENCY_CYCLE',
    'mission dependencies form a cycle: M3 -> M1 -> M2 -> M3',
  );

  const missions = (await core.status()).missions;
  assert.deepEqual(
    missions.map(({ id, dependsOn }) => ({ id, dependsOn })),
    [
      { id: 'M3', dependsOn: [] },
      { id: 'M2', dependsOn: ['M3'] },
      { id: 'M1', dependsOn: ['M2'] },
    ],
  );
});

test('a valid dependency DAG with shared and chained dependencies is accepted', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission(mission('M4'));
  await core.addMission(mission('M3'));
  await core.addMission(mission('M2', ['M4']));
  await core.addMission(mission('M1', ['M2', 'M3']));

  const missions = (await core.status()).missions;
  assert.deepEqual(
    Object.fromEntries(missions.map(({ id, dependsOn }) => [id, dependsOn])),
    { M4: [], M3: [], M2: ['M4'], M1: ['M2', 'M3'] },
  );
  assert.equal(git(repo, 'branch', '--list', 'tower/*').split('\n').length, 4);
  assert.equal((git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm) ?? []).length, 5);
});

test('add and edit reject missing dependencies without side effects', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission(mission('M1'));

  await assertRejectedWithoutSideEffects(
    core,
    repo,
    () => core.addMission(mission('M2', ['MISSING'])),
    'MISSION_NOT_FOUND',
    'mission MISSING does not exist',
  );
  await assertRejectedWithoutSideEffects(
    core,
    repo,
    () => core.editMission({ missionId: 'M1', dependsOn: ['MISSING'] }),
    'MISSION_NOT_FOUND',
    'mission MISSING does not exist',
  );
});

test('add and edit reject repeated dependencies without side effects', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission(mission('M1'));

  await assertRejectedWithoutSideEffects(
    core,
    repo,
    () => core.addMission(mission('M2', ['M1', 'M1'])),
    'DEPENDENCY_INVALID',
    'mission dependencies must not repeat',
  );
  await assertRejectedWithoutSideEffects(
    core,
    repo,
    () => core.editMission({ missionId: 'M1', dependsOn: ['M1', 'M1'] }),
    'DEPENDENCY_INVALID',
    'mission dependencies must not repeat',
  );
});

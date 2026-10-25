import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { TowerStore } from '../lib/store.js';
import { makeRepo } from './helpers.js';

test('state writes are durable JSON and reads validate the version', async (t) => {
  const repo = makeRepo(t);
  const store = new TowerStore(repo);
  const state = {
    version: 1,
    repoRoot: repo,
    baseBranch: 'main',
    baseCommit: 'abc',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    missions: [],
    events: [],
  };
  await store.write(state);
  assert.equal((await store.read()).baseCommit, 'abc');
  const persisted = JSON.parse(await readFile(store.statePath, 'utf8'));
  assert.equal(persisted.version, 1);
  state.version = 99;
  await assert.rejects(store.write(state), /unsupported Tower state version/);
});

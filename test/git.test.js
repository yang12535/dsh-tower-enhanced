import assert from 'node:assert/strict';
import test from 'node:test';
import { currentBranch, runGit } from '../lib/git.js';
import { TowerCore } from '../lib/core.js';
import { git, makeRepo } from './helpers.js';

test('detached HEAD has a specific error for currentBranch and init', async (t) => {
  const repo = makeRepo(t);
  git(repo, 'checkout', '--detach', 'HEAD');
  await assert.rejects(currentBranch(repo), (error) => error.code === 'DETACHED_HEAD');
  const core = new TowerCore({ cwd: repo });
  await assert.rejects(core.init(), (error) => error.code === 'DETACHED_HEAD');
});

test('non-numeric process failures reject instead of masquerading as exit zero', async () => {
  await assert.rejects(
    runGit('/definitely/not/a/tower/repository', ['status']),
    (error) => error.name === 'TowerError' && ['GIT_FAILED', 'GIT_ABORTED'].includes(error.code),
  );
});

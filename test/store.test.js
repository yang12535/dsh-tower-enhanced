import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rename, rm } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';
import { TowerStore } from '../lib/store.js';
import { makeRepo } from './helpers.js';
import { chmod, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TowerError } from '../lib/errors.js';
import { ensureLocalExclude, validateState } from '../lib/store.js';

const runCommand = promisify(execFile);
const RENAME_OS_ERRORS = ['EISDIR', 'ENOTEMPTY', 'EEXIST'];

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

// --- shared helpers for the expanded coverage below ---

const TEMP_PREFIX = path.join(tmpdir(), 'dsh-tower-store-test-');

// Plain temporary directory; TowerStore itself needs no git metadata, so most
// tests below use this instead of a full git repository.
function tempDir(t) {
  const dir = mkdtempSync(TEMP_PREFIX);
  t.after(() => {
    if (dir.startsWith(TEMP_PREFIX)) rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function mission(id, overrides = {}) {
  return {
    id,
    title: `Mission ${id}`,
    branch: `tower/${id.toLowerCase()}`,
    worktree: `.dsh-tower/worktrees/${id.toLowerCase()}`,
    status: 'pending',
    dependsOn: [],
    scope: [],
    revision: 1,
    ...overrides,
  };
}

function baseState(repoRoot, missions = []) {
  return {
    version: 1,
    repoRoot: repoRoot,
    baseBranch: 'main',
    baseCommit: 'abc123',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    missions,
    events: [],
  };
}

function towerError(code, messagePattern) {
  return (error) => {
    assert.ok(error instanceof TowerError, `expected TowerError, got ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    if (messagePattern) assert.match(error.message, messagePattern);
    return true;
  };
}

// Leftover `<state.json>.<pid>.<uuid>.tmp` siblings would reveal a torn write.
async function tmpResidue(directory) {
  const entries = await readdir(directory);
  return entries.filter((name) => name.endsWith('.tmp'));
}

// --- constructor argument validation ---

test('TowerStore rejects invalid repoRoot and stateDirectory arguments', (t) => {
  const repo = tempDir(t);
  assert.throws(() => new TowerStore('relative/path'), towerError('REPO_ROOT_INVALID', /repoRoot must be absolute/));
  assert.throws(() => new TowerStore(repo, '/absolute/dir'), towerError('STATE_DIRECTORY_INVALID', /must be a relative path/));
  assert.throws(() => new TowerStore(repo, ''), towerError('STATE_DIRECTORY_INVALID', /must be a relative path/));
  assert.throws(() => new TowerStore(repo, '..'), towerError('STATE_DIRECTORY_INVALID', /must stay inside the repository/));
  assert.throws(() => new TowerStore(repo, 'a/../../escape'), towerError('STATE_DIRECTORY_INVALID', /must stay inside the repository/));
  assert.throws(() => new TowerStore(repo, '.'), towerError('STATE_DIRECTORY_INVALID', /must stay inside the repository/));
  const nested = new TowerStore(repo, 'nested/tower');
  assert.equal(nested.directory, path.join(repo, 'nested/tower'));
  assert.equal(nested.statePath, path.join(repo, 'nested/tower/state.json'));
  assert.equal(nested.worktrees, path.join(repo, 'nested/tower/worktrees'));
});

// --- uninitialized store semantics ---

test('reading an uninitialized store reports TOWER_NOT_INITIALIZED without creating files', async (t) => {
  const repo = tempDir(t);
  const store = new TowerStore(repo);
  assert.equal(await store.exists(), false);
  await assert.rejects(store.read(), towerError('TOWER_NOT_INITIALIZED', /not initialized/));
  await assert.rejects(store.read(), towerError('TOWER_NOT_INITIALIZED', /action init first/));
  // failed reads must not lazily create the state directory or any file
  assert.deepEqual(await readdir(repo), []);
});

// --- version mismatch / corrupted state file ---

test('version mismatches fail with STATE_INVALID and never overwrite the file', async (t) => {
  const repo = tempDir(t);
  const store = new TowerStore(repo);
  await store.write(baseState(repo));
  const future = { ...baseState(repo), version: 99, baseCommit: 'from-the-future' };
  await writeFile(store.statePath, `${JSON.stringify(future, null, 2)}\n`);
  const before = await readFile(store.statePath, 'utf8');
  await assert.rejects(store.read(), towerError('STATE_INVALID', /unsupported Tower state version 99/));
  // update() reads before mutating, so the mutator never runs and nothing is written back
  let mutatorRan = false;
  await assert.rejects(
    store.update(() => {
      mutatorRan = true;
    }),
    towerError('STATE_INVALID', /unsupported Tower state version 99/),
  );
  assert.equal(mutatorRan, false);
  assert.equal(await readFile(store.statePath, 'utf8'), before);
  assert.equal(await store.exists(), true);
  assert.deepEqual(await tmpResidue(store.directory), []);
});

test('corrupted JSON fails with STATE_INVALID, keeps the cause and preserves the file', async (t) => {
  const repo = tempDir(t);
  const store = new TowerStore(repo);
  await mkdir(path.dirname(store.statePath), { recursive: true });
  await writeFile(store.statePath, '{ this is not json');
  const before = await readFile(store.statePath, 'utf8');
  await assert.rejects(store.read(), towerError('STATE_INVALID', /could not parse/));
  await assert.rejects(store.read(), (error) => {
    assert.ok(error instanceof TowerError);
    assert.equal(error.code, 'STATE_INVALID');
    assert.ok(error.cause instanceof SyntaxError, 'original parse error is attached as cause');
    return true;
  });
  // a failing update leaves the (corrupt) bytes untouched as well
  await assert.rejects(store.update(() => assert.fail('mutator must not run')), towerError('STATE_INVALID', /could not parse/));
  assert.equal(await readFile(store.statePath, 'utf8'), before);
  assert.deepEqual(await tmpResidue(store.directory), []);
});

// --- atomic write failure path ---

test('write failures keep the previous state readable and leave no partial files', async (t) => {
  // Simulated with a real read-only directory (no fs mocking); as root chmod
  // cannot restrict writes, so that environment skips this case.
  if (process.getuid && process.getuid() === 0) {
    t.skip('chmod-based read-only directories do not block root');
    return;
  }
  const repo = tempDir(t);
  const store = new TowerStore(repo);
  await store.write(baseState(repo, [mission('M1')]));
  const before = await readFile(store.statePath, 'utf8');
  const permissionDenied = (error) => ['EACCES', 'EPERM'].includes(error.code);
  await chmod(store.directory, 0o500);
  try {
    await assert.rejects(store.write(baseState(repo, [mission('M1'), mission('M2')])), permissionDenied);
    await assert.rejects(
      store.update((state) => {
        state.missions.push(mission('M3'));
      }),
      permissionDenied,
    );
  } finally {
    // restore before cleanup so the t.after rmSync can unlink the directory
    await chmod(store.directory, 0o700);
  }
  assert.equal(await readFile(store.statePath, 'utf8'), before);
  assert.deepEqual((await store.read()).missions.map((entry) => entry.id), ['M1']);
  assert.deepEqual(await tmpResidue(store.directory), []);
  // the queue survives the failures and keeps serving later updates
  await store.update((state) => {
    state.missions.push(mission('M2'));
  });
  assert.deepEqual((await store.read()).missions.map((entry) => entry.id), ['M1', 'M2']);
});

test('rename onto a non-empty directory rethrows the raw OS error and leaves no temp file', async (t) => {
  const repo = tempDir(t);
  const store = new TowerStore(repo);
  await store.write(baseState(repo, [mission('M1')]));
  await rm(store.statePath);
  await mkdir(store.statePath);
  const blocker = path.join(store.statePath, 'blocker');
  await writeFile(blocker, 'target-content');
  await assert.rejects(store.write(baseState(repo, [mission('M1'), mission('M2')])), (error) => {
    assert.ok(!(error instanceof TowerError), 'rename error must not be wrapped in TowerError');
    assert.ok(RENAME_OS_ERRORS.includes(error.code), `unexpected error code ${error.code}`);
    assert.equal(error.syscall, 'rename');
    return true;
  });
  assert.equal(await readFile(blocker, 'utf8'), 'target-content');
  assert.deepEqual(await tmpResidue(store.directory), []);
});

test('update rename failures keep the saved original state and spare unrelated temp files', async (t) => {
  const repo = tempDir(t);
  const store = new TowerStore(repo);
  await store.write(baseState(repo, [mission('M1')]));
  const before = await readFile(store.statePath, 'utf8');
  const unrelated = path.join(store.directory, 'unrelated.tmp');
  await writeFile(unrelated, 'another-process-temp');
  const saved = path.join(store.directory, 'state.json.saved');
  let failure;
  try {
    await store.update(async (state) => {
      await rename(store.statePath, saved);
      await mkdir(store.statePath);
      await writeFile(path.join(store.statePath, 'blocker'), 'occupied');
      state.missions.push(mission('M2'));
    });
    assert.fail('update should reject when the rename target is a non-empty directory');
  } catch (error) {
    failure = error;
  }
  assert.ok(!(failure instanceof TowerError), 'rename error must not be wrapped in TowerError');
  assert.ok(RENAME_OS_ERRORS.includes(failure.code), `unexpected error code ${failure.code}`);
  assert.equal(failure.syscall, 'rename');
  assert.equal(await readFile(saved, 'utf8'), before);
  assert.equal(await readFile(path.join(store.statePath, 'blocker'), 'utf8'), 'occupied');
  assert.deepEqual(await tmpResidue(store.directory), ['unrelated.tmp']);
  await rm(store.statePath, { recursive: true, force: true });
  await rename(saved, store.statePath);
  await store.update((state) => {
    state.missions.push(mission('M3'));
  });
  assert.deepEqual((await store.read()).missions.map((entry) => entry.id), ['M1', 'M3']);
  assert.equal(await readFile(unrelated, 'utf8'), 'another-process-temp');
  assert.deepEqual(await tmpResidue(store.directory), ['unrelated.tmp']);
});

test('a real EFBIG mid-write failure keeps state.json byte-identical and cleans its temp file', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('RLIMIT_FSIZE via bash ulimit is exercised on Linux only');
    return;
  }
  const repo = tempDir(t);
  const store = new TowerStore(repo);
  await store.write(baseState(repo, [mission('M1')]));
  const before = await readFile(store.statePath, 'utf8');
  const libUrl = new URL('../lib/store.js', import.meta.url).href;
  const child = `
import { readFile, readdir } from 'node:fs/promises';
import { TowerStore } from ${JSON.stringify(libUrl)};
const store = new TowerStore(${JSON.stringify(repo)});
let errorCode = null;
let errorName = null;
try {
  await store.update((state) => {
    state.events.push({ type: 'padding', payload: 'x'.repeat(8192) });
  });
} catch (error) {
  errorCode = error.code ?? null;
  errorName = error.constructor?.name ?? null;
}
process.stdout.write(JSON.stringify({
  errorCode,
  errorName,
  raw: await readFile(store.statePath, 'utf8'),
  tmp: (await readdir(${JSON.stringify(store.directory)})).filter((name) => name.endsWith('.tmp')),
}));
`;
  // ulimit -f 2 caps this child at 2 KiB per file; SIGXFSZ is ignored so
  // writeFile returns EFBIG after a partial write instead of being killed.
  const { stdout, stderr } = await runCommand(
    'bash',
    ['-c', 'trap "" XFSZ && ulimit -f 2 && exec "$0" --input-type=module -e "$1"', process.execPath, child],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 },
  );
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.notEqual(result.errorName, 'TowerError');
  assert.equal(result.errorCode, 'EFBIG');
  assert.equal(result.raw, before);
  assert.deepEqual(result.tmp, []);
  assert.equal(await readFile(store.statePath, 'utf8'), before);
  assert.deepEqual(await tmpResidue(store.directory), []);
  await store.update((state) => {
    state.missions.push(mission('M2'));
  });
  assert.deepEqual((await store.read()).missions.map((entry) => entry.id), ['M1', 'M2']);
});

// --- serialized update queue ---

test('concurrent updates are serialized and lose no read-modify-write cycles', async (t) => {
  const repo = tempDir(t);
  const store = new TowerStore(repo);
  await store.write(baseState(repo));
  const total = 25;
  const observed = [];
  const results = await Promise.all(
    Array.from({ length: total }, (_, index) =>
      store.update(async (state) => {
        // every mutator must observe exactly the missions written by its predecessors
        observed.push(state.missions.length);
        state.missions.push(mission(`M${index}`));
        return index;
      }),
    ),
  );
  assert.deepEqual(results, Array.from({ length: total }, (_, index) => index));
  assert.deepEqual(observed, Array.from({ length: total }, (_, index) => index));
  const final = await store.read();
  assert.equal(final.missions.length, total);
  assert.deepEqual(
    final.missions.map((entry) => entry.id),
    Array.from({ length: total }, (_, index) => `M${index}`),
  );
  const persisted = JSON.parse(await readFile(store.statePath, 'utf8'));
  assert.equal(persisted.missions.length, total);
  assert.deepEqual(await tmpResidue(store.directory), []);
});

test('mutator failures never persist partial changes', async (t) => {
  const repo = tempDir(t);
  const store = new TowerStore(repo);
  await store.write(baseState(repo, [mission('M1')]));
  const before = await store.read();
  const beforeRaw = await readFile(store.statePath, 'utf8');
  const failure = new Error('mutator exploded');
  await assert.rejects(
    store.update((state) => {
      state.missions.push(mission('M2')); // partial mutation before the throw
      state.baseBranch = 'corrupted';
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(await readFile(store.statePath, 'utf8'), beforeRaw);
  assert.deepEqual(await store.read(), before);
  assert.deepEqual(await tmpResidue(store.directory), []);
  // a later update still runs: the queue is not poisoned by the failure
  await store.update((state) => {
    state.missions.push(mission('M3'));
  });
  assert.deepEqual((await store.read()).missions.map((entry) => entry.id), ['M1', 'M3']);
});

test('a failing update does not block or corrupt sibling updates in the queue', async (t) => {
  const repo = tempDir(t);
  const store = new TowerStore(repo);
  await store.write(baseState(repo));
  const outcomes = await Promise.allSettled([
    store.update((state) => {
      state.missions.push(mission('A'));
    }),
    store.update(() => {
      throw new Error('boom');
    }),
    store.update((state) => {
      state.missions.push(mission('B'));
    }),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.equal(outcomes[2].status, 'fulfilled');
  assert.deepEqual((await store.read()).missions.map((entry) => entry.id), ['A', 'B']);
});

// --- permissions, layout and read-after-write consistency ---

test('write creates the state directory tree and keeps state.json at mode 0600', async (t) => {
  const repo = tempDir(t);
  const store = new TowerStore(repo, 'nested/deep/tower');
  await store.write(baseState(repo));
  const info = await stat(store.statePath);
  assert.equal(info.mode & 0o777, 0o600);
  const worktrees = await stat(path.join(repo, 'nested/deep/tower/worktrees'));
  assert.ok(worktrees.isDirectory());
  assert.equal(await store.exists(), true);
  const defaults = new TowerStore(repo);
  assert.equal(defaults.directory, path.join(repo, '.dsh-tower'));
});

test('written state re-reads identically with stable JSON formatting and no temp residue', async (t) => {
  const repo = tempDir(t);
  const store = new TowerStore(repo);
  const startedAt = Date.now();
  const state = baseState(repo, [mission('M1', { status: 'merged' })]);
  await store.write(state);
  assert.ok(Date.parse(state.updatedAt) >= startedAt, 'write() stamps updatedAt on the in-memory state');
  const raw = await readFile(store.statePath, 'utf8');
  assert.ok(raw.endsWith('\n'));
  const parsed = JSON.parse(raw);
  assert.equal(raw, `${JSON.stringify(parsed, null, 2)}\n`);
  assert.equal(new Date(parsed.updatedAt).toISOString(), parsed.updatedAt);
  assert.equal(parsed.updatedAt, state.updatedAt);
  assert.equal(parsed.missions[0].status, 'merged');
  assert.deepEqual(await store.read(), parsed);
  assert.deepEqual(await tmpResidue(store.directory), []);
  assert.deepEqual((await readdir(store.directory)).sort(), ['state.json', 'worktrees']);
});

// --- validateState schema enforcement ---

test('validateState accepts valid states and rejects structural violations', (t) => {
  const repo = tempDir(t);
  const good = baseState(repo, [
    mission('M1', { status: 'merged' }),
    mission('M2', { status: 'pending', dependsOn: ['M1'], revision: 7 }),
  ]);
  assert.equal(validateState(good), good);
  const cases = [
    [null, /Tower state must be an object/],
    [{ ...baseState(repo), version: 2 }, /unsupported Tower state version 2/],
    [{ ...baseState(repo), repoRoot: 'relative/path' }, /repoRoot must be absolute/],
    [{ ...baseState(repo), baseBranch: '' }, /baseBranch is required/],
    [{ ...baseState(repo), baseCommit: '' }, /baseCommit is required/],
    [{ ...baseState(repo), missions: 'nope' }, /missions must be an array/],
    [baseState(repo, [mission('M1'), mission('M1')]), /duplicate mission M1/],
    [baseState(repo, [mission('M1', { status: 'bogus' })]), /unknown mission status bogus/],
    [baseState(repo, [mission('M1', { worktree: '' })]), /mission worktree is required/],
    [baseState(repo, [mission('M1', { revision: 0 })]), /mission revision must be positive/],
    [baseState(repo, [mission('M1', { revision: 1.5 })]), /mission revision must be positive/],
    [baseState(repo, [mission('M1', { scope: [42] })]), /mission scope must be a string array/],
    [baseState(repo, [mission('M1', { dependsOn: [{}] })]), /mission dependsOn must be a string array/],
  ];
  for (const [candidate, pattern] of cases) {
    assert.throws(() => validateState(candidate), towerError('STATE_INVALID', pattern));
  }
});

// --- ensureLocalExclude (.git/info/exclude maintenance) ---

test('ensureLocalExclude creates the exclude file on demand and is idempotent', async (t) => {
  const repo = tempDir(t);
  const exclude = path.join(repo, '.git/info/exclude');
  // .git/info does not exist yet: the directory is created and the entry appended
  await ensureLocalExclude('.git/info/exclude', repo, '.dsh-tower');
  assert.equal(await readFile(exclude, 'utf8'), '.dsh-tower/\n');
  // a second call must not duplicate the entry
  await ensureLocalExclude('.git/info/exclude', repo, '.dsh-tower');
  assert.equal(await readFile(exclude, 'utf8'), '.dsh-tower/\n');
});

test('ensureLocalExclude appends after existing content and normalizes the entry', async (t) => {
  const repo = tempDir(t);
  const exclude = path.join(repo, '.git/info/exclude');
  await mkdir(path.dirname(exclude), { recursive: true });
  await writeFile(exclude, '*.log'); // no trailing newline
  await ensureLocalExclude('.git/info/exclude', repo, 'nested/state');
  assert.equal(await readFile(exclude, 'utf8'), '*.log\nnested/state/\n');
  // backslashes are normalized and a trailing slash collapses, so this is still a no-op
  await ensureLocalExclude('.git/info/exclude', repo, 'nested\\state\\');
  assert.equal(await readFile(exclude, 'utf8'), '*.log\nnested/state/\n');
  // an entry that is already present without a trailing newline is left byte-identical
  await writeFile(exclude, 'custom\nnested/state/');
  await ensureLocalExclude('.git/info/exclude', repo, 'nested/state');
  assert.equal(await readFile(exclude, 'utf8'), 'custom\nnested/state/');
});

test('ensureLocalExclude surfaces non-ENOENT read errors', async (t) => {
  const repo = tempDir(t);
  await mkdir(path.join(repo, 'blocker'), { recursive: true });
  await assert.rejects(
    ensureLocalExclude('blocker', repo, '.dsh-tower'),
    (error) => error.code === 'EISDIR',
  );
});

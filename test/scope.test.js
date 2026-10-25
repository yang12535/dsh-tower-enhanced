import assert from 'node:assert/strict';
import test from 'node:test';
import { approve, commitFile, git, initializedCore, makeRepo, writeDirty } from './helpers.js';

// Mission-scope coverage: validateScope rules enforced by addMission (probed
// through the public TowerCore API; validateScope itself is not exported) and
// the glob semantics matchesGlob applies to changedFiles inside the merge
// gate's OUT_OF_SCOPE block. Everything runs against real temporary git
// repositories and a real TowerCore, mirroring the fixtures in helpers.js.

/** Run a worker that applies `mutate` in the mission worktree, commit, get a clean review, and return the merge gate verdict. */
async function scopedGate(core, { title, scope }, mutate) {
  const mission = await core.addMission({ title, description: `${title} mission.`, scope });
  const begun = await core.beginSpawn({ missionId: mission.id, role: 'worker' });
  await core.attachSpawn(begun.runId, `worker-${mission.id}`);
  mutate(begun.mission.worktree);
  git(begun.mission.worktree, 'add', '-A');
  git(begun.mission.worktree, 'commit', '-m', `worker: ${title}`);
  await core.completeSpawn(begun.runId, { stopReason: 'completed', output: 'worker report' });
  await approve(core, mission.id);
  return core.mergeGate(mission.id);
}

/** Sorted file names listed by the gate's OUT_OF_SCOPE block, or null when there is no such block. */
function outsideFiles(gate) {
  const block = gate.blocks.find((candidate) => candidate.code === 'OUT_OF_SCOPE');
  return block ? [...block.files].sort() : null;
}

function writeAll(worktree, files) {
  for (const [file, content] of Object.entries(files)) writeDirty(worktree, file, content);
}

test('addMission rejects empty, null-byte, absolute, and parent-escaping scope patterns', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);

  const malformed = [[''], ['src/**', ''], ['a\0b']];
  for (const scope of malformed) {
    await assert.rejects(() => core.addMission({ title: 'Malformed', description: 'Bad pattern shape.', scope }), (error) => {
      assert.equal(error.code, 'SCOPE_INVALID', JSON.stringify(scope));
      assert.match(error.message, /scope patterns must be non-empty strings/);
      return true;
    });
  }

  const escaping = [
    ['/etc/passwd'],
    ['//server/share'],
    ['..'],
    ['../secret'],
    ['src/../lib'],
    ['src/**', 'a/../../etc'],
  ];
  for (const scope of escaping) {
    await assert.rejects(() => core.addMission({ title: 'Escaping', description: 'Path escapes the repository.', scope }), (error) => {
      assert.equal(error.code, 'SCOPE_INVALID', JSON.stringify(scope));
      assert.match(error.message, /must be repository-relative/);
      return true;
    });
  }
  await assert.rejects(() => core.addMission({ title: 'Absolute', description: 'Absolute path.', scope: ['/etc/passwd'] }), /\/etc\/passwd/);

  // None of the rejected calls may leave a mission behind.
  assert.deepEqual((await core.status()).missions, []);
});

test('addMission deduplicates scope patterns and accepts literal dots and whitespace', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);

  const deduped = await core.addMission({
    title: 'Dedup',
    description: 'Repeated patterns collapse.',
    scope: ['src/**', '...', 'src/**', 'a..b.js', ' '],
  });
  // '...' and 'a..b.js' are literal names, not '..' segments, so they pass.
  // Whitespace-only items are neither trimmed nor rejected (current behavior:
  // such a pattern matches only a file literally called " " and therefore
  // over-restricts rather than widening the scope).
  assert.deepEqual(deduped.scope, ['src/**', '...', 'a..b.js', ' ']);

  // `null` coalesces to the default empty scope, i.e. unrestricted.
  const unrestricted = await core.addMission({ title: 'Null scope', description: 'Nullish default.', scope: null });
  assert.deepEqual(unrestricted.scope, []);
});

test('addMission splits a string scope into characters where editMission rejects it', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);

  // Current behavior: addMission iterates scope patterns without an
  // Array.isArray guard, so a plain string is validated character by
  // character and silently accepted. Reported as a consistency gap;
  // editMission rejects the very same input.
  const split = await core.addMission({ title: 'String scope', description: 'String input.', scope: 'ab' });
  assert.deepEqual(split.scope, ['a', 'b']);
  await assert.rejects(() => core.editMission({ missionId: split.id, scope: 'ab' }), (error) => {
    assert.equal(error.code, 'ARGUMENT_INVALID');
    assert.match(error.message, /scope must be an array/);
    return true;
  });

  // A string containing '/' is rejected only because the lone '/' character is
  // itself an absolute path, which produces a confusing message.
  await assert.rejects(() => core.addMission({ title: 'Path string', description: 'String path.', scope: 'src/x' }), (error) => {
    assert.equal(error.code, 'SCOPE_INVALID');
    assert.match(error.message, /repository-relative: \/$/);
    return true;
  });

  // A non-iterable scope leaks a raw TypeError instead of ARGUMENT_INVALID.
  await assert.rejects(() => core.addMission({ title: 'Not iterable', description: 'Number input.', scope: 42 }), TypeError);

  // The failed updates must not wedge the store.
  const healthy = await core.addMission({ title: 'Still healthy', description: 'Store recovers.', scope: ['lib/**'] });
  assert.deepEqual(healthy.scope, ['lib/**']);
});

test('scope and dependsOn validation stay independent with distinct error codes', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const first = await core.addMission({ title: 'First', description: 'Dependency target.' });

  await assert.rejects(() => core.addMission({ title: 'Bad scope', description: 'Scope only.', scope: ['/abs'] }), (error) => {
    assert.equal(error.code, 'SCOPE_INVALID');
    return true;
  });
  // dependsOn problems surface their own codes even when the scope is also invalid.
  await assert.rejects(() => core.addMission({ title: 'Unknown dep', description: 'Both invalid.', scope: ['/abs'], dependsOn: ['NOPE'] }), (error) => {
    assert.equal(error.code, 'MISSION_NOT_FOUND');
    return true;
  });
  await assert.rejects(() => core.addMission({ title: 'Repeat dep', description: 'Both invalid.', scope: ['/abs'], dependsOn: [first.id, first.id] }), (error) => {
    assert.equal(error.code, 'DEPENDENCY_INVALID');
    return true;
  });
  await assert.rejects(() => core.addMission({ title: 'String dep', description: 'Both invalid.', scope: ['/abs'], dependsOn: first.id }), (error) => {
    assert.equal(error.code, 'ARGUMENT_INVALID');
    assert.match(error.message, /dependsOn must be a string array/);
    return true;
  });
  await assert.rejects(() => core.addMission({ title: 'Number dep', description: 'Both invalid.', scope: ['/abs'], dependsOn: [42] }), (error) => {
    assert.equal(error.code, 'ARGUMENT_INVALID');
    return true;
  });

  const both = await core.addMission({ title: 'Valid pair', description: 'Both valid.', scope: ['lib/**'], dependsOn: [first.id] });
  assert.deepEqual(both.scope, ['lib/**']);
  assert.deepEqual(both.dependsOn, [first.id]);
  // Rejected calls consumed no ids and stored no missions.
  assert.deepEqual((await core.status()).missions.map((mission) => mission.id), [first.id, both.id]);
});

test('directory globs: ** crosses separators, * stays within one segment', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);

  const deep = await scopedGate(core, { title: 'Deep **', scope: ['src/**'] }, (worktree) => writeAll(worktree, {
    'src/a/b/c/deep.js': 'deep\n',
    'src/top.txt': 'top\n',
    'src.txt': 'sibling\n',
  }));
  assert.equal(deep.ready, false);
  assert.deepEqual(outsideFiles(deep), ['src.txt'], 'src/** matches any depth below src/ but not a sibling like src.txt');
  assert.deepEqual([...deep.observations.changedFiles].sort(), ['src.txt', 'src/a/b/c/deep.js', 'src/top.txt']);

  const rootStar = await scopedGate(core, { title: 'Root star', scope: ['*.js'] }, (worktree) => writeAll(worktree, {
    'root.js': 'root\n',
    'src/root.js': 'nested\n',
  }));
  assert.deepEqual(outsideFiles(rootStar), ['src/root.js'], '*.js matches only repository-root files');

  const dirStar = await scopedGate(core, { title: 'Dir star', scope: ['src/*.js'] }, (worktree) => writeAll(worktree, {
    'src/flat.js': 'flat\n',
    'src/sub/nested.js': 'nested\n',
  }));
  assert.deepEqual(outsideFiles(dirStar), ['src/sub/nested.js'], 'src/*.js does not reach subdirectories');

  const midGlobstar = await scopedGate(core, { title: 'Mid **', scope: ['src/**/gen/*.js'] }, (worktree) => writeAll(worktree, {
    'src/gen/x.js': 'zero extra segments\n',
    'src/a/b/gen/y.js': 'two extra segments\n',
    'src/gen/sub/z.js': 'below gen\n',
  }));
  assert.equal(midGlobstar.ready, false);
  assert.deepEqual(outsideFiles(midGlobstar), ['src/gen/sub/z.js'], '**/ matches zero or more whole segments');

  const leadGlobstar = await scopedGate(core, { title: 'Leading **', scope: ['**/*.js'] }, (worktree) => writeAll(worktree, {
    'a.js': 'root\n',
    'a/b/c.js': 'deep\n',
    'd.txt': 'not js\n',
  }));
  assert.deepEqual(outsideFiles(leadGlobstar), ['d.txt'], '**/*.js matches .js files at every depth');
});

test('single-segment wildcards: ? and character classes', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);

  const question = await scopedGate(core, { title: 'Question', scope: ['src/a?.js'] }, (worktree) => writeAll(worktree, {
    'src/ab.js': 'matched\n',
    'src/abc.js': 'too long\n',
  }));
  assert.equal(question.ready, false);
  assert.deepEqual(outsideFiles(question), ['src/abc.js'], '? matches exactly one character');

  const charClass = await scopedGate(core, { title: 'Char class', scope: ['src/[ab].js'] }, (worktree) => writeAll(worktree, {
    'src/a.js': 'in class\n',
    'src/c.js': 'out of class\n',
  }));
  assert.deepEqual(outsideFiles(charClass), ['src/c.js'], '[ab] matches a or b');

  const negated = await scopedGate(core, { title: 'Negated class', scope: ['src/x[!0-9].js'] }, (worktree) => writeAll(worktree, {
    'src/xa.js': 'letter\n',
    'src/x1.js': 'digit\n',
  }));
  assert.deepEqual(outsideFiles(negated), ['src/x1.js'], '[!0-9] rejects digits');
});

test('multi-pattern scopes pass on any match; an empty scope skips the check', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);

  const anyMatch = await scopedGate(core, { title: 'Any match', scope: ['docs/**', 'lib/**'] }, (worktree) => writeAll(worktree, {
    'lib/a.js': 'lib\n',
    'docs/deep/b.md': 'docs\n',
    'test/c.js': 'test\n',
  }));
  assert.equal(anyMatch.ready, false);
  assert.deepEqual(outsideFiles(anyMatch), ['test/c.js'], 'each file may match any single pattern');

  const inside = await scopedGate(core, { title: 'All inside', scope: ['outside/**'] }, (worktree) => writeAll(worktree, {
    'outside/one.txt': 'one\n',
    'outside/deep/two.txt': 'two\n',
  }));
  assert.equal(inside.ready, true, 'a clean review of in-scope changes passes the gate');
  assert.equal(outsideFiles(inside), null);

  const empty = await scopedGate(core, { title: 'Empty scope', scope: [] }, (worktree) => writeAll(worktree, {
    'anywhere/x.txt': 'x\n',
    'other/y.js': 'y\n',
  }));
  assert.equal(empty.ready, true, 'an empty scope disables the OUT_OF_SCOPE check entirely');
  assert.equal(outsideFiles(empty), null);
  assert.equal(empty.observations.changedFiles, undefined, 'with an empty scope the gate never even collects changed files');
});

test('renames hit the scope gate as delete+add because rename detection is disabled', async (t) => {
  const repo = makeRepo(t);
  commitFile(repo, 'allowed/a.txt', 'renamed within scope\n', 'fixture: in-scope file');
  commitFile(repo, 'allowed/move-out.txt', 'renamed out of scope\n', 'fixture: file to move out');
  const core = await initializedCore(repo);

  const inside = await scopedGate(core, { title: 'Rename inside', scope: ['allowed/**'] }, (worktree) => {
    git(worktree, 'mv', 'allowed/a.txt', 'allowed/b.txt');
  });
  assert.equal(inside.ready, true);
  assert.equal(outsideFiles(inside), null);
  assert.deepEqual([...inside.observations.changedFiles].sort(), ['allowed/a.txt', 'allowed/b.txt'], '--no-renames reports both sides of the rename');

  const outside = await scopedGate(core, { title: 'Rename outside', scope: ['allowed/**'] }, (worktree) => {
    git(worktree, 'mv', 'allowed/move-out.txt', 'moved-out.txt');
  });
  assert.equal(outside.ready, false);
  assert.deepEqual(outsideFiles(outside), ['moved-out.txt'], 'the new path lands outside the scope even though the old path matched');
  assert.deepEqual([...outside.observations.changedFiles].sort(), ['allowed/move-out.txt', 'moved-out.txt']);
  const block = outside.blocks.find((candidate) => candidate.code === 'OUT_OF_SCOPE');
  assert.match(block.message, /moved-out\.txt/);
});

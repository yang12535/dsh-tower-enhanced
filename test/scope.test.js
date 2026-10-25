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

test('addMission deduplicates exact scope patterns without trimming literal whitespace', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const scope = ['src/**', '...', 'a..b.js', ' ', ' src/**', 'src/file '];
  const deduped = await core.addMission({
    title: 'Dedup', description: 'Repeated patterns collapse.', scope: [...scope, 'src/**'],
  });
  assert.deepEqual(deduped.scope, scope);
  const edited = await core.editMission({ missionId: deduped.id, scope: [...scope, ' src/**'] });
  assert.deepEqual(edited.scope, scope);
});

test('add and edit reject non-array scope without state or Git side effects', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const mission = await core.addMission({ title: 'Editable', description: 'Target.', scope: ['lib/**'] });
  const before = await core.status();
  const branches = git(repo, 'for-each-ref', '--format=%(refname) %(objectname)');
  const worktrees = git(repo, 'worktree', 'list', '--porcelain');
  for (const scope of ['ab', 'src/x', '', 42, false, {}, new Set(['lib/**']), null]) {
    const invalid = (error) => {
      assert.equal(error.code, 'ARGUMENT_INVALID');
      assert.match(error.message, /scope must be an array of glob patterns/);
      return true;
    };
    await assert.rejects(core.addMission({ title: 'Invalid', description: 'Bad scope.', scope }), invalid);
    await assert.rejects(core.editMission({ missionId: mission.id, scope }), invalid);
    assert.deepEqual(await core.status(), before);
    assert.equal(git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'), branches);
    assert.equal(git(repo, 'worktree', 'list', '--porcelain'), worktrees);
  }
  const healthy = await core.addMission({ title: 'Healthy', description: 'Store recovers.', scope: ['lib/**'] });
  assert.equal(healthy.id, 'M2');
  assert.deepEqual(healthy.scope, ['lib/**']);
});

test('null scope is not an unrestricted default; omitted and empty scope remain supported', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await assert.rejects(core.addMission({ title: 'Null', description: 'Invalid.', scope: null }), (error) => error.code === 'ARGUMENT_INVALID');
  for (const fields of [{}, { scope: undefined }, { scope: [] }]) {
    const mission = await core.addMission({ title: 'Unrestricted', description: 'Default or explicit.', ...fields });
    assert.deepEqual(mission.scope, []);
  }
  const mission = await core.addMission({ title: 'Restricted', description: 'Keep scope.', scope: ['lib/**'] });
  assert.deepEqual((await core.editMission({ missionId: mission.id, title: 'Renamed' })).scope, ['lib/**']);
  assert.deepEqual((await core.editMission({ missionId: mission.id, scope: undefined })).scope, ['lib/**']);
  assert.deepEqual((await core.editMission({ missionId: mission.id, scope: [] })).scope, []);
});

test('invalid scope elements are rejected consistently without persisting edits', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const mission = await core.addMission({ title: 'Restricted', description: 'Keep scope.', scope: ['lib/**'] });
  const before = await core.status();
  for (const scope of [[42], [null], [{}], [''], ['lib/**', undefined], new Array(1)]) {
    const invalid = (error) => {
      assert.equal(error.code, 'SCOPE_INVALID');
      assert.match(error.message, /non-empty strings/);
      return true;
    };
    await assert.rejects(core.addMission({ title: 'Invalid', description: 'Bad element.', scope }), invalid);
    await assert.rejects(core.editMission({ missionId: mission.id, title: 'Must not persist', scope }), invalid);
    assert.deepEqual(await core.status(), before);
  }
});

test('scope gate preserves leading and trailing spaces instead of authorizing trimmed paths', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const gate = await scopedGate(core, { title: 'Literal spaces', scope: [' allowed/**', 'trailing ', ' '] }, (worktree) => writeAll(worktree, {
    ' allowed/file.txt': 'in scope\n',
    'allowed/file.txt': 'outside scope\n',
    'trailing ': 'in scope\n',
    trailing: 'outside scope\n',
    ' ': 'in scope\n',
  }));
  assert.equal(gate.ready, false);
  assert.deepEqual(outsideFiles(gate), ['allowed/file.txt', 'trailing']);
  assert.deepEqual([...gate.observations.changedFiles].sort(), [' ', ' allowed/file.txt', 'allowed/file.txt', 'trailing', 'trailing ']);
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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { sampleTowerState } from './projection.test.js';
import { towerProjectionDefinition, TOWER_RECORD_TYPE, deriveMissionGateBlocks } from '../lib/projection.js';

// Mission-card gate summary: the merge-commit short SHA and the gate block
// codes a controller needs to judge "can this merge?" without running
// `tower gate`. Covers the projection's read-only derivation (no git) and
// the client rendering fed by it.

function element(type, props = {}, key) { return { type, key, props }; }
function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node !== 'object') return String(node);
  return textOf(node.props?.children);
}
function findAll(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate));
  return [...(predicate(node) ? [node] : []), ...findAll(node.props?.children, predicate)];
}
const has = (name, value) => (node) => node.props?.[name] === value;
const withProp = (name) => (node) => node.props != null && name in node.props;
const missionCards = (tree) => findAll(tree, (node) => node.props?.['data-mission-id']);
const cardOf = (tree, id) => missionCards(tree).find((node) => node.props['data-mission-id'] === id);

// Same vm-based technique as test/client.test.js: load the browser module
// with stubbed React/primitives and expand function components by hand.
function harness(tower = sampleTowerState(), { language = 'zh', now } = {}) {
  let definition, hookIndex, activeHooks;
  const clock = { now };
  const hooks = new Map(), slots = new Map(), opened = [], catalog = new Map(), dictionaries = {};
  const rows = {
    root: { title: 'Controller A' },
    'worker-child': { parentId: 'root', projectionValues: { subagent: { label: 'tower:M1:worker' } } },
    'review-child': { parentId: 'root', projectionValues: { subagent: { label: 'tower:M1:reviewer' } } },
  };
  const projections = { root: { values: { tower } } };
  const react = {
    useState(initial) {
      const index = hookIndex++, values = activeHooks;
      if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
      return [values[index], (next) => { values[index] = typeof next === 'function' ? next(values[index]) : next; }];
    },
    useRef: () => ({ current: null }), useEffect() {}, useLayoutEffect() {},
  };
  const require = (id) => {
    if (id === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'Fragment' };
    if (id === 'react') return react;
    if (id === 'react-dom') return { createPortal: (node) => node };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {
      StateDot: 'StateDot', IconUsersOutlineRegular: 'Icon',
      useAnchoredPosition: () => ({ top: 0, left: 0 }), useDismissOnOutsidePointer() {},
    };
    throw new Error(`Unexpected module: ${id}`);
  };
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (value) => { definition = value; } } },
    document: { querySelector: () => ({}), body: {} }, URLSearchParams,
    Date: class extends Date { static now() { return clock.now ?? super.now(); } },
  });
  const exported = definition.factory(require);
  const services = {
    effect: (fn) => fn(),
    sessions: { subagentAddress: (id) => catalog.get(id), list: { getSnapshot: () => ({ byId: rows }) } },
    sidebarRight: { openResource: (address, options) => opened.push({ address, options }) },
    locale: {
      register: (ns, values) => { dictionaries[ns] = values; },
      bind: (ns) => (key, vars = {}) => ((dictionaries[ns][language] ?? dictionaries[ns].zh)[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => vars[name]),
    },
    sidebarRightTabs: { register: (value) => { services.tabDefinitions = value; } },
    slots: { inject: (_, fn) => fn(), register: (meta, component) => slots.set(meta.name, { meta, component }) },
  };
  exported.apply(new Proxy(services, {
    get(target, key) {
      if (key !== 'effect' && !exported.inject.includes(key)) throw new Error(`Missing inject: ${key}`);
      if (!(key in target)) throw new Error(`Missing service: ${key}`);
      return target[key];
    },
  }));
  function expand(node, path) {
    if (node == null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}/${child?.key ?? i}`));
    if (typeof node.type === 'function') {
      const id = `${path}:${node.type.name}`;
      if (!hooks.has(id)) hooks.set(id, []);
      activeHooks = hooks.get(id); hookIndex = 0;
      return expand(node.type(node.props), id);
    }
    return { ...node, props: { ...node.props, children: expand(node.props.children, path) } };
  }
  function render(sessionId = 'root', parentId, surface = 'sidebar.right.pane.tab') {
    const slot = slots.get(surface);
    const props = {
      sessionId,
      useSession: (selector) => selector({ subagent: parentId ? { address: { parentSessionId: parentId } } : undefined }),
      useSessions: (selector) => selector({ phase: 'ready', byId: rows, projectionsBySession: projections }),
      t: services.locale.bind('tower-enhanced'), ...slot.meta.inject(),
    };
    return expand(element(slot.component, props), `${surface}:${sessionId}`);
  }
  return { render, opened, rows, catalog, projections, slots, services, module: exported, clock };
}

function missionsView(harnessInstance) {
  let tree = harnessInstance.render();
  findAll(tree, has('data-tower-view-button', 'missions'))[0].props.onClick();
  return harnessInstance.render();
}

// A mission carrying only the fields the card and the derivation read.
// `gateBlocks` stands in for what the projection wire view attaches.
function gateMission(over = {}) {
  return {
    id: 'M1', title: 'Gate mission', description: '', dependsOn: [], scope: [],
    branch: 'tower/m1', worktree: '/tmp/tower-panel/.dsh-tower/worktrees/m1',
    baseCommit: 'base-sha', status: 'approved', revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z', worktreeRemoved: false,
    worker: undefined, review: { runId: 'review-run', verdict: 'clean', merge: true },
    merge: undefined, gateBlocks: [], ...over,
  };
}

function towerOf(missions) {
  const tower = sampleTowerState();
  tower.missions = missions;
  return tower;
}

test('deriveMissionGateBlocks mirrors the state-checkable gate codes of core, in order', () => {
  const mission = (over = {}) => ({ id: 'M2', status: 'pending', dependsOn: [], worktreeRemoved: false, ...over });
  const siblings = [
    mission({ id: 'M1', status: 'merged' }),
    mission({ id: 'M3', status: 'worker_running' }),
    mission({ id: 'M4', status: 'abandoned' }),
  ];
  const blocks = (over) => deriveMissionGateBlocks(mission(over), siblings);
  // terminal missions are past the gate: core reports empty blocks for a
  // mission it detects as already merged, and an abandoned one never merges
  assert.deepEqual(deriveMissionGateBlocks(mission({ id: 'M9', status: 'merged' }), siblings), []);
  assert.deepEqual(deriveMissionGateBlocks(mission({ id: 'M9', status: 'abandoned' }), siblings), []);
  // pending without any review: not approvable and nothing clean to merge
  assert.deepEqual(blocks(), ['NOT_APPROVED', 'NO_CLEAN_REVIEW']);
  // unmerged or missing dependencies block; merged/abandoned ones resolve
  assert.deepEqual(blocks({ dependsOn: ['M3'] }), ['NOT_APPROVED', 'DEPENDENCIES_NOT_MERGED', 'NO_CLEAN_REVIEW']);
  assert.deepEqual(blocks({ dependsOn: ['gone'] }), ['NOT_APPROVED', 'DEPENDENCIES_NOT_MERGED', 'NO_CLEAN_REVIEW']);
  assert.deepEqual(blocks({ dependsOn: ['M1', 'M4'] }), ['NOT_APPROVED', 'NO_CLEAN_REVIEW']);
  // a removed worktree contributes its own code
  assert.deepEqual(blocks({ worktreeRemoved: true }), ['NOT_APPROVED', 'WORKTREE_REMOVED', 'NO_CLEAN_REVIEW']);
  // all four state-checkable codes keep core's push order
  assert.deepEqual(
    blocks({ dependsOn: ['M3'], worktreeRemoved: true }),
    ['NOT_APPROVED', 'DEPENDENCIES_NOT_MERGED', 'WORKTREE_REMOVED', 'NO_CLEAN_REVIEW'],
  );
  // only a clean, merge-approved review satisfies the review check
  assert.deepEqual(blocks({ status: 'approved', review: { verdict: 'clean', merge: true } }), []);
  assert.deepEqual(blocks({ status: 'approved', review: { verdict: 'clean', merge: false } }), ['NO_CLEAN_REVIEW']);
  assert.deepEqual(blocks({ status: 'approved', review: { verdict: 'changes_requested', merge: false } }), ['NO_CLEAN_REVIEW']);
  assert.deepEqual(blocks({ status: 'approved', review: undefined }), ['NO_CLEAN_REVIEW']);
  // merge_blocked sits with the approvable statuses: only real blockers remain
  assert.deepEqual(blocks({ status: 'merge_blocked', review: { verdict: 'clean', merge: true } }), []);
  assert.deepEqual(blocks({ status: 'merge_blocked', dependsOn: ['M3'] }), ['DEPENDENCIES_NOT_MERGED', 'NO_CLEAN_REVIEW']);
  // a completed worker is not yet approved, so the status check still blocks
  assert.deepEqual(blocks({ status: 'worker_completed', review: { verdict: 'clean', merge: true } }), ['NOT_APPROVED']);
  // degenerate input stays safe and the derivation never writes into its input
  assert.deepEqual(deriveMissionGateBlocks(undefined, siblings), []);
  const pristine = mission({ dependsOn: ['M3'] });
  deriveMissionGateBlocks(pristine, siblings);
  assert.deepEqual(Object.keys(pristine).sort(), ['dependsOn', 'id', 'status', 'worktreeRemoved']);
});

test('wire view attaches gateBlocks per mission without touching the stored state', () => {
  // tower records never carry gateBlocks; only the wire view derives it
  const record = (over = {}) => ({
    id: 'A', title: 'Gate mission', description: '', dependsOn: [], scope: [],
    branch: 'tower/a', worktree: '/tmp/tower-panel/.dsh-tower/worktrees/a',
    baseCommit: 'base-sha', status: 'pending', revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z', worktreeRemoved: false,
    worker: undefined, review: undefined, merge: undefined, ...over,
  });
  const state = towerOf([
    record({}), // pending without review: derives NOT_APPROVED + NO_CLEAN_REVIEW
    record({ id: 'B', status: 'approved', review: { runId: 'rb', verdict: 'clean', merge: true }, dependsOn: ['A'] }),
    record({
      id: 'C', status: 'merged', review: { runId: 'rc', verdict: 'clean', merge: true },
      merge: { mergedAt: '2026-01-01T00:01:00.000Z', commit: 'merge-sha', reviewedCommit: 'reviewed-sha', baseCommit: 'base-sha' },
    }),
  ]);
  const applied = towerProjectionDefinition.apply(
    towerProjectionDefinition.init(),
    { type: TOWER_RECORD_TYPE, ignorable: true, data: { version: 1, state } },
  );
  assert.equal(applied.failure, null);
  const view = towerProjectionDefinition.wire.view(applied);
  const codesOf = (id) => view.missions.find((mission) => mission.id === id).gateBlocks;
  assert.deepEqual(codesOf('A'), ['NOT_APPROVED', 'NO_CLEAN_REVIEW']);
  assert.deepEqual(codesOf('B'), ['DEPENDENCIES_NOT_MERGED']);
  assert.deepEqual(codesOf('C'), []); // merged is past the gate
  // the derivation is view-only: the stored record keeps its verbatim shape
  for (const mission of applied.value.missions) assert.equal('gateBlocks' in mission, false);
  // without a record the view stays null, never a fabricated tower
  assert.equal(towerProjectionDefinition.wire.view(towerProjectionDefinition.init()), null);
});

test('merged mission cards show a 7-char short merge commit with the full SHA as title', () => {
  const sha = '1234567890abcdef1234567890abcdef12345678';
  const record = { mergedAt: '2026-01-01T00:01:00.000Z', commit: sha, reviewedCommit: 'reviewed-sha', baseCommit: 'base-sha' };
  const tree = missionsView(harness(towerOf([
    gateMission({ status: 'merged', merge: record }),
    gateMission({ id: 'M2', status: 'worker_completed', merge: record }),
  ])));
  const card = cardOf(tree, 'M1');
  const row = findAll(card, withProp('data-merge-commit'))[0];
  assert.equal(row.props['data-merge-commit'], sha);
  assert.equal(row.props.title, sha);
  // the visible chip is exactly the 7-char short form
  const short = findAll(card, has('data-merge-short', sha.slice(0, 7)))[0];
  assert.equal(textOf(short), '1234567');
  assert.equal(findAll(card, has('data-merge-short', sha)).length, 0);
  // the full SHA stays reachable for assistive tech through a hidden span
  assert.match(textOf(card), new RegExp(sha));
  // a not-yet-merged mission never shows the row, even with a lingering record
  assert.equal(findAll(cardOf(tree, 'M2'), withProp('data-merge-commit')).length, 0);
  // the 9-char sample fixture truncates the same way: short chip, hidden full text
  const sampleCard = cardOf(missionsView(harness()), 'M1');
  assert.equal(textOf(findAll(sampleCard, has('data-merge-short', 'merge-s'))[0]), 'merge-s');
  assert.match(textOf(sampleCard), /merge-sha/);
});

test('gate summary renders 0/1/3/5 blocks with +N overflow and stays absent when uninformative', () => {
  // five codes as a git-informed projection could report them; the last two
  // are beyond what the state-only derivation can see
  const CODES = ['NOT_APPROVED', 'DEPENDENCIES_NOT_MERGED', 'WORKTREE_REMOVED', 'NO_CLEAN_REVIEW', 'BASE_DIRTY'];
  const gate = (tree, id) => findAll(cardOf(tree, id), withProp('data-gate-blocks'))[0];
  const chips = (node) => findAll(node, withProp('data-block-code'));
  const overflow = (node) => findAll(node, withProp('data-block-overflow'))[0];
  const render = (missions) => missionsView(harness(towerOf(missions)));

  // 0 blocks + approved → the ready state, no code chips
  const ready = gate(render([gateMission({ gateBlocks: [] })]), 'M1');
  assert.equal(ready.props['data-gate-blocks'], 0);
  assert.equal(ready.props['data-ready'], true);
  assert.match(textOf(ready), /合并门禁/);
  assert.match(textOf(ready), /就绪/);
  assert.equal(chips(ready).length, 0);
  assert.equal(overflow(ready), undefined);

  // 1 block: a single chip, no overflow
  const one = gate(render([gateMission({ gateBlocks: ['DEPENDENCIES_NOT_MERGED'] })]), 'M1');
  assert.equal(one.props['data-gate-blocks'], 1);
  assert.equal(one.props['data-ready'], false);
  assert.deepEqual(chips(one).map((chip) => chip.props['data-block-code']), ['DEPENDENCIES_NOT_MERGED']);
  assert.equal(overflow(one), undefined);

  // 3 blocks: all spelled out, still no overflow
  const three = gate(render([gateMission({ gateBlocks: CODES.slice(0, 3) })]), 'M1');
  assert.equal(three.props['data-gate-blocks'], 3);
  assert.deepEqual(chips(three).map((chip) => chip.props['data-block-code']), CODES.slice(0, 3));
  assert.equal(overflow(three), undefined);

  // 5 blocks: first three chips plus a "+2" overflow
  const five = gate(render([gateMission({ gateBlocks: CODES })]), 'M1');
  assert.equal(five.props['data-gate-blocks'], 5);
  assert.equal(five.props['data-ready'], false);
  assert.deepEqual(chips(five).map((chip) => chip.props['data-block-code']), CODES.slice(0, 3));
  assert.equal(overflow(five).props['data-block-overflow'], 2);
  assert.match(textOf(five), /\+2/);
  assert.doesNotMatch(textOf(five), /NO_CLEAN_REVIEW|BASE_DIRTY/);

  // 0 blocks but not approved → nothing to say, so no summary row
  assert.equal(gate(render([gateMission({ status: 'worker_running', gateBlocks: [] })]), 'M1'), undefined);
  // an older projection without gateBlocks degrades to no summary instead of guessing
  assert.equal(gate(render([gateMission({ gateBlocks: undefined })]), 'M1'), undefined);
});

test('gate summary copy is localized in zh and en', () => {
  for (const [language, label, ready] of [
    ['zh', /合并门禁/, /就绪/],
    ['en', /Merge gate/, /Ready/],
  ]) {
    const tree = missionsView(harness(towerOf([gateMission({ gateBlocks: [] })]), { language }));
    const gate = findAll(cardOf(tree, 'M1'), withProp('data-gate-blocks'))[0];
    assert.match(textOf(gate), label, language);
    assert.match(textOf(gate), ready, language);
  }
});

test('mission cards consume the projection wire view end to end', () => {
  const sha = '1234567890abcdef1234567890abcdef12345678';
  const state = towerOf([
    gateMission({ id: 'READY', status: 'approved' }), // derives []
    gateMission({ id: 'WAIT', status: 'pending', review: undefined }), // derives two blocks
    gateMission({
      id: 'DONE', status: 'merged',
      merge: { mergedAt: '2026-01-01T00:01:00.000Z', commit: sha, reviewedCommit: 'reviewed-sha', baseCommit: 'base-sha' },
    }),
  ]);
  const applied = towerProjectionDefinition.apply(
    towerProjectionDefinition.init(),
    { type: TOWER_RECORD_TYPE, ignorable: true, data: { version: 1, state } },
  );
  const tree = missionsView(harness(towerProjectionDefinition.wire.view(applied)));
  const gate = (id) => findAll(cardOf(tree, id), withProp('data-gate-blocks'))[0];
  const codes = (id) => findAll(gate(id), withProp('data-block-code')).map((node) => node.props['data-block-code']);
  assert.deepEqual(codes('READY'), []);
  assert.equal(gate('READY').props['data-ready'], true);
  assert.deepEqual(codes('WAIT'), ['NOT_APPROVED', 'NO_CLEAN_REVIEW']);
  assert.equal(gate('WAIT').props['data-ready'], false);
  // merged: no gate row at all — the short merge commit is the confirmation
  assert.equal(gate('DONE'), undefined);
  assert.equal(textOf(findAll(cardOf(tree, 'DONE'), has('data-merge-short', sha.slice(0, 7)))[0]), '1234567');
});

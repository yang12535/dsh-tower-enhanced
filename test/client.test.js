import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { sampleTowerState } from './projection.test.js';

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
const agents = (tree) => findAll(tree, (node) => node.props?.['data-tower-agent']).map((node) => node.props['data-tower-agent']);
const missionCards = (tree) => findAll(tree, (node) => node.props?.['data-mission-id']);
const cardOf = (tree, id) => missionCards(tree).find((node) => node.props['data-mission-id'] === id);
const nextOf = (card) => card && findAll(card, (node) => 'data-mission-next' in (node.props ?? {}))[0];

// Preserve hook state across renders to exercise real scope/filter/click transitions.
function harness(tower = sampleTowerState(), { language = 'zh' } = {}) {
  let definition, hookIndex, activeHooks;
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
    sidebarRightTabs: { register: (value) => { services.tabDefinition = value; } },
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
  return { render, opened, rows, catalog, projections, slots, services, module: exported };
}

test('only review belonging to this controller is shown, workspace retains both real sessions', () => {
  const h = harness();
  h.rows['worker-child'].parentId = 'older-controller';
  let tree = h.render();
  assert.deepEqual(agents(tree), ['M1:reviewer']);
  assert.equal(findAll(tree, has('data-tower-group', 'worker')).length, 0);
  assert.match(textOf(tree), /1 个子代理/);
  assert.match(textOf(tree), /deepseek-reasoner/);
  assert.doesNotMatch(textOf(tree), /deepseek-flash/);
  findAll(tree, has('data-tower-scope-button', 'workspace'))[0].props.onClick();
  tree = h.render();
  assert.deepEqual(agents(tree), ['M1:worker', 'M1:reviewer']);
  assert.match(textOf(tree), /older-controller/);
  findAll(tree, has('data-tower-scope-button', 'session'))[0].props.onClick();
  assert.deepEqual(agents(h.render()), ['M1:reviewer']);
});

test('reviewer chat inherits task context without sibling worker in either surface', () => {
  const h = harness();
  let tree = h.render('review-child', 'root');
  assert.deepEqual(agents(tree), ['M1:reviewer']);
  assert.match(textOf(tree), /当前子代理的记录/);
  assert.doesNotMatch(textOf(tree), /deepseek-flash/);
  tree = h.render('review-child', 'root', 'conversation.session.header.actions');
  findAll(tree, has('className', 'Tw_trigger'))[0].props.onClick();
  tree = h.render('review-child', 'root', 'conversation.session.header.actions');
  assert.deepEqual(agents(tree), ['M1:reviewer']);
  assert.doesNotMatch(textOf(tree), /尚未派生|deepseek-flash/);
});

test('only real child ids produce agents, one session is not duplicated across records', () => {
  const tower = sampleTowerState();
  tower.missions[0].worker = { runId: 'launching', model: 'not-a-session' };
  tower.missions.push({ ...tower.missions[0], id: 'duplicate' });
  const h = harness(tower);
  const tree = h.render();
  assert.deepEqual(agents(tree), ['M1:reviewer']);
  assert.match(textOf(tree), /1 个子代理/);
  assert.doesNotMatch(textOf(tree), /not-a-session/);
});

test('agent routes remain distinct and clicks use authoritative lineage', () => {
  const tower = sampleTowerState();
  tower.missions[0].worker.controllerSessionId = 'old-record';
  const h = harness(tower);
  h.catalog.set('worker-child', { parentSessionId: 'catalog-parent', childSessionId: 'worker-child', mode: 'continuable' });
  let tree = h.render();
  findAll(tree, has('data-tower-scope-button', 'workspace'))[0].props.onClick();
  tree = h.render();
  const worker = findAll(tree, has('data-tower-agent', 'M1:worker'))[0];
  assert.match(worker.props.title, /deepseek-official \/ deepseek-flash · max/);
  worker.props.onClick();
  assert.match(h.opened[0].address, /worker-child\?parent=catalog-parent&mode=continuable/);
  tree = h.render();
  assert.equal(findAll(tree, has('data-tower-agent', 'M1:worker'))[0].props['aria-pressed'], true);
  const reviewer = findAll(tree, has('data-tower-agent', 'M1:reviewer'))[0];
  assert.match(reviewer.props.title, /deepseek-reasoner · high/);
  reviewer.props.onClick();
  assert.match(h.opened[1].address, /review-child\?parent=root&mode=continuable/);
  h.catalog.clear(); delete h.rows['worker-child'];
  findAll(h.render(), has('data-tower-agent', 'M1:worker'))[0].props.onClick();
  assert.match(h.opened[2].address, /parent=old-record/);
});

test('unresolved ownership is not attributed to current session and cannot open a broken chat', () => {
  const h = harness();
  delete h.rows['worker-child']; delete h.rows['review-child'];
  h.catalog.set('worker-child', null);
  h.catalog.set('review-child', { childSessionId: 'different-child', parentSessionId: 'root', mode: 'continuable' });
  let tree = h.render();
  assert.deepEqual(agents(tree), []);
  assert.match(textOf(tree), /本会话没有派生/);
  findAll(tree, has('data-tower-scope-button', 'workspace'))[0].props.onClick();
  tree = h.render();
  findAll(tree, has('data-tower-agent', 'M1:reviewer'))[0].props.onClick();
  assert.equal(h.opened.length, 0);
  assert.match(textOf(h.render()), /无法确认这个子代理的归属/);
});

test('failed or interrupted reviews never show as approved and filters agree', () => {
  for (const [record, label] of [
    [{ completedAt: '2026-01-01T00:01:00Z', error: 'missing verdict' }, '失败'],
    [{ stopReason: 'aborted' }, '已中断'],
    [{ stale: true }, '结果已过期'],
    [{ verdict: 'changes_requested', merge: false }, '需要修改'],
  ]) {
    const tower = sampleTowerState();
    tower.missions[0].review = { ...tower.missions[0].review, ...record };
    const h = harness(tower);
    const tree = h.render();
    const review = findAll(tree, has('data-tower-agent', 'M1:reviewer'))[0];
    assert.match(textOf(review), new RegExp(label));
    assert.doesNotMatch(textOf(review), /审查通过/);
    findAll(tree, has('data-tower-filter', 'attention'))[0].props.onClick();
    assert.ok(agents(h.render()).includes('M1:reviewer'));
    findAll(h.render(), has('data-tower-filter', 'running'))[0].props.onClick();
    assert.deepEqual(agents(h.render()), []);
    assert.match(textOf(h.render()), /没有符合条件/);
  }
});

test('worker-only running session does not invent a Review group', () => {
  const tower = sampleTowerState();
  delete tower.missions[0].review;
  tower.missions[0].status = 'worker_running';
  tower.missions[0].worker.startedAt = new Date().toISOString();
  const h = harness(tower);
  const tree = h.render();
  assert.deepEqual(agents(tree), ['M1:worker']);
  assert.equal(findAll(tree, has('data-tower-group', 'reviewer')).length, 0);
  assert.match(textOf(tree), /1 运行中/);
  findAll(tree, has('data-tower-filter', 'running'))[0].props.onClick();
  assert.deepEqual(agents(h.render()), ['M1:worker']);
});

test('newest workspace snapshot wins; unrelated and null projections stay separate', () => {
  const h = harness();
  const newer = sampleTowerState();
  newer.updatedAt = '2026-01-02T00:00:00Z';
  newer.missions[0].review.model = 'newer-model';
  h.projections.other = { values: { tower: newer } };
  h.projections.unrelated = { values: { tower: { ...newer, repoRoot: '/another/repo', updatedAt: '2026-01-03T00:00:00Z', baseBranch: 'unrelated' } } };
  assert.match(textOf(h.render()), /newer-model/);
  assert.doesNotMatch(textOf(h.render()), /unrelated/);
  h.projections.empty = { values: { tower: null } };
  assert.match(textOf(h.render('empty')), /还没有 Tower 状态/);
});

test('missionNextStep derives the next step from status, dependencies, and review verdict', () => {
  const { missionNextStep, missionDependencyState } = harness().module;
  // Results come from the vm realm, so compare field-wise (prototypes differ).
  const sameNext = (actual, key, ids = [], blocked = false) => {
    assert.equal(actual?.key, key);
    assert.deepEqual([...(actual?.ids ?? [])], ids);
    assert.equal(actual?.blocked, blocked);
  };
  const mission = (over = {}) => ({ id: 'M2', title: 'task', status: 'pending', dependsOn: [], ...over });
  const siblings = [
    mission({ id: 'M1', status: 'merged' }),
    mission({ id: 'M3', status: 'worker_running' }),
    mission({ id: 'M4', status: 'abandoned' }),
  ];
  // pending + unmet dependency points at the id that must merge first
  sameNext(missionNextStep(mission({ dependsOn: ['M3'] }), siblings), 'next.waitDeps', ['M3'], true);
  sameNext(missionNextStep(mission({ dependsOn: ['gone', 'M3'] }), siblings), 'next.waitDeps', ['gone', 'M3'], true);
  assert.deepEqual([...missionDependencyState(mission({ dependsOn: ['gone', 'M3', 'M1'] }), siblings).map((dep) => ({ ...dep }))], [
    { id: 'gone', status: 'missing', met: false },
    { id: 'M3', status: 'worker_running', met: false },
    { id: 'M1', status: 'merged', met: true },
  ]);
  // pending + merged or abandoned dependency → spawn the worker
  sameNext(missionNextStep(mission({ dependsOn: ['M1'] }), siblings), 'next.spawnWorker');
  assert.equal(missionNextStep(mission({ dependsOn: ['M4'] }), siblings).key, 'next.spawnWorker');
  sameNext(missionNextStep(mission(), siblings), 'next.spawnWorker');
  // active stages are in progress
  assert.equal(missionNextStep(mission({ status: 'worker_running' }), siblings).key, 'next.workerRunning');
  assert.equal(missionNextStep(mission({ status: 'review_running' }), siblings).key, 'next.reviewRunning');
  // completed worker without a clean review awaits review
  assert.equal(missionNextStep(mission({ status: 'worker_completed' }), siblings).key, 'next.awaitReview');
  assert.equal(missionNextStep(mission({ status: 'worker_completed', review: { verdict: 'clean' } }), siblings).key, 'next.awaitReview');
  // a rejected verdict demands rework even if the status label lags behind
  assert.equal(missionNextStep(mission({ status: 'worker_completed', review: { verdict: 'changes_requested', merge: false } }), siblings).key, 'next.rework');
  assert.equal(missionNextStep(mission({ status: 'changes_requested' }), siblings).key, 'next.rework');
  // only a clean merge-approved review unlocks merging
  assert.equal(missionNextStep(mission({ status: 'worker_completed', review: { verdict: 'clean', merge: true } }), siblings).key, 'next.canMerge');
  assert.equal(missionNextStep(mission({ status: 'approved' }), siblings).key, 'next.canMerge');
  // terminal and manual states
  assert.equal(missionNextStep(mission({ status: 'merged' }), siblings).key, 'next.merged');
  assert.equal(missionNextStep(mission({ status: 'abandoned' }), siblings).key, 'next.abandoned');
  assert.equal(missionNextStep(mission({ status: 'worker_failed' }), siblings).key, 'next.workerFailed');
  sameNext(missionNextStep(mission({ status: 'rebase_blocked' }), siblings), 'next.rebaseManual', [], true);
  sameNext(missionNextStep(mission({ status: 'merge_blocked' }), siblings), 'next.mergeManual', [], true);
  assert.equal(missionNextStep(mission({ status: 'surprise' }), siblings).key, 'next.unknown');
  assert.equal(missionNextStep(undefined, siblings).key, 'next.unknown');
});

// One repo-wide snapshot covering every interesting stage at once.
function multiMissionTower() {
  const tower = sampleTowerState();
  const done = (over = {}) => ({ startedAt: '2026-01-01T00:00:10.000Z', completedAt: '2026-01-01T00:00:40.000Z', stopReason: 'completed', ...over });
  const template = tower.missions[0];
  tower.missions[0] = {
    ...template,
    worker: { ...template.worker, ...done() },
    review: { ...template.review, ...done() },
  };
  const extra = (over) => ({
    ...template, branch: `tower/${over.id.toLowerCase()}`, worktree: `${template.worktree}-${over.id}`,
    revision: 1, dependsOn: [], worker: undefined, review: undefined, merge: undefined, ...over,
  });
  tower.missions.push(
    extra({ id: 'M2', title: 'Blocked by dependency', status: 'pending', dependsOn: ['M3'] }),
    extra({ id: 'M3', title: 'Under work', status: 'worker_running', worker: { runId: 'w3', provider: 'deepseek-official', model: 'deepseek-flash', childId: 'm3-worker', startedAt: new Date().toISOString() } }),
    extra({
      id: 'M4', title: 'Needs rework', status: 'changes_requested',
      worker: { runId: 'w4', provider: 'deepseek-official', model: 'deepseek-flash', childId: 'm4-worker', ...done() },
      review: { runId: 'r4', provider: 'deepseek-official', model: 'deepseek-reasoner', childId: 'm4-review', verdict: 'changes_requested', merge: false, ...done() },
    }),
    extra({
      id: 'M5', title: 'Ready to merge', status: 'approved', dependsOn: ['M1'],
      worker: { runId: 'w5', provider: 'deepseek-official', model: 'deepseek-flash', childId: 'm5-worker', ...done() },
      review: { runId: 'r5', provider: 'deepseek-official', model: 'deepseek-reasoner', childId: 'm5-review', verdict: 'clean', merge: true, ...done() },
    }),
    extra({ id: 'M6', title: 'Conflicted', status: 'rebase_blocked' }),
  );
  return tower;
}

test('mission view shows stage, dependencies, roles, and merge commit per mission', () => {
  const h = harness(multiMissionTower());
  let tree = h.render();
  // agents view stays the default; the mission list is one toggle away
  assert.equal(missionCards(tree).length, 0);
  assert.ok(agents(tree).length > 0);
  findAll(tree, has('data-tower-view-button', 'missions'))[0].props.onClick();
  tree = h.render();
  assert.ok(findAll(tree, has('data-tower-mission-view', true)).length > 0);
  assert.deepEqual(missionCards(tree).map((node) => node.props['data-mission-id']), ['M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
  assert.match(textOf(tree), /6 个任务/);
  // merged mission exposes its merge commit and both spawned roles
  const m1 = cardOf(tree, 'M1');
  assert.equal(m1.props['data-mission-status'], 'merged');
  assert.equal(nextOf(m1).props['data-mission-next'], 'next.merged');
  assert.match(textOf(m1), /已合并/);
  assert.match(textOf(m1), /merge-sha/);
  assert.match(textOf(findAll(m1, has('data-mission-role', 'worker'))[0]), /deepseek-official \/ deepseek-flash/);
  assert.match(textOf(findAll(m1, has('data-mission-role', 'reviewer'))[0]), /审查通过/);
  // pending mission blocked by an unmerged dependency
  const m2 = cardOf(tree, 'M2');
  const m2next = nextOf(m2);
  assert.equal(m2next.props['data-mission-next'], 'next.waitDeps');
  assert.equal(m2next.props['data-blocked'], true);
  assert.match(textOf(m2next), /等待依赖 M3 合并/);
  const chip = findAll(m2, has('data-dep-id', 'M3'))[0];
  assert.equal(chip.props['data-dep-met'], false);
  assert.match(textOf(chip), /Worker 运行中/);
  assert.equal(findAll(m2, has('data-mission-role', 'worker'))[0].props['data-spawned'], false);
  assert.match(textOf(findAll(m2, has('data-mission-role', 'worker'))[0]), /尚未派生/);
  // running, rework, mergeable, and manual stages each get their own hint
  assert.equal(nextOf(cardOf(tree, 'M3')).props['data-mission-next'], 'next.workerRunning');
  assert.match(textOf(cardOf(tree, 'M3')), /进行中/);
  assert.match(textOf(findAll(cardOf(tree, 'M3'), has('data-mission-role', 'worker'))[0]), /运行中/);
  const m4 = cardOf(tree, 'M4');
  assert.equal(nextOf(m4).props['data-mission-next'], 'next.rework');
  assert.match(textOf(m4), /需返工并重新审查/);
  assert.match(textOf(findAll(m4, has('data-mission-role', 'reviewer'))[0]), /需要修改/);
  const m5 = cardOf(tree, 'M5');
  assert.equal(nextOf(m5).props['data-mission-next'], 'next.canMerge');
  assert.match(textOf(m5), /可合并/);
  assert.equal(findAll(m5, has('data-dep-id', 'M1'))[0].props['data-dep-met'], true);
  const m6 = cardOf(tree, 'M6');
  assert.equal(nextOf(m6).props['data-mission-next'], 'next.rebaseManual');
  assert.equal(nextOf(m6).props['data-blocked'], true);
  assert.match(textOf(m6), /需人工处理/);
  // toggling back restores the agents view untouched
  findAll(tree, has('data-tower-view-button', 'agents'))[0].props.onClick();
  tree = h.render();
  assert.equal(missionCards(tree).length, 0);
  assert.ok(agents(tree).length > 0);
  assert.match(textOf(tree), /个子代理/);
});

test('mission view unblocks when the dependency merges and stays empty without missions', () => {
  const tower = multiMissionTower();
  const h = harness(tower);
  let tree = h.render();
  findAll(tree, has('data-tower-view-button', 'missions'))[0].props.onClick();
  tree = h.render();
  assert.match(textOf(nextOf(cardOf(tree, 'M2'))), /等待依赖 M3 合并/);
  tower.missions.find((mission) => mission.id === 'M3').status = 'merged';
  tree = h.render();
  assert.equal(nextOf(cardOf(tree, 'M2')).props['data-mission-next'], 'next.spawnWorker');
  assert.match(textOf(nextOf(cardOf(tree, 'M2'))), /待派生 worker/);
  assert.equal(findAll(cardOf(tree, 'M2'), has('data-dep-id', 'M3'))[0].props['data-dep-met'], true);
  // a tower state without missions explains itself instead of rendering nothing
  const empty = sampleTowerState();
  empty.missions = [];
  const bare = harness(empty);
  tree = bare.render();
  findAll(tree, has('data-tower-view-button', 'missions'))[0].props.onClick();
  tree = bare.render();
  assert.equal(missionCards(tree).length, 0);
  assert.match(textOf(tree), /还没有任务/);
});

test('missionDependencyDepths walks unfinished chains, ignores resolved links, and never loops', () => {
  const { missionDependencyDepths } = harness().module;
  // Results come from the vm realm, so collect entries into host structures.
  const depthsOf = (missions) => Object.fromEntries(Object.entries(missionDependencyDepths(missions)));
  const mission = (over = {}) => ({ id: 'X', title: 'task', status: 'pending', dependsOn: [], ...over });
  // each unfinished link deepens by one; merged/abandoned and absent deps do not
  assert.deepEqual(depthsOf([
    mission({ id: 'A', status: 'worker_running' }),
    mission({ id: 'B', dependsOn: ['A'] }),
    mission({ id: 'C', dependsOn: ['B'] }),
    mission({ id: 'R', status: 'merged' }),
    mission({ id: 'K', status: 'abandoned' }),
    mission({ id: 'Q', dependsOn: ['R', 'K'] }),
    mission({ id: 'Z', dependsOn: ['gone'] }),
    mission({ id: 'N', dependsOn: undefined }),
  ]), { A: 0, B: 1, C: 2, R: 0, K: 0, Q: 0, Z: 1, N: 0 });
  // a mission keeps the deepest of several unfinished branches
  const diamond = depthsOf([
    mission({ id: 'A', status: 'worker_running' }),
    mission({ id: 'LEFT', dependsOn: ['A'] }),
    mission({ id: 'MID', dependsOn: ['LEFT'] }),
    mission({ id: 'TOP', dependsOn: ['MID', 'A'] }),
  ]);
  assert.deepEqual([diamond.LEFT, diamond.MID, diamond.TOP], [1, 2, 3]);
  // cycles and self-references terminate deterministically with bounded values
  const cyclic = [
    mission({ id: 'P', dependsOn: ['Q'] }),
    mission({ id: 'Q', dependsOn: ['P'] }),
    mission({ id: 'S', dependsOn: ['S', 'P'] }),
  ];
  const first = depthsOf(cyclic);
  assert.deepEqual(depthsOf(cyclic), first);
  for (const value of Object.values(first)) assert.ok(Number.isInteger(value) && value >= 0 && value <= 8);
  // depth stops growing at 8 even along a long fresh chain
  const chain = [];
  for (let i = 0; i <= 10; i += 1) {
    chain.push(mission({ id: `D${i}`, dependsOn: i ? [`D${i - 1}`] : [], status: i ? 'pending' : 'worker_running' }));
  }
  const capped = depthsOf(chain);
  assert.deepEqual([capped.D6, capped.D7, capped.D8, capped.D9, capped.D10], [6, 7, 8, 8, 8]);
  // degenerate inputs stay safe
  assert.deepEqual(depthsOf([]), {});
  assert.deepEqual(Object.entries(missionDependencyDepths(undefined)), []);
});

// A tower whose missions form known dependency shapes for depth assertions.
function chainTower() {
  const tower = sampleTowerState();
  const template = tower.missions[0];
  const node = (id, dependsOn, over = {}) => ({
    ...template, id, title: `Mission ${id}`, branch: `tower/${id.toLowerCase()}`, dependsOn,
    status: 'pending', worker: undefined, review: undefined, merge: undefined, ...over,
  });
  tower.missions = [
    node('M1', [], { status: 'merged' }), // merged template mission, no deps
    node('ROOT', [], { status: 'worker_running' }),
    node('L1', ['ROOT']),
    node('L2', ['L1']),
    node('DONE', [], { status: 'merged' }),
    node('AFTERDONE', ['DONE']), // resolved dependency does not indent
    node('MISSING', ['gone']), // missing dependency still blocks one level
  ];
  return tower;
}

function missionsView(harnessInstance) {
  let tree = harnessInstance.render();
  findAll(tree, has('data-tower-view-button', 'missions'))[0].props.onClick();
  return harnessInstance.render();
}

test('mission view indents cards by unfinished dependency depth with guide rails', () => {
  const tree = missionsView(harness(chainTower()));
  const depth = (id) => cardOf(tree, id).props['data-mission-depth'];
  assert.deepEqual(
    ['M1', 'ROOT', 'L1', 'L2', 'AFTERDONE', 'MISSING'].map(depth),
    [0, 0, 1, 2, 0, 1],
  );
  // depth 0 cards render no rail at all
  assert.equal(findAll(cardOf(tree, 'ROOT'), (node) => node.props != null && 'data-mission-indent' in node.props).length, 0);
  // each level contributes exactly one guide segment
  const rail1 = findAll(cardOf(tree, 'L1'), has('data-mission-indent', 1))[0];
  assert.equal(rail1.props.children.length, 1);
  const rail2 = findAll(cardOf(tree, 'L2'), has('data-mission-indent', 2))[0];
  assert.deepEqual([...rail2.props.children].map((guide) => guide.props['data-guide-level']), [1, 2]);
});

test('mission view caps indentation at eight levels however deep the chain', () => {
  const tower = sampleTowerState();
  const template = tower.missions[0];
  tower.missions = [];
  for (let i = 0; i <= 9; i += 1) {
    tower.missions.push({
      ...template, id: `D${i}`, title: `Mission D${i}`, branch: `tower/d${i}`,
      dependsOn: i ? [`D${i - 1}`] : [], status: i ? 'pending' : 'worker_running',
      worker: undefined, review: undefined, merge: undefined,
    });
  }
  const tree = missionsView(harness(tower));
  const depth = (id) => cardOf(tree, id).props['data-mission-depth'];
  assert.deepEqual([depth('D7'), depth('D8'), depth('D9')], [7, 8, 8]);
  const rail = findAll(cardOf(tree, 'D9'), has('data-mission-indent', 8))[0];
  assert.equal(rail.props.children.length, 8);
  assert.equal(rail.props.children[7].props['data-guide-level'], 8);
});

test('mission view survives dependency cycles and self-references without hanging', () => {
  const tower = sampleTowerState();
  const template = tower.missions[0];
  tower.missions = [
    { ...template, id: 'X', dependsOn: ['Y'], status: 'pending' },
    { ...template, id: 'Y', dependsOn: ['X', 'SELF'], status: 'pending' },
    { ...template, id: 'SELF', dependsOn: ['SELF'], status: 'pending' },
  ];
  const tree = missionsView(harness(tower));
  for (const id of ['X', 'Y', 'SELF']) {
    const card = cardOf(tree, id);
    const depth = card.props['data-mission-depth'];
    assert.ok(Number.isInteger(depth) && depth >= 0 && depth <= 8, `${id} depth ${depth}`);
    assert.equal(findAll(card, (node) => node.props != null && 'data-mission-indent' in node.props).length, depth > 0 ? 1 : 0);
  }
});

test('mission cards offer per-role session links only with a recorded controller session', () => {
  const openButtons = (node) => findAll(node, (candidate) => candidate.props != null && 'data-open-agent' in candidate.props);
  // childIds alone are not enough: the default tower records no controller session
  const plain = missionsView(harness(sampleTowerState()));
  assert.equal(findAll(plain, (candidate) => candidate.props != null && 'data-open-agent' in candidate.props).length, 0);
  assert.equal(findAll(cardOf(plain, 'M1'), has('data-mission-role', 'worker'))[0].props['data-spawned'], true);

  const tower = multiMissionTower();
  const merged = tower.missions.find((mission) => mission.id === 'M1');
  merged.worker.controllerSessionId = 'tower-controller';
  merged.review.controllerSessionId = 'tower-controller';
  const h = harness(tower);
  // without listed rows the recorded controller is the only lineage source
  delete h.rows['worker-child'];
  delete h.rows['review-child'];
  const tree = missionsView(h);
  const card = cardOf(tree, 'M1');
  assert.deepEqual(openButtons(card).map((button) => button.props['data-open-agent']), ['worker', 'reviewer']);
  assert.match(textOf(openButtons(card)[0]), /打开会话/);
  // other missions hold real child sessions but no recorded controller
  for (const id of ['M2', 'M3', 'M4', 'M5', 'M6']) assert.equal(openButtons(cardOf(tree, id)).length, 0);
  assert.equal(findAll(cardOf(tree, 'M3'), has('data-mission-role', 'worker'))[0].props['data-spawned'], true);

  // clicking opens that role's subagent chat under the recorded controller
  openButtons(card)[0].props.onClick();
  assert.equal(h.opened.length, 1);
  assert.match(h.opened[0].address, /subagentchat\/session\/worker-child\?parent=tower-controller&mode=continuable/);
  // an unresolvable lineage fails loudly through the shared hint, per role
  h.rows['review-child'] = { parentId: '' };
  findAll(card, has('data-open-agent', 'reviewer'))[0].props.onClick();
  assert.equal(h.opened.length, 1);
  const after = missionsView(h);
  const failure = findAll(cardOf(after, 'M1'), has('data-open-error', 'reviewer'))[0];
  assert.equal(failure.props.role, 'alert');
  assert.match(textOf(failure), /无法确认这个子代理的归属/);
  assert.equal(findAll(cardOf(after, 'M1'), has('data-open-error', 'worker')).length, 0);
});

const roleRowOf = (card, role) => findAll(card, has('data-mission-role', role))[0];
const errorNodes = (tree) => findAll(tree, (node) => node.props != null && 'data-agent-error' in node.props);

test('review_failed is a localized error mission with a respawn next step', () => {
  for (const [language, statusLabel, hint] of [
    ['zh', '审查失败', /重新派 reviewer 或 worker/],
    ['en', 'Review failed', /respawn a reviewer or worker/],
  ]) {
    const tower = sampleTowerState();
    tower.missions[0].status = 'review_failed';
    tower.missions[0].review = {
      ...tower.missions[0].review, completedAt: '2026-01-01T00:00:30.000Z', error: 'review transport failed',
    };
    const tree = missionsView(harness(tower, { language }));
    const card = cardOf(tree, 'M1');
    assert.ok(card, language);
    assert.match(textOf(card), new RegExp(statusLabel));
    const status = findAll(card, has('data-state', 'review_failed'))[0];
    assert.equal(findAll(status, (node) => node.type === 'StateDot')[0].props.state, 'error');
    assert.equal(nextOf(card).props['data-mission-next'], 'next.reviewFailed');
    assert.match(textOf(nextOf(card)), hint);
  }
});

test('stale or failed review hints outrank old verdicts but never override active stages', () => {
  const { missionNextStep } = harness().module;
  const mission = (over = {}) => ({ id: 'M9', title: 'task', status: 'pending', dependsOn: [], ...over });
  const nextKey = (over) => missionNextStep(mission(over), []).key;
  assert.equal(nextKey({ status: 'worker_completed', review: { stale: true, error: 'binding stale', verdict: 'clean', merge: true } }), 'next.reviewStale');
  assert.equal(nextKey({ status: 'worker_completed', review: { stale: true, verdict: 'changes_requested', merge: false } }), 'next.reviewStale');
  assert.equal(nextKey({ status: 'worker_completed', review: { error: 'no structured verdict' } }), 'next.retryReview');
  assert.equal(nextKey({ status: 'review_failed', review: { error: 'review transport failed' } }), 'next.reviewFailed');
  assert.equal(nextKey({ status: 'worker_completed', review: { verdict: 'clean', merge: true } }), 'next.canMerge');
  assert.equal(nextKey({ status: 'worker_completed', review: { verdict: 'changes_requested', merge: false } }), 'next.rework');
  const history = { stale: true, error: 'old', verdict: 'clean', merge: true };
  for (const [status, key] of [
    ['merged', 'next.merged'], ['abandoned', 'next.abandoned'],
    ['worker_running', 'next.workerRunning'], ['review_running', 'next.reviewRunning'],
  ]) {
    assert.equal(nextKey({ status, review: history }), key);
  }
});

test('mission failure states mark the matching role failed without failing the healthy worker', () => {
  const tower = sampleTowerState();
  const mission = tower.missions[0];
  mission.status = 'review_failed';
  mission.worker = { ...mission.worker, completedAt: '2026-01-01T00:00:20.000Z', stopReason: 'completed' };
  mission.review = { ...mission.review, verdict: 'clean', merge: true, completedAt: '2026-01-01T00:00:30.000Z' };
  const h = harness(tower);
  const tree = h.render();
  const review = findAll(tree, has('data-tower-agent', 'M1:reviewer'))[0];
  assert.equal(findAll(review, has('data-state', 'failed')).length, 1);
  assert.match(textOf(review), /失败/);
  assert.doesNotMatch(textOf(review), /审查通过/);
  const worker = findAll(tree, has('data-tower-agent', 'M1:worker'))[0];
  assert.equal(findAll(worker, has('data-state', 'done')).length, 1);
  assert.doesNotMatch(textOf(worker), /失败|状态未知/);
  assert.equal(errorNodes(tree).length, 0);
  findAll(tree, has('data-tower-filter', 'attention'))[0].props.onClick();
  assert.deepEqual(agents(h.render()), ['M1:reviewer']);
  findAll(h.render(), has('data-tower-filter', 'running'))[0].props.onClick();
  assert.deepEqual(agents(h.render()), []);
});

test('stale reviews keep priority over their old clean verdict and show the reason', () => {
  const tower = sampleTowerState();
  const mission = tower.missions[0];
  mission.status = 'worker_completed';
  mission.worker = { ...mission.worker, completedAt: '2026-01-01T00:00:20.000Z', stopReason: 'completed' };
  mission.review = {
    ...mission.review, completedAt: '2026-01-01T00:00:30.000Z', stale: true,
    error: 'review binding became stale; spawn a fresh reviewer', verdict: 'clean', merge: true,
  };
  const h = harness(tower);
  const tree = h.render();
  const review = findAll(tree, has('data-tower-agent', 'M1:reviewer'))[0];
  assert.equal(findAll(review, has('data-state', 'stale')).length, 1);
  assert.match(textOf(review), /结果已过期/);
  assert.doesNotMatch(textOf(review), /审查通过/);
  assert.match(textOf(findAll(tree, has('data-agent-error', 'reviewer'))[0]), /binding became stale/);
  findAll(tree, has('data-tower-filter', 'attention'))[0].props.onClick();
  assert.deepEqual(agents(h.render()), ['M1:reviewer']);
  findAll(h.render(), has('data-tower-filter', 'running'))[0].props.onClick();
  assert.deepEqual(agents(h.render()), []);
  const card = cardOf(missionsView(h), 'M1');
  assert.equal(nextOf(card).props['data-mission-next'], 'next.reviewStale');
  assert.match(textOf(findAll(roleRowOf(card, 'reviewer'), has('data-agent-error', 'reviewer'))[0]), /binding became stale/);
});

test('records without a child session are only starting during a real launch', () => {
  const tower = sampleTowerState();
  const template = tower.missions[0];
  tower.missions = [{
    ...template, status: 'worker_running', worker: { runId: 'launch', model: 'launch-model' },
    review: undefined, merge: undefined,
  }];
  const roles = () => {
    const tree = missionsView(harness(tower));
    const card = cardOf(tree, 'M1');
    return { tree, card, worker: roleRowOf(card, 'worker'), reviewer: roleRowOf(card, 'reviewer') };
  };
  let view = roles();
  assert.equal(view.worker.props['data-spawned'], false);
  assert.match(textOf(view.worker), /正在创建子代理会话/);
  assert.match(textOf(view.reviewer), /尚未派生/);
  assert.deepEqual(agents(view.tree), []);
  assert.equal(findAll(view.card, (node) => node.props != null && 'data-open-agent' in node.props).length, 0);

  tower.missions[0].status = 'review_failed';
  tower.missions[0].review = { runId: 'failed', model: 'review-model', error: 'spawn failed', completedAt: '2026-01-01T00:00:30.000Z' };
  view = roles();
  assert.doesNotMatch(textOf(view.reviewer), /正在创建子代理会话/);
  assert.match(textOf(view.reviewer), /失败/);
  assert.match(textOf(findAll(view.reviewer, has('data-agent-error', 'reviewer'))[0]), /spawn failed/);

  tower.missions[0].status = 'review_running';
  tower.missions[0].review = { runId: 'aborted', model: 'review-model', stopReason: 'aborted' };
  view = roles();
  assert.match(textOf(view.reviewer), /已中断/);
  assert.doesNotMatch(textOf(view.reviewer), /正在创建子代理会话/);

  tower.missions[0].status = 'worker_completed';
  tower.missions[0].worker = { runId: 'done', model: 'worker-model', completedAt: '2026-01-01T00:00:20.000Z', stopReason: 'completed' };
  tower.missions[0].review = undefined;
  view = roles();
  assert.match(textOf(view.worker), /执行完成/);
  assert.doesNotMatch(textOf(view.worker), /正在创建子代理会话/);

  tower.missions[0].status = 'review_failed';
  tower.missions[0].review = { runId: 'bare', model: 'review-model' };
  view = roles();
  assert.match(textOf(view.reviewer), /失败/);
  assert.doesNotMatch(textOf(view.reviewer), /正在创建子代理会话/);

  tower.missions[0].review = undefined;
  view = roles();
  assert.match(textOf(view.reviewer), /尚未派生/);
  assert.doesNotMatch(textOf(view.card), /正在创建子代理会话/);
});

test('agent failure reasons are bounded plain text in both views', () => {
  const cases = [
    { field: 'error', reason: 'a'.repeat(600), truncated: true, length: 500 },
    { field: 'error', reason: '😀'.repeat(500), truncated: false, length: 500 },
    { field: 'error', reason: '😀'.repeat(501), truncated: true, length: 500 },
    { field: 'error', reason: '<script>alert(1)</script>', truncated: false, length: 25 },
    { field: 'diagnostic', reason: 'diagnostic only', truncated: false, length: 15 },
  ];
  for (const { field, reason, truncated, length } of cases) {
    const tower = sampleTowerState();
    tower.missions[0].status = 'review_failed';
    tower.missions[0].review = {
      ...tower.missions[0].review, completedAt: '2026-01-01T00:00:30.000Z', [field]: reason,
    };
    const h = harness(tower);
    const agentsTree = h.render();
    const leafReason = findAll(agentsTree, has('data-agent-error', 'reviewer'))[0];
    assert.ok(leafReason);
    assert.equal(leafReason.props['data-error-truncated'], truncated);
    assert.equal(leafReason.props.title, undefined);
    assert.equal(leafReason.props['aria-label'], undefined);
    const leafText = textOf(leafReason);
    assert.equal(Array.from(leafText).length, length);
    assert.equal(leafText.isWellFormed(), true);
    if (truncated) assert.ok(leafText.endsWith('…'));
    else assert.equal(leafText, reason);
    assert.equal(findAll(agentsTree, (node) => node.type === 'script' || node.props?.dangerouslySetInnerHTML != null).length, 0);

    const missionsTree = missionsView(h);
    const row = roleRowOf(cardOf(missionsTree, 'M1'), 'reviewer');
    const rowReason = findAll(row, has('data-agent-error', 'reviewer'))[0];
    assert.ok(rowReason);
    assert.equal(textOf(rowReason), leafText);
    assert.equal(rowReason.props['data-error-truncated'], truncated);
    assert.equal(rowReason.props.title, undefined);
    assert.equal(rowReason.props['aria-label'], undefined);
    assert.equal(findAll(missionsTree, (node) => node.type === 'script' || node.props?.dangerouslySetInnerHTML != null).length, 0);
  }
});

test('successful agents show no error reason and stay out of attention and running', () => {
  const tower = sampleTowerState();
  tower.missions[0].status = 'merged';
  tower.missions[0].worker = {
    ...tower.missions[0].worker, completedAt: '2026-01-01T00:00:20.000Z', stopReason: 'completed',
    summary: 'worker summary is not an error',
  };
  tower.missions[0].review = { ...tower.missions[0].review, completedAt: '2026-01-01T00:00:30.000Z', stopReason: 'completed' };
  const h = harness(tower);
  const tree = h.render();
  assert.deepEqual(agents(tree), ['M1:worker', 'M1:reviewer']);
  assert.equal(errorNodes(tree).length, 0);
  findAll(tree, has('data-tower-filter', 'attention'))[0].props.onClick();
  assert.deepEqual(agents(h.render()), []);
  findAll(h.render(), has('data-tower-filter', 'running'))[0].props.onClick();
  assert.deepEqual(agents(h.render()), []);
});

test('stale and retry review hints are localized', () => {
  for (const [language, staleHint, retryHint] of [
    ['zh', /核对同步基线后重新审查/, /请重试审查/],
    ['en', /check the synced baseline/, /retry the review/],
  ]) {
    const tower = sampleTowerState();
    tower.missions[0].status = 'worker_completed';
    tower.missions[0].review = {
      ...tower.missions[0].review, stale: true, error: 'binding stale', verdict: 'clean', merge: true,
    };
    let card = cardOf(missionsView(harness(tower, { language })), 'M1');
    assert.equal(nextOf(card).props['data-mission-next'], 'next.reviewStale');
    assert.match(textOf(nextOf(card)), staleHint);
    tower.missions[0].review = {
      ...tower.missions[0].review, stale: false, error: 'no structured verdict', verdict: undefined, merge: undefined,
    };
    card = cardOf(missionsView(harness(tower, { language })), 'M1');
    assert.equal(nextOf(card).props['data-mission-next'], 'next.retryReview');
    assert.match(textOf(nextOf(card)), retryHint);
  }
});

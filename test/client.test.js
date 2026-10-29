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
  return { render, opened, rows, catalog, projections, slots, services, module: exported, clock };
}

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

const withProp = (name) => (node) => node.props != null && name in node.props;
const roleRowOf = (card, role) => findAll(card, has('data-mission-role', role))[0];
const errorNodes = (tree) => findAll(tree, withProp('data-agent-error'));
const openButtons = (node) => findAll(node, withProp('data-open-agent'));
const toggleOf = (tree, id) => findAll(tree, has('data-mission-toggle', id))[0];
const filterOf = (tree, value) => findAll(tree, has('data-tower-filter', value))[0];
const sectionOf = (tree, key) => findAll(tree, has('data-tower-section', key))[0];
const rowIds = (node) => missionCards(node).map((card) => card.props['data-mission-id']);
const mineBox = (tree) => findAll(tree, has('data-tower-mine', true))[0];

// Expand every mission row one click at a time: each toggle closes over the
// expanded set of the render it came from, so clicks must not be batched.
function missionsView(h, sessionId, parentId) {
  let tree = h.render(sessionId, parentId);
  for (;;) {
    const closed = findAll(tree, (node) => node.props?.['data-mission-toggle'] && node.props['aria-expanded'] === false)[0];
    if (!closed) return tree;
    closed.props.onClick();
    tree = h.render(sessionId, parentId);
  }
}

test('the panel lists every mission of the workspace and expands a row to its roles', () => {
  const h = harness();
  let tree = h.render();
  assert.equal(findAll(tree, has('data-tower-scope', 'workspace')).length, 1);
  assert.deepEqual(rowIds(tree), ['M1']);
  const card = cardOf(tree, 'M1');
  assert.equal(card.props['data-bucket'], 'merged');
  assert.equal(card.props['data-expanded'], false);
  // collapsed rows carry no role lines and no chat links
  assert.deepEqual(agents(tree), []);
  toggleOf(tree, 'M1').props.onClick();
  tree = h.render();
  assert.equal(cardOf(tree, 'M1').props['data-expanded'], true);
  assert.equal(toggleOf(tree, 'M1').props['aria-expanded'], true);
  assert.deepEqual(agents(tree), ['M1:worker', 'M1:reviewer']);
  assert.match(textOf(roleRowOf(cardOf(tree, 'M1'), 'worker')), /执行.*deepseek-flash/);
  assert.match(textOf(roleRowOf(cardOf(tree, 'M1'), 'reviewer')), /审查.*审查通过.*deepseek-reasoner/);
  toggleOf(tree, 'M1').props.onClick();
  assert.deepEqual(agents(h.render()), []);
});

test('this-session-only keeps missions with a child of this controller and explains an empty result', () => {
  const h = harness();
  h.rows['worker-child'].parentId = 'older-controller';
  let tree = h.render();
  mineBox(tree).props.onChange();
  tree = h.render();
  assert.equal(mineBox(tree).props.checked, true);
  assert.equal(findAll(tree, has('data-tower-scope', 'session')).length, 1);
  // the reviewer still belongs to this controller, so the mission stays
  assert.deepEqual(rowIds(tree), ['M1']);
  h.rows['review-child'].parentId = 'older-controller';
  tree = h.render();
  assert.deepEqual(rowIds(tree), []);
  assert.match(textOf(tree), /本会话没有派生/);
  assert.equal(findAll(tree, withProp('data-tower-filter')).length, 0);
  findAll(tree, has('data-tower-show-all', true))[0].props.onClick();
  tree = h.render();
  assert.equal(mineBox(tree).props.checked, false);
  assert.deepEqual(rowIds(tree), ['M1']);
});

test('only real child ids become agents and usage runs; a duplicated record counts once', () => {
  const tower = sampleTowerState();
  tower.missions[0].worker = { runId: 'launching', model: 'not-a-session' };
  tower.missions.push({ ...tower.missions[0], id: 'duplicate' });
  const tree = missionsView(harness(tower));
  assert.deepEqual(agents(tree), ['M1:reviewer', 'duplicate:reviewer']);
  assert.equal(roleRowOf(cardOf(tree, 'M1'), 'worker').props['data-spawned'], false);
  assert.equal(openButtons(roleRowOf(cardOf(tree, 'M1'), 'worker')).length, 0);
  const usage = findAll(tree, withProp('data-usage-row'));
  assert.deepEqual(usage.map((row) => [row.props['data-usage-model'], row.props['data-usage-runs']]), [['deepseek-reasoner', 1]]);
  assert.doesNotMatch(textOf(findAll(tree, has('data-tower-usage', true))[0]), /not-a-session/);
});

test('chat links use authoritative lineage and exactly one opened agent is marked', () => {
  const tower = sampleTowerState();
  tower.missions[0].worker.controllerSessionId = 'old-record';
  const h = harness(tower);
  h.catalog.set('worker-child', { parentSessionId: 'catalog-parent', childSessionId: 'worker-child', mode: 'continuable' });
  let tree = missionsView(h);
  const model = findAll(roleRowOf(cardOf(tree, 'M1'), 'worker'), has('className', 'Tw_roleModel'))[0];
  assert.equal(model.props.title, 'deepseek-official / deepseek-flash');
  assert.match(textOf(model), /deepseek-flash.*max/);
  const workerLink = findAll(tree, has('data-tower-agent', 'M1:worker'))[0];
  assert.match(workerLink.props['aria-label'], /对话 · 执行 · Different models · deepseek-flash/);
  workerLink.props.onClick();
  assert.match(h.opened[0].address, /worker-child\?parent=catalog-parent&mode=continuable/);
  assert.equal(h.opened[0].options.kind, 'subagentchat');
  tree = h.render();
  const worker = findAll(tree, has('data-tower-agent', 'M1:worker'))[0];
  assert.equal(worker.props['aria-pressed'], true);
  assert.match(textOf(worker), /已打开/);
  assert.equal(roleRowOf(cardOf(tree, 'M1'), 'worker').props['data-selected'], true);
  const reviewer = findAll(tree, has('data-tower-agent', 'M1:reviewer'))[0];
  assert.equal(reviewer.props['aria-pressed'], false);
  assert.match(textOf(reviewer), /对话/);
  reviewer.props.onClick();
  assert.match(h.opened[1].address, /review-child\?parent=root&mode=continuable/);
  tree = h.render();
  assert.equal(findAll(tree, has('data-tower-agent', 'M1:worker'))[0].props['aria-pressed'], false);
  assert.equal(findAll(tree, has('data-tower-agent', 'M1:reviewer'))[0].props['aria-pressed'], true);
  // without the catalog or a listed row, the recorded controller is the fallback
  h.catalog.clear(); delete h.rows['worker-child'];
  findAll(h.render(), has('data-tower-agent', 'M1:worker'))[0].props.onClick();
  assert.match(h.opened[2].address, /parent=old-record/);
});

test('unresolved ownership is never guessed and a refused open explains itself', () => {
  const h = harness();
  delete h.rows['worker-child']; delete h.rows['review-child'];
  h.catalog.set('worker-child', null);
  h.catalog.set('review-child', { childSessionId: 'different-child', parentSessionId: 'root', mode: 'continuable' });
  let tree = h.render();
  mineBox(tree).props.onChange();
  tree = h.render();
  assert.deepEqual(rowIds(tree), []);
  assert.match(textOf(tree), /本会话没有派生/);
  findAll(tree, has('data-tower-show-all', true))[0].props.onClick();
  tree = missionsView(h);
  findAll(tree, has('data-tower-agent', 'M1:reviewer'))[0].props.onClick();
  assert.equal(h.opened.length, 0);
  tree = h.render();
  const failure = findAll(tree, has('data-open-error', 'reviewer'))[0];
  assert.equal(failure.props.role, 'alert');
  assert.match(textOf(failure), /无法确认这个子代理的归属/);
  assert.equal(findAll(tree, has('data-open-error', 'worker')).length, 0);
  assert.equal(findAll(tree, has('data-tower-agent', 'M1:reviewer'))[0].props['aria-pressed'], false);
});

test('failed, interrupted, stale, and rejected reviews never read as approved', () => {
  for (const [status, record, label, dataState, bucket, warn] of [
    ['review_failed', { completedAt: '2026-01-01T00:01:00Z', error: 'missing verdict' }, '失败', 'failed', 'open', true],
    ['review_running', { stopReason: 'aborted', verdict: undefined, merge: undefined }, '已中断', 'interrupted', 'running', false],
    ['worker_completed', { stale: true, error: 'binding stale' }, '结果已过期', 'stale', 'open', false],
    ['changes_requested', { verdict: 'changes_requested', merge: false }, '需要修改', 'changes_requested', 'open', true],
  ]) {
    const tower = sampleTowerState();
    const mission = tower.missions[0];
    mission.status = status;
    mission.worker = { ...mission.worker, completedAt: '2026-01-01T00:00:20.000Z', stopReason: 'completed' };
    mission.review = { ...mission.review, ...record };
    const tree = missionsView(harness(tower));
    const card = cardOf(tree, 'M1');
    assert.equal(card.props['data-bucket'], bucket, status);
    assert.equal(card.props['data-warn'], warn, status);
    const review = roleRowOf(card, 'reviewer');
    assert.equal(findAll(review, has('data-state', dataState)).length, 1, status);
    assert.match(textOf(review), new RegExp(label));
    assert.doesNotMatch(textOf(review), /审查通过/);
    const worker = roleRowOf(card, 'worker');
    assert.equal(findAll(worker, has('data-state', 'done')).length, 1, status);
    assert.doesNotMatch(textOf(worker), /失败|状态未知/);
    // the status chips follow the mission bucket
    assert.equal(filterOf(tree, bucket).props['data-count'], 1);
    assert.equal(filterOf(tree, 'merged'), undefined);
  }
});

test('a running worker shows live elapsed time in its row and an unspawned reviewer', () => {
  const tower = sampleTowerState();
  delete tower.missions[0].review;
  tower.missions[0].status = 'worker_running';
  tower.missions[0].worker.startedAt = '2026-01-01T00:00:00.000Z';
  const h = harness(tower, { now: Date.parse('2026-01-01T00:02:05.000Z') });
  let tree = h.render();
  const card = cardOf(tree, 'M1');
  assert.equal(card.props['data-bucket'], 'running');
  assert.equal(textOf(findAll(card, has('className', 'Tw_rowMeta'))[0]), '执行中 · 2m05s');
  // a running row already says what happens next
  assert.equal(nextOf(card), undefined);
  assert.equal(filterOf(tree, 'running').props['data-count'], 1);
  tree = missionsView(h);
  assert.deepEqual(agents(tree), ['M1:worker']);
  const reviewer = roleRowOf(cardOf(tree, 'M1'), 'reviewer');
  assert.equal(reviewer.props['data-spawned'], false);
  assert.match(textOf(reviewer), /尚未派生/);
  assert.equal(openButtons(reviewer).length, 0);
  filterOf(tree, 'running').props.onClick();
  assert.deepEqual(rowIds(h.render()), ['M1']);
});

test('mission rows show stage, dependencies, roles, and merge commit', () => {
  const h = harness(multiMissionTower());
  let tree = h.render();
  // live work leads, open work follows, terminal history comes last
  assert.deepEqual(rowIds(sectionOf(tree, 'running')), ['M3']);
  assert.deepEqual(new Set(rowIds(sectionOf(tree, 'open'))), new Set(['M2', 'M4', 'M5', 'M6']));
  assert.deepEqual(rowIds(sectionOf(tree, 'history')), ['M1']);
  tree = missionsView(h);
  const m1 = cardOf(tree, 'M1');
  assert.equal(m1.props['data-mission-status'], 'merged');
  assert.equal(nextOf(m1), undefined);
  assert.match(textOf(m1), /merge-sha/);
  assert.match(textOf(roleRowOf(m1, 'worker')), /deepseek-flash/);
  assert.match(textOf(roleRowOf(m1, 'reviewer')), /审查通过/);
  // pending mission blocked by an unmerged dependency
  const m2 = cardOf(tree, 'M2');
  const m2next = nextOf(m2);
  assert.equal(m2next.props['data-mission-next'], 'next.waitDeps');
  assert.equal(m2next.props['data-blocked'], true);
  assert.equal(m2.props['data-warn'], true);
  assert.match(textOf(m2next), /等待依赖 M3 合并/);
  const chip = findAll(m2, has('data-dep-id', 'M3'))[0];
  assert.equal(chip.props['data-dep-met'], false);
  assert.match(textOf(chip), /执行中/);
  assert.equal(roleRowOf(m2, 'worker').props['data-spawned'], false);
  assert.match(textOf(roleRowOf(m2, 'worker')), /尚未派生/);
  // running, rework, mergeable, and manual stages
  assert.match(textOf(findAll(cardOf(tree, 'M3'), has('className', 'Tw_rowMeta'))[0]), /执行中/);
  assert.match(textOf(roleRowOf(cardOf(tree, 'M3'), 'worker')), /运行中/);
  const m4 = cardOf(tree, 'M4');
  assert.equal(nextOf(m4).props['data-mission-next'], 'next.rework');
  assert.match(textOf(m4), /需返工并重新审查/);
  assert.match(textOf(roleRowOf(m4, 'reviewer')), /需要修改/);
  const m5 = cardOf(tree, 'M5');
  assert.equal(nextOf(m5).props['data-mission-next'], 'next.canMerge');
  assert.match(textOf(m5), /可合并/);
  assert.equal(findAll(m5, has('data-dep-id', 'M1'))[0].props['data-dep-met'], true);
  const m6 = cardOf(tree, 'M6');
  assert.equal(nextOf(m6).props['data-mission-next'], 'next.rebaseManual');
  assert.equal(nextOf(m6).props['data-blocked'], true);
  assert.match(textOf(m6), /需人工处理/);
  // the all chip counts every mission; empty buckets stay hidden
  assert.equal(filterOf(tree, 'all').props['data-count'], 6);
  assert.equal(filterOf(tree, 'abandoned'), undefined);
});

test('a dependency merge unblocks its dependant and an empty tower explains itself', () => {
  const tower = multiMissionTower();
  const h = harness(tower);
  assert.match(textOf(nextOf(cardOf(h.render(), 'M2'))), /等待依赖 M3 合并/);
  tower.missions.find((mission) => mission.id === 'M3').status = 'merged';
  const tree = missionsView(h);
  assert.equal(nextOf(cardOf(tree, 'M2')).props['data-mission-next'], 'next.spawnWorker');
  assert.match(textOf(nextOf(cardOf(tree, 'M2'))), /待派生执行代理/);
  assert.equal(findAll(cardOf(tree, 'M2'), has('data-dep-id', 'M3'))[0].props['data-dep-met'], true);
  const empty = sampleTowerState();
  empty.missions = [];
  const bare = harness(empty).render();
  assert.equal(missionCards(bare).length, 0);
  assert.match(textOf(bare), /还没有任务/);
  assert.equal(findAll(bare, withProp('data-tower-filter')).length, 0);
});

test('chat links appear for every spawned role; a refused open alerts per role', () => {
  const tower = multiMissionTower();
  const h = harness(tower);
  let tree = missionsView(h);
  assert.deepEqual(openButtons(cardOf(tree, 'M1')).map((button) => button.props['data-open-agent']), ['worker', 'reviewer']);
  assert.deepEqual(openButtons(cardOf(tree, 'M2')), []);
  assert.deepEqual(openButtons(cardOf(tree, 'M3')).map((button) => button.props['data-open-agent']), ['worker']);
  openButtons(cardOf(tree, 'M1'))[0].props.onClick();
  assert.match(h.opened[0].address, /subagentchat\/session\/worker-child\?parent=root&mode=continuable/);
  // m3-worker has neither a listed row nor a recorded controller
  findAll(cardOf(tree, 'M3'), has('data-open-agent', 'worker'))[0].props.onClick();
  assert.equal(h.opened.length, 1);
  tree = h.render();
  const failure = findAll(cardOf(tree, 'M3'), has('data-open-error', 'worker'))[0];
  assert.equal(failure.props.role, 'alert');
  assert.match(textOf(failure), /无法确认这个子代理的归属/);
  assert.equal(findAll(cardOf(tree, 'M1'), withProp('data-open-error')).length, 0);
});

test('role elapsed time formats second and minute boundaries and requires startedAt', () => {
  for (const [seconds, expected] of [[45, '45s'], [59, '59s'], [60, '1m00s'], [200, '3m20s']]) {
    const tower = sampleTowerState();
    const started = Date.parse('2026-01-01T00:00:00.000Z');
    tower.missions[0].worker = {
      ...tower.missions[0].worker,
      startedAt: new Date(started).toISOString(),
      completedAt: new Date(started + seconds * 1000).toISOString(),
      stopReason: 'completed',
    };
    tower.missions[0].review = undefined;
    const row = roleRowOf(cardOf(missionsView(harness(tower)), 'M1'), 'worker');
    const elapsed = findAll(row, has('data-agent-elapsed', 'worker'));
    assert.equal(elapsed.length, 1);
    assert.equal(textOf(elapsed[0]), expected, `${seconds} seconds`);
  }
  const tower = sampleTowerState();
  tower.missions[0].worker = { ...tower.missions[0].worker, completedAt: '2026-01-01T00:00:45.000Z', stopReason: 'completed' };
  const card = cardOf(missionsView(harness(tower)), 'M1');
  assert.equal(findAll(card, withProp('data-agent-elapsed')).length, 0);
});

test('running role elapsed time advances and becomes fixed on completion', () => {
  const tower = sampleTowerState();
  tower.missions[0].status = 'worker_running';
  tower.missions[0].worker = { ...tower.missions[0].worker, startedAt: '2026-01-01T00:00:00.000Z' };
  tower.missions[0].review = undefined;
  const h = harness(tower, { now: Date.parse('2026-01-01T00:00:45.000Z') });
  missionsView(h);
  const elapsed = () => findAll(roleRowOf(cardOf(h.render(), 'M1'), 'worker'), has('data-agent-elapsed', 'worker'))[0];
  assert.equal(textOf(elapsed()), '45s');
  h.clock.now += 15_000;
  assert.equal(textOf(elapsed()), '1m00s');
  tower.missions[0].status = 'worker_completed';
  tower.missions[0].worker.completedAt = '2026-01-01T00:01:20.000Z';
  tower.missions[0].worker.stopReason = 'completed';
  assert.equal(textOf(elapsed()), '1m20s');
  h.clock.now += 60_000;
  assert.equal(textOf(elapsed()), '1m20s');
});

test('unusual stop reasons get localized badges; a normal end adds none', () => {
  for (const [language, reason, label, dataState, dot] of [
    ['zh', 'completed', null],
    ['zh', 'error', '出错', 'error', 'error'],
    ['zh', 'aborted', '已中止', 'aborted', 'warning'],
    ['zh', 'crash-loop', 'crash-loop', 'unknown', 'idle'],
    ['en', 'completed', null],
    ['en', 'error', 'Error', 'error', 'error'],
    ['en', 'aborted', 'Aborted', 'aborted', 'warning'],
  ]) {
    const tower = sampleTowerState();
    tower.missions[0].worker = {
      ...tower.missions[0].worker,
      startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:45.000Z', stopReason: reason,
    };
    tower.missions[0].review = undefined;
    const row = roleRowOf(cardOf(missionsView(harness(tower, { language })), 'M1'), 'worker');
    const badges = findAll(row, has('data-agent-stop-reason', reason));
    if (label === null) {
      assert.equal(badges.length, 0, `${language}:${reason}`);
      continue;
    }
    assert.equal(badges.length, 1, `${language}:${reason}`);
    assert.equal(badges[0].props['data-state'], dataState);
    assert.equal(findAll(badges[0], (node) => node.type === 'StateDot')[0].props.state, dot);
    assert.equal(textOf(badges[0]).trim(), label);
  }
});

test('review_failed, interrupted, and stale reviews keep distinct markers and next steps', () => {
  const tower = sampleTowerState();
  tower.missions[0].status = 'review_failed';
  tower.missions[0].review = { ...tower.missions[0].review, completedAt: '2026-01-01T00:00:30.000Z', error: 'review transport failed' };
  let card = cardOf(missionsView(harness(tower)), 'M1');
  const head = findAll(card, has('data-mission-toggle', 'M1'))[0];
  assert.equal(findAll(head, (node) => node.type === 'StateDot')[0].props.state, 'error');
  assert.match(textOf(roleRowOf(card, 'reviewer')), /失败/);
  assert.equal(nextOf(card).props['data-mission-next'], 'next.reviewFailed');

  tower.missions[0].status = 'review_running';
  tower.missions[0].review = {
    ...tower.missions[0].review, startedAt: '2026-01-01T00:00:00.000Z', completedAt: undefined,
    error: undefined, stopReason: 'aborted', verdict: undefined, merge: undefined,
  };
  card = cardOf(missionsView(harness(tower)), 'M1');
  const interrupted = findAll(roleRowOf(card, 'reviewer'), has('data-state', 'interrupted'))[0];
  assert.equal(findAll(interrupted, (node) => node.type === 'StateDot')[0].props.state, 'warning');
  assert.match(textOf(interrupted), /已中断/);
  assert.match(textOf(findAll(card, has('className', 'Tw_rowMeta'))[0]), /审查中/);

  tower.missions[0].status = 'worker_completed';
  tower.missions[0].review = {
    ...tower.missions[0].review, completedAt: '2026-01-01T00:00:30.000Z', stopReason: undefined,
    stale: true, error: 'binding stale', verdict: 'clean', merge: true,
  };
  card = cardOf(missionsView(harness(tower)), 'M1');
  const stale = findAll(roleRowOf(card, 'reviewer'), has('data-state', 'stale'))[0];
  assert.equal(findAll(stale, (node) => node.type === 'StateDot')[0].props.state, 'warning');
  assert.match(textOf(stale), /结果已过期/);
  assert.equal(nextOf(card).props['data-mission-next'], 'next.reviewStale');
  assert.match(textOf(findAll(roleRowOf(card, 'reviewer'), has('data-agent-error', 'reviewer'))[0]), /binding stale/);
});

test('review_failed is a localized error mission with a respawn next step', () => {
  for (const [language, statusLabel, hint] of [
    ['zh', '审查失败', /重新派审查或执行代理/],
    ['en', 'Review failed', /respawn a reviewer or worker/],
  ]) {
    const tower = sampleTowerState();
    tower.missions[0].status = 'review_failed';
    tower.missions[0].review = { ...tower.missions[0].review, completedAt: '2026-01-01T00:00:30.000Z', error: 'review transport failed' };
    const card = cardOf(harness(tower, { language }).render(), 'M1');
    assert.ok(card, language);
    assert.equal(textOf(findAll(card, has('className', 'Tw_rowMeta'))[0]), statusLabel);
    assert.equal(nextOf(card).props['data-mission-next'], 'next.reviewFailed');
    assert.match(textOf(nextOf(card)), hint);
  }
});

test('records without a child session are only starting during a real launch', () => {
  const tower = sampleTowerState();
  const template = tower.missions[0];
  tower.missions = [{ ...template, status: 'worker_running', worker: { runId: 'launch', model: 'launch-model' }, review: undefined, merge: undefined }];
  const roles = () => {
    const tree = missionsView(harness(tower));
    const card = cardOf(tree, 'M1');
    return { tree, card, worker: roleRowOf(card, 'worker'), reviewer: roleRowOf(card, 'reviewer') };
  };
  let view = roles();
  assert.equal(view.worker.props['data-spawned'], false);
  assert.match(textOf(view.worker), /正在创建会话/);
  assert.match(textOf(view.reviewer), /尚未派生/);
  assert.deepEqual(agents(view.tree), []);
  assert.equal(openButtons(view.card).length, 0);

  tower.missions[0].status = 'review_failed';
  tower.missions[0].review = { runId: 'failed', model: 'review-model', error: 'spawn failed', completedAt: '2026-01-01T00:00:30.000Z' };
  view = roles();
  assert.doesNotMatch(textOf(view.reviewer), /正在创建会话/);
  assert.match(textOf(view.reviewer), /失败/);
  assert.match(textOf(findAll(view.reviewer, has('data-agent-error', 'reviewer'))[0]), /spawn failed/);

  tower.missions[0].status = 'review_running';
  tower.missions[0].review = { runId: 'aborted', model: 'review-model', stopReason: 'aborted' };
  view = roles();
  assert.match(textOf(view.reviewer), /已中断/);
  assert.doesNotMatch(textOf(view.reviewer), /正在创建会话/);

  tower.missions[0].status = 'worker_completed';
  tower.missions[0].worker = { runId: 'done', model: 'worker-model', completedAt: '2026-01-01T00:00:20.000Z', stopReason: 'completed' };
  tower.missions[0].review = undefined;
  view = roles();
  assert.match(textOf(view.worker), /已完成/);
  assert.doesNotMatch(textOf(view.worker), /正在创建会话/);

  tower.missions[0].status = 'review_failed';
  tower.missions[0].review = { runId: 'bare', model: 'review-model' };
  view = roles();
  assert.match(textOf(view.reviewer), /失败/);
  assert.doesNotMatch(textOf(view.reviewer), /正在创建会话/);

  tower.missions[0].review = undefined;
  view = roles();
  assert.match(textOf(view.reviewer), /尚未派生/);
  assert.doesNotMatch(textOf(view.card), /正在创建会话/);
});

test('agent failure reasons are bounded plain text', () => {
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
    tower.missions[0].review = { ...tower.missions[0].review, completedAt: '2026-01-01T00:00:30.000Z', [field]: reason };
    const tree = missionsView(harness(tower));
    const rowReason = findAll(roleRowOf(cardOf(tree, 'M1'), 'reviewer'), has('data-agent-error', 'reviewer'))[0];
    assert.ok(rowReason);
    assert.equal(rowReason.props['data-error-truncated'], truncated);
    assert.equal(rowReason.props.title, undefined);
    assert.equal(rowReason.props['aria-label'], undefined);
    const text = textOf(rowReason);
    assert.equal(Array.from(text).length, length);
    assert.equal(text.isWellFormed(), true);
    if (truncated) assert.ok(text.endsWith('…'));
    else assert.equal(text, reason);
    assert.equal(findAll(tree, (node) => node.type === 'script' || node.props?.dangerouslySetInnerHTML != null).length, 0);
  }
});

test('successful agents show no error reason and their mission stays in history', () => {
  const tower = sampleTowerState();
  tower.missions[0].worker = {
    ...tower.missions[0].worker, completedAt: '2026-01-01T00:00:20.000Z', stopReason: 'completed',
    summary: 'worker summary is not an error',
  };
  tower.missions[0].review = { ...tower.missions[0].review, completedAt: '2026-01-01T00:00:30.000Z', stopReason: 'completed' };
  const tree = missionsView(harness(tower));
  assert.deepEqual(agents(tree), ['M1:worker', 'M1:reviewer']);
  assert.equal(errorNodes(tree).length, 0);
  assert.equal(cardOf(tree, 'M1').props['data-warn'], false);
  assert.equal(filterOf(tree, 'running'), undefined);
  assert.equal(filterOf(tree, 'open'), undefined);
  // the summary is a result, shown only inside the details
  assert.match(textOf(findAll(tree, has('data-agent-result', 'worker'))[0]), /worker summary is not an error/);
});

test('stale and retry review hints are localized', () => {
  for (const [language, staleHint, retryHint] of [
    ['zh', /核对基线后重新审查/, /请重试审查/],
    ['en', /check the synced baseline/, /retry the review/],
  ]) {
    const tower = sampleTowerState();
    tower.missions[0].status = 'worker_completed';
    tower.missions[0].review = { ...tower.missions[0].review, stale: true, error: 'binding stale', verdict: 'clean', merge: true };
    let card = cardOf(harness(tower, { language }).render(), 'M1');
    assert.equal(nextOf(card).props['data-mission-next'], 'next.reviewStale');
    assert.match(textOf(nextOf(card)), staleHint);
    tower.missions[0].review = { ...tower.missions[0].review, stale: false, error: 'no structured verdict', verdict: undefined, merge: undefined };
    card = cardOf(harness(tower, { language }).render(), 'M1');
    assert.equal(nextOf(card).props['data-mission-next'], 'next.retryReview');
    assert.match(textOf(nextOf(card)), retryHint);
  }
});

// --- Status chips, sections, and the history fold ---

function bucketTower() {
  const tower = sampleTowerState();
  const template = tower.missions[0];
  const extra = (over) => ({ ...template, branch: `tower/${over.id.toLowerCase()}`, revision: 1, dependsOn: [], worker: undefined, review: undefined, merge: undefined, ...over });
  tower.missions.push(
    extra({
      id: 'RUN', title: 'Running mission', status: 'worker_running', createdAt: '2026-01-01T00:00:03.000Z',
      worker: { runId: 'run', provider: 'deepseek-official', model: 'run-model', childId: 'run-child', startedAt: '2026-01-01T00:00:05.000Z' },
    }),
    extra({ id: 'OPEN', title: 'Open mission', status: 'pending', createdAt: '2026-01-01T00:00:02.000Z' }),
    extra({ id: 'GONE', title: 'Abandoned mission', status: 'abandoned', createdAt: '2026-01-01T00:00:01.000Z' }),
  );
  return tower;
}

test('status chips count missions by bucket, hide empty buckets, and filter the list', () => {
  const tower = bucketTower();
  const h = harness(tower);
  let tree = h.render();
  const chips = findAll(findAll(tree, has('className', 'Tw_filters'))[0], withProp('data-tower-filter'));
  assert.deepEqual(chips.map((chip) => [chip.props['data-tower-filter'], chip.props['data-count'], chip.props['aria-pressed']]), [
    ['all', 4, true], ['running', 1, false], ['open', 1, false], ['merged', 1, false], ['abandoned', 1, false],
  ]);
  assert.match(textOf(chips[1]), /进行中 1/);
  filterOf(tree, 'open').props.onClick();
  tree = h.render();
  assert.equal(filterOf(tree, 'open').props['aria-pressed'], true);
  assert.deepEqual(rowIds(tree), ['OPEN']);
  // a single bucket needs no section heads
  assert.equal(findAll(sectionOf(tree, 'open'), has('className', 'Tw_sectionHead')).length, 0);
  // an active filter keeps its chip even after its bucket empties
  tower.missions.find((mission) => mission.id === 'OPEN').status = 'abandoned';
  tree = h.render();
  assert.equal(filterOf(tree, 'open').props['data-count'], 0);
  assert.deepEqual(rowIds(tree), []);
  assert.match(textOf(tree), /没有符合条件的任务/);
  filterOf(tree, 'all').props.onClick();
  tree = h.render();
  assert.equal(filterOf(tree, 'open'), undefined);
  assert.deepEqual(rowIds(tree).sort(), ['GONE', 'M1', 'OPEN', 'RUN']);
});

test('the all filter leads with live and open work; history folds below the usage ranking', () => {
  const h = harness(bucketTower());
  let tree = h.render();
  const workspace = findAll(tree, has('data-tower-workspace', true))[0];
  const order = workspace.props.children.flat(Infinity)
    .filter((node) => node?.props?.['data-tower-section'] || node?.props?.['data-tower-usage'])
    .map((node) => node.props['data-tower-section'] ?? 'usage');
  assert.deepEqual([...order], ['running', 'open', 'usage', 'history']);
  assert.deepEqual(rowIds(sectionOf(tree, 'history')), ['M1', 'GONE']);
  const head = findAll(sectionOf(tree, 'history'), has('data-history-toggle', true))[0];
  assert.equal(head.props['aria-expanded'], true);
  assert.match(textOf(head), /历史 2/);
  head.props.onClick();
  tree = h.render();
  assert.equal(findAll(sectionOf(tree, 'history'), has('data-history-toggle', true))[0].props['aria-expanded'], false);
  assert.deepEqual(rowIds(sectionOf(tree, 'history')), []);
  // live work is never folded away
  assert.deepEqual(rowIds(sectionOf(tree, 'running')), ['RUN']);
  assert.equal(findAll(sectionOf(tree, 'running'), withProp('data-history-toggle')).length, 0);
});

test('history alone keeps its foldable head under the usage ranking', () => {
  const tree = harness().render();
  assert.equal(findAll(tree, has('data-history-toggle', true)).length, 1);
  assert.equal(findAll(tree, has('data-tower-section', 'running')).length, 0);
});

// --- Model usage ranking ---

const usageOf = (tree) => findAll(tree, has('data-tower-usage', true))[0];
const usageRows = (tree) => findAll(tree, withProp('data-usage-row'));
const tokens = (total) => {
  const uncachedInputTokens = Math.round(total * 0.2), outputTokens = Math.round(total * 0.1), cacheReadTokens = Math.round(total * 0.6);
  return { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: total - uncachedInputTokens - outputTokens - cacheReadTokens };
};

test('usage ranks models by tokens with runs on the left and tokens on the right', () => {
  const tower = multiMissionTower();
  const h = harness(tower);
  h.rows['worker-child'].projectionValues = { tokenUsage: tokens(1_000_000) };
  h.rows['review-child'].projectionValues = { tokenUsage: tokens(4_000_000) };
  h.rows['m3-worker'] = { projectionValues: { tokenUsage: tokens(500_000) } };
  h.rows['m4-review'] = { projectionValues: { tokenUsage: tokens(250_000) } };
  const tree = h.render();
  const section = usageOf(tree);
  assert.equal(section.props['data-usage-metric'], 'tokens');
  // runs per provider/model: flash = M1, M3, M4, M5 workers; reasoner = M1, M4, M5 reviews
  assert.deepEqual(usageRows(tree).map((row) => [
    row.props['data-usage-model'], row.props['data-usage-runs'], row.props['data-usage-tokens'],
  ]), [['deepseek-reasoner', 3, 4_250_000], ['deepseek-flash', 4, 1_500_000]]);
  const [first, second] = usageRows(tree);
  assert.match(textOf(first), /deepseek-reasoner.*3 次.*deepseek-official.*4\.3M/);
  assert.match(textOf(second), /deepseek-flash.*4 次.*1\.5M/);
  assert.equal(findAll(first, withProp('data-usage-share'))[0].props['data-usage-share'], 100);
  assert.equal(findAll(second, withProp('data-usage-share'))[0].props['data-usage-share'], 35);
  assert.match(textOf(section), /模型用量.*7 次 · 5\.8M tok/);
  assert.match(textOf(findAll(section, has('data-usage-unknown', 3))[0]), /3 个会话的用量未加载/);
  // the column heads name each side
  assert.match(textOf(findAll(section, has('className', 'Tw_usageRow Tw_usageCols'))[0]), /模型 · 次数.*排行.*token/);
});

test('usage falls back to a run ranking when no token totals are loaded', () => {
  const tree = harness(multiMissionTower()).render();
  const section = usageOf(tree);
  assert.equal(section.props['data-usage-metric'], 'runs');
  assert.deepEqual(usageRows(tree).map((row) => [row.props['data-usage-model'], row.props['data-usage-runs'], row.props['data-usage-tokens']]), [
    ['deepseek-flash', 4, undefined], ['deepseek-reasoner', 3, undefined],
  ]);
  assert.match(textOf(usageRows(tree)[0]), /—/);
  assert.match(textOf(section), /7 次 · —/);
});

test('usage folds, caps its rows, and follows the session-only scope', () => {
  const tower = sampleTowerState();
  const template = tower.missions[0];
  for (let index = 0; index < 11; index += 1) {
    tower.missions.push({
      ...template, id: `X${index}`, merge: undefined, review: undefined,
      worker: { runId: `x${index}`, provider: 'p', model: `model-${String(index).padStart(2, '0')}`, childId: `x-child-${index}` },
    });
  }
  const h = harness(tower);
  let tree = h.render();
  assert.equal(usageRows(tree).length, 10);
  assert.match(textOf(findAll(tree, has('data-usage-overflow', 3))[0]), /\+3 个模型/);
  findAll(tree, has('data-usage-toggle', true))[0].props.onClick();
  tree = h.render();
  assert.equal(usageOf(tree).props['data-usage-collapsed'], true);
  assert.equal(usageRows(tree).length, 0);
  findAll(tree, has('data-usage-toggle', true))[0].props.onClick();
  // only children listed under this controller count once the scope narrows
  mineBox(h.render()).props.onChange();
  tree = h.render();
  assert.deepEqual(usageRows(tree).map((row) => row.props['data-usage-model']).sort(), ['deepseek-flash', 'deepseek-reasoner']);
});

test('tokenTotal, formatTokens, and modelUsage are pure and tolerant', () => {
  const { tokenTotal, formatTokens, modelUsage, missionBucket } = harness().module;
  assert.equal(tokenTotal(tokens(1000)), 1000);
  assert.equal(tokenTotal({ uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3 }), undefined);
  assert.equal(tokenTotal(null), undefined);
  assert.equal(tokenTotal({ uncachedInputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), undefined);
  for (const [value, text] of [[0, '0'], [950, '950'], [9_500, '9.5K'], [95_000, '95K'], [999_400, '999K'], [999_600, '1.0M'], [12_340_000, '12M'], [1.2e9, '1.2B'], [undefined, '—'], [Number.NaN, '—']]) {
    assert.equal(formatTokens(value), text, String(value));
  }
  const usage = modelUsage([
    { childId: 'a', provider: 'p', model: 'm', reasoningEffort: 'high' },
    { childId: 'b', provider: 'p', model: 'm', reasoningEffort: 'max' },
    { childId: 'c', provider: 'q', model: 'm' },
    { provider: 'p', model: 'no-session' },
  ], { a: { projectionValues: { tokenUsage: tokens(10) } } });
  assert.deepEqual(JSON.parse(JSON.stringify(usage)), [
    { provider: 'p', model: 'm', runs: 2, tokens: 10, unknown: 1 },
    { provider: 'q', model: 'm', runs: 1, tokens: 0, unknown: 1 },
  ]);
  assert.deepEqual(['worker_running', 'review_running', 'pending', 'approved', 'odd', 'merged', 'abandoned'].map((status) => missionBucket({ status })),
    ['running', 'running', 'open', 'open', 'open', 'merged', 'abandoned']);
});

test('role lines show the child session tokens when the host lists them', () => {
  const h = harness();
  h.rows['review-child'].projectionValues = { ...h.rows['review-child'].projectionValues, tokenUsage: tokens(2_500_000) };
  const tree = missionsView(h);
  const tokensNode = findAll(roleRowOf(cardOf(tree, 'M1'), 'reviewer'), withProp('data-agent-tokens'))[0];
  assert.equal(tokensNode.props['data-agent-tokens'], 2_500_000);
  assert.equal(textOf(tokensNode), '2.5M tok');
  assert.equal(findAll(roleRowOf(cardOf(tree, 'M1'), 'worker'), withProp('data-agent-tokens')).length, 0);
});

// --- Resume provenance and details ---

test('resumed agents are tagged per role and expose provenance without prompt hashes', () => {
  for (const [language, tag, runLabel, seqLabel] of [
    ['zh', '续接', '审查 · 上次运行', '审查 · 会话序号'],
    ['en', 'Resumed', 'Reviewer · Previous run', 'Reviewer · Session sequence'],
  ]) {
    const tower = sampleTowerState();
    tower.missions[0].review.resumeFrom = { runId: 'previous-run-42', sessionSeq: 7, childId: 'previous-child', promptHash: 'never-render-this-hash' };
    const h = harness(tower, { language });
    let tree = h.render();
    // the collapsed row already carries one tag
    assert.equal(textOf(findAll(cardOf(tree, 'M1'), has('data-mission-resumed', true))[0]), tag);
    tree = missionsView(h);
    const card = cardOf(tree, 'M1');
    assert.equal(textOf(findAll(roleRowOf(card, 'reviewer'), has('data-agent-resumed', 'reviewer'))[0]), tag);
    assert.equal(findAll(roleRowOf(card, 'worker'), withProp('data-agent-resumed')).length, 0, language);
    const details = findAll(card, has('className', 'Tw_details'))[0];
    assert.match(textOf(details), new RegExp(`${runLabel}.*previous-run-42.*${seqLabel}.*7`));
    assert.match(textOf(details), /详情|Details/);
    assert.doesNotMatch(textOf(tree), /never-render-this-hash|promptHash/);
  }
});

test('details carry the description, branch, commits, results, and checks', () => {
  const tower = sampleTowerState();
  Object.assign(tower.missions[0].worker, { headCommit: 'head-sha', output: 'worker output text' });
  Object.assign(tower.missions[0].review, { reviewedCommit: 'reviewed-sha', summary: 'review summary', checks: ['tests pass', 'scope ok'] });
  const details = findAll(cardOf(missionsView(harness(tower)), 'M1'), has('className', 'Tw_details'))[0];
  const text = textOf(details);
  assert.match(text, /分支.*tower\/m1/);
  assert.match(text, /执行 · 提交.*head-sha/);
  assert.match(text, /审查 · 审查提交.*reviewed-sha/);
  assert.match(text, /任务说明.*Show worker and reviewer models/);
  assert.match(text, /执行 · 结果.*worker output text/);
  assert.match(text, /审查 · 结果.*review summary/);
  assert.deepEqual(findAll(details, (node) => node.type === 'li').map(textOf), ['tests pass', 'scope ok']);
});

test('a child session sees only its own record, opened by default, with no scope switch', () => {
  const tower = multiMissionTower();
  const tree = harness(tower).render('m4-review', 'root');
  assert.equal(findAll(tree, has('data-tower-scope', 'agent')).length, 1);
  assert.equal(mineBox(tree), undefined);
  assert.match(textOf(tree), /当前子代理的记录/);
  assert.deepEqual(rowIds(tree), ['M4']);
  assert.equal(cardOf(tree, 'M4').props['data-expanded'], true);
  assert.deepEqual(agents(tree), ['M4:reviewer']);
  assert.equal(roleRowOf(cardOf(tree, 'M4'), 'worker'), undefined);
  assert.deepEqual(usageRows(tree).map((row) => row.props['data-usage-model']), ['deepseek-reasoner']);
});

test('the newest same-repo snapshot wins and foreign repos stay out', () => {
  // equal updatedAt keeps the session's own seed snapshot
  {
    const h = harness();
    const equal = sampleTowerState();
    equal.missions[0].title = 'Equal snapshot';
    h.projections.equalSession = { values: { tower: equal } };
    assert.match(textOf(h.render()), /Different models/);
    assert.doesNotMatch(textOf(h.render()), /Equal snapshot/);
  }
  // a strictly newer same-repo snapshot wins and the repo badge stays put
  {
    const h = harness();
    const newer = sampleTowerState();
    newer.updatedAt = '2026-01-02T00:00:00.000Z';
    newer.missions[0].review.model = 'newer-review-model';
    h.projections.newerSession = { values: { tower: newer } };
    const tree = h.render();
    assert.match(textOf(tree), /newer-review-model/);
    const badge = findAll(tree, has('className', 'Tw_repo'))[0];
    assert.equal(badge.props.title, '/tmp/tower-panel');
    assert.match(textOf(badge), /tower-panel · main/);
  }
  // a newer snapshot from another repo never leaks into this workspace
  {
    const h = harness();
    const foreign = sampleTowerState();
    foreign.repoRoot = '/another/workspace';
    foreign.baseBranch = 'foreign';
    foreign.updatedAt = '2026-01-03T00:00:00.000Z';
    foreign.missions[0].title = 'Foreign mission';
    h.projections.foreignSession = { values: { tower: foreign } };
    const tree = h.render();
    assert.doesNotMatch(textOf(tree), /Foreign mission|foreign/);
    assert.match(textOf(findAll(tree, has('className', 'Tw_repo'))[0]), /tower-panel · main/);
  }
  // the parent session's fresher snapshot outranks the session's own stale one
  {
    const h = harness();
    const ownOld = sampleTowerState();
    ownOld.updatedAt = '2025-12-31T00:00:00.000Z';
    ownOld.missions[0].title = 'Own older snapshot';
    h.projections['review-child'] = { values: { tower: ownOld } };
    const parentNew = sampleTowerState();
    parentNew.updatedAt = '2026-01-05T00:00:00.000Z';
    parentNew.missions[0].title = 'Parent newer snapshot';
    h.projections.root = { values: { tower: parentNew } };
    const tree = h.render('review-child', 'root');
    assert.match(textOf(tree), /Parent newer snapshot/);
    assert.doesNotMatch(textOf(tree), /Own older snapshot/);
  }
});

test('sessions without any tower show unavailable and no agents controls', () => {
  const h = harness();
  h.projections.empty = { values: { tower: null } };
  const tree = h.render('empty');
  const notice = findAll(tree, has('role', 'status'))[0];
  assert.match(textOf(notice), /还没有 Tower 状态/);
  // no view toggle, scope switch, or filter row exists without a tower
  assert.equal(findAll(tree, withProp('data-tower-view-button')).length, 0);
  assert.equal(findAll(tree, withProp('data-tower-scope-button')).length, 0);
  assert.equal(findAll(tree, withProp('data-tower-filter')).length, 0);
  assert.equal(findAll(tree, has('className', 'Tw_scope')).length, 0);
  assert.equal(findAll(tree, has('className', 'Tw_filters')).length, 0);
  assert.equal(agents(tree).length, 0);
  assert.equal(findAll(tree, has('className', 'Tw_repo')).length, 0);
});

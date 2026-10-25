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

// Preserve hook state across renders to exercise real scope/filter/click transitions.
function harness(tower = sampleTowerState()) {
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
      bind: (ns) => (key, vars = {}) => (dictionaries[ns].zh[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => vars[name]),
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
  return { render, opened, rows, catalog, projections, slots, services };
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

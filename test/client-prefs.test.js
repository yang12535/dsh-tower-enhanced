import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { sampleTowerState } from './projection.test.js';

// Panel-preference persistence across unmounts (tab switches): the module
// memory cache (tier a) plus best-effort localStorage under the
// `dsh-tower:prefs:v1` namespace (tier b). Same vm technique as
// test/client.test.js, extended with a fake localStorage, a deterministic
// requestAnimationFrame queue, real useRef identity, effect flushes with
// cleanups, and an unmount that drops hook state like a real tab switch.

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
const agents = (tree) => findAll(tree, (node) => node.props?.['data-tower-agent']).map((node) => node.props['data-tower-agent']);
const pressedMap = (tree, key) => Object.fromEntries(
  findAll(tree, withProp(key)).map((node) => [node.props[key], node.props['aria-pressed']]),
);
const groupOf = (tree, role) => findAll(tree, has('data-tower-group', role))[0];
const headOf = (group) => findAll(group, has('className', 'Tw_groupHead'))[0];
const scrollerOf = (tree) => findAll(tree, has('data-tower-workspace', true))[0];

// Deterministic requestAnimationFrame: callbacks wait in a queue until the
// test flushes them, so restore/write timing is observable and stable.
function frameClock() {
  const queue = new Map();
  let nextId = 1;
  return {
    request(callback) { const id = nextId++; queue.set(id, callback); return id; },
    cancel(id) { queue.delete(id); },
    flush() { const pending = [...queue.values()]; queue.clear(); for (const callback of pending) callback(); },
    size: () => queue.size,
  };
}

// localStorage stand-in over an in-memory Map, optionally throwing on every
// access to mimic private mode, a sandboxed iframe, or an exhausted quota.
function fakeStorage({ throws = false } = {}) {
  const store = new Map();
  return {
    store,
    getItem(key) { if (throws) throw new Error('SecurityError: storage denied'); return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { if (throws) throw new Error('QuotaExceededError: quota exceeded'); store.set(key, String(value)); },
  };
}

const GLOBAL_KEY = 'dsh-tower:prefs:v1:global';
const sessionKey = (sessionId) => `dsh-tower:prefs:v1:session:${sessionId}`;
function seed(storage, { global: globalPrefs = null, sessions = {} } = {}) {
  if (globalPrefs) storage.setItem(GLOBAL_KEY, JSON.stringify(globalPrefs));
  for (const [sessionId, record] of Object.entries(sessions)) {
    storage.setItem(sessionKey(sessionId), JSON.stringify(record));
  }
  return storage;
}

function harness(tower = sampleTowerState(), { language = 'zh', now, storage = null, frames = frameClock() } = {}) {
  let definition, hookIndex, activeHooks;
  const clock = { now };
  const hooks = new Map(), slots = new Map(), opened = [], catalog = new Map(), dictionaries = {};
  const pendingEffects = [];
  const domNodes = new Map(); // ref object -> one stable fake node across renders
  const rows = {
    root: { title: 'Controller A' },
    'worker-child': { parentId: 'root', projectionValues: { subagent: { label: 'tower:M1:worker' } } },
    'review-child': { parentId: 'root', projectionValues: { subagent: { label: 'tower:M1:reviewer' } } },
  };
  const projections = { root: { values: { tower } } };
  const react = {
    useState(initial) {
      const index = hookIndex++, values = activeHooks;
      if (!(index in values)) values[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [values[index].value, (next) => { values[index].value = typeof next === 'function' ? next(values[index].value) : next; }];
    },
    // Real identity semantics: one ref object per hook slot, kept across
    // renders, so the component can rely on listRef staying stable.
    useRef(initial) {
      const index = hookIndex++, values = activeHooks;
      if (!(index in values)) values[index] = { current: initial };
      return values[index];
    },
    // Effects are collected and flushed after the tree is expanded (after
    // refs are bound), re-run only when their deps change, and their
    // cleanups run on unmount — the minimum React behavior persistence needs.
    useEffect(effect, deps) {
      const index = hookIndex++, values = activeHooks;
      if (!(index in values)) values[index] = { deps: undefined, cleanup: null, ran: false };
      pendingEffects.push({ slot: values[index], effect, deps });
    },
    useLayoutEffect() {},
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
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { definition = value; } } },
    document: { querySelector: () => ({}), body: {} }, URLSearchParams,
    Date: class extends Date { static now() { return clock.now ?? super.now(); } },
    requestAnimationFrame: (callback) => frames.request(callback),
    cancelAnimationFrame: (id) => frames.cancel(id),
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
  };
  // A missing localStorage (not present at all) and a throwing one are both
  // legal worlds the panel must survive; only inject it when asked.
  if (storage) sandbox.localStorage = storage;
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox);
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
  function bindRefs(node) {
    const visit = (candidate) => {
      if (!candidate || typeof candidate !== 'object') return;
      if (Array.isArray(candidate)) { candidate.forEach(visit); return; }
      const ref = candidate.props?.ref;
      if (ref != null && typeof ref === 'object' && 'current' in ref) {
        if (!domNodes.has(ref)) domNodes.set(ref, { scrollTop: 0 });
        ref.current = domNodes.get(ref);
      }
      visit(candidate.props?.children);
    };
    visit(node);
  }
  function flushEffects() {
    for (const { slot, effect, deps } of pendingEffects.splice(0)) {
      const changed = !slot.ran
        || !Array.isArray(deps)
        || !Array.isArray(slot.deps)
        || deps.length !== slot.deps.length
        || deps.some((value, index) => value !== slot.deps[index]);
      if (!changed) continue;
      if (typeof slot.cleanup === 'function') slot.cleanup();
      slot.cleanup = effect() ?? null;
      slot.ran = true;
      slot.deps = deps;
    }
  }
  function render(sessionId = 'root', parentId, surface = 'sidebar.right.pane.tab', pathKey) {
    const slot = slots.get(surface);
    const props = {
      sessionId,
      useSession: (selector) => selector({ subagent: parentId ? { address: { parentSessionId: parentId } } : undefined }),
      useSessions: (selector) => selector({ phase: 'ready', byId: rows, projectionsBySession: projections }),
      t: services.locale.bind('tower-enhanced'), ...slot.meta.inject(),
    };
    const tree = expand(element(slot.component, props), pathKey ?? `${surface}:${sessionId}`);
    bindRefs(tree);
    flushEffects();
    return tree;
  }
  // Simulate the tab switch: run every cleanup (ref detach, pending flushes),
  // then forget all hook state so a next render remounts from scratch.
  function unmount(sessionId = 'root', surface = 'sidebar.right.pane.tab') {
    const prefix = `${surface}:${sessionId}`;
    pendingEffects.length = 0;
    for (const [path, values] of [...hooks.entries()]) {
      const inside = path === prefix || path.startsWith(`${prefix}:`) || path.startsWith(`${prefix}/`);
      if (!inside) continue;
      for (const slot of values) {
        if (typeof slot?.cleanup === 'function') slot.cleanup();
        if (slot != null && typeof slot === 'object' && 'current' in slot) slot.current = null;
      }
      hooks.delete(path);
    }
  }
  return { render, unmount, opened, rows, catalog, projections, slots, services, module: exported, clock, frames, storage };
}

// Two attention-classified agents (one per role) so the attention filter,
// both role groups, and selection are all observable at once.
function attentionTower() {
  const tower = sampleTowerState();
  const template = tower.missions[0];
  tower.missions = [
    {
      ...template, id: 'W', status: 'worker_failed', merge: undefined, review: undefined,
      worker: { ...template.worker, childId: 'w-failed', completedAt: '2026-01-01T00:00:20.000Z', stopReason: 'completed' },
    },
    {
      ...template, id: 'R', status: 'review_failed', merge: undefined, worker: undefined,
      review: { ...template.review, childId: 'r-failed', completedAt: '2026-01-01T00:00:30.000Z', error: 'review blew up' },
    },
  ];
  return tower;
}
function attentionHarness(options = {}) {
  const h = harness(attentionTower(), options);
  h.rows['w-failed'] = { parentId: 'root' };
  h.rows['r-failed'] = { parentId: 'root' };
  return h;
}

test('first mount without any record shows the historical defaults', () => {
  // absent storage, empty storage, and storage that throws on access:
  // nothing saved means nothing restored, in every world
  for (const storage of [null, fakeStorage(), fakeStorage({ throws: true })]) {
    const h = harness(sampleTowerState(), { storage });
    const tree = h.render('root');
    assert.deepEqual(pressedMap(tree, 'data-tower-view-button'), { missions: false, agents: true }, String(storage));
    assert.deepEqual(pressedMap(tree, 'data-tower-scope-button'), { session: true, workspace: false });
    assert.deepEqual(pressedMap(tree, 'data-tower-filter'), { all: true, running: false, attention: false });
    assert.deepEqual(agents(tree), ['M1:worker', 'M1:reviewer']);
    for (const id of ['M1:worker', 'M1:reviewer']) {
      assert.equal(findAll(tree, has('data-tower-agent', id))[0].props['aria-pressed'], false);
    }
    assert.equal(headOf(groupOf(tree, 'worker')).props['aria-expanded'], true);
    assert.equal(headOf(groupOf(tree, 'reviewer')).props['aria-expanded'], true);
    assert.equal(h.frames.size(), 0, 'no scroll to restore, no frame scheduled');
  }
});

test('a saved record restores view, scope, filter, collapsed, and selected on the first render', () => {
  const storage = seed(fakeStorage(), {
    global: { view: 'agents', scope: 'workspace', filter: 'attention', collapsed: ['reviewer'] },
    sessions: { root: { selected: 'w-failed' } },
  });
  const h = attentionHarness({ storage });
  // The lazy initial values mean the very FIRST render is already restored —
  // there is no default-render-then-overwrite flash to wait out.
  const tree = h.render('root');
  assert.deepEqual(pressedMap(tree, 'data-tower-scope-button'), { session: false, workspace: true });
  assert.deepEqual(pressedMap(tree, 'data-tower-filter'), { all: false, running: false, attention: true });
  assert.equal(headOf(groupOf(tree, 'reviewer')).props['aria-expanded'], false);
  assert.equal(findAll(groupOf(tree, 'reviewer'), has('className', 'Tw_groupBody')).length, 0);
  assert.equal(headOf(groupOf(tree, 'worker')).props['aria-expanded'], true);
  assert.equal(findAll(tree, has('data-tower-agent', 'W:worker'))[0].props['aria-pressed'], true);
  assert.equal(findAll(tree, has('data-agent-session', 'w-failed'))[0].props['data-selected'], true);
  assert.match(textOf(findAll(tree, has('data-agent-session', 'w-failed'))[0]), /已打开/);

  // the missions view restores the same lazy way in a fresh module (page)
  const missions = harness(sampleTowerState(), {
    storage: seed(fakeStorage(), { global: { view: 'missions' } }),
  });
  const missionsTree = missions.render('root');
  assert.ok(findAll(missionsTree, has('data-tower-mission-view', true)).length > 0);
  assert.deepEqual(pressedMap(missionsTree, 'data-tower-view-button'), { missions: true, agents: false });
  assert.equal(findAll(missionsTree, withProp('data-tower-scope-button')).length, 0);
});

test('a selected id that no longer exists degrades to no selection', () => {
  const storage = seed(fakeStorage(), {
    global: { view: 'agents', scope: 'session' },
    sessions: { root: { selected: 'ghost-child' } },
  });
  const h = harness(sampleTowerState(), { storage });
  const tree = h.render('root');
  // every card renders unselected — the dangling id behaves exactly like null
  for (const id of ['M1:worker', 'M1:reviewer']) {
    assert.equal(findAll(tree, has('data-tower-agent', id))[0].props['aria-pressed'], false);
    assert.equal(findAll(tree, has('data-tower-agent', id))[0].props['aria-selected'], undefined);
  }
  assert.equal(findAll(tree, has('data-agent-session', 'worker-child'))[0].props['data-selected'], false);
  assert.doesNotMatch(textOf(tree), /已打开/);
  // the panel stays operable: a fresh click selects normally
  findAll(tree, has('data-tower-agent', 'M1:reviewer'))[0].props.onClick();
  const after = h.render('root');
  assert.equal(findAll(after, has('data-tower-agent', 'M1:reviewer'))[0].props['aria-pressed'], true);
  assert.equal(findAll(after, has('data-agent-session', 'review-child'))[0].props['data-selected'], true);
  // and the recovered selection persists for the next mount
  h.unmount('root');
  const restored = h.render('root');
  assert.equal(findAll(restored, has('data-tower-agent', 'M1:reviewer'))[0].props['aria-pressed'], true);
});

test('remount after a tab switch restores state through localStorage', () => {
  const storage = fakeStorage();
  const first = attentionHarness({ storage });
  let tree = first.render('root');
  findAll(tree, has('data-tower-scope-button', 'workspace'))[0].props.onClick();
  tree = first.render('root');
  findAll(tree, has('data-tower-filter', 'attention'))[0].props.onClick();
  tree = first.render('root');
  findAll(tree, has('data-tower-agent', 'R:reviewer'))[0].props.onClick();
  tree = first.render('root');
  headOf(groupOf(tree, 'reviewer')).props.onClick();
  first.unmount('root');
  // the two records landed under the documented namespace, split as specified
  // (routesCollapsed is the M68 route-usage fold, always boolean)
  assert.deepEqual(JSON.parse(storage.store.get(GLOBAL_KEY)), {
    view: 'agents', scope: 'workspace', filter: 'attention', collapsed: ['reviewer'], routesCollapsed: false,
  });
  assert.deepEqual(JSON.parse(storage.store.get(sessionKey('root'))), { selected: 'r-failed', scrollTop: null });
  // a fresh module load (what a new page would see) has an empty memory
  // cache, so restoration here can only come from localStorage
  const second = attentionHarness({ storage });
  let restored = second.render('root');
  assert.deepEqual(pressedMap(restored, 'data-tower-scope-button'), { session: false, workspace: true });
  assert.deepEqual(pressedMap(restored, 'data-tower-filter'), { all: false, running: false, attention: true });
  assert.equal(headOf(groupOf(restored, 'reviewer')).props['aria-expanded'], false);
  // the collapsed group still holds the selected card: expand and confirm
  headOf(groupOf(restored, 'reviewer')).props.onClick();
  restored = second.render('root');
  assert.equal(findAll(restored, has('data-tower-agent', 'R:reviewer'))[0].props['aria-pressed'], true);
});

test('remount restores through the in-memory cache when storage throws or is absent', () => {
  for (const storage of [fakeStorage({ throws: true }), null]) {
    const h = attentionHarness({ storage });
    let tree = h.render('root');
    findAll(tree, has('data-tower-scope-button', 'workspace'))[0].props.onClick();
    tree = h.render('root');
    findAll(tree, has('data-tower-filter', 'attention'))[0].props.onClick();
    tree = h.render('root');
    findAll(tree, has('data-tower-agent', 'R:reviewer'))[0].props.onClick();
    tree = h.render('root');
    // detour to the missions view, then "switch tabs" from there
    findAll(tree, has('data-tower-view-button', 'missions'))[0].props.onClick();
    h.render('root');
    h.unmount('root');
    // tier a alone restores everything, including the view
    let restored = h.render('root');
    assert.ok(findAll(restored, has('data-tower-mission-view', true)).length > 0, 'view restored from memory');
    findAll(restored, has('data-tower-view-button', 'agents'))[0].props.onClick();
    restored = h.render('root');
    assert.deepEqual(pressedMap(restored, 'data-tower-scope-button'), { session: false, workspace: true });
    assert.deepEqual(pressedMap(restored, 'data-tower-filter'), { all: false, running: false, attention: true });
    assert.equal(findAll(restored, has('data-tower-agent', 'R:reviewer'))[0].props['aria-pressed'], true);
    if (storage) assert.equal(storage.store.size, 0, 'throwing storage stayed empty');
  }
});

test('scroll position is written per frame on scroll and restored after remount', () => {
  const storage = fakeStorage();
  const h = harness(sampleTowerState(), { storage });
  const tree = h.render('root');
  const scroller = scrollerOf(tree);
  const node = scroller.props.ref.current;
  assert.ok(node, 'the list ref is bound to the scroll container');
  // a burst of scroll events coalesces into one frame and one write, keeping
  // only the latest position
  node.scrollTop = 120;
  scroller.props.onScroll();
  node.scrollTop = 240;
  scroller.props.onScroll();
  scroller.props.onScroll();
  assert.equal(h.frames.size(), 1);
  h.frames.flush();
  assert.deepEqual(JSON.parse(storage.store.get(sessionKey('root'))), { selected: null, scrollTop: 240 });
  // unmount → remount: the fresh container restores after one rAF, not before
  h.unmount('root');
  const remounted = h.render('root');
  const freshNode = scrollerOf(remounted).props.ref.current;
  assert.notEqual(freshNode, node);
  assert.equal(freshNode.scrollTop, 0, 'restoration waits for the frame');
  assert.equal(h.frames.size(), 1);
  h.frames.flush();
  assert.equal(freshNode.scrollTop, 240);
  // the same scroll survives into a fresh module (page) through storage
  const page2 = harness(sampleTowerState(), { storage });
  const p2tree = page2.render('root');
  const p2node = scrollerOf(p2tree).props.ref.current;
  assert.equal(page2.frames.size(), 1);
  page2.frames.flush();
  assert.equal(p2node.scrollTop, 240);
});

test('a throwing or missing localStorage never crashes the panel', () => {
  const storage = fakeStorage({ throws: true });
  const h = harness(sampleTowerState(), { storage });
  let tree;
  assert.doesNotThrow(() => { tree = h.render('root'); });
  assert.deepEqual(pressedMap(tree, 'data-tower-view-button'), { missions: false, agents: true });
  // interactions write through the memory tier even while storage throws
  assert.doesNotThrow(() => {
    findAll(tree, has('data-tower-view-button', 'missions'))[0].props.onClick();
    tree = h.render('root');
    const scroller = scrollerOf(tree);
    scroller.props.ref.current.scrollTop = 77;
    scroller.props.onScroll();
    h.frames.flush();
  });
  assert.equal(storage.store.size, 0);
  h.unmount('root');
  // and the memory tier alone brings both the view and the scroll back
  const restored = h.render('root');
  assert.ok(findAll(restored, has('data-tower-mission-view', true)).length > 0);
  h.frames.flush();
  assert.equal(scrollerOf(restored).props.ref.current.scrollTop, 77);
});

test('switching sessions resets the per-session record and shares the global UI preferences', () => {
  const storage = fakeStorage();
  const h = attentionHarness({ storage });
  // one mounted panel instance (fixed path) that changes its session prop
  const surface = 'sidebar.right.pane.tab';
  const at = (sessionId) => h.render(sessionId, 'root', surface, 'panel');
  let tree = at('root');
  // pick non-default UI preferences, then select an agent (the historical
  // scope-switch reset clears an earlier selection, so select afterwards)
  findAll(tree, has('data-tower-scope-button', 'workspace'))[0].props.onClick();
  tree = at('root');
  findAll(tree, has('data-tower-agent', 'R:reviewer'))[0].props.onClick();
  at('root');
  // the switch itself renders once with the old state, then the effect
  // reloads: a session without its own record starts unselected (the
  // historical selection reset) while the global UI preference follows
  at('other');
  tree = at('other');
  assert.deepEqual(pressedMap(tree, 'data-tower-scope-button'), { session: false, workspace: true });
  assert.deepEqual(agents(tree), ['W:worker', 'R:reviewer']);
  for (const id of ['W:worker', 'R:reviewer']) {
    assert.equal(findAll(tree, has('data-tower-agent', id))[0].props['aria-pressed'], false);
  }
  // the other session builds its own selection record
  findAll(tree, has('data-tower-agent', 'W:worker'))[0].props.onClick();
  at('other');
  // switching back restores root's own selection on top of the shared prefs
  at('root');
  tree = at('root');
  assert.equal(findAll(tree, has('data-tower-agent', 'R:reviewer'))[0].props['aria-pressed'], true);
  assert.equal(findAll(tree, has('data-tower-agent', 'W:worker'))[0].props['aria-pressed'], false);
  assert.equal(JSON.parse(storage.store.get(sessionKey('root'))).selected, 'r-failed');
  assert.equal(JSON.parse(storage.store.get(sessionKey('other'))).selected, 'w-failed');

  // with no records at all, a switch lands exactly on the historical defaults
  const bare = attentionHarness();
  const bareAt = (sessionId) => bare.render(sessionId, 'root', surface, 'bare');
  bareAt('root');
  bareAt('solo');
  const solo = bareAt('solo');
  assert.deepEqual(pressedMap(solo, 'data-tower-view-button'), { missions: false, agents: true });
  assert.deepEqual(pressedMap(solo, 'data-tower-scope-button'), { session: true, workspace: false });
});

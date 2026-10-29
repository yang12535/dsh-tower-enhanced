import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { sampleTowerState } from './projection.test.js';

// Panel-preference persistence across unmounts (tab switches): the module
// memory cache (tier a) plus best-effort localStorage under the
// `dsh-tower:prefs:v2` namespace (tier b). Same vm technique as
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
const rowOf = (tree, id) => findAll(tree, has('data-mission-id', id))[0];
const toggleOf = (tree, id) => findAll(tree, has('data-mission-toggle', id))[0];
const usageOf = (tree) => findAll(tree, has('data-tower-usage', true))[0];
const mineBox = (tree) => findAll(tree, has('data-tower-mine', true))[0];
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
// Every getItem attempt is recorded in `reads` — including the ones that
// throw — so tests can assert against real storage traffic (how many reads,
// against which keys) rather than against function-call bookkeeping.
// setItem stays unrecorded; writes are already observable via `store`.
function fakeStorage({ throws = false } = {}) {
  const store = new Map();
  const reads = [];
  return {
    store,
    reads,
    getItem(key) { reads.push(key); if (throws) throw new Error('SecurityError: storage denied'); return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { if (throws) throw new Error('QuotaExceededError: quota exceeded'); store.set(key, String(value)); },
  };
}

const GLOBAL_KEY = 'dsh-tower:prefs:v2:global';
const sessionKey = (sessionId) => `dsh-tower:prefs:v2:session:${sessionId}`;
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

// Two open missions with one failed agent each, so the open filter, row
// expansion, and selection are all observable at once.
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

// Expand one row and open its agent's chat, re-rendering between the clicks
// like a user would (each handler closes over the render it came from).
function openAgentOf(h, missionId, agentId, sessionId = 'root', at = () => h.render(sessionId)) {
  let tree = at();
  if (rowOf(tree, missionId).props['data-expanded'] !== true) {
    toggleOf(tree, missionId).props.onClick();
    tree = at();
  }
  findAll(tree, has('data-tower-agent', agentId))[0].props.onClick();
  return at();
}

test('first mount without any record shows the defaults', () => {
  // absent storage, empty storage, and storage that throws on access:
  // nothing saved means nothing restored, in every world
  for (const storage of [null, fakeStorage(), fakeStorage({ throws: true })]) {
    const h = harness(sampleTowerState(), { storage });
    const tree = h.render('root');
    assert.equal(mineBox(tree).props.checked, false, String(storage));
    assert.deepEqual(pressedMap(tree, 'data-tower-filter'), { all: true, merged: false });
    assert.equal(rowOf(tree, 'M1').props['data-expanded'], false);
    assert.deepEqual(agents(tree), []);
    assert.equal(findAll(tree, has('data-history-toggle', true))[0].props['aria-expanded'], true);
    assert.equal(usageOf(tree).props['data-usage-collapsed'], false);
    assert.equal(h.frames.size(), 0, 'no scroll to restore, no frame scheduled');
  }
});

test('a saved record restores filter, folds, expanded rows, and selection on the first render', () => {
  const storage = seed(fakeStorage(), {
    global: { mine: true, filter: 'open', usageCollapsed: true },
    sessions: { root: { expanded: ['W'], selected: 'w-failed' } },
  });
  const h = attentionHarness({ storage });
  // The lazy initial values mean the very FIRST render is already restored —
  // there is no default-render-then-overwrite flash to wait out.
  const tree = h.render('root');
  assert.equal(mineBox(tree).props.checked, true);
  assert.deepEqual(pressedMap(tree, 'data-tower-filter'), { all: false, open: true });
  assert.equal(rowOf(tree, 'W').props['data-expanded'], true);
  assert.equal(rowOf(tree, 'R').props['data-expanded'], false);
  assert.equal(findAll(tree, has('data-tower-agent', 'W:worker'))[0].props['aria-pressed'], true);
  assert.equal(findAll(tree, has('data-agent-session', 'w-failed'))[0].props['data-selected'], true);
  assert.match(textOf(findAll(tree, has('data-agent-session', 'w-failed'))[0]), /已打开/);
  assert.equal(usageOf(tree).props['data-usage-collapsed'], true);

  // records of the earlier v1 layout are not read at all
  const legacy = fakeStorage();
  legacy.setItem('dsh-tower:prefs:v1:global', JSON.stringify({ view: 'missions', filter: 'attention' }));
  const fresh = harness(sampleTowerState(), { storage: legacy }).render('root');
  assert.deepEqual(pressedMap(fresh, 'data-tower-filter'), { all: true, merged: false });
  assert.deepEqual(legacy.reads, [GLOBAL_KEY, sessionKey('root')]);
});

test('a selected id that no longer exists degrades to no selection', () => {
  const storage = seed(fakeStorage(), { sessions: { root: { expanded: ['M1'], selected: 'ghost-child' } } });
  const h = harness(sampleTowerState(), { storage });
  const tree = h.render('root');
  // every link renders unselected — the dangling id behaves exactly like null
  for (const id of ['M1:worker', 'M1:reviewer']) {
    assert.equal(findAll(tree, has('data-tower-agent', id))[0].props['aria-pressed'], false);
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

// The interaction sequence both remount tests replay: open filter, expand R
// and open its reviewer, fold the usage ranking.
function interact(h) {
  let tree = h.render('root');
  findAll(tree, has('data-tower-filter', 'open'))[0].props.onClick();
  openAgentOf(h, 'R', 'R:reviewer');
  tree = h.render('root');
  findAll(tree, has('data-usage-toggle', true))[0].props.onClick();
  h.render('root');
}

test('remount after a tab switch restores state through localStorage', () => {
  const storage = fakeStorage();
  const first = attentionHarness({ storage });
  interact(first);
  first.unmount('root');
  // the two records landed under the documented namespace, split as specified
  assert.deepEqual(JSON.parse(storage.store.get(GLOBAL_KEY)), {
    mine: false, filter: 'open', historyCollapsed: false, usageCollapsed: true,
  });
  assert.deepEqual(JSON.parse(storage.store.get(sessionKey('root'))), { expanded: ['R'], selected: 'r-failed', scrollTop: null });
  // a fresh module load (what a new page would see) has an empty memory
  // cache, so restoration here can only come from localStorage
  const second = attentionHarness({ storage });
  const restored = second.render('root');
  assert.deepEqual(pressedMap(restored, 'data-tower-filter'), { all: false, open: true });
  assert.equal(rowOf(restored, 'R').props['data-expanded'], true);
  assert.equal(rowOf(restored, 'W').props['data-expanded'], false);
  assert.equal(findAll(restored, has('data-tower-agent', 'R:reviewer'))[0].props['aria-pressed'], true);
  assert.equal(usageOf(restored).props['data-usage-collapsed'], true);
});

test('remount restores through the in-memory cache when storage throws or is absent', () => {
  for (const storage of [fakeStorage({ throws: true }), null]) {
    const h = attentionHarness({ storage });
    interact(h);
    h.unmount('root');
    // tier a alone restores everything
    const restored = h.render('root');
    assert.deepEqual(pressedMap(restored, 'data-tower-filter'), { all: false, open: true });
    assert.equal(rowOf(restored, 'R').props['data-expanded'], true);
    assert.equal(findAll(restored, has('data-tower-agent', 'R:reviewer'))[0].props['aria-pressed'], true);
    assert.equal(usageOf(restored).props['data-usage-collapsed'], true);
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
  assert.deepEqual(JSON.parse(storage.store.get(sessionKey('root'))), { expanded: null, selected: null, scrollTop: 240 });
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
  const p2node = scrollerOf(page2.render('root')).props.ref.current;
  assert.equal(page2.frames.size(), 1);
  page2.frames.flush();
  assert.equal(p2node.scrollTop, 240);
});

test('a throwing or missing localStorage never crashes the panel', () => {
  const storage = fakeStorage({ throws: true });
  const h = harness(sampleTowerState(), { storage });
  let tree;
  assert.doesNotThrow(() => { tree = h.render('root'); });
  assert.deepEqual(pressedMap(tree, 'data-tower-filter'), { all: true, merged: false });
  // interactions write through the memory tier even while storage throws
  assert.doesNotThrow(() => {
    findAll(tree, has('data-tower-filter', 'merged'))[0].props.onClick();
    tree = h.render('root');
    const scroller = scrollerOf(tree);
    scroller.props.ref.current.scrollTop = 77;
    scroller.props.onScroll();
    h.frames.flush();
  });
  assert.equal(storage.store.size, 0);
  h.unmount('root');
  // and the memory tier alone brings both the filter and the scroll back
  const restored = h.render('root');
  assert.deepEqual(pressedMap(restored, 'data-tower-filter'), { all: false, merged: true });
  h.frames.flush();
  assert.equal(scrollerOf(restored).props.ref.current.scrollTop, 77);
});

test('switching sessions keeps per-session rows and selection and shares the global preferences', () => {
  const storage = fakeStorage();
  const h = attentionHarness({ storage });
  // one mounted panel instance (fixed path) that changes its session prop
  const surface = 'sidebar.right.pane.tab';
  const at = (sessionId) => h.render(sessionId, 'root', surface, 'panel');
  findAll(at('root'), has('data-tower-filter', 'open'))[0].props.onClick();
  openAgentOf(h, 'R', 'R:reviewer', 'root', () => at('root'));
  // the switch itself renders once with the old state, then the effect
  // reloads: a session without its own record starts collapsed and
  // unselected while the global filter follows
  at('other');
  let tree = at('other');
  assert.deepEqual(pressedMap(tree, 'data-tower-filter'), { all: false, open: true });
  assert.equal(rowOf(tree, 'R').props['data-expanded'], false);
  assert.deepEqual(agents(tree), []);
  // the other session builds its own record
  openAgentOf(h, 'W', 'W:worker', 'other', () => at('other'));
  // switching back restores root's own rows and selection
  at('root');
  tree = at('root');
  assert.equal(rowOf(tree, 'R').props['data-expanded'], true);
  assert.equal(rowOf(tree, 'W').props['data-expanded'], false);
  assert.equal(findAll(tree, has('data-tower-agent', 'R:reviewer'))[0].props['aria-pressed'], true);
  assert.deepEqual(JSON.parse(storage.store.get(sessionKey('root'))), { expanded: ['R'], selected: 'r-failed', scrollTop: null });
  assert.deepEqual(JSON.parse(storage.store.get(sessionKey('other'))), { expanded: ['W'], selected: 'w-failed', scrollTop: null });

  // with no records at all, a switch lands exactly on the defaults
  const bare = attentionHarness();
  const bareAt = (sessionId) => bare.render(sessionId, 'root', surface, 'bare');
  bareAt('root');
  bareAt('solo');
  const solo = bareAt('solo');
  assert.equal(mineBox(solo).props.checked, false);
  assert.deepEqual(pressedMap(solo, 'data-tower-filter'), { all: true, open: false });
});

// The snapshot load: one loadPanelPrefs per sessionId shared by every lazy
// initializer and both [sessionId] effects, counted as real getItem calls
// against fakeStorage.reads so the assertions pin both the count and the keys.
test('a first mount reads storage exactly twice: the global record then the session record', () => {
  const storage = seed(fakeStorage(), {
    global: { filter: 'open', usageCollapsed: true },
    sessions: { root: { expanded: ['W'], selected: 'w-failed', scrollTop: 123 } },
  });
  const h = attentionHarness({ storage });
  const tree = h.render('root');
  // the one snapshot really fed the first render
  assert.deepEqual(pressedMap(tree, 'data-tower-filter'), { all: false, open: true });
  assert.equal(rowOf(tree, 'W').props['data-expanded'], true);
  // exactly two reads — one per persisted record — in loadPanelPrefs order
  assert.deepEqual(storage.reads, [GLOBAL_KEY, sessionKey('root')]);
  // the same snapshot also carries scrollTop: the restore frame is scheduled
  // without any further read and applies after the flush
  assert.equal(h.frames.size(), 1);
  h.frames.flush();
  assert.equal(scrollerOf(tree).props.ref.current.scrollTop, 123);
  // ordinary re-renders and interactions reuse the snapshot: no new read
  h.render('root');
  findAll(h.render('root'), has('data-tower-filter', 'all'))[0].props.onClick();
  assert.deepEqual(pressedMap(h.render('root'), 'data-tower-filter'), { all: true, open: false });
  assert.deepEqual(storage.reads, [GLOBAL_KEY, sessionKey('root')]);
});

test('switching sessions adds exactly one new global+session read pair', () => {
  const storage = seed(fakeStorage(), {
    sessions: { root: { expanded: ['R'], selected: 'r-failed' }, other: { expanded: ['W'], selected: 'w-failed' } },
  });
  const h = attentionHarness({ storage });
  const surface = 'sidebar.right.pane.tab';
  const at = (sessionId) => h.render(sessionId, 'root', surface, 'panel');
  at('root');
  assert.deepEqual(storage.reads, [GLOBAL_KEY, sessionKey('root')]);
  // the switch loads the other session's own record: two reads only, and the
  // snapshot applied is really that session's (its own rows and selection)
  at('other');
  assert.deepEqual(storage.reads, [GLOBAL_KEY, sessionKey('root'), GLOBAL_KEY, sessionKey('other')]);
  let tree = at('other');
  assert.equal(findAll(tree, has('data-tower-agent', 'W:worker'))[0].props['aria-pressed'], true);
  assert.equal(rowOf(tree, 'R').props['data-expanded'], false);
  assert.deepEqual(storage.reads, [GLOBAL_KEY, sessionKey('root'), GLOBAL_KEY, sessionKey('other')]);
  // switching back is again exactly one new global+session pair
  at('root');
  assert.deepEqual(storage.reads, [
    GLOBAL_KEY, sessionKey('root'), GLOBAL_KEY, sessionKey('other'), GLOBAL_KEY, sessionKey('root'),
  ]);
  tree = at('root');
  assert.equal(findAll(tree, has('data-tower-agent', 'R:reviewer'))[0].props['aria-pressed'], true);
  assert.equal(rowOf(tree, 'W').props['data-expanded'], false);
});

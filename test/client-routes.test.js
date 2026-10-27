import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { commitFile, initializedCore, makeRepo } from './helpers.js';
import { sampleTowerState } from './projection.test.js';
import { towerProjectionDefinition, TOWER_RECORD_TYPE, deriveRouteUsage } from '../lib/projection.js';

// Route usage in the panel: the projection's read-only per-route aggregate
// (M64's `summary` routes, mirrored by `deriveRouteUsage`) surfaced as a
// collapsible table above the missions/agents views. The drift guard at the
// top is the load-bearing assertion: the panel may only ever agree with
// `tower summary`, so the projection derivation is compared field by field
// against core's own aggregate on one shared, real state.

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
const routesSection = (tree) => findAll(tree, withProp('data-tower-routes'))[0];
const routeRows = (tree) => findAll(tree, withProp('data-route-row'));
const routeCell = (row, field) => findAll(row, has('data-route-field', field))[0];

// Same vm technique as test/client-prefs.test.js: stubbed React/primitives,
// a fake localStorage, deterministic rAF, effect flushes, and an unmount that
// drops hook state like a real tab switch — the fold must survive all of it.
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
function fakeStorage() {
  const store = new Map();
  return {
    store,
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
  };
}
const GLOBAL_KEY = 'dsh-tower:prefs:v1:global';

function harness(tower = sampleTowerState(), { language = 'zh', storage = null, frames = frameClock() } = {}) {
  let definition, hookIndex, activeHooks;
  const hooks = new Map(), slots = new Map(), opened = [], catalog = new Map(), dictionaries = {};
  const pendingEffects = [];
  const rows = { root: { title: 'Controller A' } };
  const projections = { root: { values: { tower } } };
  const react = {
    useState(initial) {
      const index = hookIndex++, values = activeHooks;
      if (!(index in values)) values[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [values[index].value, (next) => { values[index].value = typeof next === 'function' ? next(values[index].value) : next; }];
    },
    useRef(initial) {
      const index = hookIndex++, values = activeHooks;
      if (!(index in values)) values[index] = { current: initial };
      return values[index];
    },
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
    requestAnimationFrame: (callback) => frames.request(callback),
    cancelAnimationFrame: (id) => frames.cancel(id),
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
  };
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
  function render(sessionId = 'root', parentId, surface = 'sidebar.right.pane.tab') {
    const slot = slots.get(surface);
    const props = {
      sessionId,
      useSession: (selector) => selector({ subagent: parentId ? { address: { parentSessionId: parentId } } : undefined }),
      useSessions: (selector) => selector({ phase: 'ready', byId: rows, projectionsBySession: projections }),
      t: services.locale.bind('tower-enhanced'), ...slot.meta.inject(),
    };
    const tree = expand(element(slot.component, props), `${surface}:${sessionId}`);
    flushEffects();
    return tree;
  }
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
  return { render, unmount, rows, catalog, projections, slots, services, module: exported, frames, storage };
}

// A mission carrying only the fields the table and the derivation read.
function routeMission(over = {}) {
  return {
    id: 'M1', title: 'Route mission', description: '', dependsOn: [], scope: [],
    branch: 'tower/m1', worktree: '/tmp/tower-panel/.dsh-tower/worktrees/m1',
    baseCommit: 'base-sha', status: 'pending', revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z', worktreeRemoved: false,
    worker: undefined, review: undefined, merge: undefined, ...over,
  };
}
function towerOf(missions) {
  const tower = sampleTowerState();
  tower.missions = missions;
  return tower;
}
// Minimal worker/review record for wire-view fixtures: `runId` is the only
// field the projection schema requires, the route fields stay optional.
const rec = (id, route = {}) => ({ runId: id, ...route });
// The wire view a real panel receives: the stored state plus the derived fields.
function wireView(state) {
  const applied = towerProjectionDefinition.apply(
    towerProjectionDefinition.init(),
    { type: TOWER_RECORD_TYPE, ignorable: true, data: { version: 1, state } },
  );
  assert.equal(applied.failure, null);
  return towerProjectionDefinition.wire.view(applied);
}

/** Spawn a worker with an optional route and walk it to a finished record. */
async function runWorker(core, options = {}) {
  const mission = options.mission ?? await core.addMission({ title: options.title ?? 'Implement feature', description: 'Implement and test the feature.' });
  const begun = await core.beginSpawn({
    missionId: mission.id,
    role: 'worker',
    ...(options.provider === undefined ? {} : { provider: options.provider, model: options.model }),
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
  });
  if (options.commit !== false) commitFile(begun.mission.worktree, `src/${mission.id}.txt`, 'implemented\n', 'worker implementation');
  await core.completeSpawn(begun.runId, { stopReason: 'completed', output: 'worker report' });
}

/** Spawn a reviewer with an optional route and let it record a clean verdict. */
async function runReviewer(core, missionId, route = {}) {
  const begun = await core.beginSpawn({ missionId, role: 'reviewer', ...route });
  await core.completeSpawn(begun.runId, {
    stopReason: 'completed',
    output: 'clean review',
    structured: { verdict: 'clean', merge: true, summary: 'clean', findings: [], checks: [] },
  });
}

test('deriveRouteUsage matches core summaryRoutes field by field on the same state', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  // Enough shapes that bucketing, counting, and every tie-break level run:
  // a shared busy route across two missions, provider+model with and without
  // an effort, an unrouted spawn (nulls), and a reviewer-only route. Each
  // mission gets at most one worker then one reviewer — a re-spawned worker
  // would clear the mission's review record (core's beginSpawn semantics).
  const busy = await core.addMission({ title: 'Busy', description: 'Worker and reviewer share this route.' });
  await runWorker(core, { mission: busy, title: 'Busy', provider: 'prov-busy', model: 'model-b', reasoningEffort: 'high' });
  await runReviewer(core, busy.id, { provider: 'prov-busy', model: 'model-b', reasoningEffort: 'high' });
  await runWorker(core, { title: 'Busy again', provider: 'prov-busy', model: 'model-b', reasoningEffort: 'high' });
  await runWorker(core, { title: 'Alpha', provider: 'prov-a', model: 'model-a' });
  await runWorker(core, { title: 'Effortless', provider: 'prov-a', model: 'model-a', reasoningEffort: 'low' });
  await runWorker(core, { title: 'Unrouted' });
  const reviewed = await core.addMission({ title: 'Reviewed', description: 'Reviewed mission.' });
  await runWorker(core, { mission: reviewed, title: 'Reviewed', provider: 'prov-w', model: 'model-w' });
  await runReviewer(core, reviewed.id, { provider: 'prov-r', model: 'model-r' });
  // Terminal missions count too — core's aggregate deliberately includes
  // merged and abandoned records (their runs consumed quota like any other).
  // The merged worker reuses the live busy route, so filtering terminal
  // missions would silently drop a count; the two reviewers own routes under
  // one provider with two different models, and the abandoned worker lands in
  // the null bucket shared with the pending Unrouted mission, so the same
  // filter would also vanish whole rows and shift null tie-breaks.
  const merged = await core.addMission({ title: 'Merged', description: 'Terminal mission that merged.' });
  await runWorker(core, { mission: merged, title: 'Merged', provider: 'prov-busy', model: 'model-b', reasoningEffort: 'high' });
  await runReviewer(core, merged.id, { provider: 'prov-merged', model: 'model-m2' });
  assert.equal((await core.merge(merged.id)).merged, true);
  const abandoned = await core.addMission({ title: 'Abandoned', description: 'Terminal mission that was dropped.' });
  await runWorker(core, { mission: abandoned, title: 'Abandoned' });
  await runReviewer(core, abandoned.id, { provider: 'prov-merged', model: 'model-m1' });
  await core.abandon(abandoned.id);

  const state = await core.store.read();
  // the fixture really reached both terminal states, records still attached
  assert.ok(state.missions.some((mission) => mission.status === 'merged' && mission.worker && mission.review), 'a merged mission with records exists');
  assert.ok(state.missions.some((mission) => mission.status === 'abandoned' && mission.worker && mission.review), 'an abandoned mission with records exists');
  const { routes } = await core.summary();
  assert.ok(routes.length >= 8, 'the scenario must exercise several buckets');
  const derived = deriveRouteUsage(state);
  // The anti-drift contract: same length, same order, and every field equal.
  assert.equal(derived.length, routes.length);
  for (let index = 0; index < derived.length; index++) {
    assert.deepEqual(Object.keys(derived[index]).sort(), ['model', 'provider', 'reasoningEffort', 'reviewerCount', 'total', 'workerCount'], `entry ${index} field set`);
    for (const field of ['provider', 'model', 'reasoningEffort', 'workerCount', 'reviewerCount', 'total']) {
      assert.deepEqual(derived[index][field], routes[index][field], `entry ${index} field ${field}`);
    }
  }
  // the busy route really did aggregate across missions, roles, and the
  // merged mission — dropping terminal records would read total 3 here
  assert.deepEqual(derived[0], { provider: 'prov-busy', model: 'model-b', reasoningEffort: 'high', workerCount: 3, reviewerCount: 1, total: 4 });
  // both terminal reviewers are present under their own provider/models
  assert.deepEqual(
    derived.filter((entry) => entry.provider === 'prov-merged'),
    [
      { provider: 'prov-merged', model: 'model-m1', reasoningEffort: null, workerCount: 0, reviewerCount: 1, total: 1 },
      { provider: 'prov-merged', model: 'model-m2', reasoningEffort: null, workerCount: 0, reviewerCount: 1, total: 1 },
    ],
  );
  // the abandoned worker's unrouted spawn joined the pending mission's nulls
  assert.deepEqual(derived.find((entry) => entry.provider === null), { provider: null, model: null, reasoningEffort: null, workerCount: 2, reviewerCount: 0, total: 2 });
  // The missions-array form derives the very same aggregate.
  assert.deepEqual(deriveRouteUsage(state.missions), routes);
  // The wire view publishes the same routes while the stored record stays verbatim.
  const view = wireView(state);
  assert.deepEqual(view.routes, routes);
  assert.equal('routes' in (await core.store.read()), false, 'the stored state never gains a routes field');
});

test('deriveRouteUsage buckets nulls and orders ties exactly like summaryRoutes', () => {
  const missions = [
    routeMission({ id: 'A', worker: { provider: 'prov-z', model: 'model-z' }, review: { provider: 'prov-z', model: 'model-z' } }),
    routeMission({ id: 'B', worker: {} }),
    routeMission({ id: 'C', worker: { provider: 'prov-a', model: 'model-s' } }),
    routeMission({ id: 'D', worker: { provider: 'prov-s', model: 'model-s', reasoningEffort: 'low' } }),
    routeMission({ id: 'E', worker: { provider: 'prov-s', model: 'model-s', reasoningEffort: 'high' } }),
    routeMission({ id: 'F', worker: { provider: 'prov-s', model: 'model-s' } }),
    // terminal missions contribute on every axis: the merged worker doubles a
    // live route, the abandoned worker doubles the null bucket, and the
    // abandoned reviewer adds a review count to a worker-only route —
    // filtering by status would shift counts, rows, and tie-breaks below
    routeMission({ id: 'G', status: 'merged', worker: { provider: 'prov-z', model: 'model-z' } }),
    routeMission({ id: 'H', status: 'abandoned', worker: {}, review: { provider: 'prov-a', model: 'model-s' } }),
  ];
  assert.deepEqual(deriveRouteUsage(missions), [
    { provider: 'prov-z', model: 'model-z', reasoningEffort: null, workerCount: 2, reviewerCount: 1, total: 3 },
    // null sorts before any string inside the total-2 tie group
    { provider: null, model: null, reasoningEffort: null, workerCount: 2, reviewerCount: 0, total: 2 },
    { provider: 'prov-a', model: 'model-s', reasoningEffort: null, workerCount: 1, reviewerCount: 1, total: 2 },
    { provider: 'prov-s', model: 'model-s', reasoningEffort: null, workerCount: 1, reviewerCount: 0, total: 1 },
    { provider: 'prov-s', model: 'model-s', reasoningEffort: 'high', workerCount: 1, reviewerCount: 0, total: 1 },
    { provider: 'prov-s', model: 'model-s', reasoningEffort: 'low', workerCount: 1, reviewerCount: 0, total: 1 },
  ]);
  // degenerate inputs stay safe: no missions, no records, nothing to count
  assert.deepEqual(deriveRouteUsage([]), []);
  assert.deepEqual(deriveRouteUsage({ missions: [] }), []);
  assert.deepEqual(deriveRouteUsage(undefined), []);
});

test('the route table renders at most 8 sorted rows and folds the tail into +N', () => {
  // One heavy route (total 3), one unrouted bucket, and eight distinct
  // single-run routes: 10 buckets, 8 rows, 2 folded.
  const missions = [
    routeMission({ id: 'A', worker: rec('wa', { provider: 'prov-heavy', model: 'model-h', reasoningEffort: 'high' }), review: rec('ra', { provider: 'prov-heavy', model: 'model-h', reasoningEffort: 'high' }) }),
    routeMission({ id: 'B', worker: rec('wb', { provider: 'prov-heavy', model: 'model-h', reasoningEffort: 'high' }) }),
    routeMission({ id: 'D', worker: rec('wd') }),
    ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'].map((suffix) => routeMission({
      id: `M-${suffix}`, worker: rec(`w-${suffix}`, { provider: `prov-${suffix}`, model: `model-${suffix}` }),
    })),
  ];
  const tower = wireView(towerOf(missions));
  assert.equal(tower.routes.length, 10);
  const tree = harness(tower).render();
  const section = routesSection(tree);
  assert.ok(section, 'the section renders when routes exist');
  assert.equal(section.props['data-routes-collapsed'], false);
  const rows = routeRows(tree);
  assert.equal(rows.length, 8, 'at most 8 rows render');
  // rows follow the projection order: total descending, then the tie-breaks
  assert.deepEqual(rows.map((row) => row.props['data-route-total']), [3, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(textOf(routeCell(rows[0], 'provider')), 'prov-heavy');
  assert.equal(textOf(routeCell(rows[0], 'model')), 'model-h');
  assert.equal(textOf(routeCell(rows[0], 'reasoningEffort')), 'high');
  assert.deepEqual(
    rows.slice(1).map((row) => textOf(routeCell(row, 'provider'))),
    [null, 'prov-c1', 'prov-c2', 'prov-c3', 'prov-c4', 'prov-c5', 'prov-c6'].map((provider) => (provider === null ? '—' : provider)),
  );
  // the unrouted bucket shows the dash placeholder, never an invented value
  assert.equal(textOf(routeCell(rows[1], 'provider')), '—');
  assert.equal(textOf(routeCell(rows[1], 'model')), '—');
  assert.equal(textOf(routeCell(rows[1], 'reasoningEffort')), '—');
  // the two lightest routes folded away
  const overflow = findAll(tree, withProp('data-route-overflow'))[0];
  assert.equal(overflow.props['data-route-overflow'], 2);
  assert.match(textOf(overflow), /\+2/);
  assert.doesNotMatch(textOf(section), /prov-c7|prov-c8/);
  assert.equal(rows.at(-1).props['data-route-row'], 7);
});

test('an empty or absent routes aggregate renders no section at all', () => {
  // no worker/review records → no routes → nothing, not even an empty table
  const empty = harness(wireView(towerOf([routeMission({})])));
  assert.equal(routesSection(empty.render()), undefined);
  assert.equal(routeRows(empty.render()).length, 0);
  // a projection that predates the field degrades to no section
  const legacy = harness(towerOf([routeMission({ worker: rec('w', { provider: 'p', model: 'm' }) })]));
  assert.equal(routesSection(legacy.render()), undefined);
  // an explicit empty array behaves the same
  const blank = harness({ ...sampleTowerState(), routes: [] });
  assert.equal(routesSection(blank.render()), undefined);
});

test('route table copy is localized in zh and en', () => {
  const missions = [
    routeMission({ id: 'A', worker: rec('wa', { provider: 'prov-a', model: 'model-a' }), review: rec('ra', { provider: 'prov-a', model: 'model-a' }) }),
    ...['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9'].map((suffix) => routeMission({
      id: `M-${suffix}`, worker: rec(`w-${suffix}`, { provider: `prov-${suffix}`, model: `model-${suffix}` }),
    })),
  ];
  for (const [language, title, headers, more] of [
    ['zh', '路由用量', ['服务商', '模型', '推理强度', 'Worker', 'Reviewer', '总计'], '+2 条路由'],
    ['en', 'Route usage', ['Provider', 'Model', 'Effort', 'Worker', 'Reviewer', 'Total'], '+2 more routes'],
  ]) {
    const tree = harness(wireView(towerOf(missions)), { language }).render();
    const section = routesSection(tree);
    assert.match(textOf(section), new RegExp(title), language);
    assert.deepEqual(
      findAll(section, withProp('data-route-column')).map((cell) => textOf(cell)),
      headers,
      language,
    );
    assert.equal(textOf(findAll(tree, withProp('data-route-overflow'))[0]), more, language);
    // the header count reports the full bucket count, folded rows included
    assert.match(textOf(section), /10/);
  }
});

test('the routes section collapses, persists the fold, and survives a remount', () => {
  const storage = fakeStorage();
  const tower = wireView(towerOf([
    routeMission({ id: 'A', worker: rec('wa', { provider: 'prov-a', model: 'model-a' }), review: rec('ra', { provider: 'prov-r', model: 'model-r' }) }),
  ]));
  const h = harness(tower, { storage });
  let tree = h.render();
  let section = routesSection(tree);
  assert.equal(section.props['data-routes-collapsed'], false);
  assert.equal(findAll(tree, withProp('data-routes-toggle'))[0].props['aria-expanded'], true);
  assert.ok(findAll(tree, withProp('data-route-row')).length > 0, 'expanded shows the table');
  // fold it: header stays, table and overflow note go away
  findAll(tree, withProp('data-routes-toggle'))[0].props.onClick();
  tree = h.render();
  section = routesSection(tree);
  assert.equal(section.props['data-routes-collapsed'], true);
  assert.equal(findAll(tree, withProp('data-routes-toggle'))[0].props['aria-expanded'], false);
  assert.equal(findAll(tree, withProp('data-route-row')).length, 0);
  assert.equal(findAll(tree, withProp('data-route-overflow')).length, 0);
  // the fold landed in the global prefs record under its own key
  const record = JSON.parse(storage.store.get(GLOBAL_KEY));
  assert.equal(record.routesCollapsed, true);
  assert.deepEqual(record.collapsed, [], 'the per-role-group collapsed key keeps its own semantics');
  // a tab switch (unmount/remount) restores the fold
  h.unmount('root');
  let remounted = h.render('root');
  assert.equal(routesSection(remounted).props['data-routes-collapsed'], true);
  assert.equal(routeRows(remounted).length, 0);
  // a fresh module load (new page) restores it from storage on first render
  const page2 = harness(tower, { storage });
  const first = page2.render('root');
  assert.equal(routesSection(first).props['data-routes-collapsed'], true, 'no expand-then-collapse flash');
  // expanding again updates the same record
  findAll(remounted, withProp('data-routes-toggle'))[0].props.onClick();
  remounted = h.render('root');
  assert.equal(routesSection(remounted).props['data-routes-collapsed'], false);
  assert.ok(routeRows(remounted).length > 0);
  assert.equal(JSON.parse(storage.store.get(GLOBAL_KEY)).routesCollapsed, false);
});

test('the panel consumes the wire view end to end and shows routes above both views', () => {
  const state = towerOf([
    routeMission({ id: 'M1', worker: rec('w1', { provider: 'prov-a', model: 'model-a' }) }),
    routeMission({ id: 'M2', worker: rec('w2', { provider: 'prov-b', model: 'model-b' }) }),
  ]);
  const view = wireView(state);
  assert.deepEqual(view.routes, deriveRouteUsage(state.missions));
  const h = harness(view);
  const agents = h.render();
  assert.ok(routesSection(agents), 'visible in the agents view');
  assert.equal(routeRows(agents).length, 2);
  // flipping to the missions view keeps the section in place
  findAll(agents, has('data-tower-view-button', 'missions'))[0].props.onClick();
  const missions = h.render();
  assert.ok(routesSection(missions), 'still visible in the missions view');
  assert.equal(routeRows(missions).length, 2);
  // routes render even when no agent has a session (records without childId)
  assert.equal(findAll(missions, withProp('data-tower-agent')).length, 0);
});

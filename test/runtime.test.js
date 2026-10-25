import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, inject, name } from '../lib/index.js';
import { TowerRuntime } from '../lib/runtime.js';
import { initializedCore, makeRepo } from './helpers.js';

function routeContext(resolved = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      llm: {
        async resolveCallConfig(config) {
          calls.push(config);
          return { ...config, ...resolved };
        },
      },
    },
  };
}

const parent = {
  options: { provider: 'main-provider', model: 'main-smart', reasoningEffort: 'high', maxTokens: 4096 },
  session: { requestHeader: () => undefined },
};

test('role defaults select a different worker model and clear inherited route effort', async () => {
  const { ctx, calls } = routeContext();
  const runtime = new TowerRuntime(ctx, {
    allowedModels: [{ provider: 'worker-provider', model: 'worker-fast' }],
    workerAgentOptions: { provider: 'worker-provider', model: 'worker-fast' },
  });
  const selected = await runtime.resolveRoute(parent, 'worker', {}, new AbortController().signal);
  assert.equal(selected.route.provider, 'worker-provider');
  assert.equal(selected.route.model, 'worker-fast');
  assert.equal(selected.agentOptions.reasoningEffort, undefined);
  assert.equal(selected.agentOptions.maxTokens, undefined);
  assert.deepEqual(calls, [{ provider: 'worker-provider', model: 'worker-fast' }]);
});

test('per-spawn route and effort are validated against the allowlist', async () => {
  const { ctx, calls } = routeContext({ reasoningEffort: 'low' });
  const runtime = new TowerRuntime(ctx, { allowedModels: [{ provider: 'secondary', model: 'fast' }] });
  const selected = await runtime.resolveRoute(parent, 'reviewer', { provider: 'secondary', model: 'fast', reasoning_effort: 'low', max_tokens: 1024 }, new AbortController().signal);
  assert.deepEqual(selected.agentOptions, { provider: 'secondary', model: 'fast', reasoningEffort: 'low', maxTokens: 1024 });
  assert.deepEqual(calls, [{ provider: 'secondary', model: 'fast', reasoningEffort: 'low' }]);
  await assert.rejects(runtime.resolveRoute(parent, 'worker', { provider: 'other', model: 'unapproved' }, new AbortController().signal), /not in tower.allowedModels/);
});

test('no override preserves the current request route without a preflight call', async () => {
  const { ctx, calls } = routeContext();
  const runtime = new TowerRuntime(ctx, {});
  const current = {
    ...parent,
    options: { provider: 'stale', model: 'old', reasoningEffort: 'high' },
    session: { requestHeader: () => ({ config: { provider: 'main-provider', model: 'main-smart', reasoningEffort: 'high' } }) },
  };
  const selected = await runtime.resolveRoute(current, 'worker', {}, new AbortController().signal);
  assert.equal(selected.agentOptions, undefined);
  assert.deepEqual(selected.route, { provider: 'main-provider', model: 'main-smart', reasoningEffort: 'high' });
  assert.equal(calls.length, 0);
});

test('an explicit route does not inherit the configured default route effort', async () => {
  const { ctx, calls } = routeContext();
  const runtime = new TowerRuntime(ctx, {
    allowedModels: [{ provider: 'default', model: 'fast' }, { provider: 'other', model: 'new' }],
    workerAgentOptions: { provider: 'default', model: 'fast', reasoningEffort: 'high' },
  });
  const selected = await runtime.resolveRoute(parent, 'worker', { provider: 'other', model: 'new' }, new AbortController().signal);
  assert.equal(selected.agentOptions.reasoningEffort, undefined);
  assert.deepEqual(calls, [{ provider: 'other', model: 'new' }]);
});

test('provider and model must be supplied together', async () => {
  const runtime = new TowerRuntime(routeContext().ctx, {});
  await assert.rejects(runtime.resolveRoute(parent, 'worker', { provider: 'secondary' }, new AbortController().signal), /supplied together/);
  await assert.rejects(runtime.resolveRoute(parent, 'worker', { max_tokens: 0 }, new AbortController().signal), /positive safe integer/);
});

function spawnHarness(attachSpawn) {
  const lifecycle = { disposeCalls: 0, failCalls: 0, activation: undefined };
  let settleResult;
  const activation = {
    childId: 'child-run',
    result: new Promise((resolve) => { settleResult = resolve; }),
    async dispose() { lifecycle.disposeCalls += 1; },
  };
  lifecycle.settle = (value) => settleResult(value);
  const ctx = {
    ...routeContext().ctx,
    subagents: { startActivation: async () => activation },
    logger: { warn() {} },
  };
  const runtime = new TowerRuntime(ctx, {});
  const core = {
    async mission() { return { id: 'M1', title: 'Mission', description: 'Work', scope: [] }; },
    async beginSpawn() {
      return { runId: 'run-1', mission: { id: 'M1', title: 'Mission', description: 'Work', scope: [], worktree: '/tmp', status: 'worker_running' } };
    },
    attachSpawn,
    async failSpawn() { lifecycle.failCalls += 1; return { status: 'worker_failed' }; },
  };
  const agent = { ...parent, id: 'parent', session: { header: {}, requestHeader: () => undefined } };
  lifecycle.activation = activation;
  return { runtime, core, agent, lifecycle };
}

test('a fulfilled activation is disposed when attach fails', async () => {
  const { runtime, core, agent, lifecycle } = spawnHarness(async () => { throw new Error('attach failed'); });
  await assert.rejects(runtime.spawn(core, agent, { role: 'worker', mission_id: 'M1' }, new AbortController().signal), /attach failed/);
  assert.equal(lifecycle.disposeCalls, 1);
  assert.equal(lifecycle.failCalls, 1);
});

test('dispose during attach cannot leak a late published activation', async () => {
  let finishAttach;
  const { runtime, core, agent, lifecycle } = spawnHarness(() => new Promise((resolve) => { finishAttach = resolve; }));
  const pending = runtime.spawn(core, agent, { role: 'worker', mission_id: 'M1' }, new AbortController().signal);
  const rejection = assert.rejects(pending, /disposed/);
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.dispose();
  finishAttach();
  await rejection;
  assert.equal(lifecycle.disposeCalls, 1);
  assert.equal(runtime.active.size, 0);
});

test('settled activation records completion, cleans up, and emits a runtime notice', async () => {
  const { runtime, core, agent, lifecycle } = spawnHarness(async () => undefined);
  const completions = [];
  core.completeSpawn = async (_runId, result) => {
    completions.push(result);
    return { status: 'worker_completed' };
  };
  const notices = [];
  agent.steer = (message) => notices.push(message);
  const started = await runtime.spawn(core, agent, { role: 'worker', mission_id: 'M1' }, new AbortController().signal);
  const entry = runtime.active.get(started.runId);
  lifecycle.settle({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] });
  await entry.done;
  assert.equal(completions.length, 1);
  assert.equal(completions[0].output, 'done');
  assert.equal(runtime.active.size, 0);
  assert.equal(lifecycle.disposeCalls, 1);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].source.kind, 'subagent-settled');
  assert.equal(notices[0].source.form, 'notice');
  assert.equal(notices[0].source.senderSessionId, 'child-run');
  assert.match(notices[0].source.summary, /worker_completed/);
});

test('bundle registers the tower tool and owned runtime effect', () => {
  const registrations = [];
  const effects = [];
  const ctx = {
    root: { sessionProjections: { register: () => () => undefined } },
    tools: { register(definition) { registrations.push(definition); return () => undefined; } },
    effect(disposer, label) { effects.push({ disposer, label }); },
  };
  apply(ctx, {});
  assert.equal(name, 'tower-enhanced');
  assert.deepEqual(inject, ['tools', 'subagents', 'workingDirectory', 'llm', 'sessions', 'sessionProjections']);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, 'tower');
  assert.equal(registrations[0].parameters.properties.action.enum.includes('spawn'), true);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].label, 'tower-enhanced.runtime');
});

function executeHarness(repo) {
  const ctx = {
    workingDirectory: { async ensure() { return repo; } },
    sessions: { async flush() {} },
    llm: { async resolveCallConfig(config) { return config; } },
    subagents: {},
    logger: { warn() {} },
  };
  return { ctx, runtime: new TowerRuntime(ctx, {}) };
}

function sessionAgent(id, parentSession) {
  return {
    ...parent,
    session: {
      id,
      header: parentSession === undefined ? {} : { parentSession },
      requestHeader: () => undefined,
    },
  };
}

test('a delegated Session may own a workspace tower (membership is per workspace)', async (t) => {
  const repo = makeRepo(t);
  await initializedCore(repo);
  const { runtime } = executeHarness(repo);
  const result = await runtime.execute({ action: 'status' }, { agent: sessionAgent('child-session', 'root-session'), signal: new AbortController().signal });
  assert.equal(result.baseBranch, 'main');
});

test('a second Session is refused only while another owns the workspace', async (t) => {
  const repo = makeRepo(t);
  await initializedCore(repo);
  const { runtime } = executeHarness(repo);
  runtime.inFlight.set(repo, 'owner-session');
  await assert.rejects(
    runtime.execute({ action: 'status' }, { agent: sessionAgent('other-session'), signal: new AbortController().signal }),
    /another Session \(owner-session\) owns this workspace tower/,
  );
  // The owner itself continues normally, and an idle workspace is free again.
  const ownerResult = await runtime.execute({ action: 'status' }, { agent: sessionAgent('owner-session'), signal: new AbortController().signal });
  assert.equal(ownerResult.baseBranch, 'main');
  runtime.inFlight.delete(repo);
  runtime.active.set('run-1', { core: { store: { repoRoot: repo } }, parent: { session: { id: 'busy-session' } } });
  await assert.rejects(
    runtime.execute({ action: 'status' }, { agent: sessionAgent('another-session'), signal: new AbortController().signal }),
    /busy-session/,
  );
  runtime.active.delete('run-1');
  const free = await runtime.execute({ action: 'status' }, { agent: sessionAgent('another-session'), signal: new AbortController().signal });
  assert.equal(free.baseBranch, 'main');
});

test('a refused call finishes without touching repository state', async (t) => {
  const repo = makeRepo(t);
  await initializedCore(repo);
  const { runtime } = executeHarness(repo);
  runtime.inFlight.set(repo, 'owner-session');
  await assert.rejects(
    runtime.execute({ action: 'add', id: 'M9', title: 'blocked', description: 'must not be written' }, { agent: sessionAgent('intruder'), signal: new AbortController().signal }),
    /WORKSPACE_BUSY|owns this workspace tower/,
  );
  const core = await runtime.coreAt(repo, new AbortController().signal);
  const state = await core.status({ observe: false });
  assert.deepEqual(state.missions.map((mission) => mission.id), []);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, inject, name } from '../lib/index.js';
import { TowerRuntime } from '../lib/runtime.js';
import { TowerError } from '../lib/errors.js';
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

function catalogHarness(options = {}) {
  const calls = { listProviders: 0, listModels: [], resolveModelInfo: [], resolveCallConfig: [] };
  const ctx = {
    llm: {
      listProviders() {
        calls.listProviders += 1;
        return (options.providers ?? []).map((info) => ({ ...info }));
      },
      async listModels(provider) {
        calls.listModels.push(provider);
        const catalog = (options.catalogs ?? {})[provider];
        if (catalog instanceof Error) throw catalog;
        if (catalog === undefined) {
          const missing = new Error(`no adapter registered for provider "${provider}"`);
          missing.code = 'NO_ADAPTER';
          throw missing;
        }
        return catalog.map((model) => ({ ...model }));
      },
      async resolveModelInfo(provider, model) {
        calls.resolveModelInfo.push({ provider, model });
        const info = (options.exact ?? {})[model];
        if (info instanceof Error) throw info;
        return { ...info };
      },
      async resolveCallConfig(config) {
        calls.resolveCallConfig.push(config);
        return { ...config };
      },
    },
  };
  return { ctx, calls, runtime: new TowerRuntime(ctx, options.config ?? {}) };
}

function runModels(runtime, args = {}) {
  return runtime.execute({ action: 'models', ...args }, { agent: sessionAgent('controller-session'), signal: new AbortController().signal });
}

test('models without a provider aggregates every registered catalog in stable order', async () => {
  const { runtime, calls } = catalogHarness({
    providers: [
      { id: 'zai-coding-cn', name: 'ZAI Coding (CN)' },
      { id: 'deepseek-official', name: 'DeepSeek Official' },
      { id: 'kimi-coding', name: 'Kimi Coding' },
    ],
    catalogs: {
      'zai-coding-cn': [
        { provider: 'zai-coding-cn', id: 'glm-5.3-air', name: 'GLM 5.3 Air' },
        { provider: 'zai-coding-cn', id: 'glm-5.3', name: 'GLM 5.3', inputModalities: ['text'] },
      ],
      'deepseek-official': [
        { provider: 'deepseek-official', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
        { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat', description: 'General chat model' },
      ],
      'kimi-coding': [
        { provider: 'kimi-coding', id: 'kimi-k2', name: 'Kimi K2' },
      ],
    },
    config: { allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-chat' }] },
  });
  const result = await runModels(runtime);
  // Providers sort by route ascending; the parent's own route must not narrow the listing.
  assert.deepEqual(result.providers.map((entry) => entry.provider), ['deepseek-official', 'kimi-coding', 'zai-coding-cn']);
  assert.deepEqual(result.providers.map((entry) => entry.name), ['DeepSeek Official', 'Kimi Coding', 'ZAI Coding (CN)']);
  // Models sort by id ascending and keep only the fields the adapter disclosed.
  assert.deepEqual(result.providers[0].models, [
    { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat', description: 'General chat model' },
    { provider: 'deepseek-official', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
  ]);
  assert.deepEqual(result.providers[2].models, [
    { provider: 'zai-coding-cn', id: 'glm-5.3', name: 'GLM 5.3', inputModalities: ['text'] },
    { provider: 'zai-coding-cn', id: 'glm-5.3-air', name: 'GLM 5.3 Air' },
  ]);
  assert.deepEqual(result.providers.map((entry) => entry.truncated), [false, false, false]);
  assert.equal('provider' in result, false);
  assert.equal('models' in result, false);
  assert.deepEqual(result.allowedModels, [{ provider: 'deepseek-official', model: 'deepseek-chat' }]);
  // The catalog walk must not resolve each advertised model's route.
  assert.equal(calls.listProviders, 1);
  assert.deepEqual(calls.resolveModelInfo, []);
  assert.deepEqual(calls.resolveCallConfig, []);
});

test('models aggregation truncates each provider catalog at 100 entries', async () => {
  const wide = Array.from({ length: 105 }, (_, index) => ({ provider: 'wide', id: `wide-${String(104 - index).padStart(3, '0')}`, name: `Wide ${104 - index}` }));
  const { runtime } = catalogHarness({
    providers: [
      { id: 'wide', name: 'Wide Provider' },
      { id: 'narrow', name: 'Narrow Provider' },
    ],
    catalogs: {
      wide,
      narrow: [
        { provider: 'narrow', id: 'narrow-2', name: 'Narrow 2' },
        { provider: 'narrow', id: 'narrow-1', name: 'Narrow 1' },
      ],
    },
  });
  const result = await runModels(runtime);
  // The descending mock input is sorted ascending first, so truncation keeps a deterministic prefix.
  assert.equal(result.providers[0].provider, 'narrow');
  assert.equal(result.providers[0].truncated, false);
  assert.deepEqual(result.providers[0].models.map((model) => model.id), ['narrow-1', 'narrow-2']);
  assert.equal(result.providers[1].provider, 'wide');
  assert.equal(result.providers[1].truncated, true);
  assert.equal(result.providers[1].models.length, 100);
  assert.equal(result.providers[1].models[0].id, 'wide-000');
  assert.equal(result.providers[1].models[99].id, 'wide-099');
});

test('one provider catalog failure does not fail the aggregate summary', async () => {
  const failure = new Error('gateway catalog unavailable');
  failure.code = 'AUTH';
  const { runtime } = catalogHarness({
    providers: [
      { id: 'broken', name: 'Broken' },
      { id: 'healthy', name: 'Healthy' },
      { id: 'untyped', name: 'Untyped' },
    ],
    catalogs: {
      broken: failure,
      healthy: [{ provider: 'healthy', id: 'good-1', name: 'Good 1' }],
      untyped: new Error('plain failure without a code'),
    },
  });
  const result = await runModels(runtime);
  assert.deepEqual(result.providers[0], {
    provider: 'broken',
    name: 'Broken',
    truncated: false,
    models: [],
    error: { code: 'AUTH', message: 'gateway catalog unavailable' },
  });
  assert.deepEqual(result.providers[1].models, [{ provider: 'healthy', id: 'good-1', name: 'Good 1' }]);
  assert.equal(result.providers[1].error, undefined);
  assert.deepEqual(result.providers[2].error, { code: 'MODEL_CATALOG_FAILED', message: 'plain failure without a code' });
});

test('a cancelled aggregate listing surfaces the cancellation instead of per-provider errors', async () => {
  const { runtime } = catalogHarness({
    providers: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    catalogs: {
      a: Object.assign(new Error('catalog fetch aborted mid-flight'), { code: 'AUTH' }),
      b: [{ provider: 'b', id: 'b-1', name: 'B1' }],
    },
  });
  const controller = new AbortController();
  controller.abort(new Error('caller cancelled'));
  await assert.rejects(
    runtime.execute({ action: 'models' }, { agent: sessionAgent('controller-session'), signal: controller.signal }),
    /catalog fetch aborted mid-flight/,
  );
});

test('models with a provider keeps the single-provider catalog listing', async () => {
  const { runtime, calls } = catalogHarness({
    providers: [{ id: 'deepseek-official', name: 'DeepSeek Official' }],
    catalogs: {
      'deepseek-official': Array.from({ length: 502 }, (_, index) => ({ provider: 'deepseek-official', id: `m-${String(index).padStart(3, '0')}`, name: `M ${index}` })),
    },
  });
  const result = await runModels(runtime, { provider: 'deepseek-official' });
  assert.equal(result.provider, 'deepseek-official');
  assert.equal(result.models.length, 500);
  assert.deepEqual(result.models[0], { provider: 'deepseek-official', id: 'm-000', name: 'M 0' });
  assert.equal('providers' in result, false);
  assert.equal('allowedModels' in result, false);
  assert.equal(calls.listProviders, 0);
  assert.deepEqual(calls.listModels, ['deepseek-official']);
});

test('models with provider and model resolves the exact route metadata', async () => {
  const resolved = {
    provider: 'deepseek-official',
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner',
    inputModalities: ['text'],
    context: { contextWindow: 128000 },
    defaultMaxTokens: 8192,
    reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
  };
  const { runtime, calls } = catalogHarness({
    providers: [{ id: 'deepseek-official', name: 'DeepSeek Official' }],
    catalogs: { 'deepseek-official': [{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
    exact: { 'deepseek-reasoner': resolved },
  });
  const result = await runModels(runtime, { provider: 'deepseek-official', model: 'deepseek-reasoner' });
  assert.deepEqual(result, { provider: 'deepseek-official', models: [resolved] });
  assert.deepEqual(calls.resolveModelInfo, [{ provider: 'deepseek-official', model: 'deepseek-reasoner' }]);
  assert.equal(calls.listProviders, 0);
  assert.deepEqual(calls.listModels, []);
});

test('models exact route failures still propagate unchanged', async () => {
  const notFound = Object.assign(new Error('unknown model "missing"'), { code: 'MODEL_NOT_FOUND' });
  const { runtime } = catalogHarness({ exact: { missing: notFound } });
  await assert.rejects(runModels(runtime, { provider: 'deepseek-official', model: 'missing' }), /unknown model/);
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

/**
 * Minimal core double for the edit dispatch path: seeded into
 * `runtime.cores` so `coreAt` reuses it instead of constructing a real
 * TowerCore, while `resolveRoot` still resolves the real temporary repo.
 */
function editHarness(repo, editMission) {
  const calls = { edit: [], status: 0 };
  const core = {
    async open() {},
    async editMission(args) {
      calls.edit.push(args);
      return await editMission(args);
    },
    async status() {
      calls.status += 1;
      return { baseBranch: 'main', missions: [] };
    },
  };
  const { runtime } = executeHarness(repo);
  runtime.cores.set(repo, core);
  return { calls, runtime };
}

function runEdit(runtime, args) {
  return runtime.execute({ action: 'edit', ...args }, { agent: sessionAgent('controller-session'), signal: new AbortController().signal });
}

test('edit maps tool arguments onto core.editMission and returns the mission', async (t) => {
  const repo = makeRepo(t);
  const mission = { id: 'M2', title: 'Edited title', description: 'Edited objective', scope: ['lib/', 'test/'], dependsOn: ['M1'], status: 'pending', revision: 2 };
  const { calls, runtime } = editHarness(repo, async () => mission);
  const result = await runEdit(runtime, { mission_id: ' M2 ', title: 'Edited title', description: 'Edited objective', scope: ['lib/', 'test/'], depends_on: ['M1'] });
  assert.deepEqual(result, { mission });
  assert.deepEqual(calls.edit, [{ missionId: 'M2', title: 'Edited title', description: 'Edited objective', scope: ['lib/', 'test/'], dependsOn: ['M1'] }]);
  // edit is a mutating action: the projection is published and the workspace claim is released.
  assert.equal(calls.status, 1);
  assert.equal(runtime.inFlight.has(repo), false);
});

test('edit forwards only the fields the caller supplied', async (t) => {
  const repo = makeRepo(t);
  const { calls, runtime } = editHarness(repo, async (args) => ({ id: args.missionId, title: 'kept', scope: [], dependsOn: [], revision: 3, status: 'pending' }));
  const result = await runEdit(runtime, { mission_id: 'M1', depends_on: [] });
  assert.deepEqual(calls.edit, [{ missionId: 'M1', dependsOn: [] }]);
  assert.equal(result.mission.title, 'kept');
  assert.equal(result.mission.revision, 3);
});

test('edit rejects a missing or blank mission_id before reaching the core', async (t) => {
  const repo = makeRepo(t);
  const { calls, runtime } = editHarness(repo, async () => { throw new Error('core.editMission must not run'); });
  await assert.rejects(
    runEdit(runtime, { title: 'orphan edit' }),
    (error) => error instanceof TowerError && error.code === 'ARGUMENT_INVALID' && error.message === 'mission_id must be a non-empty string',
  );
  await assert.rejects(runEdit(runtime, { mission_id: '   ' }), /mission_id must be a non-empty string/);
  assert.deepEqual(calls.edit, []);
});

test('edit propagates core rejections such as MISSION_NOT_EDITABLE to the tool layer', async (t) => {
  const repo = makeRepo(t);
  const { runtime } = editHarness(repo, () => {
    throw new TowerError('MISSION_NOT_EDITABLE', 'mission M2 is worker_running; only a pending mission can be edited');
  });
  await assert.rejects(
    runEdit(runtime, { mission_id: 'M2', title: 'too late' }),
    (error) => error instanceof TowerError && error.code === 'MISSION_NOT_EDITABLE' && /only a pending mission can be edited/.test(error.message),
  );
  assert.equal(runtime.inFlight.has(repo), false);
});

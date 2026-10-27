import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply, inject, name } from '../lib/index.js';
import { TowerRuntime } from '../lib/runtime.js';
import { TowerError } from '../lib/errors.js';
import { initializedCore, makeRepo } from './helpers.js';

/** Last physical line of a settlement notice; the stop reason must live there. */
function lastLine(text) {
  return text.split('\n').at(-1);
}

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
  const text = notices[0].content[0].text;
  assert.equal(text.split('\n')[0], 'Tower worker for M1 completed: mission status worker_completed');
  assert.match(text, /tower action=status/, 'the generic next-action hint remains');
  assert.equal(lastLine(text), 'stopReason: completed');
});

/**
 * Track-focused harness: one fake activation whose settlement the test
 * controls (resolve or reject), a configurable core double, a steer-collecting
 * parent agent, and a logging spy so containment guarantees are assertable.
 */
function trackHarness() {
  const lifecycle = { disposeCalls: 0, failCalls: 0, logs: { warn: [], error: [] }, settle: undefined, reject: undefined };
  const activation = {
    childId: 'child-run',
    result: new Promise((resolve, reject) => { lifecycle.settle = resolve; lifecycle.reject = reject; }),
    async dispose() { lifecycle.disposeCalls += 1; },
  };
  const notices = [];
  const core = {
    async mission() { return { id: 'M1', title: 'Mission', description: 'Work', scope: [] }; },
    async beginSpawn(args = {}) {
      return {
        runId: 'run-1',
        mission: {
          id: 'M1',
          title: 'Mission',
          description: 'Work',
          scope: [],
          worktree: '/tmp',
          status: args.role === 'reviewer' ? 'review_running' : 'worker_running',
          review: { baseCommit: 'base-1', reviewedCommit: 'tip-1' },
        },
      };
    },
    async attachSpawn() {},
    async completeSpawn() { return { id: 'M1', status: 'worker_completed' }; },
    async failSpawn() { lifecycle.failCalls += 1; return { id: 'M1', status: 'worker_failed' }; },
    async status() { return { baseBranch: 'main', missions: [] }; },
  };
  const ctx = {
    llm: { async resolveCallConfig(config) { return config; } },
    subagents: { startActivation: async () => activation },
    sessions: { async flush() {} },
    logger: {
      warn(message) { lifecycle.logs.warn.push(String(message)); },
      error(message) { lifecycle.logs.error.push(String(message)); },
    },
  };
  const agent = {
    ...parent,
    id: 'parent',
    session: { header: {}, requestHeader: () => undefined },
    steer: (message) => notices.push(message),
  };
  return { runtime: new TowerRuntime(ctx, {}), core, agent, lifecycle, notices };
}

function runTrackedSpawn(harness, role = 'worker') {
  return harness.runtime.spawn(harness.core, harness.agent, { role, mission_id: 'M1' }, new AbortController().signal);
}

test('a failed reviewer activation notifies review_failed with a bounded reason and next action', async () => {
  const harness = trackHarness();
  harness.core.completeSpawn = async () => ({ id: 'M1', status: 'review_failed', review: { stopReason: 'error', error: '429 rate limited' } });
  const started = await runTrackedSpawn(harness, 'reviewer');
  const entry = harness.runtime.active.get(started.runId);
  harness.lifecycle.settle({ stopReason: 'error', diagnostic: '429 rate limited' });
  await entry.done;
  assert.equal(harness.notices.length, 1, 'the failure notice must reach the controller');
  const notice = harness.notices[0];
  assert.equal(notice.source.kind, 'subagent-settled');
  assert.equal(notice.source.senderSessionId, 'child-run');
  assert.equal(notice.source.summary, 'Tower reviewer for M1 failed: mission status review_failed');
  const text = notice.content[0].text;
  assert.match(text, /^Tower reviewer for M1 failed: mission status review_failed/);
  assert.match(text, /spawn a fresh reviewer/);
  assert.equal(lastLine(text), 'stopReason: error; reason: 429 rate limited');
  assert.equal(text.split('\n').length, 3, 'summary, next action, then the stop-reason line');
  assert.equal(harness.runtime.active.size, 0);
  assert.equal(harness.lifecycle.disposeCalls, 1);
});

test('an interrupted reviewer run reports interrupted with its reason and next action', async () => {
  const harness = trackHarness();
  harness.core.completeSpawn = async () => ({ id: 'M1', status: 'review_failed', review: { stopReason: 'aborted', error: 'activation is not owned by this runtime' } });
  await runTrackedSpawn(harness, 'reviewer');
  const entry = harness.runtime.active.get('run-1');
  harness.lifecycle.settle({ stopReason: 'aborted', diagnostic: 'activation is not owned by this runtime' });
  await entry.done;
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0].source.summary, 'Tower reviewer for M1 interrupted: mission status review_failed');
  const text = harness.notices[0].content[0].text;
  assert.match(text, /^Next: spawn a fresh reviewer/m);
  assert.equal(lastLine(text), 'stopReason: aborted; reason: activation is not owned by this runtime');
});

test('a missing activation stop reason falls back to the role record stop reason', async () => {
  const harness = trackHarness();
  harness.core.completeSpawn = async () => ({ id: 'M1', status: 'review_failed', review: { stopReason: 'error', error: '429 rate limited' } });
  await runTrackedSpawn(harness, 'reviewer');
  const entry = harness.runtime.active.get('run-1');
  harness.lifecycle.settle({ diagnostic: '429 rate limited' });
  await entry.done;
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0].source.summary, 'Tower reviewer for M1 failed: mission status review_failed');
  assert.equal(lastLine(harness.notices[0].content[0].text), 'stopReason: error; reason: 429 rate limited');
});

test('a record-only aborted stop reason classifies the run as interrupted', async () => {
  const harness = trackHarness();
  harness.core.completeSpawn = async () => ({ id: 'M1', status: 'review_failed', review: { stopReason: 'aborted', error: 'activation is not owned by this runtime' } });
  await runTrackedSpawn(harness, 'reviewer');
  const entry = harness.runtime.active.get('run-1');
  harness.lifecycle.settle({ diagnostic: 'activation is not owned by this runtime' });
  await entry.done;
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0].source.summary, 'Tower reviewer for M1 interrupted: mission status review_failed');
  assert.equal(lastLine(harness.notices[0].content[0].text), 'stopReason: aborted; reason: activation is not owned by this runtime');
});

test('a run with no stop reason anywhere reports unknown and keeps the next action', async () => {
  const harness = trackHarness();
  harness.core.failSpawn = async () => ({ id: 'M1', status: 'worker_failed', worker: { error: 'activation crashed' } });
  await runTrackedSpawn(harness);
  const entry = harness.runtime.active.get('run-1');
  harness.lifecycle.reject(new Error('activation crashed'));
  await entry.done;
  assert.equal(harness.notices.length, 1);
  const text = harness.notices[0].content[0].text;
  assert.equal(harness.notices[0].source.summary, 'Tower worker for M1 failed: mission status worker_failed');
  assert.match(text, /^Next: spawn a fresh worker/m);
  assert.equal(lastLine(text), 'stopReason: unknown; reason: activation crashed');
});

test('a failed run truncates its role-record reason to 500 characters', async () => {
  const harness = trackHarness();
  const longError = `429 ${'x'.repeat(600)}`;
  harness.core.completeSpawn = async () => ({ id: 'M1', status: 'review_failed', review: { stopReason: 'error', error: longError } });
  await runTrackedSpawn(harness, 'reviewer');
  const entry = harness.runtime.active.get('run-1');
  harness.lifecycle.settle({ stopReason: 'error' });
  await entry.done;
  assert.equal(harness.notices.length, 1);
  const prefix = 'stopReason: error; reason: ';
  const final = lastLine(harness.notices[0].content[0].text);
  assert.ok(final.startsWith(prefix), 'the reason lives on the final stop-reason line');
  assert.ok(final.length - prefix.length <= 500, 'the reason is truncated to 500 characters');
  assert.ok(final.endsWith('…'));
});

test('a multi-line diagnostic reason stays on the final physical line', async () => {
  const harness = trackHarness();
  const diagnostic = '429 rate limited\n{"error":{"code":429,"message":"rate limited"}}\nretry-after: 30';
  harness.core.completeSpawn = async () => ({ id: 'M1', status: 'review_failed', review: { stopReason: 'error', error: diagnostic } });
  await runTrackedSpawn(harness, 'reviewer');
  const entry = harness.runtime.active.get('run-1');
  harness.lifecycle.settle({ stopReason: 'error', diagnostic });
  await entry.done;
  assert.equal(harness.notices.length, 1);
  const text = harness.notices[0].content[0].text;
  assert.match(text, /^Next: spawn a fresh reviewer/m);
  assert.equal(text.split('\n').length, 3, 'the reason must not add physical lines');
  assert.equal(
    lastLine(text),
    'stopReason: error; reason: 429 rate limited {"error":{"code":429,"message":"rate limited"}} retry-after: 30',
  );
});

test('a multi-line stop reason is normalized onto the final physical line', async () => {
  const harness = trackHarness();
  harness.core.completeSpawn = async () => ({ id: 'M1', status: 'worker_completed' });
  await runTrackedSpawn(harness);
  const entry = harness.runtime.active.get('run-1');
  harness.lifecycle.settle({ stopReason: 'completed\n(parent finished)\n' });
  await entry.done;
  assert.equal(harness.notices.length, 1);
  const text = harness.notices[0].content[0].text;
  assert.equal(text.split('\n').length, 3, 'the stop reason must not add physical lines');
  assert.equal(lastLine(text), 'stopReason: completed (parent finished)');
});

test('a long multi-line reason is collapsed before it is truncated', async () => {
  const harness = trackHarness();
  const diagnostic = Array.from({ length: 40 }, (_, index) => `429 attempt ${index} rate limited`).join('\r\n');
  harness.core.completeSpawn = async () => ({ id: 'M1', status: 'worker_failed', worker: { stopReason: 'error', error: diagnostic } });
  await runTrackedSpawn(harness);
  const entry = harness.runtime.active.get('run-1');
  harness.lifecycle.settle({ stopReason: 'error' });
  await entry.done;
  assert.equal(harness.notices.length, 1);
  const text = harness.notices[0].content[0].text;
  assert.equal(text.split('\n').length, 3, 'the truncated reason must not add physical lines');
  const prefix = 'stopReason: error; reason: ';
  const final = lastLine(text);
  assert.ok(final.startsWith(prefix), 'the reason lives on the final stop-reason line');
  assert.ok(final.length - prefix.length <= 500, 'the reason is truncated to 500 characters');
  assert.ok(final.endsWith('…'));
  assert.ok(!/[\r\n]/.test(final), 'no raw line break may survive inside the final line');
});

test('approved, rejected, and stale settlements also end with a stop reason', async () => {
  const cases = [
    { status: 'approved', review: { stopReason: 'completed' }, expected: 'stopReason: completed' },
    { status: 'changes_requested', review: { stopReason: 'completed' }, expected: 'stopReason: completed' },
    {
      status: 'worker_completed',
      review: { stale: true, error: 'review binding became stale while the reviewer was running' },
      expected: 'stopReason: completed; reason: review binding became stale while the reviewer was running',
    },
  ];
  for (const item of cases) {
    const harness = trackHarness();
    harness.core.completeSpawn = async () => ({ id: 'M1', status: item.status, review: item.review });
    await runTrackedSpawn(harness, 'reviewer');
    const entry = harness.runtime.active.get('run-1');
    harness.lifecycle.settle({
      stopReason: 'completed',
      structured: { verdict: 'clean', merge: true, summary: 'ok', findings: [], checks: [] },
    });
    await entry.done;
    assert.equal(harness.notices.length, 1, `${item.status} must notify`);
    assert.equal(lastLine(harness.notices[0].content[0].text), item.expected, `${item.status} must end with its stop reason`);
  }
});

test('a completeSpawn failure still steers a notice carrying the recorded error', async () => {
  const harness = trackHarness();
  harness.core.completeSpawn = async () => { throw new Error('state write failed'); };
  harness.core.failSpawn = async () => ({ id: 'M1', status: 'worker_failed', worker: { error: 'state write failed' } });
  await runTrackedSpawn(harness);
  const entry = harness.runtime.active.get('run-1');
  harness.lifecycle.settle({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] });
  await entry.done;
  assert.equal(harness.notices.length, 1, 'recording failure must not silence the notice');
  const text = harness.notices[0].content[0].text;
  assert.match(text, /^Tower worker for M1 failed: mission status worker_failed/);
  assert.match(text, /spawn a fresh worker/);
  // The model completed; only recording the state failed. The stop reason must
  // keep that meaning instead of being rewritten as an error.
  assert.equal(lastLine(text), 'stopReason: completed; reason: state write failed');
});

test('an unrecordable run still notifies with role, mission, run, and error', async () => {
  const harness = trackHarness();
  harness.core.completeSpawn = async () => { throw new Error('state store unavailable'); };
  harness.core.failSpawn = async () => { throw new Error('state store unavailable'); };
  await runTrackedSpawn(harness);
  const entry = harness.runtime.active.get('run-1');
  const longError = `activation transport crashed ${'x'.repeat(600)}`;
  harness.lifecycle.reject(new Error(longError));
  await entry.done;
  assert.equal(harness.notices.length, 1, 'even a doubly-failing settlement must notify');
  const text = harness.notices[0].content[0].text;
  assert.match(text, /^Tower worker for M1 failed: mission status unknown/);
  assert.match(text, /run run-1 could not be recorded in Tower state/);
  assert.match(text, /tower action=status/);
  assert.match(text, /^Next: inspect the mission with tower action=status/m);
  const prefix = 'stopReason: unknown; reason: ';
  const final = lastLine(text);
  assert.ok(final.startsWith(prefix), 'the fallback ends with stopReason and the bounded error');
  const reason = final.slice(prefix.length);
  assert.ok(reason.startsWith('activation transport crashed'));
  assert.ok(reason.length <= 500, 'the reason is truncated to 500 characters');
  assert.ok(reason.endsWith('…'));
  assert.ok(harness.lifecycle.logs.error.some((line) => /could not record failed worker run run-1/.test(line)));
});

test('an unrecordable completed run still reports its completed stop reason', async () => {
  const harness = trackHarness();
  harness.core.completeSpawn = async () => { throw new Error('state store unavailable'); };
  harness.core.failSpawn = async () => { throw new Error('state store unavailable'); };
  await runTrackedSpawn(harness);
  const entry = harness.runtime.active.get('run-1');
  harness.lifecycle.settle({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] });
  await entry.done;
  assert.equal(harness.notices.length, 1);
  const text = harness.notices[0].content[0].text;
  assert.match(text, /^Tower worker for M1 failed: mission status unknown/);
  assert.match(text, /^Next: inspect the mission/m);
  // The model completed; only recording failed, so the stop reason must not
  // be rewritten to error just because the state could not be written.
  assert.equal(lastLine(text), 'stopReason: completed; reason: state store unavailable');
});

test('a failing projection publication never blocks the settlement notice', async () => {
  const harness = trackHarness();
  harness.core.status = async () => { throw new Error('projection publish failed'); };
  await runTrackedSpawn(harness);
  const entry = harness.runtime.active.get('run-1');
  harness.lifecycle.settle({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] });
  await entry.done;
  assert.equal(harness.notices.length, 1, 'publication failure must not block the steer');
  assert.equal(harness.notices[0].source.summary, 'Tower worker for M1 completed: mission status worker_completed');
  assert.equal(lastLine(harness.notices[0].content[0].text), 'stopReason: completed');
  assert.ok(harness.lifecycle.logs.warn.some((line) => /projection publication failed/i.test(line)));
});

test('a failing steer is logged as an error and still settles the run', async () => {
  const harness = trackHarness();
  harness.agent.steer = () => { throw new Error('steer rejected'); };
  await runTrackedSpawn(harness);
  const entry = harness.runtime.active.get('run-1');
  harness.lifecycle.settle({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] });
  await entry.done;
  assert.equal(harness.runtime.active.size, 0);
  assert.ok(harness.lifecycle.logs.error.some((line) => /settlement notification failed for run-1/.test(line)));
});

test('agent/created steers one stale-run notice per persisted run and dedupes repeats', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  const zombie = await core.addMission({ title: 'Zombie', description: 'Stale after restart' });
  await core.beginSpawn({ missionId: zombie.id, role: 'worker', controllerSessionId: 'controller-session' });
  const live = await core.addMission({ title: 'Live', description: 'Owned by this runtime' });
  const liveRun = await core.beginSpawn({ missionId: live.id, role: 'worker', controllerSessionId: 'controller-session' });
  const zombieStartedAt = (await core.mission(zombie.id)).worker.startedAt;
  const harness = trackHarness();
  harness.runtime.active.set(liveRun.runId, {});
  const steered = [];
  const controllerAgent = (id) => ({ session: { id, header: { cwd: repo } }, steer: (message) => steered.push(message) });
  await harness.runtime.onAgentCreated({ agent: controllerAgent('controller-session') });
  assert.equal(steered.length, 1);
  const notice = steered[0];
  assert.equal(notice.source.form, 'notice');
  assert.equal(notice.source.summary, 'Tower restart left 1 run(s) recorded as running');
  const text = notice.content[0].text;
  assert.match(text, new RegExp(`- ${zombie.id} worker started ${zombieStartedAt}`));
  assert.match(text, /tower action=recover/);
  assert.ok(!text.includes(live.id), 'runs owned by this runtime are not stale');
  // A repeat creation for the same run steers nothing more.
  await harness.runtime.onAgentCreated({ agent: controllerAgent('controller-session') });
  assert.equal(steered.length, 1);
  // A different session never receives the zombie notice.
  await harness.runtime.onAgentCreated({ agent: controllerAgent('someone-else') });
  assert.equal(steered.length, 1);
});

test('agent/created stays silent without tower state and only warns on unreadable state', async (t) => {
  const harness = trackHarness();
  const steered = [];
  const agent = (overrides = {}) => ({ session: { id: 'session', header: {}, ...overrides.header }, steer: (message) => steered.push(message), ...overrides });
  // A repository without tower state steers nothing.
  const bare = makeRepo(t);
  await harness.runtime.onAgentCreated({ agent: agent({ header: { cwd: bare } }) });
  assert.equal(steered.length, 0);
  // Missing cwd or a missing session is silently ignored.
  await harness.runtime.onAgentCreated({ agent: agent() });
  await harness.runtime.onAgentCreated({});
  assert.equal(steered.length, 0);
  // Unparseable state only warns and never throws into agent creation.
  const broken = makeRepo(t);
  await initializedCore(broken);
  writeFileSync(path.join(broken, '.dsh-tower', 'state.json'), '{not json');
  await harness.runtime.onAgentCreated({ agent: agent({ header: { cwd: broken } }) });
  assert.equal(steered.length, 0);
  assert.ok(harness.lifecycle.logs.warn.some((line) => /could not read tower state/.test(line)));
});

/** Seed one stale worker run for a controller session in a real temporary tower. */
async function staleTower(repo, id, sessionId = 'controller-session') {
  const core = await initializedCore(repo);
  const mission = await core.addMission({ id, title: `Stale ${id}`, description: 'Stale after restart' });
  const run = await core.beginSpawn({ missionId: mission.id, role: 'worker', controllerSessionId: sessionId });
  return { core, mission, run };
}

test('agent/created probes the effective working directory, not the creation-time cwd', async (t) => {
  // The Session was created in repo A, but its durable working directory has
  // since moved to a subdirectory of repo B. Both repositories hold stale runs
  // for this controller, so probing the wrong root is observable.
  const repoA = makeRepo(t);
  await staleTower(repoA, 'A1');
  const repoB = makeRepo(t);
  await staleTower(repoB, 'B1');
  const subdir = path.join(repoB, 'nested');
  mkdirSync(subdir);
  const harness = trackHarness();
  const ensureCalls = [];
  harness.runtime.ctx.workingDirectory = {
    async ensure(agent, signal) {
      ensureCalls.push({ sessionId: agent.session.id, signal });
      return subdir;
    },
  };
  const steered = [];
  const agent = { session: { id: 'controller-session', header: { cwd: repoA } }, steer: (message) => steered.push(message) };
  await harness.runtime.onAgentCreated({ agent });
  assert.deepEqual(ensureCalls.map((call) => call.sessionId), ['controller-session']);
  assert.equal(steered.length, 1);
  const text = steered[0].content[0].text;
  assert.match(text, /- B1 worker started /);
  assert.ok(!text.includes('- A1 worker'), 'the creation-time repo must not be probed');
  assert.match(text, /tower action=recover/);
  // The runtime dedupes the persisted run: a repeat creation steers nothing,
  // while still resolving the current directory exactly once per event.
  await harness.runtime.onAgentCreated({ agent });
  assert.equal(ensureCalls.length, 2);
  assert.equal(steered.length, 1);
});

test('agent/created never falls back to the creation cwd when the working directory cannot be resolved', async (t) => {
  const repoA = makeRepo(t);
  await staleTower(repoA, 'A1');
  const harness = trackHarness();
  let ensureCalls = 0;
  harness.runtime.ctx.workingDirectory = {
    async ensure() {
      ensureCalls += 1;
      throw new Error('working directory disappeared');
    },
  };
  const steered = [];
  const agent = { session: { id: 'controller-session', header: { cwd: repoA } }, steer: (message) => steered.push(message) };
  await harness.runtime.onAgentCreated({ agent });
  assert.equal(ensureCalls, 1);
  assert.equal(steered.length, 0, 'a failed resolution must not probe the old repository');
  assert.ok(harness.lifecycle.logs.warn.some((line) => /could not resolve the current working directory/.test(line)));
});

test('agent/created stays quiet when the effective directory is outside Git', async (t) => {
  const repoA = makeRepo(t);
  await staleTower(repoA, 'A1');
  const outside = mkdtempSync(path.join(tmpdir(), 'dsh-tower-probe-plain-'));
  t.after(() => {
    if (outside.startsWith(path.join(tmpdir(), 'dsh-tower-probe-plain-'))) rmSync(outside, { recursive: true, force: true });
  });
  const harness = trackHarness();
  harness.runtime.ctx.workingDirectory = { async ensure() { return outside; } };
  const steered = [];
  const agent = { session: { id: 'controller-session', header: { cwd: repoA } }, steer: (message) => steered.push(message) };
  await harness.runtime.onAgentCreated({ agent });
  assert.equal(steered.length, 0);
  assert.deepEqual(harness.lifecycle.logs.warn, [], 'a non-repository cwd is the ordinary no-tower case');
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

test('bundle subscribes the runtime to agent/created without letting probe failures escape', async () => {
  const listeners = new Map();
  const ctx = {
    root: { sessionProjections: { register: () => () => undefined } },
    tools: { register: () => () => undefined },
    effect: () => undefined,
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name); },
  };
  apply(ctx, {});
  const handler = listeners.get('agent/created');
  assert.ok(typeof handler === 'function', 'the bundle must subscribe to agent/created');
  // An agent without a usable cwd is silently ignored; the serial listener never throws.
  await handler({ agent: { session: { id: 'session' } } });
  await handler({});
  assert.equal(listeners.has('agent/created'), true);
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

/** Promise that the test settles explicitly. */
function deferred() {
  let resolve;
  const promise = new Promise((settled) => { resolve = settled; });
  return { promise, resolve };
}

/**
 * Real-core startup harness: the runtime's first startActivation call parks
 * until the test releases it, mirroring a slow host spawn, and later settles
 * only when the test (or disposal) decides. `failStart` makes the first
 * startActivation reject; `park: false` returns the first activation without
 * parking; `core` seeds a core (possibly wrapped) into `runtime.cores` so
 * `coreAt` reuses it instead of opening a fresh instance.
 */
function startupHarness(repo, options = {}) {
  const starting = deferred();
  const release = deferred();
  const lifecycle = { disposes: 0, settle: undefined };
  let nextId = 0;
  const runtime = new TowerRuntime({
    workingDirectory: { async ensure() { return repo; } },
    sessions: { async flush() {} },
    llm: { async resolveCallConfig(config) { return config; } },
    subagents: {
      async startActivation() {
        const index = ++nextId;
        if (index === 1 && options.failStart === true) {
          starting.resolve();
          throw new Error('host refused the activation');
        }
        const outcome = deferred();
        const activation = {
          childId: `fixture-child-${index}`,
          result: outcome.promise,
          async dispose() { lifecycle.disposes += 1; outcome.resolve({ stopReason: 'aborted', output: [] }); },
        };
        if (index === 1) {
          lifecycle.settle = outcome.resolve;
          starting.resolve();
          if (options.park !== false) await release.promise;
        }
        return activation;
      },
    },
    logger: { warn() {}, error() {} },
  }, {});
  if (options.core !== undefined) runtime.cores.set(repo, options.core);
  // These regressions exercise ownership and run registration, not projection
  // persistence.
  runtime.publish = async () => {};
  const run = (agent, args) => runtime.execute(args, { agent, signal: new AbortController().signal });
  const controller = (id) => ({ options: { provider: 'fixture-provider', model: 'fixture-model' }, session: { id, header: {}, requestHeader() {} }, steer() {} });
  return { runtime, run, controller, starting, release, lifecycle };
}

test('a concurrent short call must not release its Session sibling startup claim', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ id: 'M1', title: 'First', description: 'Starting in controller A.' });
  await core.addMission({ id: 'M2', title: 'Second', description: 'Must not start in controller B concurrently.' });
  const { runtime, run, controller, starting, release } = startupHarness(repo);
  const a = controller('controller-A');
  const first = run(a, { action: 'spawn', mission_id: 'M1', role: 'worker' });
  try {
    await starting.promise;
    // A read-only call from the same Session finishes while the spawn call is
    // still parked in startActivation; its finally must release only its own
    // claim, never the sibling spawn call's.
    await run(a, { action: 'summary' });
    const ownerAfterSummary = runtime.workspaceOwner(repo);
    let foreignAccepted = false;
    try { await run(controller('controller-B'), { action: 'spawn', mission_id: 'M2', role: 'worker' }); foreignAccepted = true; }
    catch (error) { assert.equal(error.code, 'WORKSPACE_BUSY'); }
    release.resolve();
    await first;
    const activeControllers = [...new Set([...runtime.active.values()].map((entry) => entry.parent.session.id))];
    assert.deepEqual({ ownerAfterSummary, foreignAccepted, activeControllers }, { ownerAfterSummary: 'controller-A', foreignAccepted: false, activeControllers: ['controller-A'] });
  } finally {
    release.resolve();
    await first.catch(() => {});
    await runtime.dispose();
  }
});

test('concurrent short calls from one Session do not release each other', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ id: 'M1', title: 'Read', description: 'A slow read holds the claim.' });
  // Park the first summary inside the core: by the time the core method runs,
  // the call has already claimed the workspace, so the parked window proves
  // claim stacking without any spawn in flight.
  const summaryEntered = deferred();
  const finishSummary = deferred();
  const realSummary = core.summary.bind(core);
  core.summary = (...args) => {
    summaryEntered.resolve();
    return finishSummary.promise.then(() => realSummary(...args));
  };
  const { runtime, run, controller } = startupHarness(repo, { core });
  const a = controller('controller-A');
  const slow = run(a, { action: 'summary' });
  try {
    await summaryEntered.promise;
    await run(a, { action: 'status' });
    // The sibling short call returned; its finally must release only its own
    // claim, so a foreign Session is still refused and the owner is unchanged.
    await assert.rejects(
      run(controller('controller-B'), { action: 'status' }),
      (error) => error.code === 'WORKSPACE_BUSY',
    );
    assert.equal(runtime.workspaceOwner(repo), 'controller-A');
    finishSummary.resolve();
    await slow;
    assert.equal(runtime.workspaceOwner(repo), undefined, 'the last call releases the workspace');
    assert.equal(runtime.inFlight.has(repo), false);
  } finally {
    finishSummary.resolve();
    await slow.catch(() => {});
    await runtime.dispose();
  }
});

test('recover must not classify this runtime pending startup as a stale run', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ id: 'M1', title: 'Starting', description: 'The host has not yet returned the activation handle.' });
  const { runtime, run, controller, starting, release } = startupHarness(repo);
  const a = controller('controller-A');
  const first = run(a, { action: 'spawn', mission_id: 'M1', role: 'worker' });
  try {
    await starting.promise;
    const recovered = await run(a, { action: 'recover' });
    release.resolve();
    await first;
    const mission = await core.mission('M1');
    assert.deepEqual(
      { recovered: recovered.recovered.map((item) => item.mission), status: mission.status, tracked: runtime.active.size },
      { recovered: [], status: 'worker_running', tracked: 1 },
    );
  } finally {
    release.resolve();
    await first.catch(() => {});
    await runtime.dispose();
  }
});

test('recover still reaps persisted orphans while a starting run is exempt', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ id: 'M1', title: 'Starting', description: 'Owned by this runtime.' });
  await core.addMission({ id: 'M2', title: 'Orphan', description: 'Persisted running by a departed controller.' });
  await core.beginSpawn({ missionId: 'M2', role: 'worker', controllerSessionId: 'gone-controller' });
  const { runtime, run, controller, starting, release } = startupHarness(repo);
  const first = run(controller('controller-A'), { action: 'spawn', mission_id: 'M1', role: 'worker' });
  try {
    await starting.promise;
    const recovered = await run(controller('controller-A'), { action: 'recover' });
    assert.deepEqual(recovered.recovered.map((item) => item.mission), ['M2'], 'the starting exemption must not mask genuine orphans');
    assert.equal((await core.mission('M1')).status, 'worker_running');
    assert.equal((await core.mission('M2')).status, 'worker_failed');
    release.resolve();
    await first;
    assert.equal((await core.mission('M1')).status, 'worker_running', 'the starting run settles on its own terms');
  } finally {
    release.resolve();
    await first.catch(() => {});
    await runtime.dispose();
  }
});

test('the workspace frees only after the last sibling call and its activation settle', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ id: 'M1', title: 'Busy', description: 'Holds the workspace across sibling calls.' });
  const { runtime, run, controller, starting, release, lifecycle } = startupHarness(repo);
  const a = controller('controller-A');
  const first = run(a, { action: 'spawn', mission_id: 'M1', role: 'worker' });
  try {
    await starting.promise;
    await run(a, { action: 'summary' });
    assert.equal(runtime.workspaceOwner(repo), 'controller-A', 'the spawn call still holds its own claim after the sibling released');
    await assert.rejects(
      run(controller('controller-B'), { action: 'status' }),
      (error) => error.code === 'WORKSPACE_BUSY',
    );
    release.resolve();
    const started = await first;
    // The spawn call has returned; the workspace stays owned by the live
    // activation it started, so a foreign Session is still refused.
    assert.equal(runtime.workspaceOwner(repo), 'controller-A');
    await assert.rejects(
      run(controller('controller-B'), { action: 'status' }),
      (error) => error.code === 'WORKSPACE_BUSY',
    );
    const entry = runtime.active.get(started.runId);
    lifecycle.settle({ stopReason: 'completed', output: [{ type: 'text', text: 'worker report' }] });
    await entry.done;
    assert.equal(runtime.active.size, 0, 'settlement removes the run registration');
    assert.equal(runtime.workspaceOwner(repo), undefined);
    assert.equal(runtime.inFlight.has(repo), false);
    const takeover = await run(controller('controller-B'), { action: 'status' });
    assert.equal(takeover.baseBranch, 'main');
  } finally {
    release.resolve();
    await first.catch(() => {});
    await runtime.dispose();
  }
});

test('a failed startActivation unregisters the run and frees the workspace', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ id: 'M1', title: 'Start failure', description: 'The host refuses this activation.' });
  const { runtime, run, controller, lifecycle } = startupHarness(repo, { failStart: true });
  await assert.rejects(
    run(controller('controller-A'), { action: 'spawn', mission_id: 'M1', role: 'worker' }),
    /host refused the activation/,
  );
  const mission = await core.mission('M1');
  assert.equal(mission.status, 'worker_failed');
  assert.match(mission.worker.error, /host refused the activation/);
  assert.equal(runtime.active.size, 0, 'no starting registration may survive a failed start');
  assert.equal(runtime.workspaceOwner(repo), undefined);
  assert.equal(runtime.inFlight.has(repo), false);
  assert.equal(lifecycle.disposes, 0, 'no activation existed to dispose');
  // The freed tower is claimable again and the cleanup leaks no exemption:
  // recover from another Session finds nothing to do.
  const recovered = await run(controller('controller-B'), { action: 'recover' });
  assert.deepEqual(recovered.recovered, []);
  await runtime.dispose();
});

test('a failed attachSpawn unregisters the run, disposes the activation, and frees the workspace', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ id: 'M1', title: 'Attach failure', description: 'The activation handle cannot be recorded.' });
  core.attachSpawn = async () => { throw new Error('attach recording failed'); };
  const { runtime, run, controller, lifecycle } = startupHarness(repo, { core, park: false });
  await assert.rejects(
    run(controller('controller-A'), { action: 'spawn', mission_id: 'M1', role: 'worker' }),
    /attach recording failed/,
  );
  const mission = await core.mission('M1');
  assert.equal(mission.status, 'worker_failed');
  assert.match(mission.worker.error, /attach recording failed/);
  assert.equal(runtime.active.size, 0, 'the starting registration is removed');
  assert.equal(lifecycle.disposes, 1, 'the started activation is disposed exactly once');
  assert.equal(runtime.workspaceOwner(repo), undefined);
  assert.equal(runtime.inFlight.has(repo), false);
  await runtime.dispose();
  assert.equal(lifecycle.disposes, 1, 'dispose must not double-dispose the rolled-back activation');
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

/**
 * Minimal core double for the summary dispatch path: seeded into
 * `runtime.cores` so `coreAt` reuses it instead of constructing a real
 * TowerCore, mirroring editHarness above.
 */
function summaryHarness(repo, summary) {
  const calls = { summary: [], status: 0 };
  const core = {
    async open() {},
    async summary(args) {
      calls.summary.push(args);
      return await summary(args);
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

function runSummary(runtime, args = {}) {
  return runtime.execute({ action: 'summary', ...args }, { agent: sessionAgent('controller-session'), signal: new AbortController().signal });
}

test('summary maps tool arguments onto core.summary and returns the payload', async (t) => {
  const repo = makeRepo(t);
  const overview = {
    version: 3,
    baseBranch: 'main',
    counts: { missions: 2, workerRunning: 1, reviewRunning: 0, approved: 0, merged: 0, blocked: 0, abandoned: 1 },
    missions: [{ id: 'M1', title: 'First', status: 'worker_running' }],
  };
  const { calls, runtime } = summaryHarness(repo, async () => overview);
  const result = await runSummary(runtime);
  assert.deepEqual(result, { summary: overview });
  // An omitted mission_id must reach the core as undefined (report every mission).
  assert.deepEqual(calls.summary.map((args) => args.missionId), [undefined]);
  const narrowed = await runSummary(runtime, { mission_id: 'M2' });
  assert.deepEqual(narrowed, { summary: overview });
  assert.deepEqual(calls.summary.map((args) => args.missionId), [undefined, 'M2']);
  // summary is read-only like status: a projection publication would have called
  // core.status here, the way the edit test above observes exactly one such call.
  assert.equal(calls.status, 0);
  assert.equal(runtime.inFlight.has(repo), false);
});

test('summary propagates core rejections such as MISSION_NOT_FOUND to the tool layer', async (t) => {
  const repo = makeRepo(t);
  const { runtime } = summaryHarness(repo, () => {
    throw new TowerError('MISSION_NOT_FOUND', 'mission NOPE does not exist');
  });
  await assert.rejects(
    runSummary(runtime, { mission_id: 'NOPE' }),
    (error) => error instanceof TowerError && error.code === 'MISSION_NOT_FOUND' && /does not exist/.test(error.message),
  );
  assert.equal(runtime.inFlight.has(repo), false);
});

test('summary runs end-to-end against a real tower without touching state', async (t) => {
  const repo = makeRepo(t);
  const core = await initializedCore(repo);
  await core.addMission({ title: 'First mission', description: 'Implement the first feature.' });
  await core.addMission({ title: 'Second mission', description: 'Implement the second feature.' });
  const { runtime } = executeHarness(repo);
  const before = await core.store.read();
  const result = await runSummary(runtime);
  assert.equal(result.summary.baseBranch, 'main');
  assert.deepEqual(result.summary.counts, { missions: 2, workerRunning: 0, reviewRunning: 0, approved: 0, merged: 0, blocked: 0, abandoned: 0 });
  assert.deepEqual(result.summary.missions.map((entry) => entry.id), ['M1', 'M2']);
  const narrowed = await runSummary(runtime, { mission_id: 'M2' });
  assert.deepEqual(narrowed.summary.missions.map((entry) => entry.id), ['M2'], 'mission_id narrows the entries while counts stay global');
  assert.equal(narrowed.summary.counts.missions, 2);
  assert.deepEqual(await core.store.read(), before, 'summary must not touch revisions, events, or updatedAt');
});

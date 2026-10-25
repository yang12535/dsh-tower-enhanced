import assert from 'node:assert/strict';
import test from 'node:test';
import { TowerRuntime } from '../lib/runtime.js';

/**
 * Fake LLM adapter catalog mirroring the models harness in test/runtime.test.js:
 * no real provider is contacted, providers/catalogs/exact routes are injected,
 * and the adapter's documented stable error codes (NO_ADAPTER for an
 * unregistered provider, caller-supplied codes for failing catalogs,
 * MODEL_NOT_FOUND for an unknown exact route) are reproduced so the runtime's
 * three routing forms can be pinned without external services.
 */
function catalogHarness(options = {}) {
  const calls = { listProviders: 0, listModels: [], resolveModelInfo: [] };
  const providers = options.providers ?? [];
  const registered = new Set(providers.map((info) => info.id));
  const noAdapter = (provider) => Object.assign(new Error(`no adapter registered for provider "${provider}"`), { code: 'NO_ADAPTER' });
  const ctx = {
    llm: {
      listProviders() {
        calls.listProviders += 1;
        return providers.map((info) => ({ ...info }));
      },
      async listModels(provider) {
        calls.listModels.push(provider);
        const catalog = (options.catalogs ?? {})[provider];
        if (catalog === undefined) throw noAdapter(provider);
        if (catalog instanceof Error) throw catalog;
        return catalog.map((model) => ({ ...model }));
      },
      async resolveModelInfo(provider, model) {
        calls.resolveModelInfo.push({ provider, model });
        if (!registered.has(provider)) throw noAdapter(provider);
        const info = (options.exact ?? {})[provider]?.[model];
        if (info === undefined) {
          throw Object.assign(new Error(`unknown model "${model}" on provider "${provider}"`), { code: 'MODEL_NOT_FOUND' });
        }
        return { ...info };
      },
    },
  };
  return { ctx, calls, runtime: new TowerRuntime(ctx, options.config ?? {}) };
}

function controllerAgent() {
  return {
    options: { provider: 'controller-provider', model: 'controller-smart' },
    session: { id: 'controller-session', header: {}, requestHeader: () => undefined },
  };
}

function runModels(runtime, args = {}) {
  return runtime.execute({ action: 'models', ...args }, { agent: controllerAgent(), signal: new AbortController().signal });
}

/** Deep-equal after a JSON round trip: catches undefined fields and non-JSON values leaking into results. */
const jsonClone = (value) => JSON.parse(JSON.stringify(value));

test('no provider: aggregate form groups every provider, caps each catalog at 100, and flags truncation', async () => {
  const wide = Array.from({ length: 105 }, (_, index) => ({ provider: 'wide', id: `wide-${String(104 - index).padStart(3, '0')}`, name: `Wide ${104 - index}` }));
  const edge = Array.from({ length: 100 }, (_, index) => ({ provider: 'edge', id: `edge-${String(index).padStart(3, '0')}` }));
  const allowed = [{ provider: 'small', model: 's-1' }, { provider: 'wide', model: 'wide-000' }];
  const { runtime, calls } = catalogHarness({
    providers: [
      { id: 'wide', name: 'Wide Provider' },
      { id: 'anonymous' },
      { id: 'small', name: 'Small Provider' },
      { id: 'edge', name: 'Edge Provider' },
    ],
    catalogs: {
      wide,
      edge,
      anonymous: [{ provider: 'anonymous', id: 'anon-1' }],
      small: [
        { provider: 'small', id: 's-3', name: 'S 3' },
        { provider: 'small', id: 's-1', name: 'S 1', description: 'First small model' },
        { provider: 'small', id: 's-2', name: 'S 2', inputModalities: ['text', 'image'] },
      ],
    },
    config: { allowedModels: allowed },
  });

  const result = await runModels(runtime);

  // Grouping and stable order: exactly one entry per registered provider, sorted by route ascending.
  assert.equal(result.providers.length, 4);
  assert.deepEqual(result.providers.map((entry) => entry.provider), ['anonymous', 'edge', 'small', 'wide']);
  // A provider that disclosed no name gets no `name` key at all.
  assert.equal('name' in result.providers[0], false);
  assert.deepEqual(result.providers.map((entry) => entry.name), [undefined, 'Edge Provider', 'Small Provider', 'Wide Provider']);
  // Counts stay consistent with each catalog: whole list below the cap, exactly 100 at the cap, capped at 100 above it.
  assert.deepEqual(result.providers.map((entry) => entry.models.length), [1, 100, 3, 100]);
  assert.deepEqual(result.providers.map((entry) => entry.truncated), [false, false, false, true]);
  // Exactly 100 entries is not truncated; 105 is, keeping the ascending first 100 of the descending input.
  assert.equal(result.providers[1].models[0].id, 'edge-000');
  assert.equal(result.providers[1].models[99].id, 'edge-099');
  assert.equal(result.providers[3].models[0].id, 'wide-000');
  assert.equal(result.providers[3].models[99].id, 'wide-099');
  // Models sort by id ascending regardless of input order and keep only the fields the adapter disclosed.
  assert.deepEqual(result.providers[2].models, [
    { provider: 'small', id: 's-1', name: 'S 1', description: 'First small model' },
    { provider: 'small', id: 's-2', name: 'S 2', inputModalities: ['text', 'image'] },
    { provider: 'small', id: 's-3', name: 'S 3' },
  ]);
  assert.deepEqual(result.providers[0].models, [{ provider: 'anonymous', id: 'anon-1' }]);
  // The aggregate result carries only the provider groups plus the configured allowlist; there is no scalar `total` field in this contract.
  assert.deepEqual(Object.keys(result), ['providers', 'allowedModels']);
  assert.deepEqual(result.allowedModels, allowed);
  assert.equal('provider' in result, false);
  assert.equal('models' in result, false);
  assert.equal('total' in result, false);
  // Discovery discipline: one provider listing, one catalog fetch per provider, never per-model route resolution.
  assert.equal(calls.listProviders, 1);
  assert.equal(calls.listModels.length, 4);
  assert.deepEqual([...calls.listModels].sort(), ['anonymous', 'edge', 'small', 'wide']);
  assert.deepEqual(calls.resolveModelInfo, []);
  assert.deepEqual(result, jsonClone(result));
});

test('no provider: one failing catalog is isolated as a structured error while the rest still return', async () => {
  const { runtime, calls } = catalogHarness({
    providers: [
      { id: 'healthy', name: 'Healthy' },
      { id: 'broken', name: 'Broken' },
      { id: 'plain', name: 'Plain' },
      { id: 'ghost', name: 'Ghost' },
    ],
    catalogs: {
      healthy: [{ provider: 'healthy', id: 'good-2', name: 'Good 2' }, { provider: 'healthy', id: 'good-1', name: 'Good 1' }],
      broken: Object.assign(new Error('gateway catalog unavailable'), { code: 'AUTH' }),
      plain: new Error('plain failure without a code'),
      // ghost has no registered catalog: the adapter answers NO_ADAPTER.
    },
  });

  const result = await runModels(runtime);

  // The call still succeeds and every provider keeps its own entry.
  assert.deepEqual(result.providers.map((entry) => entry.provider), ['broken', 'ghost', 'healthy', 'plain']);
  // A coded catalog error keeps its stable adapter code on its own entry; models stay empty, truncation stays false.
  assert.deepEqual(result.providers[0], {
    provider: 'broken',
    name: 'Broken',
    truncated: false,
    models: [],
    error: { code: 'AUTH', message: 'gateway catalog unavailable' },
  });
  // An uncoded error degrades to MODEL_CATALOG_FAILED; an unregistered provider surfaces NO_ADAPTER.
  assert.deepEqual(result.providers[3].error, { code: 'MODEL_CATALOG_FAILED', message: 'plain failure without a code' });
  assert.deepEqual(result.providers[1].error, { code: 'NO_ADAPTER', message: 'no adapter registered for provider "ghost"' });
  // Healthy catalogs are unaffected: complete, sorted, and error-free.
  assert.deepEqual(result.providers[2], {
    provider: 'healthy',
    name: 'Healthy',
    truncated: false,
    models: [
      { provider: 'healthy', id: 'good-1', name: 'Good 1' },
      { provider: 'healthy', id: 'good-2', name: 'Good 2' },
    ],
  });
  // Containment must not skip the remaining fetches, and no allowlist was configured.
  assert.equal(calls.listModels.length, 4);
  assert.equal('allowedModels' in result, false);
  assert.deepEqual(result, jsonClone(result));
});

test('provider only: the single-provider catalog is capped at 500 entries', async () => {
  const big = Array.from({ length: 502 }, (_, index) => ({ provider: 'big', id: `big-${String(index).padStart(3, '0')}`, name: `Big ${index}` }));
  const allowed = [{ provider: 'big', model: 'big-000' }];
  const { runtime, calls } = catalogHarness({
    providers: [{ id: 'big', name: 'Big' }, { id: 'small', name: 'Small' }],
    catalogs: {
      big,
      small: [{ provider: 'small', id: 's-1' }, { provider: 'small', id: 's-2' }, { provider: 'small', id: 's-3' }],
    },
    config: { allowedModels: allowed },
  });

  const capped = await runModels(runtime, { provider: 'big' });
  assert.equal(capped.provider, 'big');
  assert.equal(capped.models.length, 500); // 502 advertised, 500 reported
  assert.equal(capped.models[0].id, 'big-000');
  assert.equal(capped.models[499].id, 'big-499');
  assert.deepEqual(capped.models[499], { provider: 'big', id: 'big-499', name: 'Big 499' });
  // The single-provider listing carries no truncation flag and no provider groups.
  assert.deepEqual(Object.keys(capped), ['provider', 'models', 'allowedModels']);
  assert.equal('truncated' in capped, false);
  assert.equal('providers' in capped, false);
  assert.deepEqual(capped.allowedModels, allowed);
  // A catalog within the cap returns whole.
  const whole = await runModels(runtime, { provider: 'small' });
  assert.equal(whole.provider, 'small');
  assert.deepEqual(whole.models.map((model) => model.id), ['s-1', 's-2', 's-3']);
  // Only the requested provider's adapter is consulted; no exact-route resolution happens.
  assert.equal(calls.listProviders, 0);
  assert.deepEqual(calls.listModels, ['big', 'small']);
  assert.deepEqual(calls.resolveModelInfo, []);
  assert.deepEqual(capped, jsonClone(capped));
  assert.deepEqual(whole, jsonClone(whole));
});

test('provider only: an unregistered provider surfaces the adapter error code', async () => {
  const { runtime, calls } = catalogHarness({
    providers: [{ id: 'known', name: 'Known' }],
    catalogs: { known: [] },
  });
  await assert.rejects(
    runModels(runtime, { provider: 'unknown' }),
    (error) => error.code === 'NO_ADAPTER' && /no adapter registered for provider "unknown"/.test(error.message),
  );
  assert.deepEqual(calls.listModels, ['unknown']);
});

test('provider and model: the exact route resolves one entry with its reasoning capabilities', async () => {
  const route = {
    provider: 'deepseek-official',
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner',
    inputModalities: ['text'],
    context: { contextWindow: 128000, maxOutputTokens: 8192 },
    defaultMaxTokens: 8192,
    reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
  };
  const allowed = [{ provider: 'deepseek-official', model: 'deepseek-reasoner' }];
  const { runtime, calls } = catalogHarness({
    providers: [{ id: 'deepseek-official', name: 'DeepSeek Official' }],
    catalogs: { 'deepseek-official': [{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
    exact: { 'deepseek-official': { 'deepseek-reasoner': route } },
    config: { allowedModels: allowed },
  });

  const result = await runModels(runtime, { provider: 'deepseek-official', model: 'deepseek-reasoner' });

  // A single route entry, never the whole catalog.
  assert.deepEqual(result, { provider: 'deepseek-official', models: [route], allowedModels: allowed });
  assert.equal(result.models.length, 1);
  // The exact form resolves metadata the catalog forms never fabricate: context, defaultMaxTokens, reasoning efforts.
  assert.deepEqual(result.models[0].reasoning, { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' });
  assert.equal(result.models[0].context.contextWindow, 128000);
  assert.equal(result.models[0].context.maxOutputTokens, 8192);
  assert.equal(result.models[0].defaultMaxTokens, 8192);
  assert.deepEqual(result.models[0].inputModalities, ['text']);
  // Exactly one adapter resolution with the requested route; no catalog walk.
  assert.deepEqual(calls.resolveModelInfo, [{ provider: 'deepseek-official', model: 'deepseek-reasoner' }]);
  assert.equal(calls.listProviders, 0);
  assert.deepEqual(calls.listModels, []);
  assert.deepEqual(result, jsonClone(result));
});

test('provider and model: unknown routes propagate the adapter error code unchanged', async () => {
  const { runtime } = catalogHarness({
    providers: [{ id: 'deepseek-official', name: 'DeepSeek Official' }],
    exact: { 'deepseek-official': { 'deepseek-reasoner': { provider: 'deepseek-official', id: 'deepseek-reasoner' } } },
  });
  // Known provider, unknown model.
  await assert.rejects(
    runModels(runtime, { provider: 'deepseek-official', model: 'missing' }),
    (error) => error.code === 'MODEL_NOT_FOUND' && /unknown model "missing"/.test(error.message),
  );
  // Unknown provider: neither the provider route nor the model exists.
  await assert.rejects(
    runModels(runtime, { provider: 'ghost', model: 'missing' }),
    (error) => error.code === 'NO_ADAPTER' && /no adapter registered for provider "ghost"/.test(error.message),
  );
});

test('parameter routing: provider alone is the catalog form and absent args stay aggregate', async () => {
  const { runtime } = catalogHarness({
    providers: [{ id: 'small', name: 'Small' }],
    catalogs: { small: [{ provider: 'small', id: 's-1' }] },
  });
  // A provider without a model is valid: it asks for the single-provider catalog listing.
  const catalogForm = await runModels(runtime, { provider: 'small' });
  assert.deepEqual(catalogForm, { provider: 'small', models: [{ provider: 'small', id: 's-1' }] });
  // No args at all routes to the aggregate summary, not an error.
  const aggregateForm = await runModels(runtime);
  assert.deepEqual(aggregateForm.providers.map((entry) => entry.provider), ['small']);
});

test('every routing form survives a JSON round trip unchanged', async () => {
  const wide = Array.from({ length: 103 }, (_, index) => ({ provider: 'multi', id: `m-${String(index).padStart(3, '0')}` }));
  const route = {
    provider: 'multi',
    id: 'm-042',
    name: 'M 42',
    reasoning: { efforts: [{ id: 'high' }], defaultEffort: 'high' },
    context: { contextWindow: 64000 },
  };
  const { runtime } = catalogHarness({
    providers: [{ id: 'multi', name: 'Multi' }, { id: 'failing', name: 'Failing' }],
    catalogs: {
      multi: wide,
      failing: Object.assign(new Error('catalog down'), { code: 'AUTH' }),
    },
    exact: { multi: { 'm-042': route } },
  });
  const aggregate = await runModels(runtime);
  const provider = await runModels(runtime, { provider: 'multi' });
  const exact = await runModels(runtime, { provider: 'multi', model: 'm-042' });
  // Includes the truncated entry and the isolated error entry.
  assert.deepEqual(aggregate, jsonClone(aggregate));
  assert.deepEqual(provider, jsonClone(provider));
  assert.deepEqual(exact, jsonClone(exact));
  // The structured error stays a plain JSON object after the trip.
  const failing = jsonClone(aggregate).providers.find((entry) => entry.provider === 'failing');
  assert.deepEqual(failing.error, { code: 'AUTH', message: 'catalog down' });
});

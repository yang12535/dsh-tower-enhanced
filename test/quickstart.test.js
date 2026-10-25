import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TowerCore } from '../lib/core.js';
import { TowerRuntime } from '../lib/runtime.js';
import { commitFile, git, makeRepo } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = path.join(root, 'README.md');
const schemaPath = path.join(root, 'lib/index.js');

/** Extract the tool's declared actions and parameter names from its real schema. */
function toolSchema() {
  const source = readFileSync(schemaPath, 'utf8');
  const actionBlock = source.match(/action:\s*\{[^}]*?enum:\s*\[([^\]]*)\]/s);
  assert.ok(actionBlock, 'could not read the tower action enum from lib/index.js');
  const actions = [...actionBlock[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
  const parametersBlock = source.match(/parameters:\s*\{([\s\S]*?)\n\s*\},\n\s*output:/);
  assert.ok(parametersBlock, 'could not read the tower parameter schema from lib/index.js');
  const parameters = [...parametersBlock[1].matchAll(/^ {6}([A-Za-z_][A-Za-z0-9_]*): \{/gm)].map((match) => match[1]);
  assert.ok(actions.includes('teardown') && parameters.includes('mission_id'), 'the extracted tool schema is implausibly incomplete');
  return { actions: new Set(actions), parameters: new Set(parameters) };
}

/** Return the source lines belonging to fenced blocks in README's Quick start. */
function quickStartCodeLines(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## Quick start\s*$/.test(line));
  assert.notEqual(start, -1, 'README.md has no Quick start section');
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const code = [];
  let fenced = false;
  for (let index = start + 1; index < end; index += 1) {
    if (/^\s*```/.test(lines[index])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) code.push({ text: lines[index], line: index + 1 });
  }
  assert.equal(fenced, false, 'README.md Quick start contains an unterminated code fence');
  return code;
}

/** Find a balanced tower(...) call, ignoring delimiters in strings and comments. */
function readTowerCall(lines, start) {
  let depth = 0;
  let quote;
  let escaped = false;
  let blockComment = false;
  const collected = [];
  for (let index = start; index < lines.length; index += 1) {
    const text = lines[index].text;
    collected.push(text);
    let lineComment = false;
    for (let column = 0; column < text.length; column += 1) {
      const char = text[column];
      const next = text[column + 1];
      if (lineComment) break;
      if (blockComment) {
        if (char === '*' && next === '/') {
          blockComment = false;
          column += 1;
        }
        continue;
      }
      if (quote !== undefined) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = undefined;
        continue;
      }
      if (char === '/' && next === '/') {
        lineComment = true;
        column += 1;
      } else if (char === '/' && next === '*') {
        blockComment = true;
        column += 1;
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        assert.ok(depth >= 0, `README.md:${lines[start].line}: unbalanced tower call`);
        if (depth === 0) {
          collected[collected.length - 1] = text.slice(0, column + 1);
          return {
            source: collected.join('\n'),
            line: lines[start].line,
            next: index,
          };
        }
      }
    }
  }
  assert.fail(`README.md:${lines[start].line}: unterminated tower(...) call`);
}

/** Parse only Quick start's actual tower({...}) calls; prose is never executed. */
function quickStartCalls(source) {
  const lines = quickStartCodeLines(source);
  const calls = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*tower\s*\(\s*\{/.test(lines[index].text)) continue;
    const call = readTowerCall(lines, index);
    calls.push(call);
    index = call.next;
  }
  return calls;
}

/**
 * Small parser for the data-only object literals used by tool documentation.
 * It accepts comments, quoted keys, arrays and primitive values, but never
 * evaluates README contents as JavaScript.
 */
function parseObjectLiteral(source, line) {
  const tokens = [];
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      index = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      assert.notEqual(close, -1, `README.md:${line}: unterminated block comment`);
      index = close + 2;
      continue;
    }
    if ('{}[]:,'.includes(char)) {
      tokens.push({ type: char, value: char });
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = '';
      let closed = false;
      for (index += 1; index < source.length; index += 1) {
        const current = source[index];
        if (current === quote) {
          closed = true;
          index += 1;
          break;
        }
        if (current !== '\\') {
          value += current;
          continue;
        }
        const escaped = source[++index];
        assert.notEqual(escaped, undefined, `README.md:${line}: unterminated string escape`);
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
        if (escaped === 'u' || escaped === 'x') {
          const length = escaped === 'u' ? 4 : 2;
          const hex = source.slice(index + 1, index + 1 + length);
          assert.match(hex, new RegExp(`^[0-9A-Fa-f]{${length}}$`), `README.md:${line}: invalid string escape`);
          value += String.fromCodePoint(Number.parseInt(hex, 16));
          index += length;
        } else if (escaped === '\n') {
          // JavaScript line continuation contributes no character.
        } else {
          value += escapes[escaped] ?? escaped;
        }
      }
      assert.ok(closed, `README.md:${line}: unterminated string`);
      tokens.push({ type: 'value', value });
      continue;
    }
    const number = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      tokens.push({ type: 'value', value: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    const identifier = source.slice(index).match(/^[A-Za-z_$][\w$]*/);
    if (identifier) {
      const word = identifier[0];
      if (word === 'true' || word === 'false' || word === 'null') {
        tokens.push({ type: 'value', value: word === 'null' ? null : word === 'true' });
      } else {
        tokens.push({ type: 'identifier', value: word });
      }
      index += word.length;
      continue;
    }
    assert.fail(`README.md:${line}: unsupported token "${char}" in tower call`);
  }

  let cursor = 0;
  const fail = (message) => assert.fail(`README.md:${line}: ${message}`);
  const take = (type) => {
    const token = tokens[cursor++];
    if (token?.type !== type) fail(`expected ${type}, got ${token?.value ?? 'end of call'}`);
    return token;
  };
  function value() {
    const token = tokens[cursor];
    if (token?.type === 'value') {
      cursor += 1;
      return token.value;
    }
    if (token?.type === '{') return object();
    if (token?.type === '[') return array();
    fail(`expected a literal value, got ${token?.value ?? 'end of call'}`);
  }
  function array() {
    take('[');
    const result = [];
    while (tokens[cursor]?.type !== ']') {
      result.push(value());
      if (tokens[cursor]?.type === ']') break;
      take(',');
    }
    take(']');
    return result;
  }
  function object() {
    take('{');
    const result = {};
    while (tokens[cursor]?.type !== '}') {
      const key = tokens[cursor++];
      if (!key || !['identifier', 'value'].includes(key.type) || typeof key.value !== 'string') fail('expected an object key');
      take(':');
      result[key.value] = value();
      if (tokens[cursor]?.type === '}') break;
      take(',');
    }
    take('}');
    return result;
  }
  const parsed = object();
  if (cursor !== tokens.length) fail(`unexpected token ${tokens[cursor]?.value}`);
  return parsed;
}

function assertSpawnResult(result, args, line) {
  for (const field of ['mission', 'role', 'runId', 'childId']) {
    assert.ok(Object.hasOwn(result, field), `README.md:${line}: spawn result is missing ${field}`);
  }
  assert.equal(result.mission, args.mission_id);
  assert.equal(result.role, args.role);
  assert.equal(typeof result.runId, 'string');
  assert.ok(result.runId.length > 0);
  assert.equal(typeof result.childId, 'string');
  assert.ok(result.childId.length > 0);
  assert.equal(result.status, `${args.role === 'worker' ? 'worker' : 'review'}_running`);
  assert.equal(result.route.provider, args.provider);
  assert.equal(result.route.model, args.model);
}

test('README Quick start executes verbatim through the real Tower runtime and Git lifecycle', async (t) => {
  const schema = toolSchema();
  const calls = quickStartCalls(readFileSync(readmePath, 'utf8')).map((call) => ({
    ...call,
    args: parseObjectLiteral(call.source.slice(call.source.indexOf('{'), call.source.lastIndexOf('}') + 1), call.line),
  }));
  // Validate every documented line before checking the sequence, so an unknown
  // action anywhere in Quick start reports its own README line rather than only
  // a generic ordering mismatch.
  for (const { args, line } of calls) {
    assert.ok(schema.actions.has(args.action), `README.md:${line}: action "${args.action}" does not exist in the tower implementation`);
    const unknown = Object.keys(args).filter((key) => !schema.parameters.has(key));
    assert.deepEqual(unknown, [], `README.md:${line}: parameter(s) not present in the tower schema: ${unknown.join(', ')}`);
  }
  assert.deepEqual(
    calls.map((call) => call.args.action),
    ['init', 'add', 'spawn', 'status', 'spawn', 'gate', 'merge', 'teardown'],
    'README Quick start must contain the complete documented init-to-teardown sequence',
  );

  const repo = makeRepo(t);
  const core = new TowerCore({ cwd: repo });
  const activations = [];
  const routes = [];
  const logs = [];
  const ctx = {
    workingDirectory: { async ensure() { return repo; } },
    sessions: { async flush() {} },
    llm: {
      async resolveCallConfig(config) {
        routes.push(config);
        return { ...config };
      },
    },
    subagents: {
      async startActivation(request) {
        let settle;
        let reject;
        const activation = {
          childId: `quickstart-child-${activations.length + 1}`,
          result: new Promise((resolve, rejectResult) => { settle = resolve; reject = rejectResult; }),
          settled: false,
          async dispose() {},
        };
        activation.settle = (value) => { activation.settled = true; settle(value); };
        activation.reject = (error) => { activation.settled = true; reject(error); };
        activation.request = request;
        activations.push(activation);
        return activation;
      },
    },
    logger: {
      warn(message) { logs.push(String(message)); },
      error(message) { logs.push(String(message)); },
    },
  };
  const agent = {
    id: 'quickstart-controller',
    options: { provider: 'controller-provider', model: 'controller-model' },
    session: { id: 'quickstart-session', header: {}, requestHeader: () => undefined },
    steer() {},
  };
  const runtime = new TowerRuntime(ctx, {});
  runtime.cores.set(repo, core);
  t.after(async () => {
    for (const activation of activations) {
      if (!activation.settled) activation.reject(new Error('test ended before fake activation settled'));
    }
    await runtime.dispose();
  });

  // Replacement boundary: only the external child agent is fake. Its controlled
  // settlement drives the production Runtime.track/Core.completeSpawn path. The
  // worker makes a real Git commit; the reviewer supplies the structured verdict
  // a real child would return. No Core, Git, gate, merge, or teardown step is mocked.
  let mission;
  let worktree;
  let branch;
  let workerCommit;
  for (const call of calls) {
    const { args } = call;
    let result;
    try {
      result = await runtime.execute(args, { agent, signal: new AbortController().signal });
    } catch (error) {
      throw new Error(`README.md:${call.line}: tower action "${args.action}" failed with its documented arguments: ${error.message}`, { cause: error });
    }

    if (args.action === 'init') {
      assert.equal(result.repoRoot, repo);
      assert.equal(result.baseBranch, 'main');
      assert.deepEqual(result.missions, []);
    } else if (args.action === 'add') {
      mission = result.mission;
      assert.equal(mission.id, args.id);
      assert.equal(mission.title, args.title);
      assert.equal(mission.description, args.description);
      assert.deepEqual(mission.scope, args.scope);
      assert.equal(mission.status, 'pending');
      worktree = mission.worktree;
      branch = mission.branch;
      assert.equal(existsSync(worktree), true);
    } else if (args.action === 'spawn') {
      assertSpawnResult(result, args, call.line);
      const current = await core.mission(args.mission_id);
      assert.equal(current.status, result.status);
      const entry = runtime.active.get(result.runId);
      const activation = activations.find((candidate) => candidate.childId === result.childId);
      assert.ok(entry && activation, `README.md:${call.line}: spawn did not register its fake activation`);
      if (args.role === 'worker') {
        workerCommit = commitFile(worktree, 'README.md', '# Quick start worker change\n', 'quickstart worker commit');
        activation.settle({ stopReason: 'completed', output: [{ type: 'text', text: 'worker completed' }] });
        await entry.done;
        assert.equal((await core.mission(args.mission_id)).status, 'worker_completed');
      } else {
        assert.equal(result.binding.reviewedCommit, workerCommit);
        activation.settle({
          stopReason: 'completed',
          output: [{ type: 'text', text: 'clean review' }],
          structured: { verdict: 'clean', merge: true, summary: 'clean', findings: [], checks: ['quick start regression'] },
        });
        await entry.done;
        assert.equal((await core.mission(args.mission_id)).status, 'approved');
      }
    } else if (args.action === 'status') {
      assert.ok(result.mission, `README.md:${call.line}: mission status result is missing mission`);
      assert.equal(result.mission.id, args.mission_id);
      assert.equal(result.mission.status, 'worker_completed');
      assert.equal(result.mission.worker.headCommit, workerCommit);
    } else if (args.action === 'gate') {
      assert.equal(typeof result.ready, 'boolean', `README.md:${call.line}: gate result is missing ready`);
      assert.ok(Array.isArray(result.blocks), `README.md:${call.line}: gate result is missing blocks`);
      assert.equal(result.ready, true);
      assert.deepEqual(result.blocks, []);
    } else if (args.action === 'merge') {
      assert.equal(result.merged, true);
      assert.equal(typeof result.mergeCommit, 'string', `README.md:${call.line}: merge result is missing mergeCommit`);
      assert.equal(result.mergeCommit, git(repo, 'rev-parse', 'HEAD'));
      assert.equal(result.mission.status, 'merged');
      assert.equal(git(repo, 'show', 'HEAD:README.md'), '# Quick start worker change');
    } else if (args.action === 'teardown') {
      assert.ok(Array.isArray(result.results));
      assert.deepEqual(result.results, [{ mission: args.mission_id, removed: true }]);
      assert.equal(existsSync(worktree), false, 'teardown must remove the registered worktree');
      assert.equal(git(repo, 'rev-parse', '--verify', branch), workerCommit, 'teardown must preserve the mission branch');
      const finalMission = await core.mission(args.mission_id);
      assert.equal(finalMission.status, 'merged');
      assert.equal(finalMission.worktreeRemoved, true);
    } else {
      assert.fail(`README.md:${call.line}: no quick-start assertion is implemented for action "${args.action}"`);
    }
  }
  assert.equal(routes.length, 2, 'both documented provider/model routes must be resolved');
  // appendPluginRecord requires a host Session instance; this lightweight agent
  // double cannot publish projections, as in the existing runtime test harness.
  assert.deepEqual(
    logs.filter((message) => !message.startsWith('Tower projection publication failed: Receiver must be an instance of class Session')),
    [],
    'the quick start must not emit unexpected runtime warnings or errors',
  );
});

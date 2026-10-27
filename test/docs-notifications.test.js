import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Read-only guard over the settlement-notification contract as documented in
// both READMEs and docs/operations.md.
//
// lib/runtime.js `track`/`settlementNotice` guarantees: every settled
// worker/reviewer run BUILDS a notice and ATTEMPTS `parent.steer`; state
// recording and projection publishing failures are contained and never
// silence that attempt. It does NOT guarantee end-to-end delivery: a failing
// steer is only logged as an error and there is no persistent retry queue
// (docs/security-model.md §"通知可能泄露…不是无限可靠的消息总线" states the
// same boundary). The docs this file pins once overpromised delivery
// ("保证送达" / "the notice still goes out") and even ruled undelivered
// notices out of investigations. This guard keeps the corrected wording from
// regressing in either direction: no overstated guarantee, and the real
// per-settle attempt guarantee plus its failure boundary stay documented.
//
// Like test/docs-consistency.test.js, this file never modifies documents.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Documents that state the settlement-notification contract. */
const DOC_FILES = ['README.md', 'README.zh-CN.md', 'docs/operations.md'];

/**
 * Per-file floor in UTF-16 code units. A deleted or emptied file must fail
 * loudly instead of passing every regex below vacuously.
 */
const MIN_LENGTHS = { 'README.md': 4000, 'README.zh-CN.md': 4000, 'docs/operations.md': 10000 };

/** Load one pinned document, failing on a missing or gutted file. */
function loadDoc(rel) {
  const abs = path.join(root, rel);
  assert.ok(existsSync(abs), `${rel} is missing; the notification-contract guard cannot run against it`);
  const text = readFileSync(abs, 'utf8');
  assert.ok(
    text.length >= MIN_LENGTHS[rel],
    `${rel} shrank to ${text.length} characters (expected >= ${MIN_LENGTHS[rel]}); ` +
      'the notification-contract guard would be vacuous',
  );
  return text;
}

/**
 * Overpromising phrasings that must never come back, paired with the exact
 * old claim each one encodes. The Chinese list bans the bare phrase
 * 保证送达 outright, so the corrected docs deliberately avoid reusing it even
 * inside negations (they say 尽力而为 / 不构成端到端保证 instead).
 */
const FORBIDDEN = [
  // README.md once claimed "Failure always reaches the controller" and that
  // "the notice still goes out" — end-to-end delivery the runtime cannot
  // promise once parent.steer itself can fail.
  { pattern: /Failure always reaches the controller/, why: 'EN: failure always reaches the controller' },
  { pattern: /the notice still goes out/, why: 'EN: notice always goes out even if delivery fails' },
  { pattern: /sends the controller an outcome notice/, why: 'EN: outcome notice phrased as accomplished delivery' },
  { pattern: /guaranteed delivery/, why: 'EN: blanket guaranteed-delivery claim' },
  // README.zh-CN.md 的旧措辞：失败一定会通知控制器 / 通知也仍会发出。
  { pattern: /失败一定会通知控制器/, why: 'ZH: 失败一定会通知控制器' },
  { pattern: /通知也仍会发出/, why: 'ZH: 通知也仍会发出（端到端送达承诺）' },
  { pattern: /也仍会发送通知/, why: 'ZH: 也仍会发送通知（把尝试说成送达）' },
  { pattern: /保证送达/, why: 'ZH: 保证送达（实现没有持久重试队列，做不到）' },
  // docs/operations.md once declared silent failure "not a scenario that
  // needs investigation" and that a failed delivery is "never silent" —
  // both hide the real best-effort boundary from operators.
  { pattern: /「静默失败」不是需要排查的场景/, why: 'ZH: 把「静默失败」排除出排查范围' },
  { pattern: /绝不静默/, why: 'ZH: 投递失败"绝不静默"的绝对化承诺' },
];

test('notification docs exist and stay substantial (no vacuous pass)', () => {
  for (const rel of DOC_FILES) {
    const text = loadDoc(rel);
    assert.ok(text.includes('Tower') || text.includes('tower'), `${rel} no longer mentions Tower at all`);
  }
});

test('no doc promises guaranteed end-to-end settlement delivery', () => {
  for (const rel of DOC_FILES) {
    const text = loadDoc(rel);
    for (const { pattern, why } of FORBIDDEN) {
      assert.ok(
        !pattern.test(text),
        `${rel} still contains the overpromising wording (${why}); ` +
          'settlement notices are best-effort: generated and attempted per settle, but the steer itself can fail with only an error log',
      );
    }
  }
});

test('operations keeps the real guarantee: every settle builds a notice and attempts delivery', () => {
  const ops = loadDoc('docs/operations.md');
  // §2.10 body: generation + attempt per settle ...
  assert.match(ops, /每个 worker\/reviewer 落定都会生成/, '§2.10 must state the notice is generated for every settled run');
  assert.match(ops, /并尝试 (steer|投递)/, '§2.10 must state delivery is attempted, not accomplished');
  // ... and state/projection failures are isolated from that attempt.
  assert.match(
    ops,
    /即使 state 落账或投影发布失败，这次投递尝试也仍会进行/,
    '§2.10 must keep the isolation guarantee: state/projection failure does not stop the notice attempt',
  );
  // The section heading itself must not promise delivery.
  assert.match(ops, /### 2\.10 运行期通知（[^）]*投递[^）]*）/, '§2.10 heading must frame the notice as attempted delivery');
});

test('operations states the delivery boundary: steer failure logged, no persistent retry, status/logs as fallback', () => {
  const ops = loadDoc('docs/operations.md');
  assert.match(ops, /仅记 error 日志/, '§2.10/§3.15 must say a failed steer is only logged as an error');
  assert.match(ops, /没有持久重试/, '§2.10 must state there is no persistent retry queue');
  // A missing notice is itself an investigation scenario with a named fallback.
  assert.match(ops, /[未没]收到通知/, 'operations must treat a missing notice as observable, not impossible');
  assert.match(ops, /error 日志兜底/, 'operations must name the status/log fallback for missing notices');
});

test('both READMEs keep the same best-effort delivery contract (en/zh parity)', () => {
  const en = loadDoc('README.md');
  assert.match(en, /delivery is attempted, not guaranteed/, 'EN README must frame delivery as attempted');
  assert.match(
    en,
    /even when state recording or projection publishing fails, the attempt still happens/,
    'EN README must keep the isolation guarantee',
  );
  assert.match(en, /only logged as an error with no persistent retry/, 'EN README must state the no-retry boundary');
  assert.match(en, /attempts to steer the controller an outcome notice/, 'EN README feature list must phrase notice as an attempt');

  const zh = loadDoc('README.zh-CN.md');
  assert.match(zh, /投递是尽力而为/, 'ZH README must frame delivery as best-effort');
  assert.match(zh, /即使状态记录或投影发布失败，这次尝试也仍会进行/, 'ZH README must keep the isolation guarantee');
  assert.match(zh, /仅记 error 日志、没有持久重试/, 'ZH README must state the logged-only, no-retry boundary');
  assert.match(zh, /都会生成结果通知并尝试投递给控制器/, 'ZH README feature list must phrase notice as generated + attempted');
});

test('operations §3.15 routes the models lookup to §2.9 (where models lives), not §2.3 (spawn worker)', () => {
  const ops = loadDoc('docs/operations.md');
  const rateLimitRows = ops.split(/\r?\n/).filter((line) => line.includes('供应商限流'));
  assert.ok(rateLimitRows.length > 0, '§3.15 supplier-rate-limit rows not found');
  const row = rateLimitRows.find((line) => line.includes('换路由'));
  assert.ok(row, '§3.15 supplier-rate-limit disposition row (换路由或等窗口) not found');
  assert.match(row, /`models`/, 'the rate-limit row should keep pointing operators at the `models` action');
  assert.match(row, /§2\.9/, 'the models cross-reference must be §2.9');
  assert.ok(!/§2\.3/.test(row), 'the models cross-reference must not point at §2.3 (spawn worker)');

  // Ground the reference: §2.9 must actually be the section documenting `models`.
  const section29 = ops.match(/### 2\.9[\s\S]*?(?=\n### |\n## )/);
  assert.ok(section29, '§2.9 section not found in operations.md');
  assert.match(section29[0], /`models`：/, '§2.9 must document the `models` action for the cross-reference to be meaningful');
});

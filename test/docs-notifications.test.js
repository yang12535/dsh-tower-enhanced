import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Read-only guard over the settlement-notification contract as documented in
// both READMEs, docs/operations.md, and docs/architecture.md.
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
const DOC_FILES = ['README.md', 'README.zh-CN.md', 'docs/operations.md', 'docs/architecture.md'];

/**
 * Per-file floor in UTF-16 code units. A deleted or emptied file must fail
 * loudly instead of passing every regex below vacuously.
 */
const MIN_LENGTHS = {
  'README.md': 4000,
  'README.zh-CN.md': 4000,
  'docs/operations.md': 10000,
  'docs/architecture.md': 20000,
};

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

/**
 * The settlement-notice final-line contract (lib/runtime.js
 * `settlementNotice`, pinned by test/runtime.test.js track/settlement cases):
 * a regular notice is first line `Tower <role> for <mission> <outcome>:
 * mission status <status>` → next-action line → physical LAST line
 * `stopReason: <actual value>`; when the run could not be recorded in Tower
 * state at all, a run-diagnostic line (`run <runId> could not be recorded in
 * Tower state`) precedes the next action, and the last physical line is still
 * the stop reason; failed/interrupted/stale outcomes append `; reason:
 * <bounded reason>` on that same line; a missing stop reason is reported as
 * `unknown`; line breaks and repeated whitespace inside stopReason/reason
 * collapse to one space so the final line stays single-line, with the reason
 * still capped at 500 characters; and when the model completed but state
 * recording failed, the stop reason keeps `completed` (the recording error
 * moves into `reason`) instead of being rewritten as an error.
 *
 * The M80 runtime change made all of that true; these docs then still
 * described only the summary line, `reason`, and Next. Each notification doc
 * must carry every point below — this is a keyword/regex checklist per file,
 * not full-text equality, so rewording around the pinned keywords stays free.
 */
const ZH_FINAL_LINE_POINTS = [
  // Regular notice order: summary first line, then the next-action line.
  { pattern: /常规形态是首行/, why: '常规顺序：首行概要 → next action 行' },
  // The unrecordable-run fallback inserts a run-diagnostic line before Next
  // (test/runtime.test.js "an unrecordable run still notifies…").
  { pattern: /Next 之前另有一行 `run <runId> could not be recorded in Tower state`/, why: 'run 无法落账时 Next 前插入 run 诊断行' },
  // The final physical line reports the actual stop reason — not just the
  // first-line summary shape — in BOTH the regular and fallback shapes.
  { pattern: /物理末行固定是 `stopReason: <实际值>`/, why: '末行固定报告实际 stopReason' },
  // failed/interrupted/stale carry the bounded reason on that same line.
  { pattern: /在同一行追加 `; reason: <有界原因>`/, why: 'failed/interrupted/stale 同一行的有界 reason' },
  // A missing stop reason is reported as unknown, never invented.
  { pattern: /stopReason 缺失时末行报告 `unknown`/, why: '缺失 stopReason 报告 unknown' },
  // Newlines/repeated whitespace collapse so the final line stays one line.
  { pattern: /换行和连续空白都会折叠成一个空格/, why: 'stopReason/reason 单行化折叠' },
  // Model completion survives a state-recording failure.
  { pattern: /不会把完成伪写成 error/, why: 'state 落账失败不把 completed 伪写成 error' },
  // The reason bound stays 500 characters.
  { pattern: /500 字符/, why: 'reason 最多 500 字符' },
];

const FINAL_LINE_CONTRACT = [
  {
    rel: 'README.md',
    points: [
      // Regular notice order: summary first line, then the next-action line.
      { pattern: /first line `Tower <role> for <mission> <outcome>: mission status <status>`, then the next-action line/, why: 'regular order: summary line, then next action' },
      // The unrecordable-run fallback inserts a run-diagnostic line before Next.
      { pattern: /run-diagnostic line \(`run <runId> could not be recorded in Tower state`\) precedes the next action/, why: 'unrecordable-run fallback inserts a run-diagnostic line before Next' },
      // Final physical line reports the actual stop reason.
      { pattern: /The physical last line is always `stopReason: <actual value>`/, why: 'final physical line = actual stopReason' },
      { pattern: /append `; reason: <bounded reason>`[^\n]*on that same (?:last )?line/, why: 'failed/interrupted/stale same-line bounded reason' },
      { pattern: /A missing stop reason reports `unknown`/, why: 'missing stop reason reports unknown' },
      { pattern: /line breaks or repeated whitespace inside the stop reason or reason are collapsed to a single line/, why: 'single-line folding of stopReason/reason' },
      { pattern: /completion is never rewritten as an error/, why: 'state-recording failure keeps completed' },
      { pattern: /500 characters/, why: 'reason capped at 500 characters' },
    ],
  },
  { rel: 'README.zh-CN.md', points: ZH_FINAL_LINE_POINTS },
  { rel: 'docs/operations.md', points: ZH_FINAL_LINE_POINTS },
  { rel: 'docs/architecture.md', points: ZH_FINAL_LINE_POINTS },
];

test('every notification doc pins the settlement final-line stopReason contract', () => {
  for (const { rel, points } of FINAL_LINE_CONTRACT) {
    const text = loadDoc(rel);
    for (const { pattern, why } of points) {
      assert.ok(
        pattern.test(text),
        `${rel} lost a final-line contract point (${why}); lib/runtime.js settlementNotice ends every ` +
          'settlement notice with `stopReason: <actual value>` and a same-line bounded reason for ' +
          'failed/interrupted/stale outcomes',
      );
    }
  }
});

test('architecture frames notices as generate-and-attempt only, never guaranteed delivery', () => {
  const arch = loadDoc('docs/architecture.md');
  // §3.4 must own the explicit semantics that replaced the old 「保证送达」
  // label: only generation + attempt per settle is guaranteed.
  assert.match(
    arch,
    /只保证[^\n]*生成并尝试投递/,
    '§3.4 must state only generation-and-attempt is guaranteed',
  );
  assert.match(
    arch,
    /不承诺端到端送达/,
    '§3.4 must deny end-to-end delivery explicitly',
  );
  // The section heading itself must not revive a delivery guarantee.
  assert.match(arch, /### 3\.4 落定通知：只保证生成并尝试投递/, '§3.4 heading must keep the generate-and-attempt framing');
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

test('operations §3.14 corrupt-state runbook keeps the fallback attempt, not silence', () => {
  const ops = loadDoc('docs/operations.md');
  const section = ops.match(/### 3\.14[^\n]*\n[\s\S]*?(?=\n### |\n## )/);
  assert.ok(section, '§3.14 state-recovery runbook not found in operations.md');
  const body = section[0];

  // Reverse assertion: losing `status` must not be described as losing the
  // notice too. lib/runtime.js `track` still runs completeSpawn -> failSpawn
  // -> publish -> settlementNotice -> parent.steer after a state failure, and
  // test/runtime.test.js "an unrecordable run still notifies with role,
  // mission, run, and error" pins exactly one fallback notice when BOTH
  // completeSpawn and failSpawn reject. Claiming corrupt state suppresses
  // generation/delivery is the same false reliability boundary, inverted.
  const SILENCE_CLAIMS = [
    /结算通知也[^。\n]*(不会|不再)[^。\n]*(生成|投递)/,
    /不会再生成投递/,
    /不再生成通知/,
    /通知(也)?不会(再)?(生成|投递)/,
    /结算通知[^。\n]*(停止|失败)[^。\n]*(生成|投递)/,
  ];
  for (const pattern of SILENCE_CLAIMS) {
    assert.ok(
      !pattern.test(body),
      `§3.14 claims corrupt state silences settlement notices (${pattern}); ` +
        'runtime still builds the fallback notice and attempts parent.steer after state failures',
    );
  }

  // Forward assertion: the runbook must state the accurate boundary instead —
  // status view gone, notice degraded to a fallback attempt that cannot
  // confirm what was recorded.
  assert.match(body, /`?status`?[^\n。]*不可用/, '§3.14 must say the status view is unavailable when state is corrupt');
  assert.match(body, /兜底/, '§3.14 must say the notice degrades to a fallback attempt instead of disappearing');
  assert.match(body, /role\/mission\/run\/error/, '§3.14 must name the fallback notice fields');
  assert.match(body, /不能据此确认/, '§3.14 must warn that a fallback notice cannot confirm the state was recorded');
  assert.match(body, /§2\.10/, '§3.14 must cross-reference §2.10 for the notification boundary');

  // Ground the fallback vocabulary in §2.10 itself, so §3.14 cannot invent a
  // contract the notification section does not state.
  const section210 = ops.match(/### 2\.10[^\n]*\n[\s\S]*?(?=\n### |\n## )/);
  assert.ok(section210, '§2.10 notification section not found in operations.md');
  assert.match(
    section210[0],
    /最差退化为点名 role\/mission\/run\/error/,
    '§2.10 must describe the same fallback notice that §3.14 refers to',
  );
});

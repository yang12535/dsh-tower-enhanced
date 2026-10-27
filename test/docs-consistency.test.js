import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Read-only consistency check between the documented `tower` tool actions and
// the action enum declared by the tool schema in lib/index.js. The scan never
// modifies any document: drift is reported, not fixed, so the schema stays the
// single source of truth.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Documents that mention `tower({action:"…"})` calls or action names. Missing files are skipped. */
const DOC_FILES = [
  'README.md',
  'README.zh-CN.md',
  'docs/architecture.md',
  'docs/operations.md',
  'docs/security-model.md',
];

/** Parse the tower tool's `parameters.action.enum` straight out of the defineTool source. */
function schemaActions() {
  const source = readFileSync(path.join(root, 'lib/index.js'), 'utf8');
  const block = source.match(/action:\s*\{[^}]*?enum:\s*\[([^\]]*)\]/s);
  assert.ok(
    block,
    'could not locate the `action` property with its `enum` array in lib/index.js (tool schema drifted?)',
  );
  const values = [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.ok(
    values.length >= 10,
    `parsed an implausibly small action enum from lib/index.js: [${values.join(', ')}]`,
  );
  assert.ok(new Set(values).size === values.length, `duplicate action names in the schema enum: [${values.join(', ')}]`);
  return values;
}

/**
 * Collect every documented tower action mention in a markdown source.
 * Recognized forms, reported with 1-based line numbers:
 *   - `action:"x"` / `action:'x'` / `action: "x"` (option lists, code samples)
 *   - backtick-wrapped `action=x`, e.g. `tower action=recover`
 */
function documentedActions(source) {
  const found = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const lineNo = index + 1;
    for (const match of line.matchAll(/action\s*:\s*["']([^"']+)["']/g)) {
      found.push({ file: null, line: lineNo, action: match[1] });
    }
    for (const span of line.matchAll(/`([^`]*)`/g)) {
      for (const match of span[1].matchAll(/\baction=([A-Za-z_-]+)\b/g)) {
        found.push({ file: null, line: lineNo, action: match[1] });
      }
    }
  });
  return found;
}

test('documented tower actions all exist in the tool schema enum', () => {
  const enumValues = schemaActions();
  const known = new Set(enumValues);
  const scanned = [];
  const violations = [];
  const distinct = new Set();

  for (const rel of DOC_FILES) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) continue; // 存在才扫
    scanned.push(rel);
    for (const entry of documentedActions(readFileSync(abs, 'utf8'))) {
      entry.file = rel;
      distinct.add(entry.action);
      if (!known.has(entry.action)) violations.push(entry);
    }
  }

  assert.ok(
    violations.length === 0,
    `documents reference tower actions that are not in the schema enum [${enumValues.join(', ')}]:\n`
      + violations.map((v) => `  - ${v.file}:${v.line}: action "${v.action}"`).join('\n'),
  );

  // Guard against a vacuous pass: the usage walkthroughs must really mention
  // actions, and the scan as a whole must cover a meaningful spread of them.
  // docs/architecture.md and docs/security-model.md carry no per-file minimum
  // because they legitimately may not use the `action:"…"` / `action=` forms.
  const perFile = new Map();
  for (const rel of scanned) {
    perFile.set(rel, documentedActions(readFileSync(path.join(root, rel), 'utf8')).length);
  }
  for (const rel of ['README.md', 'README.zh-CN.md']) {
    assert.ok(
      perFile.get(rel) >= 5,
      `${rel} mentions only ${perFile.get(rel) ?? 0} tower actions (expected >= 5); the extraction pattern or the doc drifted`,
    );
  }
  assert.ok(
    distinct.size >= 6,
    `the scanned documents only cover ${distinct.size} distinct tower actions (expected >= 6): [${[...distinct].join(', ')}]`,
  );
});

// --- 「纯枚举列表」form (M31) -------------------------------------------------
// Shapes recognized, ≥6 identifiers per run, reported with 1-based line numbers:
//   - backtick lists:  `init`、`add`、…  or  `init`, `add`, …  or  `init` / `add` / …
//   - bare slash lists: init / add / edit / …
const BACKTICK_ENUM_RUN = /`[A-Za-z][A-Za-z_-]*`(?:\s*[、，,;；/]\s*`[A-Za-z][A-Za-z_-]*`)+/g;
const SLASH_ENUM_RUN = /\b[A-Za-z][A-Za-z_-]*(?:\s*\/\s*[A-Za-z][A-Za-z_-]*){5,}/g;

/** Extract enumeration runs of ≥6 identifiers per line of a markdown source. */
function enumerationRuns(source) {
  const runs = [];
  source.split(/\r?\n/).forEach((line, index) => {
    for (const pattern of [BACKTICK_ENUM_RUN, SLASH_ENUM_RUN]) {
      for (const match of line.matchAll(pattern)) {
        const tokens = [...match[0].matchAll(/[A-Za-z][A-Za-z_-]*/g)].map((m) => m[0]);
        if (tokens.length >= 6) runs.push({ line: index + 1, tokens });
      }
    }
  });
  return runs;
}

// Tradeoff taken here (vs. the weaker "⊆ enum and must mention summary and edit"
// fallback): a run of ≥6 identifiers that are ALL schema actions is read as a claim
// about the complete action inventory, because every legitimate partial mention in
// the corpus mixes action names with other identifiers — docs/architecture.md's
// `TowerCore`/`TowerRuntime`/git-method tables and docs/operations.md's status
// sets (`pending`, `worker_completed`, …) never consist of action names alone.
// Mixed runs inside docs/* are therefore skipped on purpose; a mixed run inside a
// README that still contains ≥6 real action names is treated as drift (a phantom
// action left behind), since the READMEs' only ≥6 enumerations are the action
// inventories themselves. If a README ever needs a genuinely partial list, it
// should avoid the ≥6-name enumeration shape or this test must be revisited.
test('pure action enumeration lines cover the full schema enum', () => {
  const enumValues = schemaActions();
  const known = new Set(enumValues);
  const pureRuns = [];

  for (const rel of DOC_FILES) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) continue;
    const isReadme = rel === 'README.md' || rel === 'README.zh-CN.md';
    for (const run of enumerationRuns(readFileSync(abs, 'utf8'))) {
      const foreign = [...new Set(run.tokens.filter((token) => !known.has(token)))];
      if (foreign.length > 0) {
        if (isReadme && run.tokens.length - foreign.length >= 6) {
          assert.fail(
            `${rel}:${run.line} enumerates schema actions mixed with identifiers that are not in the enum [${enumValues.join(', ')}]: `
              + `${foreign.join(', ')} — README action lists must be pure; remove the phantom names`,
          );
        }
        continue; // docs/* legitimately enumerate methods/statuses/fields next to action names
      }
      pureRuns.push({ file: rel, line: run.line });
      const missing = enumValues.filter((action) => !run.tokens.includes(action));
      assert.ok(
        missing.length === 0,
        `${rel}:${run.line} action enumeration is missing schema actions: ${missing.join(', ')} `
          + `(documented: [${run.tokens.join(', ')}], schema: [${enumValues.join(', ')}])`,
      );
    }
  }

  // Guard against a vacuous pass: the enumeration form must actually be covered,
  // and a README must keep enumerating the full action inventory (README.zh-CN.md
  // documents 「可用的 action：…」; dropping or rewording it away must fail loudly).
  assert.ok(
    pureRuns.length >= 1,
    'no pure action enumeration run (≥6 schema action names) was found in any scanned doc; the extractor or the docs drifted',
  );
  assert.ok(
    pureRuns.some((run) => run.file === 'README.md' || run.file === 'README.zh-CN.md'),
    'neither README enumerates the available actions anymore; restore a complete `init`、`add`、… inventory or update this test',
  );
});

test('docs/architecture.md action enum line covers every schema action', (t) => {
  const abs = path.join(root, 'docs/architecture.md');
  if (!existsSync(abs)) {
    t.skip('docs/architecture.md does not exist; nothing to compare');
    return;
  }
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  // Heuristic: the「动作枚举」line is the one spelling a long `init / add / …`
  // slash list. Require a run of at least six names so short incidental
  // mentions (e.g. "init/add/edit/spawn" in the component table) never match,
  // and keep the longest run when several lines qualify.
  let best = null;
  lines.forEach((line, index) => {
    const run = line.match(/init(?:\s*\/\s*[A-Za-z_-]+){5,}/);
    if (run && (!best || run[0].length > best.run.length)) {
      best = { lineNo: index + 1, run: run[0] };
    }
  });
  if (!best) {
    t.skip('could not locate an "init / add / …" action enum line in docs/architecture.md; skipping the full-coverage comparison');
    return;
  }
  const parsed = best.run.split('/').map((token) => token.trim());
  const enumValues = schemaActions();
  assert.ok(
    parsed.length >= 6,
    `parsed an implausibly short action list at docs/architecture.md:${best.lineNo}: [${parsed.join(', ')}]`,
  );
  const missing = enumValues.filter((action) => !parsed.includes(action));
  assert.ok(
    missing.length === 0,
    `docs/architecture.md:${best.lineNo} action enum line is missing schema actions: ${missing.join(', ')}`
      + ` (documented: [${parsed.join(', ')}], schema: [${enumValues.join(', ')}])`,
  );
  const unknown = parsed.filter((action) => !enumValues.includes(action));
  assert.ok(
    unknown.length === 0,
    `docs/architecture.md:${best.lineNo} action enum line lists actions that are not in the schema enum: ${unknown.join(', ')}`
      + ` (documented: [${parsed.join(', ')}], schema: [${enumValues.join(', ')}])`,
  );
});

// --- doctor finding-code count guard (M73) -----------------------------------
// docs/architecture.md §8.1 claims「当前共有 N 个 finding code」. That number
// drifted twice before (M46/M62/M63) because nothing compared it with the
// implementation. This guard extracts the real code inventory from
// scripts/tower-doctor.mjs, cross-checks it against the closed whitelist in
// test/doctor-json-schema.test.js, and then requires every「N 个 finding code」
// claim in the docs to state exactly that number. docs/architecture.md owns the
// claim, so it must keep stating the number explicitly (deleting the number is
// also drift); docs/operations.md never carries the count and is only checked
// for a mismatching claim should one ever appear there.

/** Uppercase snake-case shape shared by every tower-doctor finding code. */
const FINDING_CODE_SHAPE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Extract the set of finding codes scripts/tower-doctor.mjs can emit, straight
 * from the implementation source. Recognizes both call shapes used today:
 *   - literal first argument: fail('STATE_CORRUPT', …) / finding('ORPHAN_WORKTREE', …)
 *   - identifier first argument resolved from the `'A' : 'B'` ternary branch
 *     pairs of every `const <id> = …;` initializer — the doctor has two
 *     distinct `const code =` declarations in different helper scopes, and the
 *     emitted pair (STATE_MISSING / STATE_READ_FAILED) lives in a ternary next
 *     to an `=== 'ENOENT'` comparison literal that is not a code.
 * The `function finding(code, …)` definition is skipped via lookbehind, and a
 * call site whose first argument matches neither shape fails loudly instead of
 * being silently dropped (which could otherwise make the guard pass vacuously).
 */
function doctorFindingCodes() {
  const source = readFileSync(path.join(root, 'scripts/tower-doctor.mjs'), 'utf8');
  const codes = new Set();
  const callSites = [...source.matchAll(/(?<!function )\b(?:finding|fail)\(/g)].length;
  let captured = 0;
  for (const call of source.matchAll(/(?<!function )\b(?:finding|fail)\(\s*('([^']*)'|[A-Za-z_$][\w$]*)/g)) {
    captured += 1;
    if (call[2] !== undefined) {
      codes.add(call[2]);
      continue;
    }
    const resolved = new Set();
    for (const declaration of source.matchAll(new RegExp(`\\bconst ${call[1]} = ([^;]*);`, 'g'))) {
      // Only ternary branch pairs (`? 'A' : 'B'`) name emitted codes; other
      // quoted literals in the initializer are comparisons (e.g. `=== 'ENOENT'`).
      for (const branch of declaration[1].matchAll(/\?\s*'([^']*)'\s*:\s*'([^']*)'/g)) {
        for (const code of branch.slice(1)) {
          if (FINDING_CODE_SHAPE.test(code)) resolved.add(code);
        }
      }
    }
    assert.ok(
      resolved.size > 0,
      `could not resolve the finding-code argument \`${call[1]}\` in scripts/tower-doctor.mjs; `
        + 'the doctor switched to a new call shape — extend doctorFindingCodes() in test/docs-consistency.test.js',
    );
    for (const code of resolved) codes.add(code);
  }
  assert.ok(
    captured === callSites,
    `doctorFindingCodes() recognized the first argument of ${captured}/${callSites} finding()/fail() call sites `
      + 'in scripts/tower-doctor.mjs — a call shape changed, extend the extractor in test/docs-consistency.test.js',
  );
  for (const code of codes) {
    assert.ok(FINDING_CODE_SHAPE.test(code), `extracted a malformed doctor finding code: ${code}`);
  }
  assert.ok(
    codes.size >= 20,
    `extracted an implausibly small finding-code inventory (${codes.size}) from scripts/tower-doctor.mjs; the extractor or the doctor drifted`,
  );
  return codes;
}

/** Parse the KNOWN_FINDING_CODES whitelist out of the doctor contract test (no import: that would re-register its tests). */
function whitelistedFindingCodes() {
  const source = readFileSync(path.join(root, 'test/doctor-json-schema.test.js'), 'utf8');
  const block = source.match(/const KNOWN_FINDING_CODES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(block, 'could not locate KNOWN_FINDING_CODES in test/doctor-json-schema.test.js (contract test drifted?)');
  const codes = new Set([...block[1].matchAll(/'([^']*)'/g)].map((match) => match[1]));
  assert.ok(
    codes.size >= 20,
    `parsed an implausibly small KNOWN_FINDING_CODES whitelist (${codes.size}) from test/doctor-json-schema.test.js`,
  );
  return codes;
}

/** Find every「N 个 finding code」count claim in a markdown source, with 1-based line numbers. */
function findingCodeCountClaims(source) {
  const claims = [];
  source.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(/(\d+)\s*个\s*finding\s*code/gi)) {
      claims.push({ line: index + 1, count: Number(match[1]) });
    }
  });
  return claims;
}

test('doctor finding-code whitelist matches the implementation inventory', () => {
  const implemented = doctorFindingCodes();
  const whitelisted = whitelistedFindingCodes();
  const missingFromWhitelist = [...implemented].filter((code) => !whitelisted.has(code));
  const staleInWhitelist = [...whitelisted].filter((code) => !implemented.has(code));
  assert.ok(
    missingFromWhitelist.length === 0 && staleInWhitelist.length === 0,
    `test/doctor-json-schema.test.js KNOWN_FINDING_CODES no longer matches scripts/tower-doctor.mjs `
      + `(implementation: ${implemented.size} codes, whitelist: ${whitelisted.size})\n`
      + `  missing from whitelist: ${missingFromWhitelist.join(', ') || '(none)'}\n`
      + `  no longer emitted: ${staleInWhitelist.join(', ') || '(none)'}`,
  );
});

/**
 * Collect every finding-code count-claim problem, diffed against the real
 * inventory size. Dependency-injected on purpose — `readDoc(rel)` returns the
 * document's content, or `null` when it does not exist — so the regression
 * tests below drive this exact helper with in-memory fixtures instead of a
 * parallel copy of the logic that would merely vouch for itself.
 * docs/architecture.md owns the count claim: it must exist (a missing file
 * used to `continue` the loop, letting the whole guard pass vacuously) and it
 * must state the number explicitly. docs/operations.md stays an optional scan
 * target: it never carries the claim, so only a mismatching claim, should one
 * ever appear there, is reported.
 */
function findingCodeCountProblems(expected, readDoc) {
  const problems = [];
  for (const rel of ['docs/architecture.md', 'docs/operations.md']) {
    const source = readDoc(rel);
    if (source === null) {
      if (rel === 'docs/architecture.md') {
        problems.push(
          `docs/architecture.md is missing; the finding-code count guard cannot run — restore it, `
            + `§8.1 must explicitly state the real count「${expected} 个 finding code」`,
        );
      }
      continue; // docs/operations.md is an optional scan target
    }
    const claims = findingCodeCountClaims(source);
    for (const claim of claims) {
      if (claim.count !== expected) {
        problems.push(`${rel}:${claim.line} claims ${claim.count} finding codes but the doctor emits ${expected}`);
      }
    }
    if (rel === 'docs/architecture.md') {
      // The architecture reference owns the count: removing the explicit
      // number must fail loudly instead of letting the guard pass vacuously.
      if (claims.length === 0) {
        problems.push(
          `docs/architecture.md no longer states a「${expected} 个 finding code」count claim; restore the explicit number (§8.1) so the guard stays meaningful`,
        );
      }
    }
  }
  return problems;
}

test('docs state the real tower-doctor finding-code count', () => {
  const expected = doctorFindingCodes().size;
  const problems = findingCodeCountProblems(expected, (rel) => {
    const abs = path.join(root, rel);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  });
  assert.ok(
    problems.length === 0,
    `doctor finding-code count drift (implementation: ${expected} codes in scripts/tower-doctor.mjs)\n  - `
      + problems.join('\n  - '),
  );
});

// Regression fixtures (M78): pin down every mode of the count guard by feeding
// the SAME findingCodeCountProblems() helper in-memory documents. A missing
// docs/architecture.md must fail closed; a present-but-silent or mismatching
// file must fail; the correct count (with docs/operations.md absent, as it is
// merely an optional scan target) must pass.
test('finding-code count guard fails closed when docs/architecture.md is missing', () => {
  const problems = findingCodeCountProblems(12, (rel) => (rel === 'docs/architecture.md' ? null : '# 运维\n'));
  assert.equal(problems.length, 1, `expected exactly the missing-file problem, got: [${problems.join(' | ')}]`);
  assert.match(problems[0], /docs\/architecture\.md is missing/);
});

test('finding-code count guard fails when architecture exists but states no count', () => {
  const problems = findingCodeCountProblems(12, (rel) =>
    (rel === 'docs/architecture.md' ? '# 架构\n\n§8.1 只字未提数量。\n' : null));
  assert.equal(problems.length, 1, `expected exactly the no-claim problem, got: [${problems.join(' | ')}]`);
  assert.match(problems[0], /no longer states a「12 个 finding code」count claim/);
});

test('finding-code count guard fails on a mismatching count in any scanned doc', () => {
  const problems = findingCodeCountProblems(12, (rel) =>
    (rel === 'docs/architecture.md'
      ? '§8.1 doctor 当前共有 11 个 finding code，覆盖状态与孤立项检查。\n'
      : '故障排查参考共 11 个 finding code。\n'));
  assert.equal(problems.length, 2, `expected one problem per scanned doc, got: [${problems.join(' | ')}]`);
  assert.match(problems[0], /docs\/architecture\.md:1 claims 11 finding codes but the doctor emits 12/);
  assert.match(problems[1], /docs\/operations\.md:1 claims 11 finding codes but the doctor emits 12/);
});

test('finding-code count guard passes on the correct count with operations absent', () => {
  const problems = findingCodeCountProblems(12, (rel) =>
    (rel === 'docs/architecture.md' ? '§8.1 doctor 当前共有 12 个 finding code，覆盖状态与孤立项检查。\n' : null));
  assert.deepEqual(problems, []);
});

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

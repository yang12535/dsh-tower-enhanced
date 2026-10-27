import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Read-only semantic-parity guard between README.md and README.zh-CN.md.
//
// test/i18n.test.js keeps the *UI dictionaries* in lib/client.js in sync at the
// key/placeholder level, but the two READMEs are prose: a constraint documented
// in one language and silently dropped from the other (audit M67 p2: the zh
// README long documented the spawn route rules while the en README only showed
// examples) is invisible to key/placeholder checks. A full-text diff is not the
// answer either — translations legitimately differ in wording, ordering, and
// detail. Instead, this file pins a curated keyword list: the behavioral
// constraints the Configure section must state in BOTH languages. Each list
// entry names the enforcement point in lib/runtime.js so a reworded error
// message or a changed validation triggers a conscious update of both files.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const READMES = { en: 'README.md', zh: 'README.zh-CN.md' };

/**
 * Key config/routing constraints that must appear in both READMEs.
 * Each entry pairs the en and zh phrasing of one constraint and records why
 * the constraint matters. Enforced in TowerRuntime (lib/runtime.js):
 * resolveRoute validates per-spawn routes; config parsing validates
 * allowedModels and role defaults.
 */
const CONSTRAINTS = [
  {
    // lib/runtime.js resolveRoute rejects provider-without-model (and the
    // reverse) with MODEL_ROUTE_INCOMPLETE; the tool schema in lib/index.js
    // repeats the rule. Dropping this sentence from either README reintroduces
    // the exact M67 p2 drift: examples that never state the pairing rule.
    id: 'spawn provider/model must be supplied together (MODEL_ROUTE_INCOMPLETE)',
    en: /`provider` and `model` must be supplied together/,
    zh: /`provider` 与 `model` 必须成对提供/,
  },
  {
    // lib/runtime.js resolveRoute accepts max_tokens only when
    // Number.isSafeInteger(n) && n > 0, else MAX_TOKENS_INVALID. "Safe" is not
    // decoration: 2**53 is a positive integer yet still rejected. Both READMEs
    // must keep the full positive-safe-integer claim.
    id: 'spawn max_tokens must be a positive safe integer (MAX_TOKENS_INVALID)',
    en: /`max_tokens` must be a positive safe integer/,
    zh: /`max_tokens` 必须是正的安全整数/,
  },
  {
    // When tower.allowedModels is configured, every effective route must match
    // an exact allowed pair (MODEL_ROUTE_NOT_ALLOWED; config parsing itself
    // rejects half pairs via CONFIG_INVALID). This is the allowlist contract;
    // documenting it in only one language misleads half the readers.
    id: 'allowedModels routes must resolve to an exact allowed provider/model pair (MODEL_ROUTE_NOT_ALLOWED)',
    en: /must resolve to one of those exact provider\/model pairs/,
    zh: /都必须解析为其中某个精确的 provider\/model 对/,
  },
  {
    // With no role default and no per-spawn override the child silently
    // inherits the controller's route. Users sizing costs or debugging a
    // worker's model need this stated in whichever README they read.
    id: 'no default/override means the child inherits the controller route',
    en: /inherits the controller's route/,
    zh: /继承控制器的路由/,
  },
];

/** Both READMEs must stay substantial prose, or every regex below could pass vacuously against a stub. */
const MIN_LENGTH = 4000;

test('both READMEs document the same key config constraints (keyword parity)', () => {
  const sources = Object.fromEntries(
    Object.entries(READMES).map(([lang, rel]) => {
      const text = readFileSync(path.join(root, rel), 'utf8');
      assert.ok(
        text.length >= MIN_LENGTH,
        `${rel} shrank to ${text.length} characters (expected >= ${MIN_LENGTH}); the parity guard would be vacuous`,
      );
      return [lang, text];
    }),
  );
  assert.ok(
    CONSTRAINTS.length >= 4,
    `constraint list shrank to ${CONSTRAINTS.length} entries; weakening the guard needs a conscious decision`,
  );

  const missing = [];
  for (const constraint of CONSTRAINTS) {
    for (const lang of ['en', 'zh']) {
      if (!constraint[lang].test(sources[lang])) {
        missing.push(`${READMES[lang]} is missing: ${constraint.id} (expected pattern ${constraint[lang]})`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    'bilingual READMEs drifted apart — a documented constraint is missing from one language; update BOTH files (and this keyword list only when the constraint itself changes):\n  - '
      + missing.join('\n  - '),
  );
});

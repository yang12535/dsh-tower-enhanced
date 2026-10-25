import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Read-only parity guard between the `zh` and `en` message dictionaries
// embedded in lib/client.js. The dictionaries are plain object literals with
// one `"key": "value"` pair per line, registered via ctx.locale.register(NS,
// { zh, en }). Nothing else keeps both sides in sync: a key added to only one
// language would leak the raw key (or the other language's fallback) into the
// UI. This file only *reads* lib/client.js — drift is reported, never fixed.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_FILE = path.join(root, 'lib/client.js');

/**
 * Whitelist of keys whose zh and en values are allowed to be exactly equal.
 * Every entry must carry a reason; values that are proper nouns, product
 * terms, or technical identifiers are intentionally identical in both
 * languages, so equality there is not a missing translation.
 */
const IDENTICAL_VALUE_ALLOWED = new Map([
  // "Tower" is the product name; both UIs render it unchanged.
  ['trigger', 'product proper noun'],
  ['guideTitle', 'product proper noun'],
  // "Missions"/"Review" are Tower workflow terms the zh UI keeps in English.
  ['missions', 'Tower workflow term kept in English in the zh UI'],
  ['verdict', 'Tower workflow term kept in English in the zh UI'],
  ['detail.review', 'Tower workflow term kept in English in the zh UI'],
  // "mergeCommit" is a Git/technical identifier, not natural-language copy.
  ['mergeCommit', 'git commit field identifier'],
  ['detail.mergeCommit', 'git commit field identifier'],
  // "Worker"/"Reviewer" are Tower role names.
  ['role.worker', 'Tower role name'],
  ['role.reviewer', 'Tower role name'],
  // "Agents" is a technical label the zh UI keeps in English.
  ['view.agents', 'technical label kept in English in the zh UI'],
]);

/** Minimum plausible dictionary size; guards the regex parse against silently matching nothing. */
const MIN_KEYS = 100;

/** Decode a double-quoted JS string literal body (handles \" \\ \n \t … escapes via JSON rules). */
function decodeStringLiteral(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    // Not decodable as JSON: surface the raw text so the failure is debuggable.
    return raw;
  }
}

/**
 * Extract one dictionary (`zh` or `en`) from the lib/client.js source.
 * Returns a Map key -> { value, line }, plus duplicates with line numbers.
 */
function extractDictionary(source, name) {
  const startMarker = `const ${name} = {`;
  const start = source.indexOf(startMarker);
  assert.notEqual(
    start,
    -1,
    `lib/client.js no longer contains "${startMarker}" — dictionary layout changed; update this test's parser`,
  );
  // Dictionary bodies have no nested braces outside string values, and every
  // entry line starts with whitespace + a quote, so the first line that is
  // exactly "};" after the opening is the object's closing brace.
  const end = source.indexOf('\n};', start);
  assert.notEqual(end, -1, `could not find the closing brace of the ${name} dictionary in lib/client.js`);

  const body = source.slice(start, end);
  const lineOf = (index) => source.slice(0, index).split('\n').length;

  const entries = new Map();
  const duplicates = [];
  // One `"key": "value"` pair per line; values may hold {placeholders} and
  // unicode, and the escape-aware alternatives keep a \" inside a value from
  // terminating the match early.
  const entryRe = /"((?:[^"\\\n]|\\.)*)":\s*"((?:[^"\\\n]|\\.)*)"/g;
  let match;
  while ((match = entryRe.exec(body)) !== null) {
    const key = decodeStringLiteral(match[1]);
    const record = { value: decodeStringLiteral(match[2]), line: lineOf(start + match.index) };
    if (entries.has(key)) duplicates.push(`${key} (lines ${entries.get(key).line} and ${record.line})`);
    entries.set(key, record);
  }
  return { entries, duplicates };
}

const source = readFileSync(CLIENT_FILE, 'utf8');
const zh = extractDictionary(source, 'zh');
const en = extractDictionary(source, 'en');

/** "{placeholder}" names used by a translated string, e.g. "{count} running" -> ["count"]. */
function placeholders(value) {
  return new Set((value.match(/\{([^{}]+)\}/g) ?? []).map((token) => token.slice(1, -1)));
}

/** Compact "key (zh:LINE, en:LINE)" locator for actionable failure messages. */
function locate(key) {
  const parts = [];
  if (zh.entries.has(key)) parts.push(`zh:${zh.entries.get(key).line}`);
  if (en.entries.has(key)) parts.push(`en:${en.entries.get(key).line}`);
  return `${key} (${parts.join(', ')})`;
}

test('client dictionaries parse with a plausible size (parse-drift guard)', () => {
  // If the embedded dictionary format changes and the regex matches nothing,
  // the parity tests below would pass vacuously. Sizes catch that.
  assert.ok(
    zh.entries.size >= MIN_KEYS,
    `parsed only ${zh.entries.size} zh keys from lib/client.js (expected >= ${MIN_KEYS}); the parser likely drifted from the dictionary layout`,
  );
  assert.ok(
    en.entries.size >= MIN_KEYS,
    `parsed only ${en.entries.size} en keys from lib/client.js (expected >= ${MIN_KEYS}); the parser likely drifted from the dictionary layout`,
  );
  assert.equal(
    zh.entries.size,
    en.entries.size,
    `key counts differ: zh has ${zh.entries.size}, en has ${en.entries.size}`,
  );
  assert.deepEqual(zh.duplicates, [], `duplicate keys inside the zh dictionary would silently override: ${zh.duplicates.join('; ')}`);
  assert.deepEqual(en.duplicates, [], `duplicate keys inside the en dictionary would silently override: ${en.duplicates.join('; ')}`);
});

test('zh and en dictionaries define exactly the same key set', () => {
  const missingInEn = [...zh.entries.keys()].filter((key) => !en.entries.has(key));
  const missingInZh = [...en.entries.keys()].filter((key) => !zh.entries.has(key));
  assert.deepEqual(
    missingInEn,
    [],
    `keys defined only in zh (the en UI would show the raw key or the zh fallback): ${missingInEn.map((key) => locate(key)).join(', ')}`,
  );
  assert.deepEqual(
    missingInZh,
    [],
    `keys defined only in en (dead translations, never rendered by the zh UI): ${missingInZh.map((key) => locate(key)).join(', ')}`,
  );
});

test('every dictionary value is a non-empty string', () => {
  for (const [dict, label] of [[zh.entries, 'zh'], [en.entries, 'en']]) {
    const empty = [...dict.entries()]
      .filter(([, record]) => typeof record.value !== 'string' || record.value.trim() === '')
      .map(([key]) => locate(key));
    assert.deepEqual(
      empty,
      [],
      `${label} has keys whose value is not a non-empty string: ${empty.join(', ')}`,
    );
  }
});

test('each key uses the same {placeholder} set in zh and en', () => {
  const mismatched = [];
  for (const [key, zhRecord] of zh.entries) {
    const enRecord = en.entries.get(key);
    if (!enRecord) continue; // already reported by the key-set test
    const zhSet = placeholders(zhRecord.value);
    const enSet = placeholders(enRecord.value);
    if (zhSet.size === enSet.size && [...zhSet].every((name) => enSet.has(name))) continue;
    mismatched.push(`${locate(key)}: zh uses {${[...zhSet].join('}, {')}} but en uses {${[...enSet].join('}, {')}}`);
  }
  assert.deepEqual(
    mismatched,
    [],
    `placeholder sets diverge between translations (runtime interpolation would leak or drop arguments): ${mismatched.join('; ')}`,
  );
});

test('zh values do not silently equal their en translation (explicit whitelist only)', () => {
  const unexplained = [];
  for (const [key, zhRecord] of zh.entries) {
    const enRecord = en.entries.get(key);
    if (!enRecord || zhRecord.value !== enRecord.value) continue;
    if (IDENTICAL_VALUE_ALLOWED.has(key)) continue;
    unexplained.push(`${locate(key)}: both sides are ${JSON.stringify(zhRecord.value)}`);
  }
  assert.deepEqual(
    unexplained,
    [],
    `zh and en values are identical without a whitelist entry — likely an untranslated string; add a translated zh value or whitelist the key with a reason: ${unexplained.join('; ')}`,
  );

  // Keep the whitelist itself honest: prune entries whose values are no longer
  // identical, otherwise the list rots and hides future reasoning.
  const stale = [...IDENTICAL_VALUE_ALLOWED.keys()].filter(
    (key) => !(zh.entries.has(key) && en.entries.has(key) && zh.entries.get(key).value === en.entries.get(key).value),
  );
  assert.deepEqual(
    stale,
    [],
    `whitelist entries whose values are no longer identical (remove them from IDENTICAL_VALUE_ALLOWED): ${stale.map((key) => locate(key)).join(', ')}`,
  );
});

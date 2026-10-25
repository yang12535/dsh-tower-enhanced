import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHANGELOG_FILE, PACKAGE_FILE, compareSemver, isValidReleaseDate, parseSemver } from '../scripts/release.mjs';

// Read-only consistency guard between package.json "version" and CHANGELOG.md.
//
// scripts/release.mjs promotes "## [Unreleased]" into "## [<version>] - <date>"
// sections while bumping package.json. Nothing else kept both sides in sync, so
// drift would make the release script operate on a wrong baseline. This file
// only *reads* package.json and CHANGELOG.md (the fixtures below are in-memory
// strings; no file is ever written), and it reuses the semver/date helpers
// exported by scripts/release.mjs so the parsing rules here cannot diverge from
// the exact format the release script produces.

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Mirrors UNRELEASED_HEADING in scripts/release.mjs.
const UNRELEASED_HEADING = /^##\s*\[Unreleased\]\s*$/;
// The release script writes exactly `## [<version>] - <date>` headings (see
// promoteChangelog); tolerate surrounding whitespace but nothing else so drift
// is detected rather than silently ignored.
const VERSION_HEADING = /^##\s*\[([^\]]+)\]\s*-\s*(\S+)\s*$/;
const BRACKET_HEADING = /^##\s*\[/;
const SECTION_START = /^##(?!#)/; // any level-2 heading ends the previous section body
const SUBSECTION_HEADING = /^###\s+\S/;
const LIST_ENTRY = /^\s*[-*]\s+\S/;

function findVersionLine(packageLines) {
  // First `"version":` line is the top-level field in this repo's two-space
  // indented package.json (also the shape JSON.stringify(...) writes).
  const index = packageLines.findIndex((line) => /^\s*"version"\s*:/.test(line));
  return index === -1 ? null : index + 1;
}

function parseChangelogSections(changelogRaw) {
  const lines = changelogRaw.split('\n');
  const unreleasedLines = [];
  const released = [];
  const malformedHeadings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    if (!BRACKET_HEADING.test(text)) continue;
    if (UNRELEASED_HEADING.test(text)) {
      unreleasedLines.push(index + 1);
      continue;
    }
    const match = VERSION_HEADING.exec(text);
    if (match === null) {
      malformedHeadings.push({ line: index + 1, text });
      continue;
    }
    try {
      released.push({ version: parseSemver(match[1]), raw: match[1], date: match[2], line: index + 1 });
    } catch {
      malformedHeadings.push({ line: index + 1, text });
    }
  }
  return { lines, unreleasedLines, released, malformedHeadings };
}

function countSectionContent(lines, headingLine) {
  // headingLine is 1-based, so lines[headingLine] is the first body line.
  let subsectionCount = 0;
  let listEntryCount = 0;
  for (let index = headingLine; index < lines.length && !SECTION_START.test(lines[index]); index += 1) {
    if (SUBSECTION_HEADING.test(lines[index])) subsectionCount += 1;
    if (LIST_ENTRY.test(lines[index])) listEntryCount += 1;
  }
  return { subsectionCount, listEntryCount };
}

export function collectConsistencyIssues(packageRaw, changelogRaw) {
  const issues = [];

  let pkg = null;
  try {
    pkg = JSON.parse(packageRaw);
  } catch (error) {
    issues.push(`${PACKAGE_FILE} is not valid JSON: ${error.message}`);
  }

  const packageLines = packageRaw.split('\n');
  const versionLine = findVersionLine(packageLines);
  if (versionLine === null) {
    issues.push(`${PACKAGE_FILE} has no "version" line to reference in consistency errors`);
  }

  let packageVersion = null;
  const rawVersion = pkg && typeof pkg === 'object' ? pkg.version : undefined;
  try {
    packageVersion = parseSemver(rawVersion);
  } catch {
    issues.push(`${PACKAGE_FILE} "version" ${JSON.stringify(rawVersion)} is not valid semver (${PACKAGE_FILE}:${versionLine ?? '?'})`);
  }

  const { lines, unreleasedLines, released, malformedHeadings } = parseChangelogSections(changelogRaw);
  for (const heading of malformedHeadings) {
    issues.push(
      `${CHANGELOG_FILE}:${heading.line} does not match the heading format produced by scripts/release.mjs ` +
        `("## [x.y.z] - YYYY-MM-DD" or "## [Unreleased]"): ${JSON.stringify(heading.text)}`,
    );
  }

  if (unreleasedLines.length === 0) {
    issues.push(`${CHANGELOG_FILE} has no "## [Unreleased]" section`);
  } else {
    if (unreleasedLines.length > 1) {
      issues.push(
        `${CHANGELOG_FILE} has ${unreleasedLines.length} "## [Unreleased]" sections ` +
          `(${unreleasedLines.map((line) => `${CHANGELOG_FILE}:${line}`).join(', ')}); expected exactly one`,
      );
    }
    if (released.length > 0 && unreleasedLines[0] > released[0].line) {
      issues.push(
        `${CHANGELOG_FILE} "## [Unreleased]" at ${CHANGELOG_FILE}:${unreleasedLines[0]} must appear before the first ` +
          `released version section [${released[0].raw}] at ${CHANGELOG_FILE}:${released[0].line}`,
      );
    }
  }

  if (released.length === 0) {
    issues.push(`${CHANGELOG_FILE} has no released version sections of the form "## [x.y.z] - YYYY-MM-DD"`);
  }

  // Fixed upper bound instead of "today": comparing against the current date
  // would misjudge a just-released date around midnight or in another timezone
  // and make the test flaky. Anything beyond next year is still clearly future
  // or typo drift.
  const maxAllowedYear = new Date().getUTCFullYear() + 1;
  for (const entry of released) {
    if (!isValidReleaseDate(entry.date)) {
      issues.push(
        `${CHANGELOG_FILE}:${entry.line} has invalid release date ${JSON.stringify(entry.date)} for [${entry.raw}]: ` +
          `expected a real YYYY-MM-DD calendar date`,
      );
    } else if (Number(entry.date.slice(0, 4)) > maxAllowedYear) {
      issues.push(
        `${CHANGELOG_FILE}:${entry.line} release date ${entry.date} for [${entry.raw}] is in the future ` +
          `(beyond the allowed year ${maxAllowedYear})`,
      );
    }
  }

  for (let index = 1; index < released.length; index += 1) {
    const previous = released[index - 1];
    const current = released[index];
    if (compareSemver(previous.version, current.version) <= 0) {
      issues.push(
        `${CHANGELOG_FILE} version sections must be strictly descending: [${current.raw}] at ` +
          `${CHANGELOG_FILE}:${current.line} does not sort below [${previous.raw}] at ${CHANGELOG_FILE}:${previous.line}`,
      );
    }
  }

  for (const entry of released) {
    const { subsectionCount, listEntryCount } = countSectionContent(lines, entry.line);
    if (subsectionCount === 0) {
      issues.push(
        `${CHANGELOG_FILE}:${entry.line} released section [${entry.raw}] has no "### " subsection ` +
          '(for example Added, Changed, Deprecated, Removed, Fixed, Security)',
      );
    }
    if (listEntryCount === 0) {
      issues.push(`${CHANGELOG_FILE}:${entry.line} released section [${entry.raw}] has no list entry`);
    }
  }

  if (packageVersion !== null && released.length > 0) {
    const highest = released.reduce((acc, entry) => (compareSemver(entry.version, acc.version) > 0 ? entry : acc), released[0]);
    if (packageVersion.prerelease === null) {
      if (compareSemver(highest.version, packageVersion) !== 0) {
        issues.push(
          `version mismatch: ${PACKAGE_FILE} "version" is ${packageVersion.raw} (${PACKAGE_FILE}:${versionLine}) but the ` +
            `highest released CHANGELOG section is ${highest.raw} (${CHANGELOG_FILE}:${highest.line})`,
        );
      }
    } else {
      // Tradeoff: a prerelease package version (for example 0.3.0-rc.1) is
      // regularly cut before the CHANGELOG gains a matching released section,
      // and semver ranks a prerelease below its own base version, so requiring
      // exact equality would reject legitimate staging states. Only require the
      // prerelease's x.y.z base to be at least the highest released CHANGELOG
      // section; anything below it is real drift.
      const base = { major: packageVersion.major, minor: packageVersion.minor, patch: packageVersion.patch, prerelease: null };
      if (compareSemver(base, highest.version) < 0) {
        issues.push(
          `version mismatch: ${PACKAGE_FILE} "version" is the prerelease ${packageVersion.raw} (${PACKAGE_FILE}:${versionLine}) ` +
            `whose base ${packageVersion.major}.${packageVersion.minor}.${packageVersion.patch} is below the highest released ` +
            `CHANGELOG section ${highest.raw} (${CHANGELOG_FILE}:${highest.line})`,
        );
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// In-memory fixtures (nothing on disk is written or modified)
// ---------------------------------------------------------------------------

const CURRENT_YEAR = new Date().getUTCFullYear();
const TOP_DATE = `${CURRENT_YEAR}-01-10`;
const OLDER_DATE = `${CURRENT_YEAR}-01-01`;
const CONSISTENT_SECTIONS = [
  { version: '0.2.0', date: TOP_DATE },
  { version: '0.1.0', date: OLDER_DATE },
];

function fixturePackage(version) {
  return `${JSON.stringify({ name: 'version-consistency-fixture', version }, null, 2)}\n`;
}

function fixtureChangelog({ unreleased = 'top', sections }) {
  const parts = ['# Changelog', ''];
  const unreleasedBlock = ['## [Unreleased]', '', '### Added', '', '- pending work', ''];
  if (unreleased === 'top') parts.push(...unreleasedBlock);
  for (const section of sections) {
    parts.push(`## [${section.version}] - ${section.date}`, '', ...(section.body ?? ['### Added', '', '- change']), '');
  }
  if (unreleased === 'bottom') parts.push(...unreleasedBlock);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// The real repository contract (read-only)
// ---------------------------------------------------------------------------

test('repository keeps package.json version and CHANGELOG releases in sync (read-only scan)', () => {
  const issues = collectConsistencyIssues(
    readFileSync(path.join(PROJECT_ROOT, PACKAGE_FILE), 'utf8'),
    readFileSync(path.join(PROJECT_ROOT, CHANGELOG_FILE), 'utf8'),
  );
  assert.deepEqual(issues, [], `package.json / ${CHANGELOG_FILE} consistency drift`);
});

// ---------------------------------------------------------------------------
// Drift fixtures: prove each assertion can actually fail (no vacuous checks)
// ---------------------------------------------------------------------------

test('collector accepts a consistent package/CHANGELOG fixture', () => {
  assert.deepEqual(collectConsistencyIssues(fixturePackage('0.2.0'), fixtureChangelog({ sections: CONSISTENT_SECTIONS })), []);
});

test('collector accepts a prerelease package version whose base is at least the latest CHANGELOG release', () => {
  // Prerelease tradeoff, see the comment inside collectConsistencyIssues.
  assert.deepEqual(collectConsistencyIssues(fixturePackage('0.3.0-rc.1'), fixtureChangelog({ sections: CONSISTENT_SECTIONS })), []);
});

test('collector rejects a version mismatch and reports both values with file:line', () => {
  const issues = collectConsistencyIssues(
    fixturePackage('0.2.0'),
    fixtureChangelog({ sections: [{ version: '0.3.0', date: TOP_DATE }, { version: '0.1.0', date: OLDER_DATE }] }),
  );
  assert.equal(issues.length, 1, issues.join('\n'));
  assert.match(issues[0], /version mismatch/);
  assert.match(issues[0], /0\.2\.0/);
  assert.match(issues[0], /0\.3\.0/);
  assert.match(issues[0], /package\.json:\d+/);
  assert.match(issues[0], /CHANGELOG\.md:\d+/);
});

test('collector rejects a prerelease package version below the latest CHANGELOG release', () => {
  const issues = collectConsistencyIssues(
    fixturePackage('0.2.5-rc.1'),
    fixtureChangelog({ sections: [{ version: '0.3.0', date: TOP_DATE }, { version: '0.2.0', date: OLDER_DATE }] }),
  );
  assert.equal(issues.length, 1, issues.join('\n'));
  assert.match(issues[0], /version mismatch/);
  assert.match(issues[0], /0\.2\.5-rc\.1/);
  assert.match(issues[0], /0\.3\.0/);
});

test('collector rejects an [Unreleased] section that is not above every released section', () => {
  const issues = collectConsistencyIssues(
    fixturePackage('0.2.0'),
    fixtureChangelog({ unreleased: 'bottom', sections: CONSISTENT_SECTIONS }),
  );
  assert.equal(issues.length, 1, issues.join('\n'));
  assert.match(issues[0], /must appear before/);
});

test('collector requires exactly one [Unreleased] section', () => {
  const missing = collectConsistencyIssues(
    fixturePackage('0.2.0'),
    fixtureChangelog({ unreleased: 'none', sections: CONSISTENT_SECTIONS }),
  );
  assert.equal(missing.length, 1, missing.join('\n'));
  assert.match(missing[0], /has no "## \[Unreleased\]" section/);

  const duplicated = collectConsistencyIssues(
    fixturePackage('0.2.0'),
    fixtureChangelog({ sections: CONSISTENT_SECTIONS }).replace('## [Unreleased]', '## [Unreleased]\n\n## [Unreleased]'),
  );
  assert.equal(duplicated.length, 1, duplicated.join('\n'));
  assert.match(duplicated[0], /expected exactly one/);
});

test('collector rejects version sections that are not strictly descending', () => {
  const ascending = collectConsistencyIssues(
    fixturePackage('0.2.0'),
    fixtureChangelog({ sections: [{ version: '0.1.0', date: OLDER_DATE }, { version: '0.2.0', date: TOP_DATE }] }),
  );
  assert.equal(ascending.length, 1, ascending.join('\n'));
  assert.match(ascending[0], /strictly descending/);

  const duplicatedVersion = collectConsistencyIssues(
    fixturePackage('0.2.0'),
    fixtureChangelog({ sections: [{ version: '0.2.0', date: TOP_DATE }, { version: '0.2.0', date: TOP_DATE }] }),
  );
  assert.equal(duplicatedVersion.length, 1, duplicatedVersion.join('\n'));
  assert.match(duplicatedVersion[0], /strictly descending/);
});

test('collector rejects release dates that are not real YYYY-MM-DD calendar dates', () => {
  for (const date of ['2026-13-01', '2026-02-30', '2026-1-5', 'not-a-date']) {
    const issues = collectConsistencyIssues(
      fixturePackage('0.2.0'),
      fixtureChangelog({ sections: [{ version: '0.2.0', date }, { version: '0.1.0', date: OLDER_DATE }] }),
    );
    assert.ok(
      issues.some((issue) => /invalid release date/.test(issue) && issue.includes(date)),
      `date ${date}: ${issues.join('\n')}`,
    );
  }
});

test('collector rejects release dates beyond the fixed future-year bound', () => {
  const issues = collectConsistencyIssues(
    fixturePackage('0.2.0'),
    fixtureChangelog({
      sections: [{ version: '0.2.0', date: `${CURRENT_YEAR + 2}-01-01` }, { version: '0.1.0', date: OLDER_DATE }],
    }),
  );
  assert.equal(issues.length, 1, issues.join('\n'));
  assert.match(issues[0], /in the future/);
});

test('collector rejects released sections without a subsection or without list entries', () => {
  const noSubsection = collectConsistencyIssues(
    fixturePackage('0.2.0'),
    fixtureChangelog({
      sections: [{ version: '0.2.0', date: TOP_DATE, body: ['- change directly under the version heading'] }],
    }),
  );
  assert.equal(noSubsection.length, 1, noSubsection.join('\n'));
  assert.match(noSubsection[0], /has no "### " subsection/);

  const noEntries = collectConsistencyIssues(
    fixturePackage('0.2.0'),
    fixtureChangelog({
      sections: [{ version: '0.2.0', date: TOP_DATE }, { version: '0.1.0', date: OLDER_DATE, body: ['### Fixed'] }],
    }),
  );
  assert.equal(noEntries.length, 1, noEntries.join('\n'));
  assert.match(noEntries[0], /has no list entry/);
});

test('collector flags section headings that do not match the release script format', () => {
  const issues = collectConsistencyIssues(
    fixturePackage('0.2.0'),
    fixtureChangelog({ sections: CONSISTENT_SECTIONS }).replace(`## [0.2.0] - ${TOP_DATE}`, '## [0.2.0]'),
  );
  assert.equal(issues.length, 2, issues.join('\n'));
  assert.ok(issues.some((issue) => /does not match the heading format/.test(issue)));
  // With [0.2.0] no longer released, the consistency rule must fire as well.
  assert.ok(issues.some((issue) => /version mismatch/.test(issue)));
});

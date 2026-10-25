# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [Unreleased]

### Added

- `edit` and `summary` Tower actions across `lib/index.js`, `lib/runtime.js`, and `lib/core.js`: pending missions can correct their title, description, scope, and dependencies with add-equivalent validation, while `summary` provides a read-only compact overview with global counts, one-line mission entries, and optional `mission_id` filtering.
- Explicit `review_failed` state handling in `lib/core.js`, `lib/store.js`, and `lib/client.js`: failed reviewer launches and runs remain retryable by a fresh reviewer or a worker for direct rework, with failure details and next-step guidance exposed in Tower cards.
- Guaranteed settlement notices in `lib/runtime.js`: every settled worker or reviewer steers the controller with its outcome, a bounded reason for failures/interruptions/stale reviews, and the next action; state, projection, and notification failures are contained so one failing step does not silence the others.
- Restart recovery warnings in `lib/runtime.js`: newly created agents proactively report persisted running activations left by a previous controller process once per run and direct the controller to `recover` instead of waiting for zombies that can never settle.
- Read-only diagnostics in `scripts/tower-doctor.mjs`, cross-checking `.dsh-tower/state.json` against repository and worktree facts, reporting activation and Git metadata health, and returning structured findings without repairing state or mutating Git.
- Local release automation in `scripts/release.mjs`, with validated semver/date inputs, non-writing dry runs by default, clean-worktree enforcement for `--apply`, atomic `package.json` and `CHANGELOG.md` updates, and best-effort rollback; the script never commits, tags, pushes, or uses the network.
- CI smoke coverage in `.github/workflows/ci.yml` for both script entry points, including successful `--help` invocation, read-only doctor behavior on a fresh checkout, and rejection of a non-incrementing release version.
- Documentation and release consistency guards in `test/docs-consistency.test.js` and `test/version-consistency.test.js`, keeping documented action inventories aligned with the tool schema and enforcing `package.json`/changelog version, date, ordering, and section structure invariants.

### Changed

- Expanded `README.md`, `README.zh-CN.md`, `docs/architecture.md`, `docs/operations.md`, and `docs/security-model.md` to document the new actions, explicit failure and recovery states, operational diagnostics, and their underlying trust and state-machine semantics.

### Fixed

- Refresh untouched pending mission worktrees to the current base before their first worker starts, making merged dependencies available without overwriting local or ignored files or rebasing unique commits automatically.
- Invalidate stale review bindings after a base change even when rebase leaves the mission tip unchanged, and return `reviewRequired: true` consistently with the merge gate.
- Recognize `review_failed` in the read-only doctor and continue checking its required Git artifacts instead of reporting valid state as corrupt.
- Locate restart-recovery warnings from the current working directory and Git root rather than only the session's creation-time directory.
- Show failed reviews, stale-review retry guidance, and bounded plain-text errors in Tower cards; failed launches without a child Session no longer appear to be starting indefinitely.
- Reject non-array mission scopes consistently in add/edit, including explicit `null` instead of silently creating an unrestricted mission; preserve literal whitespace in glob patterns.
- Clean up each failed state write's temporary file on write or rename errors, preserving the original error, existing target, and unrelated temporary files; cover actual partial writes and update-queue recovery.

## [0.2.0] - 2026-10-25

### Added

- Mission view in the Tower panel: missions become a first-class lens next to the role-grouped agent list, showing each mission's stage, unmet dependencies, worker/reviewer spawn state with the recorded provider/model, merge commit when merged, and a derived "next step / blocked" hint (for example pending with unmet dependencies, awaiting review, ready to merge, needs rework, needs manual attention). Existing agent grouping, scopes, filters, and details are unchanged.
- GitHub Actions CI workflow (`.github/workflows/ci.yml`): runs `pnpm test` and `pnpm run check` on Node 22.5 with `pnpm install --frozen-lockfile` and pnpm store caching on every push and pull request.
- README "Quick start" section: one minimal closed loop (`init` → `add` → `spawn` worker → `spawn` reviewer → `gate` → `merge` → `teardown`) plus a cross-provider routing example.
- `keywords` metadata in `package.json`.

## [0.1.0] - 2026-10-25

### Added

- Tower-lite controller `tower` tool with `init`, `add`, `spawn`, `status`, `send`, `interrupt`, `recover`, `models`, `rebase`, `gate`, `merge`, `abandon`, and `teardown` actions over a persisted per-repository state store.
- One branch and one isolated Git worktree per mission under `.dsh-tower/`, with optional `depends_on` mission dependencies and `scope` path allowlists.
- Worker and reviewer subagents through DSH's in-process `spawn` provider; workers must commit inside their worktree before finishing, reviewers return a structured verdict (`clean`/`changes_requested` plus a merge recommendation).
- Independent reviews bound to both the reviewed base SHA and tip SHA: any rebase or relevant movement of the base or tip requires a fresh review before merging.
- Merge gate checking dependencies, scope, clean worktrees, checked-out base, current-base ancestry, and review binding; `merge` consumes the exact reviewed SHA and verifies the result, with accounting-only reconciliation when the reviewed SHA is already contained in the base.
- Per-spawn `provider + model + reasoning_effort + max_tokens` routing with role-specific defaults, an optional exact-route allowlist (`allowedModels`), and cross-provider route mixing.
- Web UI shared by the conversation-header popover and the right Sidebar **Tower** tab: This session / Workspace scopes, agents grouped by role (Work / Review), all / running / attention filters, per-agent detail cards with task, outcome, elapsed time, recorded route, review checks, branch, and commit information, and links into native child transcripts.
- Explicit recovery semantics: `recover` marks persisted stale running activations interrupted without adopting their processes; `add`, `gate`/`merge`, and `teardown` retries reconcile recorded artifacts conservatively and never delete unexpected paths.
- Experimental local prototype bundle; no remote repository and no published artifacts.

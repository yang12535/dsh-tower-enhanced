# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [Unreleased]

### Changed

- The Tower panel is one mission list instead of separate Missions and Agents views: status chips (all / running / open / merged / abandoned) filter it, running and open missions lead, open rows state their next step, and each row expands to its dependencies, merge-stage gate summary, worker and reviewer lines with chat links, merge commit, and details. **This session only** replaces the This session / Workspace switch; Chinese copy no longer mixes in English role names.
- The route usage table is replaced by a **Model usage** ranking per provider/model: Tower session runs on the left, a token-ranked bar in the middle, and tokens on the right, read from each child Session's host `tokenUsage` projection. Role lines show the same per-session tokens.
- Panel preferences moved to the `dsh-tower:prefs:v2` namespace (session-only scope, filter, history and usage folds globally; expanded rows, selection, and scroll per session); v1 records are ignored.

### Added

- Cross-process `release --apply` serialization in `scripts/release.mjs`, using paired locks in the Git directory, fail-fast `RELEASE_LOCKED` contention errors, and guarded stale-lock recovery; concurrent and repeated apply behavior is covered by `test/release-concurrency.test.js`.
- Node 22.5 and 24 CI matrix coverage in `.github/workflows/ci.yml`, with independent test and check runs for the minimum supported and current Node versions.
- Mission worker/reviewer elapsed-time displays and localized `stopReason` badges in `lib/client.js`, including running-duration updates and terminal-state styling, with boundary and lifecycle coverage in `test/client.test.js`.
- Exhaustive mission state-machine transition matrix tests in `test/state-machine.test.js`, covering allowed and rejected outcomes for all 12 states × 7 actions, unchanged state after rejection, and state-set invariants that prevent new statuses from escaping spawn-guard classifications; `WORKER_START_BLOCKED` is a defensive assertion because it is unreachable within the valid state space.
- A machine-readable `tower-doctor --json` contract test in `test/doctor-json-schema.test.js`, pinning top-level and summary keys, finding shapes and codes, severity counts, exit codes, and stdout/stderr behavior.
- Detailed Git metadata ownership and permission pollution diagnostics in `scripts/tower-doctor.mjs`: `GIT_METADATA_FOREIGN_OWNER` warnings and `GIT_METADATA_NOT_WRITABLE` errors, at most 10 sample paths, a bounded scan with `truncated` reporting, ownership-scan skipping on non-POSIX platforms, and report-only behavior without repairs; regression coverage is in `test/doctor.test.js`, with diagnosis and remediation guidance in `docs/operations.md`.
- Strict gating for `scripts/tower-doctor.mjs` via `--fail-on-warning`: warning-only runs exit `2` instead of `1` while clean (`0`) and error (`2`) exits stay unchanged, `--json` payloads include `failOnWarning: true` only when the flag is given (the default key set is unchanged), and `--help` documents the option; exit-policy and JSON backward-compatibility coverage is in `test/doctor.test.js`, with usage documented in `README.md`, `README.zh-CN.md`, and `docs/operations.md`.
- Regression coverage in `test/control-actions.test.js`, `test/readonly-actions.test.js`, `test/quickstart.test.js`, and `test/scale-smoke.test.js` for `send`/`interrupt` semantics, read-only action consistency across mission states, the executable README quick start, and responsive 100-mission state operations.
- Mission-card merge-gate summary in `lib/client.js` and `lib/projection.js`: the projection derives a read-only `gateBlocks` list per mission from the published state — mirroring the state-checkable codes of the merge gate (`NOT_APPROVED`, `DEPENDENCIES_NOT_MERGED`, `WORKTREE_REMOVED`, `NO_CLEAN_REVIEW`) without running a single git command — and cards render up to 3 block-code chips with a `+N` overflow, a qualified ready label (zh 「状态就绪」 / en `Ready (state checks)`) with a hint that git-level checks (dirty base, base drift, out-of-scope changes, reviews staled by base movement) stay with `tower gate`, and merged missions show a 7-character short SHA of the merge commit with the full SHA kept as tooltip and screen-reader text; derivation and rendering coverage is in `test/client-gate.test.js`.
- Exhaustive merge-gate block-code matrix in `test/gate-matrix.test.js`: every block code `evaluateMergeGate` in `lib/core.js` can emit gets a real temporary-repository scenario asserting the block and its message, that co-existing problems are all reported without masking, and that the gate reopens once the problem is removed; a final test parses the gate source and fails the suite when a future code ships without a scenario.
- Recovery semantics pinned in `test/recover.test.js`: `recover` marks only running records whose runIds this runtime does not own as interrupted with bounded errors and retryable statuses, never adopts them (old runIds stay recorded and steering keeps failing with `AGENT_NOT_RUNNING`), never respawns on its own, stays a semantic no-op without zombies, leaves leftover records on missions that already left the running states inert, and exempts genuinely owned live runs.
- zh/en dictionary parity guard in `test/i18n.test.js`, read-only cross-checking the embedded locale dictionaries of `lib/client.js` for identical key sets, duplicate keys, consistent `{placeholder}` names per key, and a reasoned whitelist for values intentionally identical in both languages; drift is reported, never auto-fixed.
- Routing-form contract for the `models` action in `test/models.test.js` against an injected fake LLM catalog (no real provider is contacted): the aggregate no-argument form (grouped per provider, 100-per-catalog cap with `truncated` flags, per-catalog errors isolated), the single-provider catalog form (500-entry cap), and the exact `provider + model` route resolving one entry with its reasoning capabilities, with adapter error codes such as `NO_ADAPTER` and `MODEL_NOT_FOUND` propagating unchanged and every form surviving a JSON round trip.

### Changed

- Expanded `README.md` and `README.zh-CN.md` with the 0.3 action inventory, failure and recovery semantics, review invalidation behavior, and diagnostics/release command documentation.
- Expanded `docs/operations.md` with the §3.14 state recovery runbook: a symptom → diagnosis → safe handling → cleanup entry point for missing, corrupt, or partially recovered `.dsh-tower/state.json`, mapping tower-action errors to doctor codes, inventorying leftover artifacts read-only, and stating what is and is not reconstructible from Git facts.
- Refreshed `docs/architecture.md` for the final 0.3 contracts: read-only contracts for `status`/`summary`/`gate`/`models` (no store writes, events, or revisions), the full 12-state set with worker/reviewer restartable sets, `review_failed` entry and exit semantics, `send`/`interrupt` address validation, and the doctor and release-script contracts including the `--fail-on-warning` exit policy.
- Extended `docs/security-model.md` with the 0.3 threat/protection matrix for control-address validation, the two-layer cross-process `release --apply` lock, read-only Git-metadata diagnostics, guaranteed settlement notices, and the pending-first-spawn base refresh — each stated together with what it is not as a security boundary — plus new residual-gap entries for leftover lock and quarantine files, the limits of doctor detection, and notification leakage.

### Fixed

- Prevent concurrent `release --apply` processes from validating and writing the same release simultaneously (P1 double-write race) by holding the cross-process lock across planning, clean-worktree validation, and file updates in `scripts/release.mjs`.
- Close stale release-lock takeover and release TOCTOU races in `scripts/release.mjs`: a separate reclaim lock serializes recovery, atomic rename quarantines the exact observed lock generation, content/token checks restore newer locks, and only the owner's lock is removed.
- Validate active-run ownership for `send` and `interrupt` in `lib/runtime.js` before steering or cancelling a child, reject invalid roles consistently, and return the validated mission, role, run, and child addressing fields; regression coverage is in `test/control-actions.test.js`.

## [0.3.0] - 2026-10-26

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

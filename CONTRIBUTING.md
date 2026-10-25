# Contributing to dsh-tower-enhanced

Thanks for your interest in improving this experimental Tower-lite bundle.
This document covers local development, how changes are made through Tower
missions, and the expectations for every contribution.

## Prerequisites

- Node.js >= 22.5
- pnpm 12.15.0 (matches the pin in `.github/workflows/ci.yml`)
- Git

## Local setup

```bash
git clone <repository URL>
cd dsh-tower-enhanced
pnpm install
```

There is no build step; the plugin loads `lib/` directly.

## Development loop

Run the syntax check and the test suite before every commit:

```bash
pnpm test         # node --test test/*.test.js
pnpm run check    # node --check on every lib entry point
```

Tests use real temporary Git repositories and mock only the DSH-facing
runtime boundaries, so they exercise the actual Git behavior the controller
depends on. Both commands must pass before a change can be merged. If you
touch `package.json` or `pnpm-lock.yaml`, commit the lockfile together with
the manifest and keep `pnpm install --frozen-lockfile` working.

## Developing Tower with Tower

This project uses its own Tower workflow for development. From the
controller Session, with the base branch checked out and the main worktree
clean:

1. `tower({action:"init"})` once per repository.
2. `add` a mission with a complete description and a `scope` allowlist
   naming exactly the files the mission may touch.
3. `spawn` a worker. The worker edits only inside its mission worktree,
   runs `pnpm test` and `pnpm run check`, and must commit before
   finishing.
4. When the mission reaches `worker_completed`, `spawn` a reviewer for an
   independent, exact-SHA-bound review.
5. `gate`, then `merge` on approval. A `changes_requested` verdict starts
   another worker round and requires a fresh review.

See the README "Tool flow" section for the full sequence and recovery
semantics. Workers never push; the controller handles merging.

## Commit conventions

- Use Conventional Commits style: `type: summary`, for example
  `feat(ui): mission view with stage hints` or
  `chore: harden CI and add contributor docs`.
- Keep the subject line imperative and under 72 characters.
- Tower adds a summary commit per merged mission; workers create the
  substantive commit inside their worktree first.

## Scope and testing requirements

- Every mission declares a `scope` allowlist; stay inside it. Changes
  outside the declared scope need a new mission.
- New or changed behavior in `lib/` must come with tests in `test/` that
  fail without the change.
- Documentation (`README.md`, `CHANGELOG.md`) updates belong to the same
  mission as the behavior they describe. `CHANGELOG.md` follows
  [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
- CI runs `pnpm install --frozen-lockfile`, `pnpm test`, and
  `pnpm run check` on every push and pull request; keep it green.

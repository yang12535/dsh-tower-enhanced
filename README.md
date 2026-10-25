# dsh-tower-enhanced

Experimental **Tower-lite** bundle for DeepSeek Harness. It adds a controller `tower` tool with isolated Git worktrees, worker/reviewer subagents, exact-SHA review bindings, merge gates, and per-spawn model routes.

This is an independently maintained prototype, not Kimi Tower and not an official DeepSeek bundle.

[中文文档](README.zh-CN.md)

## Features

- One branch and worktree per mission under `.dsh-tower/`.
- Tower membership follows the workspace, like Kimi Code: any Session can own a repository's tower, and a second Session is refused only while one owns it (a call in flight, or a worker/reviewer it started still running). No root/leaf Session rule.
- Background workers and structured independent reviews through DSH's in-process `spawn` provider.
- Optional `provider + model + reasoning_effort + max_tokens` per spawn; role-specific defaults and an exact-route allowlist are configurable.
- The conversation-header popover and right Sidebar **Tower** tab share one UI. **This session** shows only real child Sessions created by the current controller. In a worker/reviewer chat it shows only that agent's own record: a reviewer never gains a sibling worker record just because they share a mission. **Workspace** explicitly shows all recorded agents and identifies their originating controller.
- Each real child Session appears once, grouped by its recorded role (`Work` or `Review`). A missing child Session produces no agent row or role placeholder. A review-only view has no Work group, and vice versa. Workspace tasks that have not created a child are listed separately from agents.
- Cards show the task, role, outcome, elapsed time, and the provider/model/reasoning effort recorded at launch. They never substitute the main conversation's model selector. Clicking a card opens its native `subagentchat` transcript; **Task & result** expands the recorded output, review checks, branch, and commit information. Failed, interrupted, stale, and changes-requested outcomes remain distinct from completion. Filters select all, running, or attention-needed agents.
- Chat links and session membership use the host's child catalog, then listed lineage, then the controller recorded at spawn. Unknown ownership is never guessed from the panel's current Session. Views use the newest available projection for the same repository; these are recorded Tower activations, not a live feed of every subsequent model change inside a child chat.
- Review evidence binds both the current base SHA and reviewed tip SHA. Any rebase or relevant movement requires a fresh review.
- Merge checks dependencies, scope, clean worktrees, checked-out base, current-base ancestry, and review binding. The merge consumes the exact reviewed SHA and verifies the result.
- Conservative teardown: only clean, registered worktrees for merged or abandoned missions; branches and state remain.

## Install

The bundle has no build step and requires Node 22.5+ and DSH 0.2.1-rc.2.

Replace the path below with the absolute path to your checkout:

```bash
dsh plugin --profile web add file:/absolute/path/to/dsh-tower-enhanced
```

Or install the local directory through **Plugins** in the DSH Web/Desktop UI. Activation may require a restart or a new session depending on the host's HMR state. The bundle includes a Web client; after installing or upgrading, refresh the existing GUI. In a conversation that has run the controller, open either the **Tower** button in the conversation header or the **Tower** entry on the right Sidebar's start page. Both views are read-only and show model routes only after the controller publishes its first state. Click an agent to load its conversation in the Sidebar; `全部展开` / `全部收起` manage the role groups. Switch to **Workspace** to inspect agents created by earlier controllers.

A `file:` installation may contain a snapshot rather than a live link to the checkout. Merging source changes does not prove that the installed bundle changed. Before accepting an upgrade, finish active runs, refresh the installed package through the host's plugin workflow, and compare its `lib/core.js`, `lib/runtime.js`, and `lib/store.js` with the intended checkout. Then restart/reload the host, refresh the GUI, and exercise the changed behavior in a disposable repository. Restarting alone cannot update an outdated on-disk package.

The bundle composes `subagents`, `workingDirectory`, `llm`, and `tools`; the normal DSH base already supplies them.

## Quick start

One minimal closed loop: initialize a tower, add a mission, run one worker and one reviewer, then gate, merge, and tear down the worktree. Each line below is one `tower` tool call from the controller Session, with the repository's base branch checked out and the main worktree clean:

```text
tower({action:"init"})
tower({action:"add", id:"M1", title:"Docs pass", description:"Proofread the README and commit.", scope:["README.md"]})
tower({action:"spawn", mission_id:"M1", role:"worker", provider:"zai-coding-cn", model:"glm-5.3"})
tower({action:"status", mission_id:"M1"})            // wait for worker_completed (the worker must commit first)
tower({action:"spawn", mission_id:"M1", role:"reviewer", provider:"zai-coding-cn", model:"glm-5.3-flash"})
tower({action:"gate", mission_id:"M1"})              // approved before merging
tower({action:"merge", mission_id:"M1"})
tower({action:"teardown", mission_id:"M1"})
```

Notes:

- The example routes the worker to `zai-coding-cn`/`glm-5.3` and the reviewer to the lighter `zai-coding-cn`/`glm-5.3-flash`. Any provider/model pair the host can resolve works, including mixing providers between the two roles.
- `gate` explains what blocks a merge; a `changes_requested` verdict needs another worker round and a fresh review before `merge`.
- `merge` consumes the exact reviewed SHA; `teardown` then removes only the clean, registered worktree — the mission branch and state remain.

## Configure

Default bundle patch:

```yaml
- insert:
    - id: tower-enhanced
      name: dsh-tower-enhanced
      config:
        provider: spawn
        stateDirectory: .dsh-tower
        branchPrefix: tower
```

Optional model policy:

```yaml
config:
  provider: spawn
  stateDirectory: .dsh-tower
  branchPrefix: tower
  allowedModels:
    - provider: deepseek-official
      model: deepseek-flash
    - provider: deepseek-official
      model: deepseek-v4-pro
  workerAgentOptions:
    provider: deepseek-official
    model: deepseek-flash
  reviewerAgentOptions:
    provider: deepseek-official
    model: deepseek-v4-pro
    reasoningEffort: high
```

Routes are ordinary LLM adapter routes, so different providers can be mixed per role. Any route the host can resolve works, for example a text-only worker and a vision-capable reviewer from another provider:

```yaml
config:
  workerAgentOptions:
    provider: zai-coding-cn
    model: glm-5.3
  reviewerAgentOptions:
    provider: zai-coding-cn
    model: glm-5.3-flash
```

The same values can be passed per spawn: `tower({action:"spawn", mission_id:"M1", role:"worker", provider:"...", model:"...", reasoning_effort:"...", max_tokens:...})`.

`allowedModels` is optional. When present, every explicit/default override must resolve to one of those exact provider/model pairs. When absent, routes are validated against the live LLM adapter without a separate allowlist. With no role default or per-spawn override, the child inherits the controller's route.

## Tool flow

1. Make the Session's working directory the intended repository (`working_directory` supports `cd`), check out the local base branch, and ensure the main worktree is clean.
2. `tower({action:"init"})`.
3. Add missions with complete descriptions and optional `depends_on`/`scope`. `scope` must be an array of repository-relative glob strings; omit it or use `[]` for unrestricted changes. Explicit `null`, strings, and other non-array values are rejected. Patterns preserve literal whitespace, including leading/trailing spaces in file names. For `edit`, omitted scope keeps the existing restriction; `[]` clears it.
4. `spawn` a worker. Before a pending mission first starts, its untouched, clean worktree fast-forwards to the current base so merged dependencies are available. Local changes, ignored-file collisions, or divergent commits block that refresh rather than being overwritten; preserve local files and explicitly `rebase` divergent work. The worker must commit before finishing. Restarting an existing worker does not automatically rebase its worktree.
5. When the mission becomes `worker_completed`, `spawn` a reviewer. The reviewer returns a structured verdict; if it fails (rate limit, crash, or no structured verdict) the mission moves to `review_failed` — spawn the reviewer again, or a worker for direct rework.
6. `status`/`gate` inspect state. An `approved` mission can be merged; `changes_requested` needs another worker round; `review_failed` is neither running nor terminal, so both a fresh reviewer and a fresh worker can start from it.
7. If the base moved, `rebase`, then obtain a fresh review before merging. A changed review base invalidates the verdict even when the mission tip stays unchanged; `reviewRequired` reports this too.
8. `merge` evaluates the gate and merges the exact reviewed SHA. `teardown` later removes eligible worktrees only.

`send` and `interrupt` address the currently active worker/reviewer. `models` lists a provider's catalog or resolves one exact route, including reasoning metadata when available. After a restart, persisted `worker_running`/`review_running` records intentionally block new work until the controller explicitly confirms the old runtime stopped and calls `recover`; this records stale activations as interrupted without adopting their processes.

## Failure recovery

- Failure always reaches the controller: every settled worker/reviewer steers the controller Session a notice shaped `Tower <role> for <mission> <outcome>: mission status <status>`, and failure/interrupted/stale outcomes add a bounded `reason` (≤500 characters from the recorded error or diagnostic) plus the next action — even when state recording or projection publishing fails, the notice still goes out (at worst as a fallback naming role, mission, run, and error).
- A failed review is explicit: a reviewer that errors out, returns no structured verdict, or never starts moves the mission to `review_failed` (recorded with `error`, `stopReason`, and `completedAt`, and a `spawn-failed` event) instead of collapsing back into `worker_completed`. Spawn a fresh reviewer from it, or a worker for direct rework; the merge gate reports `NOT_APPROVED` until a clean review approves the mission.
- The panel distinguishes failed reviews from running or approved ones and shows retry guidance. Stale review evidence takes precedence over its old verdict. Agent cards and mission role rows show errors as plain text, capped at 500 Unicode code points including the ellipsis; expanded results retain the recorded output. A failed launch without a child Session is shown in the mission view, never as a fictitious agent or a permanently starting chat.
- After a host restart, the runtime resolves the agent's current working directory to its Git repository root, including sessions that changed directories or work inside a subdirectory. It proactively steers the controller one stale-run warning per persisted `worker_running`/`review_running` activation (mission/role/start time), suggesting `tower action=recover`. The creation-time session directory is only a fallback when the working-directory service is unavailable.
- `node scripts/tower-doctor.mjs --repo <path>` performs read-only state and Git diagnostics. A valid `review_failed` mission is not corrupt state; its branch and worktree are still required and checked.
- `recover` is explicit and never adopts old processes. After confirming the previous controller stopped, it marks persisted running activations interrupted (worker runs become `worker_failed`, reviewer runs `review_failed`) so fresh agents can start.
- Retrying `add` with the same mission id reconciles only exactly matching branch/worktree artifacts with no unique commits. Conflicting artifacts require manual inspection and are never deleted automatically.
- `gate` reports `alreadyMerged` when the exact clean-reviewed SHA is already contained in the base and still matches the mission tip. `merge` then performs accounting-only reconciliation instead of merging again.
- `merge` distinguishes Git completion from state accounting and returns `postMerge`/`recoveryRequired` when later observation or persistence needs attention. Inspection failure is `mergeAttempted: true`, `merged: false`, `verified: false`; only exact-SHA verification or later reconciliation produces `merged: true`.
- Retrying `teardown` reconciles a terminal mission when its recorded path is both absent on disk and absent from Git's registered worktrees. An existing unexpected path is never removed.
- State is replaced only after writing a temporary sibling file. If writing or renaming fails, the store attempts to remove only that write's temporary file and rethrows the original error; unrelated temporary files and the existing target are not removed. Cleanup can itself fail under filesystem or permission errors, and does not roll back earlier Git operations.

## Deliberate limits

- Experimental single-process controller: ownership is enforced per repository inside one Host process (a live in-flight call or worker/reviewer activation blocks other Sessions), but the operation queue is not a cross-process Git lock. Do not run two Host processes as controllers against the same repository state.
- Reviewer read-only behavior is currently an instruction, not a restricted-preset security boundary. Worktrees isolate writes by convention, not by sandboxing.
- The UI is intentionally small: a header popover plus one right Sidebar tab. No slash-mode injection, WIP snapshot commits, surveys, PR mode, cross-session adoption, automatic dependency inference, or clean-rebase review waiver.
- A mission whose worker finishes dirty or without a structured review cannot pass the merge gate.
- Git failures can leave artifacts for inspection. `merge` reports `recoveryRequired` when its cleanup cannot prove a clean restored base; inspect manually rather than retrying blindly.

## Development

```bash
pnpm test
pnpm run check
```

Tests use real temporary Git repositories and mock only the DSH-facing runtime boundaries.

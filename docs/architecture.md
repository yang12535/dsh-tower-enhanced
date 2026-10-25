# 架构设计（维护者文档）

本文面向 `dsh-tower-enhanced` 的维护者，描述当前代码的组件划分、mission 状态机、关键不变量、并发与所有权模型以及磁盘数据布局。使用说明见 [../README.md](../README.md)；安全边界与威胁模型另见 [security-model.md](security-model.md)。

本文描述的是**当前代码的实现事实**，引用的文件路径与函数名均相对仓库根目录（本文位于 `docs/` 下，链接使用 `../` 前缀）。

## 1. 总体形态

Tower-lite 是一个单控制器的 Git mission 编排器：

- **一个仓库（repository）同一时刻只有一个控制器 Session**。所有权跟随仓库（工作区），不跟随 Session 血缘：任何 Session 都可以接管一个空闲的 tower，但只要另一个 Session 正在操作、或它启动的 worker/reviewer 仍在运行，第二个 Session 会被拒绝（`WORKSPACE_BUSY`，见 [../lib/runtime.js](../lib/runtime.js) 的 `claimWorkspace`）。
- 控制器通过 DSH 的 `tower` 工具（[../lib/index.js](../lib/index.js) 注册）驱动一个持久化的状态机（[../lib/core.js](../lib/core.js)），每个 mission 拥有独立的 Git 分支与 worktree。
- worker / reviewer 是通过 DSH 进程内 `spawn` provider 激活的子代理（[../lib/runtime.js](../lib/runtime.js) 的 `TowerRuntime.spawn`）。worker 在 mission worktree 内实现并提交；reviewer 以结构化 verdict（`clean` / `changes_requested` + merge 建议）审查一个 **exact-SHA 绑定**的 diff。
- `merge` 只消费通过审查的 exact commit，且经过一道合并门禁（merge gate）校验。
- Web UI（[../lib/client.js](../lib/client.js)）通过 session projection 只读展示状态。

## 2. 组件划分

| 文件 | 职责 | 关键导出 / 函数 |
| --- | --- | --- |
| [../lib/index.js](../lib/index.js) | 插件入口。创建 `TowerRuntime`，向 `ctx.tools` 注册 `tower` 工具（`defineTool`），向 `ctx.root.sessionProjections` 注册 projection，并在插件卸载时 `dispose` | `apply(ctx, config)` |
| [../lib/runtime.js](../lib/runtime.js) | 运行时：动作分发、子代理激活与跟踪、per-spawn 模型路由、仓库所有权、状态发布 | `TowerRuntime`：`execute`、`spawn`、`track`、`resolveRoute`、`models`、`publish`、`claimWorkspace` / `workspaceOwner` / `releaseWorkspace`、`dispose`；`REVIEW_OUTPUT_SCHEMA` |
| [../lib/core.js](../lib/core.js) | 状态机与合并门禁：init/add/edit/spawn 记录维护、只读查询（`status` / `mission` 完整快照，`summary` 紧凑概览：全局 counts + 每 mission 一行条目）、gate 评估、merge/rebase/abandon/teardown、失败恢复 | `TowerCore`：`init`、`status`、`mission`、`summary`、`addMission`、`editMission`、`beginSpawn`、`attachSpawn`、`completeSpawn`、`failSpawn`、`evaluateMergeGate`、`mergeGate`、`merge`、`rebase`、`abandon`、`teardown`、`recover`；`recoverRebaseFailure` / `recoverMergeFailure` |
| [../lib/store.js](../lib/store.js) | 原子持久化：`state.json` 读写、串行更新队列、schema 校验、`.git/info/exclude` 维护 | `TowerStore`：`read` / `write` / `update` / `ensureLayout`；`validateState`；`ensureLocalExclude` |
| [../lib/git.js](../lib/git.js) | Git 操作封装：无 shell 的 `execFile` 调用、rev-parse / status / merge-base / diff 等原语 | `runGit`、`gitOut`、`repoRoot`、`head`、`currentBranch`、`status`、`assertClean`、`isAncestor`、`changedFiles`、`rebaseInProgress`、`localExcludeFile` |
| [../lib/projection.js](../lib/projection.js) | 把控制器发布的状态变成 session projection 事件（zod 校验） | `TOWER_RECORD_TYPE`、`towerProjectionDefinition`、`towerStateSchema` |
| [../lib/client.js](../lib/client.js) | Web UI：会话头 popover + 右侧 Sidebar Tower 标签页，missions / agents 两个视图 | `apply`（client）、`missionNextStep`、`missionDependencyState`（后两者供测试） |
| [../lib/errors.js](../lib/errors.js) | 统一错误类型 | `TowerError`、`assertTower`、`errorMessage`、`errorDetails` |
| [../scripts/tower-doctor.mjs](../scripts/tower-doctor.mjs) | 独立只读诊断 CLI：state 结构、Git/Worktree 事实与元数据健康对账（§8.1） | `collectFindings`、`runDoctor`、`validateStateStructure` |
| [../scripts/release.mjs](../scripts/release.mjs) | 独立本地发布 CLI：plan/apply 分离、双层跨进程锁、原子写与回滚（§8.2） | `computePlan`、`runRelease`、`applyPlan`、`atomicWrite` |

依赖方向：`index.js` → `runtime.js` → `core.js` → (`store.js`, `git.js`, `errors.js`)；`projection.js` 被 `index.js` 注册、被 `runtime.js` 写入、被 `client.js` 消费；`client.js` 仅读取 projection，不直接触碰 Git 或状态文件。

### 2.1 工具注册（lib/index.js）

`apply` 注入 `tools`、`subagents`、`workingDirectory`、`llm`、`sessions`、`sessionProjections` 六个服务，注册名为 `tower` 的工具。工具的 action 枚举为 `init / add / edit / spawn / recover / send / interrupt / status / summary / gate / merge / rebase / abandon / teardown / models`（共 15 个，见 [../lib/index.js](../lib/index.js) 的 `enum`）。所有动作都委托给 `TowerRuntime.execute`。

`summary` 已由 `TowerRuntime.execute` 的 `case 'summary'` 接入，返回 `{ summary: await core.summary(...) }`；它与 `status` / `gate` 一样属于只读动作，完整返回契约见 §2.7。

`edit` 已可用：`execute` 的 `case 'edit'` 分支把 `mission_id / title / description / scope / depends_on` 映射到 `TowerCore.editMission`，且只转发调用方实际提供的字段（未提供的字段保持原值，不会被 `undefined` 覆盖）；仅 `pending` 状态的 mission 可编辑，其余状态抛 `MISSION_NOT_EDITABLE`（依赖校验的不变量见 §4.6；测试见 [../test/core.test.js](../test/core.test.js) 与 [../test/runtime.test.js](../test/runtime.test.js)）。

### 2.2 运行时（lib/runtime.js）

`TowerRuntime` 持有：

- `cores: Map<repoRoot, TowerCore>` —— 每个仓库一个 core 实例（`coreAt`）。
- `active: Map<runId, entry>` —— 本运行时启动、尚未落定的 worker/reviewer 激活。
- `inFlight: Map<repoRoot, sessionId>` —— 正在执行某次 `tower` 调用的 Session 占位（所有权的第一来源）。

主要流程：

- **`execute(args, exec)`**：校验调用方 Session（`assertCallingAgent`）→ `models` 动作直接走 LLM 目录（不触碰仓库状态）→ 其余动作先 `resolveRoot`（经 `workingDirectory.ensure` + `git rev-parse --show-toplevel`），再 `claimWorkspace`，然后 `coreAt` 打开（或 init）core 并分发动作，最后 `releaseWorkspace`。除 `status / summary / gate / send / interrupt` 外的动作成功后（以及任何动作抛错的 catch 路径上）调用 `publish` 发布 projection。
- **`spawn(core, agent, args, signal)`**：`resolveRoute` 解析模型路由 → `core.beginSpawn` 预写状态（先占位，防并发重复派生）→ 生成角色 briefing（`workerBrief` / `reviewerBrief`）→ `ctx.subagents.startActivation` 以 `provider: spawn`、`cwd: mission.worktree`、reviewer 附带 `outputSchema: REVIEW_OUTPUT_SCHEMA` 启动子代理 → `core.attachSpawn` 记录 `childId` → `track(entry)` 在后台跟踪。启动失败会回滚：`failSpawn` 记录失败状态；attach 失败额外 `activation.dispose()`。
- **`track(entry)`**：等待 `activation.result`，交给 `core.completeSpawn` 结算状态；随后 `publish` 并向控制器 Session `steer` 一条 `subagent-settled` 通知（子代理落定提示，不是结果本身）。
- **`resolveRoute`**：合并 role 默认（config 的 `workerAgentOptions` / `reviewerAgentOptions`）与 per-spawn 参数（`provider`+`model` 必须成对、`reasoning_effort`、`max_tokens` 正安全整数）；无任何覆盖时子代理继承控制器路由（`parentAgentOptionsForDelegation`）；配置了 `allowedModels` 时做精确路由允许清单校验（`MODEL_ROUTE_NOT_ALLOWED`）；最终经 `ctx.llm.resolveCallConfig` 验证。解析出的 route 同时写进 mission 的 `worker` / `review` 记录，供 projection/UI 展示。
- **`models`**：三种形态——不带 `provider` 时聚合并返回所有 provider 的目录（`listProviders()` + 每个 provider 一次 `listModels()`，按 provider/model 排序，每个 provider 最多 100 条并带 `truncated` 标志，单个 provider 失败内聚为该条目的 `error` 而不让整个聚合失败；取消信号除外）；只带 `provider` 时返回该 provider 目录（上限 500 条）；`provider + model` 时经 `resolveModelInfo` 返回单条精确路由元数据。目录形态不逐个解析每模型的调用配置。

### 2.3 核心状态机与门禁（lib/core.js）

`TowerCore` 的全部变更都通过 `store.update`（读-改-写 + 校验 + 落盘）完成；状态迁移伴随 `mission.revision += 1` 与事件追加（`appendEvent`，全量保留最近 200 条，`publicState` 对外只暴露最近 20 条）。状态机细节见 §3，门禁细节见 §5。

只读查询不经过 `store.update`：`status` / `mission` 返回完整快照；`summary` 返回紧凑概览——全局 `counts` 加每 mission 一行条目。可选 `mission_id` 只收窄条目，counts 始终描述整个 tower；未知 id 抛 `MISSION_NOT_FOUND`，未 init 抛与 `status` 相同的初始化错误。`summary` 不追加事件、不递增 revision、也不改 `updatedAt`，对 §4 不变量与 §5 gate 均无影响；精确字段与工具层包装见 §2.7。

### 2.4 存储（lib/store.js）

`TowerStore` 的要点：

- 布局：`<repoRoot>/<stateDirectory>/state.json` 与 `<stateDirectory>/worktrees/`（默认 `stateDirectory = .dsh-tower`，可用 config 覆盖，但必须保持在仓库内——`STATE_DIRECTORY_INVALID`）。
- `write`：先 `validateState`（version 必须为 1、`repoRoot` 绝对路径、mission 字段与 status 合法、id 唯一、`revision` 为正整数），再写临时文件 `${statePath}.${pid}.${uuid}.tmp`（权限 `0o600`）后 `rename` 原子替换，并刷新 `updatedAt`。
- `update(mutator)`：所有状态变更排在一个 per-store 的 promise 队列（`this.queue`）上串行执行，保证同一进程内的读-改-写不交错。注意这是**进程内**串行化，不是跨进程 Git 锁（见 §6.4）。
- `ensureLocalExclude`：把 `<stateDirectory>/` 追加进 `.git/info/exclude`（经 `git rev-parse --git-path info/exclude` 定位），使状态目录与 worktrees 不进版本库。这是本地 exclude，不会被提交。

### 2.5 Git 操作（lib/git.js）

所有 Git 调用走 `runGit`：`execFile('git', ['-C', cwd, ...args])`，**不经过 shell**、只接受字符串数组参数；`GIT_TERMINAL_PROMPT=0` 禁止交互式凭证提示，`LC_ALL=C` 稳定输出；默认 120s 超时、8MB `maxBuffer`、诊断信息截断到 8192 字符。上层原语（`head`、`status`、`isAncestor`、`changedFiles` 等）全部基于它。

### 2.6 投影与 UI（lib/projection.js、lib/client.js）

- 控制器侧：`TowerRuntime.publish` 把 `core.status()` 的快照作为 `plugin:tower/state` 记录追加进控制器 Session（`appendPluginRecord`）并 `sessions.flush`。
- projection 侧：`towerProjectionDefinition`（key 为 `tower`）用 zod schema 校验记录，坏记录变成 `failure` 字段而不是抛错。
- UI 侧（[../lib/client.js](../lib/client.js)）：会话头 popover 与右侧 Sidebar 标签页共享 `TowerWorkspace`。它汇总所有 Session 的 tower projection，按 `repoRoot` 聚合并取 `updatedAt` 最新的一份；提供 missions 视图（`MissionCard`：阶段、依赖芯片、worker/reviewer 行、mergeCommit、由 `missionNextStep` 推导的「下一步/受阻」提示）与 agents 视图（按角色分组、all/running/attention 过滤、点击卡片经 `subagentchat` 资源打开子代理会话）。UI 是只读投影，不是实时镜像。

### 2.7 只读动作契约

`status` / `summary` / `gate` / `models` 均不调用 `store.update` 或 `store.write`，成功路径也不发布 projection；它们不会追加事件、递增 mission revision 或刷新 `updatedAt`，必须让 `state.json` **逐字节不变**。前三个动作只读取 state 与 Git 实况；`models` 在 `resolveRoot` / `coreAt` 之前直接返回，甚至不要求仓库已 init。这里的「只读」不表示跳过 §6.1 的进程内 workspace 归属校验。

| 工具动作 | 返回结构与精简规则 |
| --- | --- |
| `status` | 无 `mission_id` 时直接返回 `publicState`：`version / repoRoot / baseBranch / baseCommit / createdAt / updatedAt / missions / events`（events 仅末 20 条）；带 `mission_id` 时返回 `{ mission }`。`observe:true` 只增加只读 Git 观察 `observations`，不改持久化状态。 |
| `summary` | 返回 `{ summary }`，其中 `summary` 含 `version / repoRoot / baseBranch / baseCommit / counts / missions`。`counts` 是七个全塔桶：`missions` 为总数，`workerRunning` / `reviewRunning` / `approved` / `merged` / `abandoned` 各计同名状态，`blocked` 合并计算 `rebase_blocked + merge_blocked`；其余状态只体现在总数与条目中。 |
| `gate` | 直接返回 `evaluateMergeGate` 的 `{ ready, blocks, observations }`；block code 见 §5。已合并对账形态为 `ready:false, alreadyMerged:true, blocks:[], warnings, observations`，仍只是查询，真正记账由 `merge` 完成。 |
| `models` | 无 `provider` 时返回 `{ providers, allowedModels? }`，每个 provider 条目含 `provider / name? / models / truncated`，失败时另带该 provider 的 `error`，按 provider/model 排序且每个 provider 最多 100 个模型；只带 `provider` 时返回 `{ provider, models, allowedModels? }`，最多 500 条；`provider + model` 时同样返回 `{ provider, models:[精确路由元数据], allowedModels? }`。目录查询不逐模型解析调用配置。 |

`summary.missions[]` 的每项只有 `id / title / status / dependsOn / worker / review / mergeCommit`：无 worker/review 记录时对应字段为 `null`，无 merge commit 时 `mergeCommit:null`；worker 精简为实际存在的 `provider / model / reasoningEffort / stopReason`，review 精简为 `provider / model / verdict / merge`。description、scope、worktree、事件与运行历史均不进入该概览。可选 `mission_id` **只收窄 `missions[]`**，七个 counts 仍是全塔值；未知 id 抛 `MISSION_NOT_FOUND`。

可执行契约：[../test/readonly-actions.test.js](../test/readonly-actions.test.js) 用真实 Git 仓库固定 status/summary/gate 的跨状态一致性、JSON round-trip 与 state 字节不变；[../test/runtime.test.js](../test/runtime.test.js) 固定 runtime 的 summary 接线及只读动作不发布 projection；[../test/doctor-json-schema.test.js](../test/doctor-json-schema.test.js) 则固定 §8.1 诊断 JSON 的键集合、退出码与重复运行字节稳定性。[../test/scale-smoke.test.js](../test/scale-smoke.test.js) 另以 100-mission state 固定紧凑查询与事件上限的抗退化行为。

## 3. Mission 状态机

状态全集（[../lib/store.js](../lib/store.js) 的 `STATUSES`，共 12 个）：

```
pending / worker_running / worker_completed / worker_failed / review_failed / review_running /
changes_requested / approved / rebase_blocked / merge_blocked / merged / abandoned
```

辅助集合（[../lib/core.js](../lib/core.js)）：

- `ACTIVE_STATUSES = { worker_running, review_running }` —— 有子代理在跑，阻止同 mission 的其他变更动作。
- `TERMINAL_STATUSES = { merged, abandoned }` —— 终态，同时是依赖（`depends_on`）的「已解决」判据（`dependenciesReady`）。
- `WORKER_RESTARTABLE = { pending, worker_completed, worker_failed, review_failed, changes_requested, approved, rebase_blocked, merge_blocked }` —— 可启动（或重启）worker 的状态。
- `REVIEW_RESTARTABLE = { worker_completed, review_failed, approved, changes_requested }` —— 可启动（或重试）reviewer 的状态。

状态集合的不变量与「状态 × 动作」全集结局由 [../test/state-machine.test.js](../test/state-machine.test.js) 固定：它用真实 Git 仓库跑满 **12 个状态 × 7 个动作**（spawnWorker、spawnReviewer、merge、rebase、teardown、editMission、addDependent）矩阵，并断言 `ACTIVE ∪ TERMINAL ∪ WORKER_RESTARTABLE` 恰好覆盖全部合法状态、三者两两不相交、`REVIEW_RESTARTABLE ⊆ WORKER_RESTARTABLE`、每个合法状态都有矩阵行；所有拒绝/拒绝式结果还要求 mission、revision 与 events 逐项不变。

### 3.1 合法迁移

| 迁移 | 触发（函数） | 前置条件 / 说明 |
| --- | --- | --- |
| （新建）→ `pending` | `addMission` | id 合法且不重复；依赖存在且不重复；scope 校验通过；创建分支与 worktree（或安全对账已有 artifact，见 §7） |
| `pending` 等 8 个可重启状态 → `worker_running` | `beginSpawn`（role=worker） | mission 非终态、非活跃、worktree 未移除；依赖全部终态（`DEPENDENCIES_NOT_MERGED`）；pending 工作树若落后于当前 base，仅在干净、仍为创建时基线且可快进时刷新，拒绝覆盖忽略文件或自动变基独有提交；**同时清空既有 review 记录** |
| `worker_running` → `worker_completed` | `completeSpawn` | 子代理 `stopReason === 'completed'` 且 worktree 干净（记录 `headCommit`）；否则见下一行 |
| `worker_running` → `worker_failed` | `completeSpawn` / `failSpawn` | 非完成停止原因；或结束时 worktree 有未提交/未跟踪文件（记录最多 50 条 dirty entries）；或激活/启动失败 |
| `worker_completed` / `review_failed` / `approved` / `changes_requested` → `review_running` | `beginSpawn`（role=reviewer） | worktree 干净；tip ≠ 当前 base（`NO_CHANGE`）；当前 base 是 tip 祖先（`STALE_BASE`，需先 rebase）；**记录 review 绑定 `baseCommit` + `reviewedCommit`（exact SHA）** |
| `review_running` → `approved` | `completeSpawn` | 绑定仍匹配（见 §4.1）且 structured verdict 为 `verdict === 'clean' && merge === true` |
| `review_running` → `changes_requested` | `completeSpawn` | 绑定匹配但有有效 verdict 不满足 clean+merge |
| `review_running` → `worker_completed` / `review_failed` | `completeSpawn` / `failSpawn` | 有效 verdict 的绑定在审查期间移动时回到 `worker_completed`（`stale: true`）；运行失败、缺少结构化 verdict 或启动失败则进入 `review_failed` |
| 任意非终态、非活跃 → `worker_completed`（tip 或 review 绑定变化），否则保留失败审查或按既有 verdict 恢复阶段 | `rebase` | worktree 干净；成功后 tip 变化或 review 的 base/tip 绑定过期时**清空 review**并返回 `reviewRequired: true`；真正无变化时保留有效 verdict 或 `review_failed` |
| 任意非终态、非活跃 → `rebase_blocked` | `rebase`（失败） | 自动 `rebase --abort` 并核对恢复状态（`recoverRebaseFailure`）；**清空 review**；冲突需人工解决后重试 |
| `approved` / `merge_blocked` → `merged` | `merge` | gate 就绪（§5）；执行 `git merge --no-ff --no-edit -m "Tower: <title> (<id>)" <reviewedCommit>`；成功后验证 merge 结果包含 reviewed commit |
| `approved` / `merge_blocked` → `merge_blocked` | `merge`（Git 失败） | 自动 `merge --abort` 并核对恢复状态（`recoverMergeFailure`）；排障后可重试 |
| `approved` / `merge_blocked` → `worker_completed` | `merge`（`mission-merge-advanced`） | Git 合并成功但结算时发现 worktree tip 已越过 reviewedCommit：合并本身有效，但多出的提交未经审查，清空 review 回到待审查 |
| 任意非终态 → `merged`（对账） | `merge`（`alreadyMerged`） | reviewed SHA 已包含在 base 中且仍等于当前 tip：只做记账（`mission.merge.reconciled = true`），不重复合并 |
| 任意非 `merged`、非活跃 → `abandoned` | `abandon` | `merged` 不可放弃（`MISSION_MERGED`）；artifacts 保留，可事后 `teardown` |
| `worker_running` → `worker_failed`；`review_running` → `review_failed` | `recover` | 仅处理不属于本运行时的 running 记录（§4.4）；reviewer 记录额外标 `stale:true` |
| （不改 status）`worktreeRemoved = true` | `teardown` | 仅终态 mission；见 §4.5 |

### 3.2 `review_failed` 的进入与离开

`review_failed` 是**非活跃、非终态**的可恢复失败，不是审查结论，也不等于绑定过期：

- **进入**：reviewer 启动或 attach 后的回滚由 `failSpawn` 记入；`completeSpawn` 观察到 `stopReason !== 'completed'` 或缺少结构化 verdict 时进入；`recover` 对不属于当前 runtime 的 persisted `review_running` 也进入此态，并记 `stopReason:'aborted'`、`stale:true`。这些路径均保留诊断到 `review.error` / `diagnostic`，追加 `spawn-failed` 或 `activation-recovered` 事件。
- **直接离开**：可重新 `spawn` reviewer（`REVIEW_RESTARTABLE`），也可 `spawn` worker 返工（`WORKER_RESTARTABLE`）；后者按 §3.1 清空旧 review。拿到有效结论后仍只会进入 `approved` 或 `changes_requested`。
- **rebase / abandon**：真正改变 tip 或使 base/tip 绑定过期的 rebase 清空 review 并回 `worker_completed`；完全 no-op 的 rebase 保留 `review_failed` 及失败记录；rebase 失败走 `rebase_blocked`；非活跃时也可 `abandon`。
- **合并边界**：gate 对该状态报 `NOT_APPROVED`。reviewer 运行期间 base/tip 漂移则回 `worker_completed` 且 `review.stale:true`，这是另一条路径，不能误记为 `review_failed`（§4.1）。

### 3.3 `send` / `interrupt` 的归属与返回

`send` 与 `interrupt` 共用 `TowerRuntime.controlAddress`（[../lib/runtime.js](../lib/runtime.js)）的三步校验：`role` 参数先过白名单，只接受 `worker` / `reviewer`，其余值立即抛 `ARGUMENT_INVALID`；core 的 `agentAddress`（[../lib/core.js](../lib/core.js)）再按 role 取对应 worker/review 记录，要求该记录已有 `childId`，且 mission status 分别为 `worker_running` / `review_running`；最后核对本进程 `active` 中的激活，要求 core、runId、missionId、role、childId **全部一致**。因此，已完成的 agent、未 attach 的 running 记录、指向另一角色的地址、重启后遗留或由另一 runtime 拥有的 run 都抛 `AGENT_NOT_RUNNING`，且不会调用 subagents 的发送/取消接口；这避免把消息或中断投递给同名的另一轮运行。

成功返回均带完整地址 `{ mission, role, runId, childId }`：`send` 另含 `sent:true` 与宿主返回的 `messageId`，消息文本经 trim 后转发；`interrupt` 另含 `interrupted:true`，以 `{ kind:'ancestor', agent }` 请求取消。两个动作本身不写 Tower state，成功路径也不 publish；实际落定状态仍由 §6.3 的 `track` 统一结算。覆盖测试见 [../test/control-actions.test.js](../test/control-actions.test.js)。

### 3.4 落定通知的保证

`TowerRuntime.track` 对每个激活只走一条结算链：等待 `activation.result` → `completeSpawn`，异常时尝试 `failSpawn` → 在 `finally` 删除 active 并 dispose activation → 独立尝试 publish → 构造并向控制器 `steer` 一条 `subagent-settled` 通知。状态落账与 projection 发布分别被隔离，二者失败都不能吞掉后续通知；即使两次状态写入都失败，fallback 通知仍点名 role、mission、runId 与错误，并提示先用 `status` 检查。

通知首行是 `Tower <role> for <mission> <outcome>: mission status <status>`；`failed` / `interrupted` / `stale` 附 reason 和下一步，reason 统一以 `boundedReason` 截到 500 字符。`review_failed` 指引重派 reviewer，`changes_requested` 指引 worker 返工后重审，approved 指引 gate/merge。这里的「保证送达」指**每次落定都必然生成并尝试投递，前序失败不会静默**；若宿主 `steer` 自身抛错，则记录 error 日志，不伪称还有跨进程持久队列或自动重试。可执行契约见 [../test/runtime.test.js](../test/runtime.test.js) 的 track/settlement 用例。

### 3.5 不允许的操作

- 终态（`merged` / `abandoned`）不能再 `spawn`（`MISSION_TERMINAL`）或 `rebase`；`merged` 不能 `abandon`。
- 活跃状态（`worker_running` / `review_running`）不能再 `spawn`（`AGENT_BUSY`）、`rebase`、`abandon`；`send` / `interrupt` 只寻址活跃子代理（§3.3）。
- 非 `REVIEW_RESTARTABLE` 状态（如 `pending`、`worker_failed`、`rebase_blocked`、`merge_blocked`）不能 `spawn` reviewer（`REVIEW_START_BLOCKED`）——审查必须先有一轮可审查的 worker 产出。
- `teardown` 对非终态 mission 不抛异常，而是逐条返回结构化拒绝（`removed:false` + `reason:'status-<status>'`）。
- 活跃状态下不会出现 `worker_failed` / `changes_requested` 等落定状态（它们是活跃态的结算结果）；`rebase_blocked` / `merge_blocked` 也只在非活跃的 Git 操作失败时产生。
- 上述拒绝与结构化拒绝都**不改 state**：mission、revision 与 events 逐项不变（[../test/state-machine.test.js](../test/state-machine.test.js) 对每个矩阵单元格断言）。

## 4. 关键不变量

这些不变量是审查绑定与合并安全的根基，改动相关代码时必须保持：

### 4.1 Review 绑定 base + tip 的 exact SHA；任何移动即失效

`beginSpawn`（reviewer 分支）把审查开始时刻的 `baseCommit`（base 分支当前 tip）与 `reviewedCommit`（mission worktree 当前 tip）写入 `mission.review`。此后有两道校验：

- `completeSpawn`：reviewer 结束时重读两端 SHA，`currentTip === record.reviewedCommit && currentBase === record.baseCommit` 才接受 verdict；否则 review 记录标 `stale`，mission 回到 `worker_completed`。
- `evaluateMergeGate`：`REVIEW_TIP_STALE`（审查的 tip ≠ 当前 tip）与 `REVIEW_BASE_STALE`（审查的 base ≠ 当前 base）都是硬阻塞。

因此任何 rebase、追加提交、base 前移都会让既有审查失效，必须重新派生 reviewer。`rebase` 与新一轮 worker spawn 也会主动清空 `mission.review`。

### 4.2 Merge 只消费 reviewed commit

- 只有 `verdict === 'clean' && merge === true` 的 review 记录才算「干净且同意合并」的审查（`NO_CLEAN_REVIEW`）。
- `merge` 把 gate 观察到的 `gate.observations.reviewedCommit`（即与 review 绑定一致的 tip）作为唯一合并对象：`git merge --no-ff --no-edit -m "Tower: <title> (<id>)" <reviewedCommit>`。
- 合并后验证 `isAncestor(reviewedCommit, mergeCommit)`；验证失败或事后观察失败进入 `mergeAttempted / verified: false / recoveryRequired` 路径，绝不记 `merged: true`。
- `alreadyMerged` 对账同样要求 reviewed SHA 等于当前 tip 且已包含在 base 中。

### 4.3 Worker 必须留下干净的已提交工作区

`completeSpawn`（worker 分支）在子代理停止后检查 worktree：`stopReason !== 'completed'` 或 `git status --porcelain --untracked-files=all` 非空都判 `worker_failed`（记录 dirty entries）。未提交/未跟踪的产物进不了审查。

### 4.4 Recover 不接管旧进程

`recover(activeRunIds)` 只把「状态文件里是 running、但 runId 不属于本运行时活跃集合」的记录标记为中止：worker 记录 `stopReason: 'aborted'` → `worker_failed`；reviewer 记录额外标 `stale: true` → `review_failed`。它从不尝试 attach、杀掉或继承旧控制器启动的进程；旧激活落定后由其宿主自行处理。重启后 persisted running 记录会一直阻塞新派生，直到控制器显式调用 `recover`。

### 4.5 Teardown 只清理 merged/abandoned 且干净的 worktree

`teardown` 逐 mission 检查：

1. 仅 `TERMINAL_STATUSES`（`merged` / `abandoned`）且非活跃；
2. 记录路径 `path.resolve(mission.worktree)` 必须位于 `store.worktrees` 目录之下（`WORKTREE_PATH_INVALID`，防止被伪造的 state.json 诱导删除任意目录）；
3. 必须出现在 `git worktree list --porcelain` 的注册列表中且 `git status` 干净，才执行 `git worktree remove`；
4. 未注册但磁盘上存在异常路径 → 拒绝（`not-a-registered-worktree`），绝不删除；未注册且磁盘上确实不存在 → 记账对账（`worktree-remove-reconciled`）。

分支与 `state.json` 永远保留；`teardown` 不改 mission status。

### 4.6 依赖必须终态才可开工

`beginSpawn`（worker）要求 `mission.dependsOn` 中每个依赖都处于 `merged` 或 `abandoned`（`dependenciesReady`；`abandoned` 也算「已解决」，因为依赖被放弃后不再阻塞下游）。gate 同样复查（`DEPENDENCIES_NOT_MERGED`）。`addMission` / `editMission` 保证依赖存在、不重复、且新边不构成环（`assertNoDependencyCycle`，自环也拒绝）。

### 4.7 Revision 单调递增

每次状态迁移（以及 spawn 记录变更）`mission.revision += 1`，revision 为正整数由 `validateState` 兜底。UI 与调用方可据此察觉状态演进。

## 5. Merge Gate（evaluateMergeGate）

`gate` / `merge` 共用 `evaluateMergeGate`，阻塞项（blocks）包括：

| 代码 | 条件 |
| --- | --- |
| `NOT_APPROVED` | mission 状态不是 `approved` / `merge_blocked` |
| `DEPENDENCIES_NOT_MERGED` | 存在非终态依赖 |
| `WORKTREE_REMOVED` | mission worktree 已被清理 |
| `BASE_DIRTY` | 主 checkout 有未提交/未跟踪文件 |
| `BASE_MISMATCH` | 主 checkout 不在 base 分支上（含 detached HEAD） |
| `WORKTREE_DIRTY` | mission worktree 不干净 |
| `NO_CHANGE` | mission tip 等于当前 base |
| `STALE_BASE` | 当前 base 不是 mission tip 的祖先（需要先 rebase） |
| `NO_CLEAN_REVIEW` / `REVIEW_TIP_STALE` / `REVIEW_BASE_STALE` | 见 §4.1、§4.2 |
| `OUT_OF_SCOPE` | mission 声明了非空 scope，但 `git diff --name-only --no-renames base...tip` 中出现不在 scope glob 内的文件 |

全部通过才 `ready`；另有 `alreadyMerged` 快捷判定（干净审查 + reviewed SHA 即当前 tip 且已包含在 base 中），走记账对账而非再次合并。scope 为空表示「不限制路径」。

## 6. 并发与所有权

### 6.1 每仓库一个控制器

所有权策略完整地实现在 `TowerRuntime` 的三个方法里（成员资格跟仓库不跟 Session 血缘）：

- `workspaceOwner(root)`：先看 `inFlight`（某次 `tower` 调用正在执行），再遍历 `this.active`（本运行时启动的激活，其 core 的 `store.repoRoot` 等于该仓库且父 Session 存活）。
- `claimWorkspace(root, sessionId)`：存在他人所有权时抛 `WORKSPACE_BUSY`；否则登记本次调用。claim 发生在 `init` / `open` 之前，被拒绝的 Session 不会触碰状态。
- `releaseWorkspace(root, sessionId)`：调用结束时只释放自己持有的 claim。

也就是说：一个 Session 可以接管空闲 tower；另一个 Session 在「有调用在飞」或「该 tower 的 worker/reviewer 仍在跑」期间被拒绝。

### 6.2 状态串行化

同一 `TowerStore` 的所有 `update` 排在 per-store promise 队列上（读→改→校验→原子写），进程内不会交错提交状态。跨 mission 的 Git 操作（如同时 merge 两个 mission）没有全局锁，各自以 `assertClean` + gate 观察为前置。

### 6.3 激活生命周期

`spawn` 先 `beginSpawn` 占位（状态进入 running，防止同 mission 重复派生），再启动激活、`attachSpawn` 记录 `childId`；`track` 在后台等待结果并结算。`dispose`（插件卸载）会 abort 所有在飞调用并 dispose 所有激活；落定路径上的 `active.delete` 保证所有权最终释放。

### 6.4 单进程边界（重要）

所有权与串行队列都只在**单个 Host 进程内**成立。它们不是跨进程的 Git 锁：两个 Host 进程同时对该仓库充当控制器不会被 `WORKSPACE_BUSY` 拦住。不要在两个进程中同时操作同一份 tower 状态。§8.2 发布脚本的锁只保护 release apply 自己的目标文件，不能替代这里的单控制器约束。

## 7. 数据布局

```
<repoRoot>/
├── .dsh-tower/                     # stateDirectory（config 可改，必须留在仓库内）
│   ├── state.json                  # 版本 1 状态文件，0o600，临时文件 + rename 原子写
│   └── worktrees/
│       └── <mission-id 小写>/       # 每 mission 一个 Git worktree（如 m1/）
├── .git/
│   ├── info/exclude                # 追加 "<stateDirectory>/" 条目（本地排除，不提交）
│   ├── release-apply.lock          # release --apply 主锁（§8.2，瞬时跨进程锁，非 Tower state）
│   └── release-apply.reclaim.lock  # 陈旧主锁回收的串行化锁（§8.2）
└── ...
```

- **分支命名**：`<branchPrefix>/<mission-id 小写>`，默认 `tower/m1`；`branchPrefix` 与 `stateDirectory` 都来自插件 config（默认值见 [../lib/runtime.js](../lib/runtime.js) 构造函数）。mission id 形如 `M1` / `API`（`/^[A-Z][A-Z0-9_-]{0,31}$/`），未指定时自动分配 `M<max+1>`。
- **`state.json` 结构**（`validateState`）：`version: 1`、`repoRoot`（绝对路径）、`baseBranch`、`baseCommit`、`createdAt` / `updatedAt`、`missions[]`、`events[]`（最多保留 200 条）。每个 mission 记录：`id`、`title`、`description`、`dependsOn`、`scope`、`branch`、`worktree`、`baseCommit`、`status`、`revision`、`createdAt`、`worktreeRemoved`，以及可选的 `worker` / `review`（runId、route、childId、起止时间、stopReason、output、headCommit / 绑定与 verdict、`stale` 等字段）与 `merge`（mergedAt、commit、reviewedCommit、baseCommit、可选 reconciled）记录。projection 的 zod schema（[../lib/projection.js](../lib/projection.js)）与之对应。
- **artifact 对账**：`addMission` 遇到已存在的同名分支/worktree 时，只有「两者同时存在、worktree 干净、位于该分支、tip 是当前 base 的祖先（无独立提交）」才对账复用（`mission-artifacts-reconciled`，mission 记 `reconciled: true`、`baseCommit` 取 worktree tip）；任何不匹配都抛 `MISSION_ARTIFACT_CONFLICT`，交给人工检查，绝不自动删除。

## 8. 诊断与发布工具

两个脚本都是独立 CLI，不经过 `TowerRuntime`，也不取得 Tower 的进程内 workspace ownership；它们的读写边界不能与 §6 的控制器模型混为一谈。操作步骤见 [operations.md](operations.md)，本节只固定设计与输出契约。

### 8.1 `tower-doctor`：只读对账与稳定 JSON

[../scripts/tower-doctor.mjs](../scripts/tower-doctor.mjs) 默认检查当前仓库的 `.dsh-tower/state.json`，也可用 `--repo` / `--state` 指定目标。检查维度包括：

1. state 可读性、JSON/schema、版本、必填字段、mission id 与依赖；
2. state.repoRoot 与实际仓库、base 分支及记录的 baseCommit 是否存在、漂移或分叉；
3. 每 mission 的分支/baseCommit、worktree 的磁盘存在性、Git 注册、检出分支与 teardown 标记一致性，以及孤儿 worktree；
4. merged mission 的 merge 记录及 mergeCommit 是否可达于 base；
5. running 状态的 run 记录是否缺失或看似已经结束；
6. Git 元数据健康：POSIX 下的异属主扫描，以及现存 objects、refs、index 和 Tower state 目录的可写性。

脚本只执行查询型 Git 命令与 `readFile/readdir/stat/lstat/access` 等读取，不改 state、不改 Git、不执行修复建议中的 `chown` / `chmod`。退出码默认为 `0`（无 finding）、`1`（有 warning 且无 error）、`2`（任一 error，或参数用法错误）；error 优先于 warning。可选 `--fail-on-warning` 提供严格守门：仅有 warning 的运行退出码由 `1` 升级为 `2`，clean 仍为 `0`、error 仍为 `2`，默认策略不变，适合发布检查 / CI 门禁在 warning 即失败（用法速查见 [operations.md](operations.md) 附录 C）。

有效参数的 `--json` 诊断运行把**唯一一个 JSON 对象写入 stdout**，人类可读诊断不混入 stdout，stderr 为空。对象含 `repo / statePath / findings / summary`，state 结构可用时另含 `baseBranch / baseTip`；仅在显式给出 `--fail-on-warning` 时额外携带 `failOnWarning: true`，默认输出的键集与类型保持不变（向后兼容的可选增键）；早期失败无法解析的字段用 `null` 或省略可选 base 字段。`summary` 固定为 `checksPassed / warnings / errors / exitCode`；finding 至少有 `code / severity / message`，再按类别附 `mission / role / path / sample` 等上下文。用法错误以退出码 2 输出到 stderr，不属于上述有效诊断 JSON 形态。

当前共有 **32 个 finding code**，分类如下（测试用白名单封闭集合，新增 code 必须同步契约测试）：

| 分类 | codes |
| --- | --- |
| state（5） | `STATE_CORRUPT`、`STATE_FIELD_INVALID`、`STATE_MISSING`、`STATE_READ_FAILED`、`STATE_VERSION` |
| repo / base（7） | `REPO_INVALID`、`REPO_MISMATCH`、`BASE_BRANCH_MISSING`、`BASE_COMMIT_UNKNOWN`、`BASE_COMMIT_DRIFT`、`BASE_COMMIT_DIVERGED`、`BASE_COMPARE_FAILED` |
| mission / 依赖（5） | `MISSION_BASE_UNKNOWN`、`MISSION_BRANCH_MISSING`、`MISSION_DEP_UNKNOWN`、`MISSION_DUPLICATE`、`MISSION_FIELD_INVALID` |
| worktree / teardown（8） | `ORPHAN_WORKTREE`、`TEARDOWN_INCOMPLETE`、`WORKTREE_BRANCH_MISMATCH`、`WORKTREE_DIR_MISSING`、`WORKTREE_LIST_FAILED`、`WORKTREE_SCAN_FAILED`、`WORKTREE_STILL_REGISTERED`、`WORKTREE_UNREGISTERED` |
| merge（3） | `MERGE_COMMIT_NOT_IN_BASE`、`MERGE_COMMIT_UNKNOWN`、`MERGE_RECORD_MISSING` |
| running（2） | `RUNNING_RECORD_FINISHED`、`RUNNING_RECORD_MISSING` |
| Git 元数据（2） | `GIT_METADATA_FOREIGN_OWNER`、`GIT_METADATA_NOT_WRITABLE` |

异属主 finding 的 `sample` 最多 **10 条**，`count` 只表示本次实际扫描发现的数量。扫描默认最多执行 **5000 次 `lstat`**，达到预算即停止并置 `truncated:true`，所以结果不是完整仓库属主审计；`node_modules` 与 Tower worktrees 目录始终跳过，符号链接不跟随。无 `process.getuid()` 的平台跳过异属主扫描，可写性检查仍执行。

[../test/doctor-json-schema.test.js](../test/doctor-json-schema.test.js) 是输出与退出码的可执行契约，并验证重复运行输出逐字节稳定、state 不变；[../test/doctor.test.js](../test/doctor.test.js) 固定 10 条样例上限、扫描预算和 `truncated` 行为，以及 `--fail-on-warning` 的退出码策略（含 `--json` 的向后兼容增键）；[../test/doctor-tower.test.js](../test/doctor-tower.test.js) 另以真实 `TowerCore` 生命周期（真实 worktree / commit / merge / teardown，Git 不 mock）产出的 state 做集成对账，仅人为改写 state.json 模拟健康生命周期不会自行产生的崩溃/伪造场景。

### 8.2 `release`：plan/apply 分离、双层锁与回滚

[../scripts/release.mjs](../scripts/release.mjs) 只准备本地版本变更，不 commit、tag、push 或访问网络。`computePlan` 读取并校验 semver、日期、`package.json` 与 `CHANGELOG.md`，生成包含每份文件 `before/after` 的计划；默认 dry-run 只渲染计划 diff，**不取锁、不写文件**。`--apply` 把整个操作——重新执行 `computePlan`、要求 `git status --porcelain` 为空、写入——都放进锁的临界区内，竞争者不可能使用持锁者写入前算出的旧计划；缺失 CHANGELOG 只有显式 `--create-changelog` 才允许创建。成功输出后文件保持 dirty，交由人工复核与提交；若本次接管了陈旧锁，输出附 `lockNotice` 说明接管原因。

为避免两个进程同时依据同一旧版本完成计划并互相覆盖，`--apply` 使用**双层跨进程锁**（下称主锁 L 与回收锁 R），而不是复用 §6 的 Tower 单进程机制：

- 两把锁都由 `git rev-parse --absolute-git-dir` 定位到 Git 实际 git-dir（linked worktree 各有各的 git-dir）：L 为 `<gitdir>/release-apply.lock`，R 为 `<gitdir>/release-apply.reclaim.lock`。锁不落在工作区，因此不会破坏 clean-worktree 前置条件，也不需要修改 `.gitignore`。
- **快路径**：以排他创建（`open 'wx'`，权限 0o600）原子抢 L；锁内容为 JSON `{ pid, timestamp, token }`，`token` 是本次持有的唯一凭据。
- L 已存在时先做陈旧判定：仅当持有 pid 已不存在（`process.kill(pid, 0)` 报 `ESRCH`）或锁龄至少 **10 分钟**（优先读锁内 timestamp，坏锁回退文件 mtime）才允许回收；否则立即抛 `RELEASE_LOCKED`，消息点名持有者 pid（无法解析时称 unknown pid）并明确**不等待、不自动重试**。
- **回收先取 R**（获取协议与 L 相同，陈旧的 R 本身也要先被回收）：R 把「陈旧 L 的回收」串行化。持有 R 后重读 L，内容必须与陈旧判定时逐字节一致，否则视为被竞争者替换（`RELEASE_LOCKED`）；随后把 L 以 `rename` 原子移入唯一隔离路径，并核验移入的字节仍是判定时那把旧锁——若发现移动的其实是竞争者刚换上的新锁，用硬链接恢复原位并中止，绝不误删；确认无误才删除隔离文件并以 `wx` 创建新 L（此时 `EEXIST` 说明有更快者，同样 `RELEASE_LOCKED`）。
- **释放只删自身 token**：释放同样先 `rename` 到唯一隔离路径、核验 token 仍属于自己才删除；若锁已被换成别人的则原样保留。L 与 R 都在 `finally` 中按此协议释放。文件系统层面的失败以 `RELEASE_LOCK_FAILED` / `RELEASE_UNLOCK_FAILED` 显式暴露。
- dry-run 不经过上述锁协议；该锁只序列化发布脚本的目标文件写入，不授权两个 Host 同时控制 Tower state（§6.4）。

写入仍逐文件采用同目录临时文件 + `rename` 原子替换，失败时清理本次临时文件。`applyPlan` 记录已成功写入的文件；后续文件失败时按逆序 best-effort 回滚：update 恢复原始字节，create 删除新文件，然后抛 `WRITE_FAILED`，消息区分「尚未写入」「已回滚」与「回滚失败」。因此原子替换降低单文件半写风险，回滚降低两份文件跨文件不一致风险，但后者不是事务保证，回滚错误会明确暴露。回归见 [../test/release.test.js](../test/release.test.js) 与 [../test/release-concurrency.test.js](../test/release-concurrency.test.js)（真进程并发：两个同时 `--apply` 恰有一个成功，落败方报结构化错误且仓库无临时/锁残留；dry-run 与 apply 并发时只有 apply 写文件）。

## 9. 失败恢复语义（汇总）

| 场景 | 行为 |
| --- | --- |
| 控制器重启后状态残留 running | 显式 `recover` 标记中止（§4.4），不接管旧进程 |
| `merge` 的 Git 失败 | `recoverMergeFailure`：必要时 `merge --abort`，核对 HEAD/status/残留 merge 状态，不能证明恢复干净则 `recoveryRequired`，mission → `merge_blocked` |
| `rebase` 失败 | `recoverRebaseFailure`：`rebase --abort` + 同样核对，mission → `rebase_blocked`，review 清空 |
| `merge` 后观察/落盘失败 | `postMerge / verified: false / recoveryRequired`，只有 exact-SHA 验证或后续对账才产生 `merged: true` |
| reviewed SHA 已在 base 中 | `alreadyMerged` 记账对账（§4.2） |
| 重试 `add` / `teardown` | 保守对账已有 artifact（§7、§4.5），意外路径绝不删除 |

## 10. 测试与验证

- `pnpm test`（[../package.json](../package.json)）：[../test/](../test) 下用真实临时 Git 仓库覆盖 core / runtime / store / git / projection / client 逻辑，仅 mock DSH 侧边界（subagents、llm、sessions 等）；[../test/integration.test.js](../test/integration.test.js) 另以真实 worktree / commit / merge（不 mock git）覆盖完整 mission 生命周期的端到端集成测试。
- `pnpm run check`：对 `lib/` 下全部模块做 `node --check` 语法检查。

维护守则：任何触碰状态迁移、gate、review 绑定或 teardown 路径的改动，都应先在测试中固定住对应不变量（§4）再改实现；文档（本文与 [security-model.md](security-model.md)）需同步更新。

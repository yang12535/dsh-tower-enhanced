# Tower 运维 Runbook：故障诊断与恢复手册

本手册面向 Tower 控制器（controller Session）的日常操作与故障处置：每一步的预期输出、失败后的下一步动作，以及各故障场景的安全处理边界。使用入门请先读 [README.md](../README.md)（或 [README.zh-CN.md](../README.zh-CN.md)）；架构论述见 [architecture.md](architecture.md)，安全边界见 [security-model.md](security-model.md)。本手册只做「操作 + 排障」。

## 基线

本手册与 base `c6080c5` 的代码行为一致：[lib/core.js](../lib/core.js)（状态机、merge gate、merge/rebase/teardown/recover 语义）、[lib/runtime.js](../lib/runtime.js)（action 分发、workspace 归属、通知与僵尸探测）、[lib/store.js](../lib/store.js)（state 持久化与校验）、[lib/git.js](../lib/git.js)（git 封装）。该基线包含：`summary` 概览、`review_failed` 状态、pending 首次派发前的 ff-only 基线同步、结算通知落定即生成并尝试投递（§2.10）与 `agent/created` 僵尸提示、rebase 时 base 变化即失效审查、`add`/`edit` 一致的 scope 校验、store 原子写失败清理临时文件，以及只读体检脚本 [scripts/tower-doctor.mjs](../scripts/tower-doctor.mjs)。

## 约定

- 所有变更类操作一律通过控制器 Session 的 `tower` 工具完成；**不要**用 bash 直接改 `.dsh-tower/state.json` 或代替 tower 执行 merge/rebase/teardown。git 命令只用于**只读诊断**（附录 A）。
- 文中 `<repo>` 指仓库根（`state.repoRoot`），`<id>` 指 mission id；mission 的分支为 `tower/<id 小写>`，worktree 为 `<repo>/.dsh-tower/worktrees/<id 小写>`。
- tower 归属跟随仓库而非 Session 血统：同一仓库的 tower 同一时刻只有一个 owner（一次调用在途，或它启动的 worker/reviewer 仍在运行）。第二个 Session 会被 `WORKSPACE_BUSY` 拒绝。
- `status` 返回的 `events` 是 `state.events` 的最后 20 条（state 内上限 200 条，事件类型见附录 B），是排障的第一手时间线。
- 每个 worker/reviewer 落定都会生成一条结算通知并尝试投递到控制器 Session（尽力而为，边界见 §2.10）。投递可能失败且只记 error 日志，所以「没收到通知」本身就是要排查的场景——用 `tower action=status` 与 error 日志兜底。

## 1. 状态机速览

合法状态集合定义在 [lib/store.js](../lib/store.js)（`STATUSES`），迁移逻辑在 [lib/core.js](../lib/core.js)。

| status | 含义 | 进入方式 | 允许的下一步 |
|---|---|---|---|
| `pending` | 已创建，未派生 | `add` / `add` 重试对账 | `spawn` worker（先做基线同步，§2.3）；`edit` 修元数据；`abandon` |
| `worker_running` | worker 运行中 | `spawn` role=worker | `send` / `interrupt`；等待落定 |
| `worker_completed` | worker 已完成且 worktree 干净 | worker 落定 / reviewer 绑定漂移 / `rebase` 后需复审 | `spawn` reviewer；`spawn` worker 返工；`rebase` |
| `worker_failed` | worker 异常结束或留下脏 worktree | worker 落定失败 / `failSpawn` / `recover` | `spawn` worker 重试；`abandon` |
| `review_running` | reviewer 运行中 | `spawn` role=reviewer | `send` / `interrupt`；等待落定 |
| `review_failed` | reviewer 异常结束（进程错误 / 无结构化结论 / 启动失败 / `recover` 标记） | reviewer 落定失败 / `failSpawn` / `recover` | `spawn` reviewer 重试；`spawn` worker 直接返工；`rebase`（真 no-op 时保持 `review_failed`） |
| `changes_requested` | 审查要求返工 | reviewer verdict 非 clean 或 merge≠true | `spawn` worker 返工（清空既有 review）；满足 §2.5 前提时 `spawn` role=reviewer 重审；干净 worktree 可 `rebase`（失效/真 no-op 规则见 §2.9） |
| `approved` | clean 且 merge=true 的审查通过 | reviewer 落定 | `gate` → `merge`；`rebase`；`abandon` |
| `rebase_blocked` | rebase 冲突，tower 已自动 `rebase --abort` | `rebase` 失败 | `spawn` worker 手工解决冲突；`abandon` |
| `merge_blocked` | merge 的 git 步骤失败，tower 已尝试 `merge --abort` | `merge` 失败 | 修复后重试 `merge`（gate 对该状态放行）；`rebase`；`abandon` |
| `merged` | 终态：已并入 base | `merge` 成功 / alreadyMerged 对账 | `teardown` |
| `abandoned` | 终态：放弃（工件保留） | `abandon` | `teardown` |

worker 可重启的状态集合（`WORKER_RESTARTABLE`）：`pending`、`worker_completed`、`worker_failed`、`review_failed`、`changes_requested`、`approved`、`rebase_blocked`、`merge_blocked`。reviewer 可启动的状态集合（`REVIEW_RESTARTABLE`）：`worker_completed`、`review_failed`、`approved`、`changes_requested`。`review_failed` 既非运行中也非终态，reviewer 与 worker 都能从它直接重派。

## 2. 日常操作流

标准闭环：`init` → `add` → `spawn` worker → `status`/`summary` → `spawn` reviewer → `gate` → `merge` → `teardown`。每小节给出调用、预期输出字段与失败后的 next action（均为 tower 动作）。

### 2.1 init

前置：Session 工作目录已切到目标仓库；base 分支已检出且主工作区干净。

```text
tower({action:"init"})            // 可选 base_branch，默认当前检出分支
```

- 预期输出：`{ version, repoRoot, baseBranch, baseCommit, createdAt, updatedAt, missions: [], events }`。幂等：state 已存在时直接返回现有 state。
- 首次 init 会创建 `.dsh-tower/worktrees/`、把 `.dsh-tower/` 写入 git 本地 exclude（`ensureLocalExclude`，不碰 `.gitignore`）。
- 失败与 next action：
  - `BASE_MISMATCH`：当前检出的分支不是请求的 base。先在主工作区检出 base 分支再 init。
  - `BASE_DIRTY`：主工作区有未提交/未跟踪文件。先提交或清理（不要指望 tower 容忍脏 base）。
  - `BASE_CONFLICT`：tower 已锚定其它 base 分支。确认仓库是否搞错；tower 不支持中途换 base。
  - `TOWER_NOT_INITIALIZED` 出现在其它动作上：说明 state 文件缺失，先 init。

### 2.2 add（含 scope 设计与校验规则）

```text
tower({action:"add", id:"M1", title:"...", description:"...", depends_on:["M0"], scope:["docs/**"]})
```

- **依赖输入参数名是 snake_case：`depends_on`。** `M0` 必须已存在。不要把返回字段的 camelCase `dependsOn` 原样传回工具：当前 `add`/`edit` 的运行时分发只读取 `depends_on`，误写 `dependsOn` 会被忽略而不报错；`add` 会得到空依赖，`edit` 则保留旧依赖。调用后核对返回的 `mission.dependsOn`，避免依赖约束被静默省略（schema 见 [lib/index.js](../lib/index.js)，分发见 [lib/runtime.js](../lib/runtime.js)）。
- 预期输出：`{ mission: { id, title, description, dependsOn, scope, branch, worktree, baseCommit, status:"pending", revision, createdAt, worktreeRemoved:false } }`，并创建分支 `tower/<id>` 与隔离 worktree（`git worktree add -b`）。`id` 省略时自动分配 `M<最大序号+1>`。
- scope 校验（`add` 与 `edit` 完全一致，见 [lib/core.js](../lib/core.js) `validateScope`）：
  - 非数组（字符串、`null`、其它类型）→ `ARGUMENT_INVALID`（`scope must be an array of glob patterns`）；空字符串模式 → `SCOPE_INVALID`（`scope patterns must be non-empty strings`）。
  - **模式不做 trim**：字面空白被原样保留（含首尾空格的文件名可以由此匹配）；去重只对完全一致的模式生效。`title`/`description` 则会 trim 且纯空白被拒（`must be a non-empty string`）。
  - 禁止绝对路径与 `..` 段（`SCOPE_INVALID`）；非法 glob 在探测时即抛 `SCOPE_INVALID`。
- scope 设计建议：
  - scope 是仓库相对 glob，空数组 = 完全不限。**建议始终显式给出**——gate 的 `OUT_OF_SCOPE` 检查只在 scope 非空时生效。
  - 粒度以目录/主题为宜（如 `docs/**`、`lib/client.js` + `test/client.test.js` 成对给出）；过宽失去保护，过窄容易把测试、locale 文案等伴生改动误伤成 out-of-scope。
  - 预期会改同一区域的 mission 用 `depends_on` 串行化，而不是靠 scope 并行硬撞（并行写同一文件最终会在 rebase/merge 阶段冲突）。
- 失败与 next action：
  - `MISSION_EXISTS` / `MISSION_ID_INVALID`：换 id（id 规则：大写字母开头，仅大写字母/数字/`_`/`-`，≤32 字符）。
  - `DEPENDENCY_INVALID`（重复或不存在）/ `MISSION_NOT_FOUND`（依赖项）：修正 `depends_on` 指向已存在的 mission。
  - `MISSION_ARTIFACT_CONFLICT`：同名分支/worktree 已存在且无法安全收编（见 3.10）。先用只读命令核对工件，再决定复用新 id 或人工清理。
  - 派生前发现描述写错：不必删掉重来，用 `edit` 修 `title`/`description`/`scope`/`depends_on`（仅 `pending` 可改，`MISSION_NOT_EDITABLE`；`scope:[]` 表示清空限制，省略该字段保持原值）。

### 2.3 spawn worker（含 pending 首次派发的基线同步）

```text
tower({action:"spawn", mission_id:"M1", role:"worker", provider:"...", model:"...", reasoning_effort:"...", max_tokens:...})   // 路由参数可选
```

- 预期输出：`{ mission:"M1", role:"worker", runId, childId, status:"worker_running", worktree, route }`。worker 在 mission worktree 内实现并**必须先 commit** 再结束。
- **pending 首次派发的基线同步**（[lib/core.js](../lib/core.js) `beginSpawn`）：`pending` mission 首次启动 worker 时，tower 读取 base 分支当前 tip；若 worktree 尚未包含它，则先验证 worktree 干净（否则 `WORKTREE_DIRTY`，state 与文件都不动）、检出分支正确（否则 `WORKTREE_BRANCH_MISMATCH`）、worktree tip 恰为记录的 `mission.baseCommit` 且仍在当前 base 的历史中（否则 `STALE_BASE`：worktree 已偏离当前基线——典型是已有 base 之外的独有提交，**必须显式 `rebase`**，tower 不会替你变基），然后执行 `git merge --ff-only --no-overwrite-ignore <base>` 快进到当前 base，使已合并的依赖成果立即可用。快进失败（如忽略文件与新 base 冲突）以 `GIT_FAILED` 原样抛出，本地文件不被覆盖。随后 `mission.baseCommit` 更新为当前 base。
  - 该同步发生在 state 落账之前：若快进已成功但 state 写入失败，重试 `spawn` 即可（快进幂等，测试覆盖此路径）。
  - 重派**已有** worker（非 `pending`）不会自动 rebase 其 worktree——基线同步只发生在 `pending` 的第一次。
- 失败与 next action：
  - `WORKSPACE_BUSY`：另一 Session 正拥有本仓库 tower。回到那个 Session 处理，或等它的调用/子代理落定；不要强行并发。
  - `AGENT_BUSY`：该 mission 已有 worker/reviewer 在跑。先 `send`/`interrupt` 或等待落定。
  - `WORKER_START_BLOCKED`：当前状态不允许启 worker（见 §1 表）。
  - `DEPENDENCIES_NOT_MERGED`：依赖未到终态（`merged` 或 `abandoned` 都算解决）。先推进依赖 mission。
  - `STALE_BASE`（pending 同步语境）：worktree 有独有提交，先 `tower({action:"rebase"})` 再 spawn。
  - `WORKTREE_BRANCH_MISMATCH`：worktree 被检到了别的分支。查清是谁动的（§3.6 同理），人工检出 `tower/<id>` 后重试。
  - `MODEL_ROUTE_*` / `MAX_TOKENS_INVALID`：路由参数不合法或不在 `allowedModels`，修正参数或配置。
  - worker 结束后状态为 `worker_failed`：见 3.7 重试。

### 2.4 status / summary

```text
tower({action:"status"})                       // 全量 state
tower({action:"status", mission_id:"M1"})      // 单个 mission：{ mission }
tower({action:"status", observe:true})         // 附带 git 实况观察
tower({action:"summary"})                      // 紧凑只读概览
tower({action:"summary", mission_id:"M1"})     // 概览，条目收窄到单个 mission
```

- `status` 预期输出：`{ version, repoRoot, baseBranch, baseCommit, missions[], events }`；`observe:true` 时额外返回 `observations: { checkedOutBranch, baseTip, baseStatus, missions: { "<id>": { tip, status:{clean, entries} } } }`。把「持久化 state」与「git 事实」并排摆出，是所有「状态怀疑滞后/不一致」场景的首选诊断（见 3.5）。mission 内 `worker`/`review` 记录的 `output`、`error`、`dirtyEntries`、`headCommit`、`structured`（审查结论）都在这里读。
- `summary` 工具预期输出：`{ summary: { version, repoRoot, baseBranch, baseCommit, counts, routes: [], missions: [] } }`（直接调用 `TowerCore.summary()` 则返回内层对象）。其中 `counts` 为**全塔**统计（`missions`/`workerRunning`/`reviewRunning`/`approved`/`merged`/`blocked`/`abandoned`），`missions[]` 为每任务一行（`id`/`title`/`status`/`dependsOn`/精简 `worker`/`review`/`mergeCommit`，不含 description/scope/worktree/历史）。`mission_id` 只收窄 `missions[]`，不改全塔 `counts` 或 `routes`。纯读：无事件、无 revision 变化，适合日常巡检。
  - `routes[]` 每项为 `{ provider, model, reasoningEffort, workerCount, reviewerCount, total }`，以 `(provider, model, reasoningEffort)` 三元组分桶；缺失的路由字段为 `null`，不能自行猜测默认模型。每条现存 worker 记录计入 `workerCount`，每条现存 review 记录计入 `reviewerCount`，`total` 为两者之和；**包含 `merged` / `abandoned` mission 的记录**，无记录时为空数组。
  - 排序：先 `total` 降序，相同再按 `provider` → `model` → `reasoningEffort` 的字典序升序，逐字段 `null` 在字符串之前，排序不依赖 locale。聚合实现见 [lib/core.js](../lib/core.js) 的 `summaryRoutes`。
  - 这些数字只统计 state **当前保留的角色记录**，不是完整历史运行次数或 token/费用账单；重新派发会替换对应记录，worker 返工还会清空 review，因此不能将 `total` 当作累计调用次数。

### 2.5 spawn reviewer

```text
tower({action:"spawn", mission_id:"M1", role:"reviewer", provider:"...", model:"..."})
```

- 前置：mission 为 `worker_completed`（或 `review_failed` 重试、`approved`/`changes_requested` 复审），worktree 干净。
- 预期输出：在 worker 的字段之外多了 `binding: { baseCommit, reviewedCommit }`——审查证据绑定精确 SHA，base 或 tip 任何移动都需要重新审查。
- 落定结果：正常返回结构化结论 → `approved`（clean 且 merge=true）或 `changes_requested`；reviewer 进程错误、被中断或未返回结构化结论 → `review_failed`（`spawn-failed` 事件，`review.error` 有诊断）；审查期间绑定漂移 → 回 `worker_completed` 且 `review.stale:true`（见 3.6）。
- 失败与 next action：
  - `REVIEW_START_BLOCKED`：状态不对（如 `pending`、`worker_failed`），先把 worker 跑完。
  - `WORKTREE_DIRTY`：worktree 有未提交/未跟踪文件。派 worker 收尾（commit 或清理）。
  - `NO_CHANGE`：mission tip 与当前 base 相同，没有可审内容。
  - `STALE_BASE`：当前 base 已不是 mission tip 的祖先，先 `rebase`。
  - 落定后 `review_failed`：见 3.7 重试。

### 2.6 gate

```text
tower({action:"gate", mission_id:"M1"})
```

- 预期输出：`{ ready:true, blocks:[], observations }`；不 ready 时 `blocks: [{ code, message, ... }]`（修复动作见 §4），`observations` 含 `baseDirty`、`checkedOutBranch`、`worktreeDirty`、`baseCommit`、`reviewedCommit`、`changedFiles`。
- 特殊形态 `{ ready:false, alreadyMerged:true, warnings, observations }`：被审 SHA 已在 base 中且仍与 mission tip 一致，走 3.4 对账，不要试图再合并一次。
- gate 是纯读操作，可反复执行；merge 前不必单独跑 gate（merge 内部会再评估一次），但它是最便宜的「为什么不能合」问答。

### 2.7 merge

```text
tower({action:"merge", mission_id:"M1"})
```

返回形态一览（完整语义见 [lib/core.js](../lib/core.js) `TowerCore.merge`）：

| 返回字段组合 | 含义 | 下一步 |
|---|---|---|
| `merged:true, advanced:false, mergeCommit` | 正常合并，mission → `merged`，`state.baseCommit` 前进 | `teardown` |
| `merged:true, advanced:true, branchTip` | 合并成功但 worktree tip 已超过被审 tip；状态回 `worker_completed`，review 清空 | 对新增提交重新 `spawn` reviewer，再 merge |
| `merged:true, reconciled:true`（或对已 `merged` 的 mission 重复 merge 得 `alreadyMerged:true`） | base 已包含被审 SHA，做记账式对账 | 无需动作，可 `teardown` |
| `merged:false` + `gate.blocks` | gate 拦截，未执行 git merge | 按 §4 修复 |
| `merged:false` + `error` + `recoveryRequired`（可能含 `abortError`/`remainingMergeState`/`restoredHead`/`clean`） | git merge 失败，tower 已尝试 `merge --abort`，mission → `merge_blocked` | 见 3.2 |
| `merged:false, mergeAttempted:true, verified:false, recoveryRequired:true, postMerge:true` | git 层合并完成但其后核对/落账失败 | 见 3.3 |

- 失败与 next action（工具层错误）：`MISSION_NOT_FOUND` 检查 id；merge 还有一种特殊**返回**形态 `merged:true, recoveryRequired:true, postMerge:true`（git 已成功、随后核对/落账失败），处置同 3.3；若整个调用抛出其它非 gate 类异常，先 `status observe:true` 再对号入座。

### 2.8 teardown

```text
tower({action:"teardown", mission_id:"M1"})    // 省略 mission_id 则遍历全部 mission
```

- 预期输出：`{ results: [{ mission, removed:true }], state }`。只移除**终态、干净、已在 git 注册**的 worktree；分支与 state 永远保留。
- 幂等与拒绝条件详见 3.9。

### 2.9 其它动作

- `edit`：修正尚未派生的 mission 元数据（`title`/`description`/`scope`/`depends_on`；仅 `pending`，校验重复依赖与依赖环 `DEPENDENCY_CYCLE`）。校验规则与 `add` 一致（§2.2）；未提供的字段保持原值。
- `rebase`：把 mission 分支变基到当前 base（失败路径见 3.1）。返回 `{ rebased:true, reviewRequired, previousTip, tip, mission }`。`reviewRequired:true` 表示旧审查已失效（review 清空、状态回 `worker_completed`）——触发条件是 **tip 变化，或审查绑定的 base/reviewed SHA 与当前不一致**：即使 tip 没动，base 前进也会使审查失效。`reviewRequired:false` 的真 no-op：既有结论原样保留（`approved`/`changes_requested` 不变）；对 `review_failed` 的 no-op 变基则保持 `review_failed`（失败记录不因变基消失，重派 reviewer 即可）。**变基之后凡 `reviewRequired:true` 必须重新审查。**
- `abandon`：mission → `abandoned`，工件保留，交给 `teardown` 清理；依赖它的 mission 视依赖为已解决。`merged` mission 不可 abandon（`MISSION_MERGED`），运行中不可 abandon（`AGENT_BUSY`）。
- `send` / `interrupt`：向当前运行中的 worker/reviewer 递话/取消（`AGENT_NOT_RUNNING` 表示没有活跃子代理可寻址）。
- `recover`：处置跨重启的僵尸 running 记录，语义见 3.8。
- `models`：查询 provider 目录/精确路由元数据，不做任何仓库操作。

### 2.10 运行期通知（落定即尝试投递 + 僵尸提示）

- **结算通知：落定即生成并尝试投递**（[lib/runtime.js](../lib/runtime.js) `track`/`settlementNotice`）：每个 worker/reviewer 落定都会生成一条通知并尝试 steer 给控制器 Session。通知结构：常规形态是首行 `Tower <role> for <mission> <outcome>: mission status <status>`、其后 next action 行（如 `review_failed` → `spawn a fresh reviewer when ready`）；run 完全无法落账（两次状态写入都失败）时，Next 之前另有一行 `run <runId> could not be recorded in Tower state` 诊断。无论哪种形态，物理末行固定是 `stopReason: <实际值>`，`failed`/`interrupted`/`stale` 结局在同一行追加 `; reason: <有界原因>`（来自记录的 error/diagnostic，最多 500 字符，缺失记 `no reason recorded`）。stopReason 优先取激活结果，缺失回退 role 记录；stopReason 缺失时末行报告 `unknown`。stopReason 与 reason 内部的换行和连续空白都会折叠成一个空格，末行因此永远是单行，多行错误文本不会撑破通知结构。若模型本身已完成、只是 state 落账失败，末行 stopReason 仍保留 `completed`、把落账错误放进 reason，不会把完成伪写成 error。即使 state 落账或投影发布失败，这次投递尝试也仍会进行（最差退化为点名 role/mission/run/error 并提示 `tower action=status` 的兜底通知）。但投递本身也可能失败：此时仅记 error 日志，没有持久重试队列——通知是落定路径上的告知机制，不是消息队列；未收到通知属于需要排查的场景，用 `status` 与 error 日志兜底。
- **`agent/created` 僵尸提示**：Host 重启后，任何新 agent 创建时，runtime 会按其当前工作目录解析仓库，读取 tower state，把该 Session 名下仍标记 `worker_running`/`review_running`、但本运行时不再拥有的激活列成一条通知（每个 run 一次，不重复打扰），建议执行 `tower action=recover`。提示只发给记录中的控制器 Session；探测失败只记警告，不影响 agent 创建。

## 3. 故障场景 Runbook

每个场景按「症状 / 诊断 / 安全处理 / 何时不应重试」组织。诊断命令统一列在附录 A，只读体检脚本见附录 C。

### 3.1 `rebase_blocked`

- 症状：`tower({action:"rebase"})` 返回 `{ rebased:false, error, recoveryRequired, ... }`，mission → `rebase_blocked`，既有 review 记录被清空（变基本身就使旧审查失效）。
- 诊断：看返回中的 `recoveryRequired`：
  - `false`：tower 已成功 `git rebase --abort`，worktree 停在变基前的原 tip、干净（`restoredTip`、`clean:true` 可证）。`error` 是 git 的冲突输出。
  - `true`：abort 失败（`abortError`）、tip 漂移（`restoredTip` ≠ 原 tip）、worktree 脏（`clean:false`）或仍处 rebase 中间态——worktree 状态不可信。
- 安全处理：
  - `recoveryRequired:false`：这是**内容冲突**，没有可自动重试的答案。派一个 worker（`rebase_blocked` 属于 `WORKER_RESTARTABLE`），在 controller instructions 里**明确授权**它在 worktree 内手工完成 rebase：解决冲突、`git rebase --continue`、提交。worker 干净落定后 mission → `worker_completed`，再走 reviewer → gate → merge。不想解决就 `abandon`。
  - `recoveryRequired:true`：不要向该 worktree 派任何 agent。先用附录 A 的只读命令确认卡住的中间态；确认后可由人工在 worktree 内执行 `git rebase --abort`（这只动 git，不动 state.json），再 `status observe:true` 复核，然后重试 `rebase` 或走 worker 手工变基路径。
- 何时不应重试：`recoveryRequired:true` 且未完成人工检查之前；以及同一冲突反复出现时——冲突是内容问题，机械重试 `rebase` 每次都会同样失败。

### 3.2 `merge_blocked`

- 症状：`merge` 返回 `merged:false` + `error` + `recoveryRequired`（可含 `abortError`、`remainingMergeState`、`restoredHead`、`clean`），mission → `merge_blocked`。典型诱因是 mission 分支与 base 的内容冲突（gate 的 `STALE_BASE` 只查祖先关系，拦不住内容冲突）。
- 诊断：`recoveryRequired:false` 且 `remainingMergeState:false` → base 已被 `merge --abort` 还原到合并前（`restoredHead`、`clean:true` 可证），只是这次合并不成；`recoveryRequired:true` 或 `remainingMergeState:true` → base 可能残留 `MERGE_HEAD` 中间态或 HEAD 漂移，必须人工核实。
- 安全处理：
  - `recoveryRequired:false`：正路是回到 worktree 解决冲突——`tower({action:"rebase"})` 大概率同样冲突并转 `rebase_blocked`，那就按 3.1 的 worker 手工变基路径走：变基 → 重新审查（review 绑定新 SHA）→ gate → merge（变基后 base 已是 tip 祖先，`--no-ff` 合并无冲突）。合并价值不高时也可 `abandon`。
  - `recoveryRequired:true`：停止一切 tower 写操作。附录 A 检查 `<repo>` 的 `MERGE_HEAD` 与 `git status`；如确认残留中间态，由人工 `git merge --abort`（只动 git），随后 `status observe:true` 验证 `baseStatus.clean` 与 `baseTip`，再选择上述路径。**绝不**用 `reset --hard`/`push` 之类的方式"修复"base。
  - 注意 gate 对 `merge_blocked` 放行 `NOT_APPROVED`，修完诱因后可直接重试 `merge`，无需先恢复到 `approved`。
- 何时不应重试：base 存在未清理的 merge 中间态（`remainingMergeState:true`）时；诱因（冲突内容）未解决时——重试只会再次失败并多产生一次事件噪音。

### 3.3 `mergeAttempted:true, merged:false, recoveryRequired:true`（合并后对账失败）

- 症状：`merge` 返回 `merged:false, mergeAttempted:true, verified:false, recoveryRequired:true, postMerge:true`，可带 `error`（如 `merge completed but the resulting base does not contain the reviewed commit`）或核对异常文本。git 层的 merge 很可能**已经成功**，失败的是其后的 head/祖先核对或 state 写入。mission 状态可能仍是 `approved`（核对失败不改状态）。
- 诊断：
  - `tower({action:"status", observe:true})`：比对 `observations.baseTip` 与 `missions["<id>"].tip`。
  - 附录 A：`merge-base --is-ancestor <reviewedCommit> <baseBranch>` 确认被审 SHA 是否已在 base 中；`log --oneline -5` 看 base 顶端是否就是那笔 `Tower: <title> (<id>)` merge commit。
- 安全处理：
  - 若被审 SHA 确已包含在 base 中：直接重试 `tower({action:"merge"})`。gate 会识别 `alreadyMerged`，这次执行**记账式对账**（事件 `mission-merge-reconciled`，mission → `merged`，返回 `merged:true, reconciled:true`），不会产生第二笔 merge commit。
  - 若 base 不包含被审 SHA 且顶端不是预期 merge commit：说明 git merge 实际没成，按 3.2 处置。
  - 变体形态 `merged:true, recoveryRequired:true, postMerge:true`（附 `error`）：git 合并已成功但其后的 state 写入抛错，merge 捕获后按 `alreadyMerged` 证据返回该形态——处理方式相同：先诊断确认 base 事实，再重试 `merge` 让对账收尾。
- 何时不应重试：base 脏（`BASE_DIRTY`）或处在 merge 中间态时；以及尚未用只读命令确认 base 事实之前——盲目重试在"其实没合并成功"的情形下会走 3.2 的冲突路径。

### 3.4 `alreadyMerged` 对账

- 症状：`gate` 返回 `{ ready:false, alreadyMerged:true, warnings, observations }`——存在 clean 且 merge=true 的 review、`reviewedCommit` 仍等于 mission tip，且该 SHA 已是 base 的祖先。常见于 3.3 的 state 写入失败后重试，或人工曾把该 SHA 合入 base。
- 诊断：`status observe:true` + `merge-base --is-ancestor <reviewedCommit> <baseBranch>`，确认「被审 SHA = mission tip = 已在 base 中」三事实。
- 安全处理：调用 `merge`。它做记账式对账：mission → `merged`，`mission.merge.commit` 记为当前 base tip，事件 `mission-merge-reconciled`，返回 `merged:true, reconciled:true`。随后正常 `teardown`。**不要**因为"看起来已经合了"就把 mission 弃置不管——state 不对账，`depends_on` 与面板状态就一直悬着。
- 何时不应重试：`alreadyMerged` 的判定同时要求 tip 一致；若 mission tip 已又前移（warnings 里会出现 `REVIEW_TIP_STALE`），这就不是对账场景，而是需要重新审查的新提交。

### 3.5 state 写入失败后的 reconciliation

- 症状：git 操作已发生，但 `.dsh-tower/state.json` 没跟上——例如 merge 成功后进程被杀、pending 基线同步快进后 state 写入失败。表现为：mission 状态与 git 事实矛盾、事件时间线缺尾、或 3.3 的 `postMerge` 形态。
- 写入机制（[lib/store.js](../lib/store.js) `TowerStore.write`）：先写临时文件 `<state.json>.<pid>.<uuid>.tmp`，再原子 rename 替换；**写或 rename 失败时会尽力清理本次的临时文件**（只删自己这份，不动无关临时文件与既有 state），然后原样重抛原始错误。注意：state 写失败不会回滚之前已发生的 git 操作。
- 诊断：一律从 `tower({action:"status", observe:true})` 开始，把持久化字段与 `observations`（`checkedOutBranch`/`baseTip`/`baseStatus`/每 mission 的 `tip` 与 `status.clean`）逐项对照；再辅以附录 A 的祖先关系检查，或直接跑 `node scripts/tower-doctor.mjs`（附录 C）。state 里的 `events` 尾部（附录 B）能看出最后一次成功落账到哪一步。
- 安全处理：tower 各动作自带保守对账，**用重试对应动作来收敛，而不是改 state**：
  - merge 已成、state 未记 → 重试 `merge`，走 3.4 的记账式对账（`mission-merge-reconciled`）。
  - pending 基线同步快进成功、state 未记 → 重试 `spawn` worker（快进幂等，条件仍满足）。
  - add 中断留下的分支/worktree → 重试同 id 的 `add`，满足条件时收编（`mission-artifacts-reconciled`，mission 带 `reconciled:true`）；不满足则 `MISSION_ARTIFACT_CONFLICT`，见 3.10。
  - worktree 已被外部删掉 → 重试 `teardown`，路径在磁盘与 git 注册表中都不存在时补记 `worktreeRemoved`（`worktree-remove-reconciled`）。
  - running 记录跨重启悬置 → `recover`（3.8）。
- 何时不应重试：对账动作本身连续失败、或 `observe`/doctor 显示 git 事实自相矛盾（如 base 处于 merge 中间态）时，停下来按 3.2/3.11 做只读排查；对账不收敛说明有更底层的问题。

### 3.6 reviewer stale / `REVIEW_BASE_STALE` / `REVIEW_TIP_STALE`

- 症状：
  - reviewer 运行期间绑定漂移：落定记录 `review.stale:true`、`error:"review binding became stale while the reviewer was running; spawn a fresh reviewer"`，mission 回 `worker_completed`（结论作废，不采信其 verdict）。
  - merge 前 gate 给出 `REVIEW_TIP_STALE`（审查时的 tip ≠ 当前 tip）或 `REVIEW_BASE_STALE`（审查时的 base ≠ 当前 base）。
  - 与 `review_failed` 的区别：stale 是「审查有效期内绑定动了、结论作废」；`review_failed` 是「reviewer 根本没产出结构化结论」（§3.7）。结算通知中 stale 结局会给出 `tower action=rebase` 指引。
- 诊断：`status` 读 `review.baseCommit`/`review.reviewedCommit`，与 `observe:true` 的 `baseTip`、mission `tip` 比对，确认是哪一端动了。
- 安全处理：
  - base 动了（别处 merge 推进了 base）：`tower({action:"rebase"})`；返回 `reviewRequired:true`（即使 tip 未变，base 变化同样触发），旧 review 被清空、mission 回 `worker_completed`，重新 `spawn` reviewer → gate → merge。
  - tip 动了（审查期间 worktree 又有提交）：直接重新 `spawn` reviewer（从 `worker_completed`/`changes_requested` 均可），新审查绑定新 SHA。
  - reviewer 进程还在跑而绑定已漂移：先 `interrupt` 再重派，避免旧结论晚到覆盖。
- 何时不应重试：绑定漂移的根因未明（例如有人手工在 worktree 提交）之前不要急着重派审查——先弄清谁动了 tip，否则新审查还会再 stale 一次。

### 3.7 `worker_failed` / `review_failed` 重试

- 症状：worker 落定后 mission → `worker_failed`：进程异常（`stopReason ≠ completed`，`worker.error` 有诊断）、脏收尾（`error:"worker finished with uncommitted or untracked files; ..."`，附 `dirtyEntries`）或 `spawn` 本身失败（`failSpawn`）。reviewer 落定后 mission → `review_failed`：进程错误、被中断、未返回结构化结论（`error:"reviewer did not return a structured verdict"` 或 diagnostic）或 spawn 失败；事件均为 `spawn-failed`。两者的结算通知都会生成并尝试投递（§2.10），未收到时直接用 `status` 诊断。
- 诊断：先用 `summary` 定位失败 mission，再用 `tower({action:"status", mission_id:"<id>"})` 读取完整 `worker`/`review` 记录里的 `stopReason`、`error`、`dirtyEntries`（精简 summary 不含全部诊断字段）。需要更多上下文时查看该 run 对应的子代理会话；需要继续修复则按下方步骤 `spawn` 新 run，不向已落定失败的 run 发 `send`。
  - `send` / `interrupt` **只对当前活跃 run 有效**：mission 必须处于相应的 `worker_running` / `review_running`，且附带的 childId/runId 与本 runtime 活跃记录的 mission/role 地址一致；缺失或不匹配会抛 `AGENT_NOT_RUNNING`。保留着旧会话或 childId 不代表仍可递话，已经落定的失败 run 不能靠 `send` 续跑。中断原因的辨别（限流 / 父会话取消 / 其它错误）与无损续跑见 §3.15。
- 安全处理（两个状态都在各自的重启集合里，直接重派）：
  - `worker_failed` → `tower({action:"spawn", mission_id:"<id>", role:"worker"})`，instructions 里点名要处理的事项（先 commit / 清理 untracked / 修复报错）。重派 worker 会**清空既有 review 记录**（`beginSpawn` 的既定行为），完成后需要完整重审；若上一轮是 `changes_requested` 后的返工失败，worker 任务简报会自动附带上一轮审查反馈。脏 worktree 会保留给新 worker 修复（不自动清理）。
  - `review_failed` → 二选一：`tower({action:"spawn", mission_id:"<id>", role:"reviewer"})` 重试审查（新 run 绑定当前 SHA）；或 `tower({action:"spawn", mission_id:"<id>", role:"worker"})` 直接返工（会清空失败记录与既有 review）。merge gate 在拿到 clean 审查前持续报 `NOT_APPROVED`。
- 何时不应重试：同一失败连续复现（说明任务本身有问题，改 mission 或 `abandon`）；worktree 处于 rebase/merge 中间态（先按 3.1/3.2 清理）；或 `error` 显示问题是环境性的（如 `429` 限流、路由不可用 `MODEL_ROUTE_*`）而未先修环境/换路由。

### 3.8 `recover` 的语义

- 语义（[lib/core.js](../lib/core.js) `TowerCore.recover`）：把**持久化**为 `worker_running`/`review_running`、且其 `runId` 不属于当前运行时活跃集合的记录，标记为已中断——`stopReason:"aborted"`、`error:"activation is not owned by this runtime; ..."`；worker 侧 mission → `worker_failed`，reviewer 侧 mission → **`review_failed`**（记录同时置 `stale:true`）。它**只改标记，绝不接管旧进程**：不会向旧子代理发消息，也不会替它收尾。
- 症状（需要 recover 的信号）：Host/控制器重启后，mission 永远停在 `worker_running`/`review_running`，任何 spawn 被 `AGENT_BUSY` 拒绝。重启后第一个新 agent 创建时通常已收到 §2.10 的僵尸提示通知。
- 诊断：`status` 确认悬置的 role 与 `runId`。注意 `recover` 只会把「当前运行时不认领」的 runId 标记为中断；旧 Host 进程的活跃与否对当前运行时不可见，必须由操作者在进程层面确认它确实已停止。
- 安全处理：**先确认旧控制器确实停止**（这是 `recover` 的前提，README "Failure recovery" 同义），再 `tower({action:"recover"})`。返回 `{ recovered: [{ mission, role, runId }], state }`。随后：worker 侧按 3.7 重派；reviewer 侧 mission 已是 `review_failed`，直接重派 reviewer。
- 何时不应重试（不应执行 recover）：旧 Host 进程可能仍在运行时——它的 worker/reviewer 落定回调仍会写 state，和 recover 的标记互相覆盖，制造真正的竞态。先停旧进程，再 recover，一次即可（幂等：没有可回收记录时返回空 `recovered`）。

### 3.9 `teardown` 的幂等与拒绝条件

- 语义（[lib/core.js](../lib/core.js) `TowerCore.teardown`）：逐 mission 判定，结果在 `results[]`，每项互不阻塞。只删 worktree；分支与 state 永远保留。
- 各返回形态：
  - `removed:true`：正常移除（终态 + 干净 + git 已注册）。
  - `removed:true, reconciled:true`：磁盘与 git 注册表都不存在该路径，补记 `worktreeRemoved`（对账式幂等）。
  - `removed:false, reason:"already-removed"`：`worktreeRemoved` 已为 true，天然幂等，重复调用无害。
  - `removed:false, reason:"status-<status>"`：非终态（或仍在运行）拒绝清理——先走到 `merged`/`abandoned`。
  - `removed:false, reason:"dirty", entries:[...]`：worktree 有未提交/未跟踪文件。若有未合并的工作，先派 worker 处理；确认无用后人工清理，再重试 teardown。
  - `removed:false, reason:"not-a-registered-worktree"`：路径存在但不在 `git worktree list` 中（曾被外部移动/破坏）。tower 拒绝删除"非自己注册的路径"，转人工处置（见 3.10）。
  - `WORKTREE_PATH_INVALID`：记录的 worktree 路径不在 `.dsh-tower/worktrees/` 之下，属 state 异常，转 3.11 只读排查。
- 何时不应重试：`reason:"dirty"` 且未决定如何处置那些文件之前——teardown 永远不会替你丢弃工作区内容，重试没有意义；`not-a-registered-worktree` 同理，重试不会改变判定。

### 3.10 孤儿 worktree / branch

- 症状：`git worktree list` 里存在 `.dsh-tower/worktrees/*` 或 `git branch --list 'tower/*'` 有分支，但 state 里没有对应 mission（state 丢失/损坏后重建、或历史 `MISSION_ARTIFACT_CONFLICT` 遗留）；或 `add` 重试报 `MISSION_ARTIFACT_CONFLICT`。`node scripts/tower-doctor.mjs` 会以 `ORPHAN_WORKTREE` 直接点名（注册未引用与磁盘残留两种都查）。
- 诊断（全部只读）：`git worktree list --porcelain`、`git for-each-ref refs/heads/tower/`、对每个孤儿分支 `merge-base --is-ancestor <tip> <baseBranch>` 判断其提交是否已在 base 中，`log --oneline <baseBranch>..<tip>` 看有无 base 之外的独有提交。
- 安全处理：
  - 想收编（推荐）：重试 `tower({action:"add", id:"<原id>"})`。仅当分支与注册 worktree 完全匹配、worktree 干净、检出该分支、且 tip 是当前 base 的祖先（无独有提交）时，tower 自动收编（`mission-artifacts-reconciled`，`reconciled:true`，状态 `pending`）；随后按需走完流程或 `abandon` + `teardown`。
  - 有独有提交的分支：tower 一定拒绝自动收编（`MISSION_ARTIFACT_CONFLICT`，正确行为）。人工评估提交价值：仍需要 → cherry-pick/merge 到正式分支后处理；确认无用 → 由人工执行 `git worktree remove <path>` + `git branch -D tower/<id>`（tower 没有"强制弃置未登记工件"的动作，这是**唯一**需要动用 git 写命令的清理场景，动手前确认路径与分支名无误）。
  - 已登记 mission 但 worktree 目录被外部删掉：`teardown` 会在路径双重不存在时补记对账（3.9），不要手工重建目录。
- 何时不应重试：`add` 收编条件不满足时重试 `add` 永远冲突——要么先满足条件（清理/合并独有提交），要么换新 id 让旧工件交人工处置。

### 3.11 `.dsh-tower/state.json` 损坏（只读诊断）

- 症状：所有 tower 动作（含 `status`）抛 `STATE_INVALID`（消息形如 `could not parse ...state.json: ...` 或字段校验失败——校验规则见 [lib/store.js](../lib/store.js) `validateState`：version=1、repoRoot 绝对路径、mission 必填字段、status 枚举、revision 正整数、id 去重）。文件整个缺失则是 `TOWER_NOT_INITIALIZED`。
- 诊断（只读）：
  - `node scripts/tower-doctor.mjs`（真实用法与退出码见附录 C）：在仓库根对账 state 与 git——结构校验（`STATE_CORRUPT`/`STATE_VERSION`/字段错误）、repo 一致性（`REPO_MISMATCH`）、base 分支与 `baseCommit` 漂移/分叉（`BASE_COMMIT_DRIFT`/`BASE_COMMIT_DIVERGED`）、mission 分支存在性、worktree 注册与磁盘一致性、孤儿 worktree、已合并 mission 的 `mergeCommit` 祖先关系、teardown 一致性，以及「状态仍是 running 但记录看起来已结束」的悬置激活（`RUNNING_RECORD_FINISHED` → 提示 `tower recover`）。它只报告、不修复。
  - `python3 -m json.tool <repo>/.dsh-tower/state.json`（或 `jq .`）：区分「JSON 语法损坏」与「结构校验失败」。
  - `git worktree list --porcelain` + `git for-each-ref refs/heads/tower/`：盘点 git 侧事实（哪些分支/worktree 存在、tip 在哪）。
  - `git log --oneline --grep="Tower: " <baseBranch>`：从 merge commit 标题反推哪些 mission 已合入。
- 安全处理：
  - **先备份再谈修复**：`cp .dsh-tower/state.json state.json.bak.<时间戳>`（复制是只读于原文件的保险动作）。
  - 没有 state 修复工具，也**禁止手工编辑 state.json** 拼回一个"看起来对"的文件——半对的 state 比损坏的 state 更难排查。
  - 重建的唯一受支持路径是让 tower 自己写 state：把损坏文件移出 `.dsh-tower/`（保留备份），`tower({action:"init"})` 建立全新 state，再用**同 id** 逐个 `add`——满足收编条件的分支/worktree 会被 `mission-artifacts-reconciled` 重新登记；已合并过的 mission 收编后状态为 `pending`，将其 `abandon`（其提交已在 base 中，无需重做）或按需重走审查。独有提交的分支不会被收编，按 3.10 人工处置。完整步骤清单、代价与「能恢复什么 / 不能恢复什么」边界见 3.14。
  - 此流程属于灾难恢复，执行前与仓库 owner 确认，全程对照第一步的 git 事实清单。
- 何时不应重试：损坏原因未查明（例如磁盘满、并发写入）之前不要急着重建，否则新 state 可能再次损坏；注意 `lib/store.js` 的写入是临时文件 + 原子 rename 且失败即清理本次临时文件，正常单控制器使用不应产生语法损坏——若反复出现，先排查是否存在双进程控制（见 §5 禁令 2）。

### 3.12 Git 元数据属主异常或关键路径不可写

另一个用户（尤其 root）曾向仓库写入对象或元数据时，当前用户后续的 `git rebase`、`merge`、提交或 state 写入可能报权限错误。[scripts/tower-doctor.mjs](../scripts/tower-doctor.mjs) 用两类 finding 区分「发现其他属主」与「关键路径已确认不可写」；它只报告，不修复。

- 症状：
  - `GIT_METADATA_FOREIGN_OWNER` 是 **warning**。若没有其它 error，doctor 默认退出码为 `1`（加 `--fail-on-warning` 则升级为 `2`，见附录 C，可让 CI / 发布门禁在 warning 即失败）；输出形如（路径、uid 与计数随环境变化）：

    ```text
    [warning] GIT_METADATA_FOREIGN_OWNER: 2 repo/git metadata entries are owned by another user (current uid 1000): e.g. /srv/repo/.git/index, /srv/repo/.git/objects/ab; suggested fix to run manually (doctor never executes it): sudo chown -R $(id -u):$(id -g) /srv/repo/.git
    24 checks passed, 1 warning(s), 0 error(s)
    ```

  - `GIT_METADATA_NOT_WRITABLE` 是 **error**。只要存在任一 error，doctor 退出码即为 `2`（即使同时有 warning）；典型输出为：

    ```text
    [error] GIT_METADATA_NOT_WRITABLE: git object store /srv/repo/.git/objects is not writable by the current user (current uid 1000) (EACCES): git operations writing here will fail (e.g. "insufficient permission for adding an object to repository database"); suggested fixes to run manually (doctor never executes them): sudo chown -R $(id -u):$(id -g) /srv/repo/.git or chmod u+w /srv/repo/.git/objects
    24 checks passed, 0 warning(s), 1 error(s)
    ```

    检查目标是现存的对象库、refs、index 与 Tower state 目录；不存在的路径会跳过（例如首次提交前没有 index），缺失 state 由其它检查报告。可用 `node scripts/tower-doctor.mjs --json` 读取结构化 `findings` 与 `summary.exitCode`；再叠加 `--fail-on-warning` 时 payload 会多出 `failOnWarning: true`（默认输出不含该键，既有键集不变）。
- 常见成因：另一个 agent 或人工用 root/`sudo` 在该仓库运行 git；同一 checkout 被多个系统用户共享；CI 容器以一种 uid 写入挂载目录，本地用户再以另一 uid 操作；或一次 `sudo git ...`/`sudo` 运行的 Tower 留下 root 属主的 index、对象、refs 或日志。`GIT_METADATA_FOREIGN_OWNER` 也可能是共享仓库的预期属主布局，须结合样例路径和当前 uid 判断，不能看到 warning 就递归改整个仓库。
- 诊断（先停止该仓库的写入，再从**主仓库根目录**执行只读命令）：

  ```bash
  cd <repo>
  id
  git rev-parse --absolute-git-dir       # 后文 <gitdir> 以此处真实输出为准
  find .git -user root -print            # 定位 root 属主的文件/目录；linked worktree 应查主仓库的 .git
  ls -ld .git/objects                    # 核对对象库属主与权限
  node scripts/tower-doctor.mjs --json
  ```

  对照 JSON finding 的 `path`/`label`（不可写目标）或 `sample`/`ownerUids`/`currentUid`（属主异常）确认影响范围。ownership finding 的 `sample` 最多 **10 条**，`count` 是本次扫描发现的异常条数；默认最多进行 **5000 次** `lstat`，达到预算后停止，`truncated:true` 表示结果并非全量，人类可读消息也会显示扫描截断。扫描只覆盖脚本选定的 repo/git/state 范围，并跳过 `node_modules` 与 Tower worktrees 目录，不能把它当作完整的仓库属主审计。非 POSIX 平台没有 `process.getuid()` 时会跳过 ownership 扫描，因此不会出现 `GIT_METADATA_FOREIGN_OWNER`；关键路径可写性检查仍照常执行。
- 安全处理：
  1. 先停止会写该仓库的 worker、CI 与人工 git 操作，保留现场并完成诊断；**修复前备份**。至少用 `cp -a <gitdir> <备份位置>` 保存实际 git 元数据，存在未提交工作时同时备份受影响 worktree；linked worktree 的 `<gitdir>` 可能只是主仓库下的管理目录，备份不能只覆盖它就假定对象库也已保存。
  2. 确认 finding 中的异常属主不是共享仓库的有意配置，并核对 `<gitdir>` 确为上一步 `git rev-parse --absolute-git-dir` 的输出后，由仓库 owner 人工执行：

     ```bash
     sudo chown -R $(id -u):$(id -g) <gitdir>
     ```

     这会把该 gitdir 递归交给**当前执行用户**；若样例还包括 `.dsh-tower/` 等 gitdir 之外的路径，应逐项确认并单独修复，不能盲目扩大 `chown -R` 范围。单纯权限位过严且属主正确时，才可针对 doctor 报告的不可写目标评估 `chmod u+w <target>`，不要用宽泛的 `chmod -R 777`。
  3. 重新运行 doctor，确认相关 finding 消失后，再恢复 git/Tower 操作。doctor 的消息会建议命令，但**绝不会执行 `chown`、`chmod`、git 写操作或 state 修改**：递归改属主需要提权、可能破坏有意的多用户/CI 权限布局，而且脚本无法推断每个路径的正确属主，因此自动修复不符合其只读契约。
- 何时不应重试：不要靠反复 `rebase`/`merge`/`spawn` 来验证权限是否“碰巧恢复”，这可能留下半写对象或中间态。worker/reviewer 仍持有并使用 worktree 时，不要同时 `chown`、清理或 teardown；先暂停新写入，让 worker 提交并干净收尾（必要时 `interrupt` 并确认进程已停），mission 到达终态且 worktree 干净后再按 3.9 `teardown`。仍看到活跃 git 进程、处于 rebase/merge 中间态、备份未完成，或 `truncated:true` 却尚未用 `find` 补查影响范围时，都不要直接重试写操作。

### 3.13 发布与锁

本地发布脚本是 [scripts/release.mjs](../scripts/release.mjs)：默认 dry-run 只计算并打印 diff，**不写文件也不取锁**；`--apply` 会在真实 gitdir 中取得跨进程锁，再完成计划计算、脏工作区检查、写前快照复核与写入。锁覆盖整个 apply 过程，但只约束遵循同一锁协议的发布进程。脚本**从不执行 commit、tag、push，也不访问网络**。

- 症状：

  | 错误码 | 典型原因 | 首要动作 |
  |---|---|---|
  | `RELEASE_LOCKED` | 主锁 / reclaim 锁的持有者存活或无法确认已退出，或获取期间锁已被其它进程替换 | 不要立即或循环重试；先查锁路径、持有 pid 与锁龄，锁龄本身不授权接管 |
  | `RELEASE_PLAN_STALE` | 写前复核发现 package/CHANGELOG 与计划快照不同、文件缺失、create 目标已出现，或无法读取/检查目标 | 本次尚未写入目标文件；保留当前内容，查清变化来源或读取故障，再重新计算计划，不要删锁强行覆盖 |
  | `DIRTY_WORKTREE` | `git status --porcelain` 非空，脚本拒绝 `--apply` | 保留并确认改动归属，提交或 stash 后使工作区干净；不要直接重跑 |
  | `VERSION_NOT_GREATER` | 目标版本不大于 [package.json](../package.json) 当前版本；相等时也属于此错误 | 检查是否已发布/已写入目标版本；选择严格更高的版本前先核对实际状态 |
  | `VERSION_ALREADY_RELEASED` | [CHANGELOG.md](../CHANGELOG.md) 已存在目标版本标题 `## [<version>]` | 核对 package 与 CHANGELOG 是否已经完成本次发布，不要重复提升或删除历史段落来强行重跑 |
  | `GIT_CHECK_FAILED` | `git rev-parse --absolute-git-dir` 或 `git status --porcelain` 执行失败 | 按 stderr 修正仓库路径、Git 元数据或权限问题，再决定是否重跑 |

  `RELEASE_LOCKED` 的人类可读输出样例（pid、路径与时间随现场变化）：

  ```text
  release: error: RELEASE_LOCKED: another release apply or stale-lock recovery may be in progress (pid 12345); lock: /srv/repo/.git/release-apply.lock (age 660000 ms; modified 2026-10-26T02:00:00.000Z). A slow or long-running holder must not be displaced based on lock age. Automatic takeover requires a confirmed missing pid (ESRCH); unknown liveness is not proof of exit. Wait for that process to finish before retrying; never wait or retry automatically. Do not remove a live lock. Manually verify the process and lock ownership before considering cleanup.
  ```

  使用 `--json` 时，同一错误在 stderr 中是 `{ "ok": false, "code": "RELEASE_LOCKED", "message": "..." }` 形态，排障字段以 `message` 为准。写前发现内容变化时，`RELEASE_PLAN_STALE` 的消息形如 `CHANGELOG.md changed since the release plan was computed; no files were written. Inspect the files and compute a new plan before retrying.`；读取失败则说明无法核验对应文件。

- 诊断（先进入实际发布仓库 `<repo>`，不要用假定的 `.git` 路径代替真实 gitdir；linked worktree 的 gitdir 通常是独立管理目录）：

  ```bash
  cd <repo>
  git rev-parse --absolute-git-dir             # 取得 <gitdir>
  gitdir="$(git rev-parse --absolute-git-dir)"
  ls -l -- "$gitdir/release-apply.lock" "$gitdir/release-apply.reclaim.lock"
  cat -- "$gitdir/release-apply.lock" "$gitdir/release-apply.reclaim.lock"
  git status --porcelain                       # 空输出才允许 --apply
  git diff -- package.json CHANGELOG.md        # 查看当前内容，不回退或覆盖

  # 仅将 <pid> 换成有效的正整数持有者 pid；未知/非法 pid 不执行以下两行
  ps -p <pid> -o pid=,stat=,etime=,args=
  kill -0 <pid>; echo "$?"
  date -u                                      # 锁龄仅供诊断，不是接管条件
  ```

  主锁为 `<gitdir>/release-apply.lock`，用于串行化整个 apply；`<gitdir>/release-apply.reclaim.lock` 只串行化陈旧锁恢复。两把锁遵循相同规则：**只有 `process.kill(pid, 0)` 明确报 `ESRCH` 才可自动接管**。锁 JSON 通常含 `pid`、数值 `timestamp`（Unix 毫秒）与 `token`；timestamp / acquiredAt / mtime 用于诊断锁龄，不设置超时接管阈值。活 holder 无论运行多久都不抢占。`kill -0` 返回 `0` 表示进程存在；非零不等于已退出，`EPERM` 表示可能仍存活但无探测权限，其他探测错误也不能证明退出。坏 JSON、缺失/非法 pid 或无法确定存活状态的锁会一直保守拒绝，等待更久不会自动解除。

  `applyPlan` 在首个写入之前检查全部目标：完整 package 与 CHANGELOG 当前字节须匹配原计划快照（不只比较版本），create 目标必须仍不存在，悬空符号链接也算占用。任何不一致或核验失败都返回 `RELEASE_PLAN_STALE`，本次不写目标。`runRelease` 的 `finally` 仍尝试仅释放自身 token 的锁；若锁已换成外来 token 则不删除。直接调用 `applyPlan` 不负责取锁/解锁。快照检查不是跨文件事务，无法阻止非协作写入者在检查后改动文件。

- 安全处理：
  1. **优先等待，或让持有者正常退出。** 用 `ps` 核对 pid 对应的确实是发布/锁恢复进程；PID 可能被复用，不能只凭数字就终止进程。慢速进程仍存活时不要为了方便而删锁，也不要用自动重试循环争抢。脚本没有 `--force-unlock` 选项。
  2. **已确认死亡的 holder 优先交给脚本回收。** 核对当前 package、CHANGELOG 与工作区状态，确保仍需发布且工作区干净后，先 dry-run 审查目标版本，再人工执行一次 `--apply`。脚本仅在探测得到 `ESRCH` 后，通过 reclaim 锁与原子 rename 隔离并核验旧锁，再取得新主锁；接管成功时会打印 `Taking over stale release lock ...`。只过了一段时间不是重跑或删锁的理由。
  3. **人工清理是异常恢复，不是默认路径。** 自动接管无法处理坏 JSON、未知 pid 等情况时，先阻止新的发布/恢复任务启动，确认相关持有者和所有可能写入这些目标的进程都已退出，备份锁内容与受影响文件，再逐一核验真实 gitdir 内的具体锁路径、内容和归属。确认没有活跃持有者后才可单独清理该残留锁；不能凭锁龄判断，也不能把主锁与 reclaim 锁批量删除。仍无法确认进程状态、权限不足或锁内容已变化时停止操作，交由仓库 owner 核验。清理后先检查 diff 和工作区，重新 dry-run；明确仍需发布后才手动 `--apply`，不要把删除与发布串成一条自动命令。
  4. **计划过期先对账，不复用旧计划。** 遇到 `RELEASE_PLAN_STALE`，保留磁盘上的较新内容，核对 `git diff -- package.json CHANGELOG.md`、当前版本与目标段落。若其他发布已完成就审查其结果；若是无关修改或读取故障，先解决并使工作区干净，再重新运行 dry-run 计算计划。该错误不意味着需要删锁，也不能通过恢复旧快照来强行发布。
  5. 成功 apply 后，[package.json](../package.json) 与 [CHANGELOG.md](../CHANGELOG.md) 会有意保持未提交状态。先审查 diff，再由人工 commit/tag；脚本不会替你做这些操作，也不会 push。

- 何时不要重试：
  - **工作区脏**：未提交或未跟踪文件未妥善处理前，重复 `--apply` 只会再次得到 `DIRTY_WORKTREE`。先逐项确认 `git status --porcelain`，提交或 stash，并确认输出为空。
  - **计划已过期**：`RELEASE_PLAN_STALE` 表示本次没有写目标，不能据此断言其他进程没有写入。先保留并核对新内容或读取故障，不复用旧计划，不删锁绕过。
  - **package 版本已提升**：`VERSION_NOT_GREATER` 可能意味着上一次 apply 已成功。先比较 package、CHANGELOG 与 git diff；若目标版本已经正确写入，直接审查并人工完成后续发布步骤，不要再次 apply。
  - **CHANGELOG 已有目标版本段**：`VERSION_ALREADY_RELEASED` 是重复发布保护。先核对目标段与 package 版本是否一致、是否属于历史发布；不一致时先人工修正状态，不要靠重跑覆盖。
  - **Git 检查失败或锁仍有效/未知**：先修复 `GIT_CHECK_FAILED` 的根因，或确认 holder 已退出。锁龄增长不改变处置权限；未改变根因的重试没有意义。

### 3.14 状态恢复：state 损坏 / 误删后的重建与清理总入口

`.dsh-tower/state.json` 是 tower 的唯一持久化账本（[lib/store.js](../lib/store.js) `TowerStore`）。本节是「state 坏了 / 没了 / 留下残留工件」后的总入口，按症状 → 诊断 → 安全处理 → 清理组织；细节语义在 3.5（写入失败对账）、3.8（`recover`）、3.9（`teardown`）、3.10（孤儿工件）、3.11（损坏的只读诊断），本节只补它们未覆盖的部分。

- 症状（tower 动作与 doctor 的 code 是**两套**，按来源对号，不要混用关键词）：

  | 场景 | tower 动作侧 | doctor 侧（[scripts/tower-doctor.mjs](../scripts/tower-doctor.mjs)） |
  |---|---|---|
  | state 文件缺失 | `TOWER_NOT_INITIALIZED` | `STATE_MISSING`（error） |
  | 非法 JSON / 顶层不是对象 | `STATE_INVALID`（消息形如 `could not parse ...state.json: ...`） | `STATE_CORRUPT`（error） |
  | 结构校验失败 | `STATE_INVALID`（`validateState`：version=1、字段类型、status 枚举、revision 正整数、id 去重） | `STATE_VERSION` / `STATE_FIELD_INVALID` / `MISSION_FIELD_INVALID` / `MISSION_DUPLICATE`（error，规则镜像 store） |
  | 文件存在但读不出（典型为权限） | 原样抛出底层 fs 错误（如 `EACCES`，store 只把 ENOENT 翻译成 `TOWER_NOT_INITIALIZED`） | `STATE_READ_FAILED`（error，配合 3.12 排查属主/权限） |
  | 终态 mission 残留活跃角色记录 | `recover` 跳过（只对账 `worker_running`/`review_running`） | `MISSION_TERMINAL_ACTIVE_ROLE`（warning，处置见下） |

  注意症状形态：store 的 `read` 先解析再校验（[lib/store.js](../lib/store.js)）。**文件缺失**时，除 `init`（幂等分支会新建 state）外的所有动作抛 `TOWER_NOT_INITIALIZED`；**文件损坏**时连 `init` 也一起失败——它的幂等分支同样要先读旧文件（[lib/core.js](../lib/core.js) `TowerCore.init`），读到坏文件照样抛 `STATE_INVALID`。诊断细节与只读命令见 3.11。

  终态 mission 残留的活跃角色记录（doctor：`MISSION_TERMINAL_ACTIVE_ROLE`，warning）也归本节处置：`merged`/`abandoned` mission 的 `worker`/`review` 记录仍带 `runId` 且无 `completedAt`/`stopReason`。正常 API 路径不会产生它（`abandon` 拒绝 running mission，merge 前审查早已落 `completedAt`），多由直接改 state 等异常路径形成；`recover` 只对账 `worker_running`/`review_running`（3.8），不会碰终态 mission，所以这类残留此前无法被任何手段发现。它本身是无害的陈旧记录，但若该 `runId` 背后的 agent 仍存活，它随后的落账会把终态 mission 改回中间态。处置顺序：**先**在进程/会话层面确认该 `runId` 已无活跃 activation，再运行 `tower({action:"recover"})` 顺带对账其它悬置激活；残留记录需要彻底清除时按本节重建流程，**不要手改 state.json**。

- 诊断：
  - **state 路径来源**：tower 动作固定使用仓库根下 `<stateDir>/state.json`（`stateDir` 是运行时配置，默认 `.dsh-tower`，工具调用参数**不能**覆盖）；doctor 默认取 `<repo>/.dsh-tower/state.json`，但可用 `--repo <path>` 与 `--state <file>` 检查任意位置（`--state` 指向 **state 文件本身**，不是目录）。
  - `node scripts/tower-doctor.mjs --json`：结构化输出 `{ repo, statePath, findings: [{ code, severity, message, ... }], summary: { checksPassed, warnings, errors, exitCode } }`，每条 finding 携带定位字段（如 `mission`、`path`、`statePath`）。**覆盖边界**：state 读不出（缺失/非法/结构不过）时 doctor 提前返回，只剩 git 元数据属主与可写性检查（它们在读取 state 之前执行）；孤儿 worktree、mission 分支等依赖 state 的检查**不会运行**——残留工件必须用下面的 git 命令人工盘点。
  - **残留工件盘点**（只读，详见附录 A / 3.10）：`git -C <repo> worktree list --porcelain`（注册的 worktree）与 `git -C <repo> branch --list 'tower/*'`（分支快扫；等价于附录 A 的 `for-each-ref refs/heads/tower/` 形式）；再用 `git -C <repo> log --oneline --grep="Tower: " <baseBranch>` 从 merge commit 标题反推哪些 mission 已合入（3.11 同款命令）。

- 安全处理：

  1. **先备份再动手**：`cp <repo>/.dsh-tower/state.json <repo>/state.json.bak.<时间戳>`。store 只保证原子写（临时文件 + rename），**没有自动备份机制**；损坏现场一旦被覆盖就彻底丢失。备份与移出的旧文件放在 `.dsh-tower/` 之外，不要放进 `worktrees/` 子目录。
  2. **先分类再决定**：用 `python3 -m json.tool` 与 doctor 区分「语法损坏 / 结构校验失败 / 文件缺失 / 读取失败」；读取失败（`STATE_READ_FAILED` / 原始 `EACCES`）先按 3.12 修属主权限。损坏根因未查明（磁盘满、双进程并发，见 §5 禁令 2）之前不要急着重建，否则新 state 可能再次损坏（3.11 同款告诫）。
  3. **先明确能恢复什么**——只有 git 可推导的事实能回来，只存在于 state 里的数据删了就是删了：

     | 事实 / 数据 | 误删或重建 state 后 |
     |---|---|
     | 分支与 worktree 的存在 | 可恢复：git 事实仍在；同 id `add` 满足收编条件时自动重新登记（`mission-artifacts-reconciled`，见 3.10） |
     | 已合入 base 的提交 | 可恢复：提交在 base 历史里，merge commit 标题 `Tower: <title> (<id>)` 可反推归属 |
     | worktree 里的未合并提交 | 可恢复：只要 `tower/<id>` 分支还在，提交就在；孤儿分支按 3.10 评估价值后收编或人工处置 |
     | 审查结论（review 记录、verdict、SHA 绑定） | **不可恢复**：只存在于 state；重建后 mission 从 `pending` 起步，要合并必须重新走完整审查 |
     | 事件时间线（`state.events`）、revision 计数、时间戳 | **不可恢复**：随 state 丢失，无法从 git 重建 |
     | mission 元数据（title/description/scope/depends_on） | 需人工重新提供：不在 git 里，重建 `add` 时对照原 mission 简报重写 |
     | 终态标记（`merged`/`abandoned` 等） | 重建后一律为 `pending`：已合并的收编后 `abandon` 对账（提交已在 base，无需重做，见 3.11） |

  4. **删除损坏 state 后重新 init**（3.11 的灾难恢复路径，完整语义见该节）：

     ```text
     ① 备份后把损坏的 state.json 移出 .dsh-tower/（init 幂等：目录里还有 state 时直接返回旧文件，所以必须先移走）
     ② 确认主工作区检出 base 分支且干净，然后 tower({action:"init"})（BASE_MISMATCH/BASE_DIRTY 见 §2.1）
     ③ 用原 id 逐个 tower({action:"add", ...})，人工重新提供 title/description/scope/depends_on
     ④ 满足收编条件的分支/worktree 自动重新登记；有独有提交的不会被收编，按 3.10 人工处置
     ⑤ 已合并过的 mission 收编后 abandon；依赖关系按原 depends_on 重挂，再逐个推进
     ```

     **代价**：历史 mission 记录（审查结论、事件时间线、revision/时间戳、元数据原值）永久丢失，重新登记的 mission 从 `pending` 起步。若 state 损坏时仍有 worker/reviewer 在跑（`status` 已不可用；§2.10 的结算通知仍会在落定时生成并尝试投递，但最差只退化为点名 role/mission/run/error 的兜底通知，不能据此确认状态已落账），先在进程/会话层面确认并停止它们再动手——重建后它们写的任何 state 都会被新账本覆盖语义。执行前与仓库 owner 确认（3.11）。

- 清理（残留 worktree / 分支）：
  - **前提：没有运行中的 activation**。state 可用时以 `tower({action:"status"})` 确认没有任何 mission 处于 `worker_running`/`review_running`；若有且属于已停止的旧控制器，先 `tower({action:"recover"})` 标记中断（3.8，前提是旧 Host 确已停止）。worker 仍在使用的 worktree 绝不清理。
  - 路由：**已登记** mission 的 worktree → `teardown`（只删终态、干净、已注册的，对账式幂等见 3.9）；**未登记**的孤儿 worktree/分支 → 3.10：优先同 id `add` 收编，确认无用才由人工执行 `git worktree remove <path>` 与 `git branch -D tower/<id>`——这是全手册**唯一**允许 git 写命令清理的场景（§5 禁令 6 的例外），且仅当分支无独有提交、或其价值已另行保全（cherry-pick/merge 到正式分支）之后；动手前逐字核对路径与分支名。
- **何时不要手改 state.json**：store 是唯一写入方——`write` 先 `validateState` 校验、写 `<state.json>.<pid>.<uuid>.tmp` 再原子 rename、失败清理本次临时文件（3.5），`read` 读回时再次校验。手改没有任何校验器把关，两种结局都更糟：语法/结构非法 → 下一次任何动作的 `read()`（含 `init` 的幂等分支）直接抛 `STATE_INVALID`，全部动作瘫痪（即本节症状）；语法结构碰巧合法但语义错误 → 制造出工具永远无法推导的僵尸状态（§5 禁令 1）。替代做法全部走 tower 动作、由 store 统一写入与校验：改 mission 元数据 → `edit`（仅 `pending`）；悬置的 running 记录 → `recover`；清理已登记 worktree → `teardown`；state 损坏/误删 → 本节与 3.11 的重建流程。**没有任何场景需要用编辑器打开 state.json。**

### 3.15 子代理中断的辨别与续跑

worker/reviewer 中断在 mission 侧都长一个样——落定成 `worker_failed`/`review_failed`，或跨重启悬置在 running（3.8）——但「为什么断」决定下一步完全不同：限流要换路由或等窗口，父会话取消可能只差一个 commit，其它错误要先定位根因。结算通知（§2.10）落定即生成并尝试投递，其物理末行 `stopReason: <实际值>`（缺失记 `unknown`；`failed`/`interrupted`/`stale` 同行附 `; reason:`）是第一道分辨信号，但投递可能失败（仅记 error 日志、无持久重试），且 `reason` 截断到 500 字符、换行和连续空白折叠成一个空格，最终辨别一律要靠 `status` 的 role 记录加子会话日志的 `turn/end`。

- 症状：`status`（§2.4）里 role 记录的 `stopReason` 为 `error`（`error` 文本各异：`429: {...}`、进程异常……）或 `aborted`（`error` 形如 `worker ended with aborted`，或 `recover` 标记的 `activation is not owned by this runtime; ...`）；也可能 mission 悬置在 `worker_running`/`review_running` 无人落定（3.8 的场景）。
- 诊断（辨别表：症状 → 判定 → 证据位置）：

  | 判定 | mission 侧（`status` 的 role 记录） | 子会话 `turn/end` 证据 |
  |---|---|---|
  | 供应商限流 | `stopReason:"error"`，`error` 文本含 `429`、`code 1308` 或 `RATE_LIMIT`（形如 `429: {...}`） | `reason.kind:"error"`，`error` 内是供应商原始响应 |
  | 父会话取消 | `stopReason:"aborted"`；worker 侧 mission → `worker_failed`、reviewer 侧 → `review_failed`（悬置 running 的经 `recover` 标记后同为 `aborted`，3.8） | `reason.kind:"aborted"` 且 `reason.reason.kind:"parent"` |
  | 其它错误 | `stopReason:"error"` 且错误文本不含 429 | `reason.kind:"error"`，`error` 为其它异常 |

  子会话日志是最终证据：`status` 里的 `error` 文本已被子代理侧截到上限（4096 字节的 diagnostic 上限），结算通知再截到 500 字符，429 响应体携带的窗口信息可能被截掉。查看方法——`<childId>` 即 `status` 中该 role 记录的 `childId`，会话日志按 `<会话根>/<项目目录>/<childId>/session.v4.jsonl.zstd` 存放（会话根默认 `~/.dsh/sessions`，其下按项目工作目录分组）：

  ```bash
  find ~/.dsh/sessions -maxdepth 2 -type d -name "<childId>"                 # 先定位子会话目录
  zstdcat ~/.dsh/sessions/<项目目录>/<childId>/session.v4.jsonl.zstd | tail  # 末尾即最后一条 turn/end
  ```

- 安全处理（处置矩阵）：

  | 判定 | 处置 |
  |---|---|
  | 供应商限流 | 换路由或等窗口：`tower({action:"spawn", mission_id:"<id>", role:"worker", provider:"...", model:"..."})` 重派（可用路由先用 `models` 查，§2.9），或等限流窗口重置。窗口重置时间看两处：子会话 `turn/end` 里完整的 429 响应体（常带重试/窗口提示），以及供应商控制台或用量页。不换路由、不到点就重试，只会再吃一次同样的 429（3.7 的环境性失败） |
  | 父会话取消 | **先查 worktree 再决定续跑或重做**（全部只读）：`git -C <worktree> status --porcelain` 看有无未提交/未跟踪文件、`git -C <worktree> log --oneline -3` 看有无已完成的新提交、`git -C <worktree> diff` 看改动内容。有成果（哪怕未提交）→ 续跑：重派 worker，instructions 里点名「worktree 已有上轮成果，先核对并提交/收尾」；一无所有 → 直接重做。mission 还悬置在 running 的先按 3.8 `recover`（前提：旧控制器确已停止） |
  | 其它错误 | 按上面的命令看子会话日志定位根因（`turn/end` 的 `error` 与其前后文）：环境性的（路由不可用 `MODEL_ROUTE_*`、网络等）先修环境再重派；任务性的按 3.7 重派，并把诊断写进新 run 的 instructions |

- 续跑语义（与实现一致，[lib/core.js](../lib/core.js) `beginSpawn`）：`spawn` 每次都新建 `runId` 并**整体替换** `mission.worker`/`mission.review` 记录，**不 adopt 旧 activation**——不会向旧子代理递话，也不会续用它的会话上下文；上一轮的工作只存在于 worktree（已提交或未提交的文件）里，这正是父会话取消后要先查 worktree 的原因。因此续跑只有两条正路：已落定为 `worker_failed`/`review_failed` → 直接重派（3.7）；悬置在 running → 先 `recover`（3.8）再重派——没有任何「接管旧进程接着跑」的动作。重派 worker 会**清空既有 review 记录**（完成后需完整重审，3.7）；worktree 里的未提交文件**保留**给新 worker 处理，tower 不自动清理。**不要手改 state.json** 去伪造落定或抹掉失败记录，替代动作清单见 3.14「何时不要手改 state.json」。
- 何时不应重试：限流未换路由且窗口未重置（同样的请求只会得到同样的 429）；父会话取消后未检查 worktree 之前（可能把已完成的工作白做一遍）；旧控制器可能仍在运行时执行 `recover`（3.8 的前提是它确已停止）。

## 4. Merge gate block code 速查表

block 由 [lib/core.js](../lib/core.js) `TowerCore.evaluateMergeGate` 产生；`message`/`entries`/`files` 字段给出细节。按「先修 base 环境，再修 mission 工件，再修审查绑定」的顺序排查通常最快。

| code | 含义 | 修复动作 |
|---|---|---|
| `NOT_APPROVED` | mission 状态不是 `approved`/`merge_blocked`，没有可合并的 clean 审查（`review_failed`/`worker_failed`/`changes_requested` 都会落在这） | 走完 worker → reviewer 流程；失败重派见 3.7；返工则重派 worker |
| `DEPENDENCIES_NOT_MERGED` | `depends_on` 中有 mission 未达终态 | 先推进/合并（或 `abandon`）依赖 mission |
| `WORKTREE_REMOVED` | mission 的 worktree 已被 teardown 移除 | 终局状态：worktree 没了无法再合并；如仍需要该改动，新开 mission |
| `BASE_DIRTY` | 主工作区有未提交/未跟踪文件（附 `entries`） | 在主工作区提交或清理；**不要**为了过 gate 把无关改动混进 base |
| `BASE_MISMATCH` | 主工作区检出的不是 `state.baseBranch`（含 detached HEAD） | 检出 base 分支再 merge |
| `WORKTREE_DIRTY` | mission worktree 有未提交/未跟踪文件（附 `entries`） | 派 worker 收尾（commit 或清理，3.7） |
| `NO_CHANGE` | mission tip 与当前 base 相同 | 无可合并内容：要么 worker 实际没提交（重派），要么成果已被合入（对照 3.4） |
| `STALE_BASE` | 当前 base 不是 mission tip 的祖先 | `tower({action:"rebase"})`，冲突则走 3.1；变基后必须重新审查（pending 首次派发时的同名错误见 §2.3，语义是"有独有提交，先显式变基"） |
| `NO_CLEAN_REVIEW` | 没有 verdict=clean 且 merge=true 的审查记录（或 review 被清空） | `spawn` reviewer 获得有效审查 |
| `REVIEW_TIP_STALE` | 审查绑定的 tip ≠ 当前 tip（审查后又出现提交） | 对新 tip 重新 `spawn` reviewer（3.6） |
| `REVIEW_BASE_STALE` | 审查绑定的 base ≠ 当前 base（审查后 base 前进） | `rebase` 后重新审查（3.6；即使 tip 未变，base 变化也使审查失效） |
| `OUT_OF_SCOPE` | 变更触及 scope 之外的文件（附 `files`） | 派 worker 把越界改动撤回/移入合规路径；确属任务必需则用 `edit` 扩 scope（仅 `pending` 可改——已派生的 mission 只能让 worker 收敛改动） |
| （非 block）`alreadyMerged:true` | 被审 SHA 已在 base 且仍等于 mission tip | 不是故障：直接 `merge` 走记账式对账（3.4） |

## 5. 风险与禁令

1. **禁止手工编辑 `.dsh-tower/state.json`。** [lib/store.js](../lib/store.js) 的 `TowerStore` 是唯一写入方（校验 + 临时文件 + 原子替换 + 失败清理本次临时文件）。手工拼 state 会绕过所有一致性检查，制造出工具永远无法推导的僵尸状态；损坏走 3.11。
2. **禁止两个 Host 进程同时充当同一仓库的控制器。** 归属仲裁（[lib/runtime.js](../lib/runtime.js) `claimWorkspace`，`WORKSPACE_BUSY`）与 store 的串行队列都是**单进程内**的机制，不是跨进程 Git 锁（README "Deliberate limits" 明示）。双进程并发会产生真正的写写竞态。
3. **不要在 dirty base 上 merge。** gate 的 `BASE_DIRTY` 是保护而非障碍：merge 会移动 base 分支，脏主工作区会让后果不可逆。先提交或清理主工作区。
4. **不要绕过 gate 手工 `git merge` mission 分支。** 绕过会破坏「审查绑定精确 SHA」的对账模型（`alreadyMerged` 判定、merge 记账、依赖解锁全部依赖它）。需要紧急合入时，也先让 tower 完成 gate → merge；事后对账按 3.4。
5. **reviewer 的只读是约定不是沙箱。** 任务简报要求 reviewer 只读（[lib/runtime.js](../lib/runtime.js) `reviewerBrief`），但没有进程级隔离；不要把敏感仓库的审查交给不受信路由（配合 `allowedModels` 收紧）。
6. **不要手工删除 worktree 目录或 `tower/*` 分支来"清理"。** teardown 的保守判定（注册、终态、干净、路径前缀校验）就是为了安全清理；手工删除会把 state 与 git 事实撕开，制造 3.10 的孤儿场景。唯一例外见 3.10 的独有提交分支人工处置。
7. **不要在 mission 中途切换/重置 base 分支。** tower 锚定 init 时的 base 分支（`BASE_CONFLICT`）；中途换 base 等于让所有审查绑定与依赖图失效。

## 附录 A：只读诊断命令清单

与 [lib/git.js](../lib/git.js) 各 helper 的探测逻辑一一对应（`status`/`currentBranch`/`isAncestor`/`changedFiles`/`rebaseInProgress`，以及 [lib/core.js](../lib/core.js) `recoverMergeFailure` 对 `MERGE_HEAD` 的探测）：

```bash
# base 侧
git -C <repo> status --porcelain=v1 --untracked-files=all   # 脏检查（BASE_DIRTY / WORKTREE_DIRTY 的事实源）
git -C <repo> symbolic-ref --quiet --short HEAD             # 检出分支（BASE_MISMATCH / DETACHED_HEAD）
git -C <repo> rev-parse --verify <baseBranch>^{commit}      # base tip
git -C <repo> rev-parse --verify MERGE_HEAD                 # merge 中间态（exit 1 = 干净）
git -C <repo> log --oneline --graph --decorate -15          # base 近况 / Tower merge commit
git -C <repo> merge-base --is-ancestor <A> <B>; echo $?     # 祖先关系（STALE_BASE / alreadyMerged）
git -C <repo> diff --name-only --no-renames <base>...<tip>  # 变更文件（OUT_OF_SCOPE）

# worktree / 分支盘点
git -C <repo> worktree list --porcelain                     # 注册 worktree（teardown / 孤儿排查）
git -C <repo> for-each-ref --format='%(refname:short) %(objectname:short)' refs/heads/tower/
git -C <worktree> rev-parse --git-path rebase-merge         # rebase 中间态（再查 rebase-apply；存在即卡变基）

# state 侧（只读）
python3 -m json.tool <repo>/.dsh-tower/state.json           # 语法/结构检查（STATE_INVALID 复现）
node scripts/tower-doctor.mjs [--repo <repo>] [--json] [--fail-on-warning]   # state ↔ git 对账体检（附录 C）
```

## 附录 B：`state.events` 事件类型（[lib/core.js](../lib/core.js) `appendEvent`）

state 内保留最近 200 条，`status` 返回最近 20 条，按时间排序，用于还原「最后一次成功落账到哪一步」：

| 事件 | 触发 |
|---|---|
| `initialized` | `init` 建立新 state |
| `mission-added` / `mission-edited` | `add` / `edit` |
| `mission-artifacts-reconciled` | `add` 重试收编既有分支/worktree（3.10） |
| `spawn-started` / `spawn-attached` / `spawn-failed` / `spawn-completed` | 子代理生命周期（`spawn-failed` 覆盖启动失败与 `worker_failed`/`review_failed` 落定，带 mission 落定状态；`spawn-completed` 带 mission 落定状态） |
| `activation-recovered` | `recover` 标记僵尸激活（3.8） |
| `mission-rebased` / `rebase-failed` | `rebase` 成功 / 失败（3.1，失败带 `recoveryRequired`） |
| `mission-merged` | merge 成功落账 |
| `mission-merge-reconciled` | alreadyMerged 记账式对账（3.4） |
| `mission-merge-advanced` | 合并成功但 tip 超过被审 SHA（2.7 表） |
| `merge-failed` | git merge 失败（3.2，带 `recoveryRequired`） |
| `merge-accounting-required` / `merge-verification-failed` | 合并后核对/落账失败（3.3） |
| `mission-abandoned` | `abandon` |
| `worktree-removed` / `worktree-remove-reconciled` | `teardown` 移除 / 对账补记（3.9） |

## 附录 C：`scripts/tower-doctor.mjs` 速查

只读体检脚本（[scripts/tower-doctor.mjs](../scripts/tower-doctor.mjs)），对账 state 与 git 事实，**不做任何写入**（不改 state、不动 git）。

```bash
node scripts/tower-doctor.mjs                     # 体检当前工作目录所在仓库
node scripts/tower-doctor.mjs --repo <path>       # 指定仓库
node scripts/tower-doctor.mjs --state <file>      # 指定 state 文件（默认 <repo>/.dsh-tower/state.json）
node scripts/tower-doctor.mjs --json              # 机器可读输出（findings + summary）
node scripts/tower-doctor.mjs --fail-on-warning   # 严格守门：有 warning 也退出 2（发布检查 / CI 门禁）
node scripts/tower-doctor.mjs --help              # 用法
```

- 退出码：`0` = 全部检查通过；`1` = 有 warning；`2` = 有 error（或参数用法错误）。加 `--fail-on-warning` 后，仅有 warning 的运行也退出 `2`（clean 仍为 `0`，error 仍为 `2`），默认行为不变，适合发布检查 / CI 严格守门；与 `--json` 同用时 payload 额外携带 `failOnWarning: true`（默认输出不含该键，既有键集不变）。人类可读输出逐行列出 `[severity] code: message` 并汇总 `N checks passed, X warning(s), Y error(s)`。
- 检查范围：state 结构（镜像 [lib/store.js](../lib/store.js) 规则）、repo 一致性、base 分支与 `baseCommit` 关系、每个 mission 的分支存在性 / worktree 注册与磁盘存在性 / 检出分支、已合并 mission 的 `mergeCommit` 是否可达自 base、teardown 一致性、悬置的 running 记录、终态 mission 残留的活跃角色记录（`MISSION_TERMINAL_ACTIVE_ROLE`）、`.dsh-tower/worktrees/` 下的孤儿目录，以及 git 元数据属主（仅 POSIX）与对象库 / refs / index / Tower state 目录的可写性。属主扫描的样例上限、扫描预算与非 POSIX 行为见 3.12。
- 常见 finding 与处置：

| code（severity） | 含义 | 处置 |
|---|---|---|
| `STATE_CORRUPT` / `STATE_VERSION` / `STATE_MISSING`（error） | state 非法 JSON / 版本不支持 / 文件缺失 | 3.11 / 3.14（缺失则先 `init`） |
| `STATE_READ_FAILED`（error） | state 文件存在但读取失败（典型为权限，store 侧对应原始 fs 错误） | 3.14；属主/权限先按 3.12 排查 |
| `REPO_MISMATCH`（warning） | `state.repoRoot` 与当前仓库不一致 | 确认是否在错误的仓库里跑 tower |
| `BASE_COMMIT_DRIFT`（warning） | base 分支已超过记录的 `baseCommit` | 正常漂移；下次 merge/rebase 会用到新 tip |
| `BASE_COMMIT_DIVERGED` / `BASE_BRANCH_MISSING`（error） | base 被重置/分叉或消失 | 禁令 7 场景，人工评估，勿盲目重试 |
| `MISSION_BRANCH_MISSING` / `WORKTREE_DIR_MISSING`（active 时 error） | 非终态 mission 的分支/worktree 消失 | 3.10 / 3.11 排查 |
| `WORKTREE_UNREGISTERED` / `WORKTREE_BRANCH_MISMATCH`（warning） | 目录存在但未注册 / 检出分支不对 | 3.10；`WORKTREE_BRANCH_MISMATCH` 也见 §2.3 |
| `ORPHAN_WORKTREE`（warning） | worktree 目录无 mission 引用 | 3.10 |
| `TEARDOWN_INCOMPLETE` / `WORKTREE_STILL_REGISTERED`（error） | `worktreeRemoved:true` 但目录/注册仍在 | 复核后人工清理（3.10 惟一例外） |
| `MERGE_RECORD_MISSING` / `MERGE_COMMIT_NOT_IN_BASE`（error） | `merged` mission 记账不完整或不在 base | 3.4 / 3.5 对账 |
| `RUNNING_RECORD_MISSING`（error）/ `RUNNING_RECORD_FINISHED`（warning） | running 状态但记录缺失 / 记录已结束 | 后者按提示执行 `tower action=recover`（3.8） |
| `MISSION_TERMINAL_ACTIVE_ROLE`（warning） | 终态（`merged`/`abandoned`）mission 的 `worker`/`review` 记录仍带 `runId` 且无 `completedAt`/`stopReason`（消息含 mission id、role、runId 前缀；`recover` 跳过终态 mission，故此前不可见） | warning 不影响 gate，`--fail-on-warning` 下升级为退出 2；处置见 3.14：确认该 `runId` 已无活跃 activation 后用 `tower recover` 对账或按 3.14 重建，**不要手改 state.json** |
| `GIT_METADATA_FOREIGN_OWNER`（warning） | 扫描发现由其它 uid 拥有的 repo/git 元数据；`sample` 最多 10 条，`truncated:true` 表示达到扫描预算 | 3.12；先停止写入、诊断与备份，再由人工确认并修复属主 |
| `GIT_METADATA_NOT_WRITABLE`（error） | 现存的对象库 / refs / index / Tower state 目录对当前用户不可写 | 3.12；先备份并处理活跃 worker，再人工修复属主或目标权限 |

### `scripts/release.mjs` 错误码映射

以下是发布脚本自身的错误，不是 doctor finding；完整诊断与安全顺序见 3.13。

| code | 含义 | 处置 |
|---|---|---|
| `RELEASE_LOCKED` | 主锁 / reclaim 锁持有者存活或状态未知，或获取期间发生锁代际变化 | 查真实 gitdir、锁内容与 pid；只有明确 `ESRCH` 才可自动回收，锁龄不授权接管或删锁；人工处置按 3.13 |
| `RELEASE_PLAN_STALE` | 写前发现目标已变化、缺失、create 目标已出现或无法核验 | 本次零目标写入；保留当前内容、查明变化或读取故障，工作区核对干净后重新 dry-run，不复用旧计划 |
| `DIRTY_WORKTREE` | `--apply` 前工作区不干净 | 提交或 stash 改动，确认 `git status --porcelain` 为空后再运行 |
| `VERSION_NOT_GREATER` | 目标版本不大于 package 当前版本 | 先确认是否已成功 apply；需要新版本时使用严格更高的 semver，不要对相同状态反复重试 |
| `VERSION_ALREADY_RELEASED` | CHANGELOG 已有目标版本段 | 核对 package、CHANGELOG 与历史发布状态，先修正不一致，不要重复 apply |
| `GIT_CHECK_FAILED` | gitdir 探测或工作区状态检查失败 | 根据 stderr 修复仓库、Git 元数据或权限问题后再运行 |

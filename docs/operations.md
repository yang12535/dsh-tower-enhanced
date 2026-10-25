# Tower 运维 Runbook：故障诊断与恢复手册

本手册面向 Tower 控制器（controller Session）的日常操作与故障处置：每一步的预期输出、失败后的下一步动作，以及各故障场景的安全处理边界。使用入门请先读 [README.md](README.md)（或 [README.zh-CN.md](README.zh-CN.md)）；本手册只做「操作 + 排障」，不重复架构论述。

## 基线与文档现状

- 本手册与 base `8fcc36c` 的代码行为一致：`lib/core.js`（状态机、merge gate、merge/rebase/teardown/recover 语义）、`lib/runtime.js`（action 分发、workspace 归属）、`lib/store.js`（state 持久化与校验）、`lib/git.js`（git 封装）。该基线已包含 M4 models 聚合、M5 `editMission`、M6 中文 README、M7 CI 加固、M8 `edit` 接线、M9 e2e 测试、M14 `summary` 的 core 实现与工具枚举。
- `docs/architecture.md` 与 `docs/security-model.md`（M10）、`scripts/tower-doctor.mjs`（M12 只读体检）由并行 mission 交付，撰写本手册时**尚未合入 base**；本手册不依赖它们存在，相关章节给出合入前的替代做法。
- 兼容性提示：`summary` 动作已在 `lib/index.js` 的工具枚举与 `lib/core.js`（`TowerCore.summary`）中就绪，但 `lib/runtime.js` 的 action 分发尚未接线（待 M17）。在本基线上调用 `tower({action:"summary"})` 会得到 `unknown Tower action summary`；日常巡检请继续用 `status`。

## 约定

- 所有变更类操作一律通过控制器 Session 的 `tower` 工具完成；**不要**用 bash 直接改 `.dsh-tower/state.json` 或代替 tower 执行 merge/rebase/teardown。git 命令只用于**只读诊断**（附录 A）。
- 文中 `<repo>` 指仓库根（`state.repoRoot`），`<id>` 指 mission id；mission 的分支为 `tower/<id 小写>`，worktree 为 `<repo>/.dsh-tower/worktrees/<id 小写>`。
- tower 归属跟随仓库而非 Session 血统：同一仓库的 tower 同一时刻只有一个 owner（一次调用在途，或它启动的 worker/reviewer 仍在运行）。第二个 Session 会被 `WORKSPACE_BUSY` 拒绝。
- `status` 返回的 `events` 是 `state.events` 的最后 20 条（事件类型见附录 B），是排障的第一手时间线。

## 1. 状态机速览

合法状态集合定义在 `lib/store.js`（`STATUSES`），迁移逻辑在 `lib/core.js`。

| status | 含义 | 进入方式 | 允许的下一步 |
|---|---|---|---|
| `pending` | 已创建，未派生 | `add` / `add` 重试对账 | `spawn` worker；`edit` 修元数据；`abandon` |
| `worker_running` | worker 运行中 | `spawn` role=worker | `send` / `interrupt`；等待落定 |
| `worker_completed` | worker 已完成且 worktree 干净 | worker 落定 / reviewer 异常落定 / `rebase` 后需复审 | `spawn` reviewer；`spawn` worker 返工；`rebase` |
| `worker_failed` | worker 异常结束或留下脏 worktree | worker 落定失败 / `failSpawn` / `recover` | `spawn` worker 重试；`abandon` |
| `review_running` | reviewer 运行中 | `spawn` role=reviewer | `send` / `interrupt`；等待落定 |
| `changes_requested` | 审查要求返工 | reviewer verdict 非 clean 或 merge≠true | `spawn` worker 返工（会清空既有 review） |
| `approved` | clean 且 merge=true 的审查通过 | reviewer 落定 | `gate` → `merge`；`rebase`；`abandon` |
| `rebase_blocked` | rebase 冲突，tower 已自动 `rebase --abort` | `rebase` 失败 | `spawn` worker 手工解决冲突；`abandon` |
| `merge_blocked` | merge 的 git 步骤失败，tower 已尝试 `merge --abort` | `merge` 失败 | 修复后重试 `merge`（gate 对该状态放行）；`rebase`；`abandon` |
| `merged` | 终态：已并入 base | `merge` 成功 / alreadyMerged 对账 | `teardown` |
| `abandoned` | 终态：放弃（工件保留） | `abandon` | `teardown` |

worker 可重启的状态集合（`WORKER_RESTARTABLE`，见 `lib/core.js`）：`pending`、`worker_completed`、`worker_failed`、`changes_requested`、`approved`、`rebase_blocked`、`merge_blocked`。reviewer 只能从 `worker_completed` / `approved` / `changes_requested` 启动。

## 2. 日常操作流

标准闭环：`init` → `add` → `spawn` worker → `status` → `spawn` reviewer → `gate` → `merge` → `teardown`。每小节给出调用、预期输出字段与失败后的 next action（均为 tower 动作）。

### 2.1 init

前置：Session 工作目录已切到目标仓库；base 分支已检出且主工作区干净。

```text
tower({action:"init"})            // 可选 base_branch，默认当前检出分支
```

- 预期输出：`{ version, repoRoot, baseBranch, baseCommit, createdAt, updatedAt, missions: [], events }`。幂等：state 已存在时直接返回现有 state。
- 首次 init 会创建 `.dsh-tower/worktrees/`、把 `.dsh-tower/` 写入 git 本地 exclude（`lib/store.js` `ensureLocalExclude`，不碰 `.gitignore`）。
- 失败与 next action：
  - `BASE_MISMATCH`：当前检出的分支不是请求的 base。先在主工作区检出 base 分支再 init。
  - `BASE_DIRTY`：主工作区有未提交/未跟踪文件。先提交或清理（不要指望 tower 容忍脏 base）。
  - `BASE_CONFLICT`：tower 已锚定其它 base 分支。确认仓库是否搞错；tower 不支持中途换 base。
  - `TOWER_NOT_INITIALIZED` 出现在其它动作上：说明 state 文件缺失，先 init。

### 2.2 add（含 scope 设计建议）

```text
tower({action:"add", id:"M1", title:"...", description:"...", dependsOn:["M0"], scope:["docs/**"]})
```

- 预期输出：`{ mission: { id, title, description, dependsOn, scope, branch, worktree, baseCommit, status:"pending", revision, createdAt, worktreeRemoved:false } }`，并创建分支 `tower/<id>` 与隔离 worktree。`id` 省略时自动分配 `M<最大序号+1>`。
- scope 设计建议：
  - scope 是仓库相对 glob，空数组 = 完全不限。**建议始终显式给出**——gate 的 `OUT_OF_SCOPE` 检查只在 scope 非空时生效。
  - 粒度以目录/主题为宜（如 `docs/**`、`lib/client.js` + `test/client.test.js` 成对给出）；过宽失去保护，过窄容易把测试、locale 文案等伴生改动误伤成 out-of-scope。
  - 不允许绝对路径与 `..`（`SCOPE_INVALID`）；重复模式会被去重。
  - 预期会改同一区域的 mission 用 `dependsOn` 串行化，而不是靠 scope 并行硬撞（并行写同一文件最终会在 rebase/merge 阶段冲突）。
- 失败与 next action：
  - `MISSION_EXISTS` / `MISSION_ID_INVALID`：换 id（id 规则：大写字母开头，仅大写字母/数字/`_`/`-`）。
  - `DEPENDENCY_INVALID` / `MISSION_NOT_FOUND`（依赖项）：修正 `depends_on` 指向已存在的 mission。
  - `MISSION_ARTIFACT_CONFLICT`：同名分支/worktree 已存在且无法安全收编（见 3.10）。先用只读命令核对工件，再决定复用新 id 或人工清理。
  - 派生前发现描述写错：不必删掉重来，用 `edit` 修 `title`/`description`/`scope`/`depends_on`（仅 `pending` 可改，`MISSION_NOT_EDITABLE`）。

### 2.3 spawn worker

```text
tower({action:"spawn", mission_id:"M1", role:"worker", provider:"...", model:"...", reasoning_effort:"...", max_tokens:...})   // 路由参数可选
```

- 预期输出：`{ mission:"M1", role:"worker", runId, childId, status:"worker_running", worktree, route }`。worker 在 mission worktree 内实现并**必须先 commit** 再结束。
- 失败与 next action：
  - `WORKSPACE_BUSY`：另一 Session 正拥有本仓库 tower。回到那个 Session 处理，或等它的调用/子代理落定；不要强行并发。
  - `AGENT_BUSY`：该 mission 已有 worker/reviewer 在跑。先 `send`/`interrupt` 或等待落定。
  - `WORKER_START_BLOCKED`：当前状态不允许启 worker（见 §1 表）。
  - `DEPENDENCIES_NOT_MERGED`：依赖未到终态（`merged` 或 `abandoned` 都算解决）。先推进依赖 mission。
  - `MODEL_ROUTE_*` / `MAX_TOKENS_INVALID`：路由参数不合法或不在 `allowedModels`，修正参数或配置。
  - worker 结束后状态为 `worker_failed`：见 3.7 重试。

### 2.4 status

```text
tower({action:"status"})                       // 全量 state
tower({action:"status", mission_id:"M1"})      // 单个 mission
tower({action:"status", observe:true})         // 附带 git 实况观察
```

- 预期输出：`{ version, repoRoot, baseBranch, baseCommit, missions[], events }`；`observe:true` 时额外返回 `observations: { checkedOutBranch, baseTip, baseStatus, missions: { "<id>": { tip, status:{clean, entries} } } }`。
- 用法：`observe:true` 把「持久化 state」与「git 事实」并排摆出，是所有「状态怀疑滞后/不一致」场景的首选诊断（见 3.5）。mission 内 `worker`/`review` 记录的 `output`、`error`、`dirtyEntries`、`headCommit`、`structured`（审查结论）都在这里读。

### 2.5 spawn reviewer

```text
tower({action:"spawn", mission_id:"M1", role:"reviewer", provider:"...", model:"..."})
```

- 前置：mission 为 `worker_completed`（或 `approved`/`changes_requested` 复审），worktree 干净。
- 预期输出：在 worker 的字段之外多了 `binding: { baseCommit, reviewedCommit }`——审查证据绑定精确 SHA，base 或 tip 任何移动都需要重新审查。
- 失败与 next action：
  - `REVIEW_START_BLOCKED`：状态不对（如 `pending`、`worker_failed`），先把 worker 跑完。
  - `WORKTREE_DIRTY`：worktree 有未提交/未跟踪文件。派 worker 收尾（commit 或清理）。
  - `NO_CHANGE`：mission tip 与当前 base 相同，没有可审内容。
  - `STALE_BASE`：当前 base 已不是 mission tip 的祖先，先 `rebase`。
  - reviewer 落定后 `review.stale:true`：见 3.6。

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

返回形态一览（完整语义见 `lib/core.js` `TowerCore.merge`）：

| 返回字段组合 | 含义 | 下一步 |
|---|---|---|
| `merged:true, advanced:false, mergeCommit` | 正常合并，mission → `merged`，`state.baseCommit` 前进 | `teardown` |
| `merged:true, advanced:true, branchTip` | 合并成功但 worktree tip 已超过被审 tip；状态回 `worker_completed`，review 清空 | 对新增提交重新 `spawn` reviewer，再 merge |
| `merged:true, reconciled:true`（或 `alreadyMerged:true`） | base 已包含被审 SHA，做记账式对账 | 无需动作，可 `teardown` |
| `merged:false` + `gate.blocks` | gate 拦截，未执行 git merge | 按 §4 修复 |
| `merged:false` + `error` + `recoveryRequired`（可能含 `abortError`/`remainingMergeState`/`restoredHead`/`clean`） | git merge 失败，tower 已尝试 `merge --abort`，mission → `merge_blocked` | 见 3.2 |
| `merged:false, mergeAttempted:true, verified:false, recoveryRequired:true, postMerge:true` | git 层合并完成但其后核对/落账失败 | 见 3.3 |

- 失败与 next action（工具层错误）：`MISSION_NOT_FOUND` 检查 id；若整个调用抛出非 gate 类异常，先 `status observe:true` 再对号入座。

### 2.8 teardown

```text
tower({action:"teardown", mission_id:"M1"})    // 省略 mission_id 则遍历全部 mission
```

- 预期输出：`{ results: [{ mission, removed:true }], state }`。只移除**终态、干净、已在 git 注册**的 worktree；分支与 state 永远保留。
- 幂等与拒绝条件详见 3.9。

### 2.9 辅助动作

- `edit`：修正尚未派生的 mission 元数据（`title`/`description`/`scope`/`depends_on`；仅 `pending`，校验依赖环 `DEPENDENCY_CYCLE`）。
- `rebase`：把 mission 分支变基到当前 base（详见 3.1 的失败路径）。成功且 tip 变化时会清空 review 并回到 `worker_completed`——**变基之后必须重新审查**。
- `abandon`：mission → `abandoned`，工件保留，交给 `teardown` 清理；依赖它的 mission 视依赖为已解决。
- `send` / `interrupt`：向当前运行中的 worker/reviewer 递话/取消（`AGENT_NOT_RUNNING` 表示没有活跃子代理可寻址）。
- `recover`：处置跨重启的僵尸 running 记录，语义见 3.8。
- `models`：查询 provider 目录/精确路由元数据，不做任何仓库操作。

## 3. 故障场景 Runbook

每个场景按「症状 / 诊断 / 安全处理 / 何时不应重试」组织。诊断命令统一列在附录 A。

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
  - 特例：若工具调用整体抛错但返回体含 `merged:true, recoveryRequired:true, postMerge:true`——git 已成功、state 写入失败——处理方式相同：先诊断，再重试 merge 让对账收尾。
- 何时不应重试：base 脏（`BASE_DIRTY`）或处在 merge 中间态时；以及尚未用只读命令确认 base 事实之前——盲目重试在"其实没合并成功"的情形下会走 3.2 的冲突路径。

### 3.4 `alreadyMerged` 对账

- 症状：`gate` 返回 `{ ready:false, alreadyMerged:true, warnings, observations }`——存在 clean 且 merge=true 的 review、`reviewedCommit` 仍等于 mission tip，且该 SHA 已是 base 的祖先。常见于 3.3 的 state 写入失败后重试，或人工曾把该 SHA 合入 base。
- 诊断：`status observe:true` + `merge-base --is-ancestor <reviewedCommit> <baseBranch>`，确认「被审 SHA = mission tip = 已在 base 中」三事实。
- 安全处理：调用 `merge`。它做记账式对账：mission → `merged`，`mission.merge.commit` 记为当前 base tip，事件 `mission-merge-reconciled`，返回 `merged:true, reconciled:true`。随后正常 `teardown`。**不要**因为"看起来已经合了"就把 mission 弃置不管——state 不对账，`depends_on` 与面板状态就一直悬着。
- 何时不应重试：`alreadyMerged` 的判定同时要求 tip 一致；若 mission tip 已又前移（warnings 里会出现 `REVIEW_TIP_STALE`），这就不是对账场景，而是需要重新审查的新提交。

### 3.5 state 写入失败后的 reconciliation

- 症状：git 操作已发生，但 `.dsh-tower/state.json` 没跟上——例如 merge 成功后进程被杀（`lib/store.js` 的写入是临时文件 + 原子 rename，不会写出半份文件，但"git 已变、state 未写"的窗口真实存在）。表现为：mission 状态与 git 事实矛盾、事件时间线缺尾、或 3.3 的 `postMerge` 形态。
- 诊断：一律从 `tower({action:"status", observe:true})` 开始，把持久化字段与 `observations`（`checkedOutBranch`/`baseTip`/`baseStatus`/每 mission 的 `tip` 与 `status.clean`）逐项对照；再辅以附录 A 的祖先关系检查。state 里的 `events` 尾部（附录 B）能看出最后一次成功落账到哪一步。
- 安全处理：tower 各动作自带保守对账，**用重试对应动作来收敛，而不是改 state**：
  - merge 已成、state 未记 → 重试 `merge`，走 3.4 的记账式对账（`mission-merge-reconciled`）。
  - add 中断留下的分支/worktree → 重试同 id 的 `add`，满足条件时收编（`mission-artifacts-reconciled`，mission 带 `reconciled:true`）；不满足则 `MISSION_ARTIFACT_CONFLICT`，见 3.10。
  - worktree 已被外部删掉 → 重试 `teardown`，路径在磁盘与 git 注册表中都不存在时补记 `worktreeRemoved`（`worktree-remove-reconciled`）。
  - running 记录跨重启悬置 → `recover`（3.8）。
- 何时不应重试：对账动作本身连续失败、或 `observe` 显示 git 事实自相矛盾（如 base 处于 merge 中间态）时，停下来按 3.2/3.11 做只读排查；对账不收敛说明有更底层的问题。

### 3.6 reviewer stale / `REVIEW_BASE_STALE` / `REVIEW_TIP_STALE`

- 症状：
  - reviewer 运行期间绑定漂移：落定记录 `review.stale:true`、`error:"review binding became stale while the reviewer was running; spawn a fresh reviewer"`，mission 回 `worker_completed`（结论作废，不采信其 verdict）。
  - merge 前 gate 给出 `REVIEW_TIP_STALE`（审查时的 tip ≠ 当前 tip）或 `REVIEW_BASE_STALE`（审查时的 base ≠ 当前 base）。
- 诊断：`status` 读 `review.baseCommit`/`review.reviewedCommit`，与 `observe:true` 的 `baseTip`、mission `tip` 比对，确认是哪一端动了。
- 安全处理：
  - base 动了（别处 merge 推进了 base）：`tower({action:"rebase"})`；成功后旧 review 被清空、mission 回 `worker_completed`，重新 `spawn` reviewer → gate → merge。
  - tip 动了（审查期间 worktree 又有提交）：直接重新 `spawn` reviewer（从 `worker_completed`/`changes_requested` 均可），新审查绑定新 SHA。
  - reviewer 进程还在跑而绑定已漂移：先 `interrupt` 再重派，避免旧结论晚到覆盖。
- 何时不应重试：绑定漂移的根因未明（例如有人手工在 worktree 提交）之前不要急着重派审查——先弄清谁动了 tip，否则新审查还会再 stale 一次。

### 3.7 `worker_failed` 重试

- 症状：worker 落定后 mission → `worker_failed`。两类典型：进程异常（`stopReason ≠ completed`，`worker.error` 有诊断）与脏收尾（`error:"worker finished with uncommitted or untracked files; commit or clean them before review"`，附 `dirtyEntries`）。`spawn` 本身失败（`failSpawn`）也落此状态。
- 诊断：`status` 读 `worker.stopReason`、`worker.error`、`worker.dirtyEntries`；需要更多上下文时 `send` 询问仍在线的 worker，或查看其子代理会话。
- 安全处理：`worker_failed` 在 `WORKER_RESTARTABLE` 中，直接重派：`tower({action:"spawn", role:"worker"})`，在 instructions 里点名要处理的事项（先 commit / 清理 untracked / 修复报错）。注意两点：
  - 重派 worker 会**清空既有 review 记录**（`beginSpawn` 的既定行为），完成后需要完整重审。
  - 若上一轮是 `changes_requested` 后的返工失败，worker 的任务简报会自动附带上一轮审查反馈（`workerBrief` 注入 `previousReview`）。
- 何时不应重试：同一失败连续复现（说明任务本身有问题，改 mission 或 `abandon`）；worktree 处于 rebase/merge 中间态（先按 3.1/3.2 清理）；或 `worker` 记录显示问题是环境性的（如路由不可用，`MODEL_ROUTE_*`）而未先修环境。

### 3.8 `recover` 的语义

- 语义（`lib/core.js` `TowerCore.recover`）：把**持久化**为 `worker_running`/`review_running`、且其 `runId` 不属于当前运行时活跃集合的记录，标记为已中断——`stopReason:"aborted"`、`error:"activation is not owned by this runtime; ..."`，worker 侧 mission → `worker_failed`，reviewer 侧 mission → `worker_completed` 且 `review.stale:true`。它**只改标记，绝不接管旧进程**：不会向旧子代理发消息，也不会替它收尾。
- 症状（需要 recover 的信号）：Host/控制器重启后，mission 永远停在 `worker_running`/`review_running`，任何 spawn 被 `AGENT_BUSY` 拒绝。
- 诊断：`status` 确认悬置的 role 与 `runId`。注意 `recover` 只会把「当前运行时不认领」的 runId 标记为中断；旧 Host 进程的活跃与否对当前运行时不可见，必须由操作者在进程层面确认它确实已停止。
- 安全处理：**先确认旧控制器确实停止**（这是 `recover` 的前提，README "Failure recovery" 同义），再 `tower({action:"recover"})`。返回 `{ recovered: [{ mission, role, runId }], state }`。随后：worker 侧按 3.7 重派；reviewer 侧 mission 已回 `worker_completed`，直接重派 reviewer。
- 何时不应重试（不应执行 recover）：旧 Host 进程可能仍在运行时——它的 worker/reviewer 落定回调仍会写 state，和 recover 的标记互相覆盖，制造真正的竞态。先停旧进程，再 recover，一次即可（幂等：没有可回收记录时返回空 `recovered`）。

### 3.9 `teardown` 的幂等与拒绝条件

- 语义（`lib/core.js` `TowerCore.teardown`）：逐 mission 判定，结果在 `results[]`，每项互不阻塞。只删 worktree；分支与 state 永远保留。
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

- 症状：`git worktree list` 里存在 `.dsh-tower/worktrees/*` 或 `git branch --list 'tower/*'` 有分支，但 state 里没有对应 mission（state 丢失/损坏后重建、或历史 `MISSION_ARTIFACT_CONFLICT` 遗留）；或 `add` 重试报 `MISSION_ARTIFACT_CONFLICT`。
- 诊断（全部只读）：`git worktree list --porcelain`、`git for-each-ref refs/heads/tower/`、对每个孤儿分支 `merge-base --is-ancestor <tip> <baseBranch>` 判断其提交是否已在 base 中，`log --oneline <baseBranch>..<tip>` 看有无 base 之外的独有提交。
- 安全处理：
  - 想收编（推荐）：重试 `tower({action:"add", id:"<原id>"})`。仅当分支与注册 worktree 完全匹配、worktree 干净、检出该分支、且 tip 是当前 base 的祖先（无独有提交）时，tower 自动收编（`mission-artifacts-reconciled`，`reconciled:true`，状态 `pending`）；随后按需走完流程或 `abandon` + `teardown`。
  - 有独有提交的分支：tower 一定拒绝自动收编（`MISSION_ARTIFACT_CONFLICT`，正确行为）。人工评估提交价值：仍需要 → cherry-pick/merge 到正式分支后处理；确认无用 → 由人工执行 `git worktree remove <path>` + `git branch -D tower/<id>`（tower 没有"强制弃置未登记工件"的动作，这是**唯一**需要动用 git 写命令的清理场景，动手前确认路径与分支名无误）。
  - 已登记 mission 但 worktree 目录被外部删掉：`teardown` 会在路径双重不存在时补记对账（3.9），不要手工重建目录。
- 何时不应重试：`add` 收编条件不满足时重试 `add` 永远冲突——要么先满足条件（清理/合并独有提交），要么换新 id 让旧工件交人工处置。

### 3.11 `.dsh-tower/state.json` 损坏（只读诊断）

- 症状：所有 tower 动作（含 `status`）抛 `STATE_INVALID`（消息形如 `could not parse ...state.json: ...` 或字段校验失败——校验规则见 `lib/store.js` `validateState`：version=1、repoRoot 绝对路径、mission 必填字段、status 枚举、revision 正整数、id 去重）。文件整个缺失则是 `TOWER_NOT_INITIALIZED`。
- 诊断（只读）：
  - `python3 -m json.tool <repo>/.dsh-tower/state.json`（或 `jq .`）：区分「JSON 语法损坏」与「结构校验失败」。
  - `git worktree list --porcelain` + `git for-each-ref refs/heads/tower/`：盘点 git 侧事实（哪些分支/worktree 存在、tip 在哪）。
  - `git log --oneline --grep="Tower: " <baseBranch>`：从 merge commit 标题反推哪些 mission 已合入。
  - `scripts/tower-doctor.mjs`（M12 交付中，**当前 base 尚未包含**）：期望用法为 `node scripts/tower-doctor.mjs`，在仓库根只读对账 state 与 git（worktree/branch/已合并 SHA 差异报告），不修改任何文件。合入前请用上述命令人工完成同样的对账。
- 安全处理：
  - **先备份再谈修复**：`cp .dsh-tower/state.json state.json.bak.<时间戳>`（复制是只读于原文件的保险动作）。
  - base 版本没有 state 修复工具，也**禁止手工编辑 state.json** 拼回一个"看起来对"的文件——半对的 state 比损坏的 state 更难排查。
  - 重建的唯一受支持路径是让 tower 自己写 state：把损坏文件移出 `.dsh-tower/`（保留备份），`tower({action:"init"})` 建立全新 state，再用**同 id** 逐个 `add`——满足收编条件的分支/worktree 会被 `mission-artifacts-reconciled` 重新登记；已合并过的 mission 收编后状态为 `pending`，将其 `abandon`（其提交已在 base 中，无需重做）或按需重走审查。独有提交的分支不会被收编，按 3.10 人工处置。
  - 此流程属于灾难恢复，执行前与仓库 owner 确认，全程对照第一步的 git 事实清单。
- 何时不应重试：损坏原因未查明（例如磁盘满、并发写入）之前不要急着重建，否则新 state 可能再次损坏；注意 `lib/store.js` 的写入是临时文件 + 原子 rename，正常单控制器使用不应产生语法损坏——若反复出现，先排查是否存在双进程控制（见 §5 禁令 2）。

## 4. Merge gate block code 速查表

block 由 `lib/core.js` `TowerCore.evaluateMergeGate` 产生；`message`/`entries`/`files` 字段给出细节。按「先修 base 环境，再修 mission 工件，再修审查绑定」的顺序排查通常最快。

| code | 含义 | 修复动作 |
|---|---|---|
| `NOT_APPROVED` | mission 状态不是 `approved`/`merge_blocked`，没有可合并的 clean 审查 | 走完 worker → reviewer 流程；返工则重派 worker（3.7） |
| `DEPENDENCIES_NOT_MERGED` | `depends_on` 中有 mission 未达终态 | 先推进/合并（或 `abandon`）依赖 mission |
| `WORKTREE_REMOVED` | mission 的 worktree 已被 teardown 移除 | 终局状态：worktree 没了无法再合并；如仍需要该改动，新开 mission |
| `BASE_DIRTY` | 主工作区有未提交/未跟踪文件（附 `entries`） | 在主工作区提交或清理；**不要**为了过 gate 把无关改动混进 base |
| `BASE_MISMATCH` | 主工作区检出的不是 `state.baseBranch`（含 detached HEAD） | 检出 base 分支再 merge |
| `WORKTREE_DIRTY` | mission worktree 有未提交/未跟踪文件（附 `entries`） | 派 worker 收尾（commit 或清理，3.7） |
| `NO_CHANGE` | mission tip 与当前 base 相同 | 无可合并内容：要么 worker 实际没提交（重派），要么成果已被合入（对照 3.4） |
| `STALE_BASE` | 当前 base 不是 mission tip 的祖先 | `tower({action:"rebase"})`，冲突则走 3.1；变基后必须重新审查 |
| `NO_CLEAN_REVIEW` | 没有 verdict=clean 且 merge=true 的审查记录（或 review 被清空） | `spawn` reviewer 获得有效审查 |
| `REVIEW_TIP_STALE` | 审查绑定的 tip ≠ 当前 tip（审查后又出现提交） | 对新 tip 重新 `spawn` reviewer（3.6） |
| `REVIEW_BASE_STALE` | 审查绑定的 base ≠ 当前 base（审查后 base 前进） | `rebase` 后重新审查（3.6） |
| `OUT_OF_SCOPE` | 变更触及 scope 之外的文件（附 `files`） | 派 worker 把越界改动撤回/移入合规路径；确属任务必需则用 `edit` 扩 scope（仅 `pending` 可改——已派生的 mission 只能让 worker 收敛改动） |
| （非 block）`alreadyMerged:true` | 被审 SHA 已在 base 且仍等于 mission tip | 不是故障：直接 `merge` 走记账式对账（3.4） |

## 5. 风险与禁令

1. **禁止手工编辑 `.dsh-tower/state.json`。** `lib/store.js` 的 `TowerStore` 是唯一写入方（校验 + 原子替换）。手工拼 state 会绕过所有一致性检查，制造出工具永远无法推导的僵尸状态；损坏走 3.11。
2. **禁止两个 Host 进程同时充当同一仓库的控制器。** 归属仲裁（`lib/runtime.js` `claimWorkspace`，`WORKSPACE_BUSY`）与 store 的串行队列都是**单进程内**的机制，不是跨进程 Git 锁（README "Deliberate limits" 明示）。双进程并发会产生真正的写写竞态。
3. **不要在 dirty base 上 merge。** gate 的 `BASE_DIRTY` 是保护而非障碍：merge 会移动 base 分支，脏主工作区会让后果不可逆。先提交或清理主工作区。
4. **不要绕过 gate 手工 `git merge` mission 分支。** 绕过会破坏「审查绑定精确 SHA」的对账模型（`alreadyMerged` 判定、merge 记账、依赖解锁全部依赖它）。需要紧急合入时，也先让 tower 完成 gate → merge；事后对账按 3.4。
5. **reviewer 的只读是约定不是沙箱。** 任务简报要求 reviewer 只读（`lib/runtime.js` `reviewerBrief`），但没有进程级隔离；不要把敏感仓库的审查交给不受信路由（配合 `allowedModels` 收紧）。
6. **不要手工删除 worktree 目录或 `tower/*` 分支来"清理"。** teardown 的保守判定（注册、终态、干净、路径前缀校验）就是为了安全清理；手工删除会把 state 与 git 事实撕开，制造 3.10 的孤儿场景。唯一例外见 3.10 的独有提交分支人工处置。
7. **不要在 mission 中途切换/重置 base 分支。** tower 锚定 init 时的 base 分支（`BASE_CONFLICT`）；中途换 base 等于让所有审查绑定与依赖图失效。

## 附录 A：只读诊断命令清单

与 `lib/git.js` 各 helper 的探测逻辑一一对应（`status`/`currentBranch`/`isAncestor`/`changedFiles`/`rebaseInProgress`，以及 `lib/core.js` `recoverMergeFailure` 对 `MERGE_HEAD` 的探测）：

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
```

## 附录 B：`state.events` 事件类型（`lib/core.js` `appendEvent`）

`status` 返回最近 20 条，按时间排序，用于还原「最后一次成功落账到哪一步」：

| 事件 | 触发 |
|---|---|
| `initialized` | `init` 建立新 state |
| `mission-added` / `mission-edited` | `add` / `edit` |
| `mission-artifacts-reconciled` | `add` 重试收编既有分支/worktree（3.10） |
| `spawn-started` / `spawn-attached` / `spawn-failed` / `spawn-completed` | 子代理生命周期（`spawn-completed` 带 mission 落定状态） |
| `activation-recovered` | `recover` 标记僵尸激活（3.8） |
| `mission-rebased` / `rebase-failed` | `rebase` 成功 / 失败（3.1，失败带 `recoveryRequired`） |
| `mission-merged` | merge 成功落账 |
| `mission-merge-reconciled` | alreadyMerged 记账式对账（3.4） |
| `mission-merge-advanced` | 合并成功但 tip 超过被审 SHA（2.7 表） |
| `merge-failed` | git merge 失败（3.2，带 `recoveryRequired`） |
| `merge-accounting-required` / `merge-verification-failed` | 合并后核对/落账失败（3.3） |
| `mission-abandoned` | `abandon` |
| `worktree-removed` / `worktree-remove-reconciled` | `teardown` 移除 / 对账补记（3.9） |

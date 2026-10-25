# dsh-tower-enhanced

[English](README.md) | 简体中文

面向 DeepSeek Harness 的实验性 **Tower-lite** 组合包。它添加了一个 `tower` 控制器工具，提供隔离的 Git worktree、worker/reviewer 子代理、精确 SHA 的审查绑定、合并门禁，以及按 spawn 独立指定的模型路由。

这是一个独立维护的原型，不是 Kimi Tower，也不是 DeepSeek 官方组合包。

## 特性

- 每个任务（mission）在 `.dsh-tower/` 下拥有一个独立分支和 worktree。
- Tower 归属跟随工作区（与 Kimi Code 相同）：任何 Session 都可以接管某个仓库的 Tower；只有当另一个 Session 正持有它时（一次调用进行中，或它启动的 worker/reviewer 仍在运行），第二个 Session 才会被拒绝。没有根/叶 Session 规则。
- 通过 DSH 进程内 `spawn` provider 运行后台 worker 与结构化的独立 review。
- 每次 spawn 可选指定 `provider + model + reasoning_effort + max_tokens`；可配置按角色的默认路由和精确路由白名单。
- 会话头部弹层与右侧边栏 **Tower** 标签页共用同一套 UI。**本会话** 只显示当前控制器创建的真实子会话。在 worker/reviewer 会话中只显示该 agent 自己的记录：reviewer 不会因为与某个 worker 同属一个任务而获得该 worker 的记录。**工作区** 显式列出所有已记录的 agent，并标明其来源控制器。
- 每个真实子会话只出现一次，按其记录的角色（`Work` 或 `Review`）分组。缺失的子会话不会产生 agent 行或角色占位符。只有 review 的视图没有 Work 分组，反之亦然。尚未创建子会话的工作区任务会与 agent 分开列出。
- 卡片显示任务、角色、结果、耗时，以及启动时记录的 provider/model/reasoning effort，绝不替代主会话的模型选择器。点击卡片会打开其原生 `subagentchat` 会话记录；**任务与结果** 可展开记录的输出、review 检查项、分支与提交信息。失败、被中断、过期（stale）与 changes-requested 的结果和正常完成始终保持可区分。筛选器可以选择全部、运行中或需要关注的 agent。
- 聊天链接与会话成员关系依次使用宿主的子会话目录、列出的谱系、spawn 时记录的控制器，绝不会从面板当前 Session 猜测未知归属。视图使用同一仓库最新可用的投影；这些是已记录的 Tower 激活，不是子会话内部后续每次模型变更的实时流。
- `edit` 可按与 `add` 相同的校验规则修正 pending 任务的标题、描述、scope 与依赖。`summary` 提供只读的紧凑概览，包含全局计数与每个任务一行的条目；可选 `mission_id` 只收窄条目，不改变全局计数。
- reviewer 启动或运行失败会进入显式且可重试的 `review_failed` 状态：可以重新 spawn reviewer，也可以直接另派 worker 返工。每个落定的 worker/reviewer 都会向控制器发送结果通知；失败时附带截断的原因与下一步操作，即使状态记录或投影发布失败也仍会发送通知。
- 宿主重启后，持久化的运行中激活会主动触发僵尸告警。在确认旧控制器已停止并显式调用 `recover` 将其标记为中断之前，这些记录会阻塞新工作；恢复过程绝不接管旧进程。
- pending 任务首次启动 worker 前，会把尚未改动且干净的 worktree 快进到当前 base。本地改动、被忽略文件的覆盖冲突或分叉提交会阻止刷新，而不会被覆盖。
- review 证据同时绑定当前的 base SHA 与被审查的 tip SHA。任何 rebase 或相关移动都需要重新审查；即使任务 tip 没变，只要 base 变化，旧 verdict 也会失效。
- merge 会检查依赖、scope、干净的 worktree、检出的 base、当前 base 的祖先关系与 review 绑定。merge 消费被审查的精确 SHA 并验证结果。
- 保守的 teardown：只移除已合并或已放弃任务中干净且已注册的 worktree；分支与状态会保留。
- 仓库脚本提供只读的状态/Git 诊断与带前置检查的本地发布准备；见[诊断与发布](#诊断与发布)。

## 安装

组合包没有构建步骤，需要 Node 22.5+ 与 DSH 0.2.1-rc.2。

请将下面的路径替换为源码仓库的实际绝对路径：

```bash
dsh plugin --profile web add file:/absolute/path/to/dsh-tower-enhanced
```

也可以在 DSH Web/Desktop UI 的 **Plugins** 中安装本地目录。根据宿主的 HMR 状态，激活可能需要重启或开启新会话。组合包包含 Web 客户端；安装或升级后请刷新现有 GUI。在已运行过控制器的会话中，打开会话头部的 **Tower** 按钮或右侧边栏起始页的 **Tower** 入口。两个视图均为只读，只有在控制器发布首个状态之后才显示模型路由。点击某个 agent 可在侧边栏加载其会话；`全部展开` / `全部收起` 用于管理角色分组。切换到 **工作区** 可以查看更早控制器创建的 agent。

`file:` 安装可能生成源码快照，而不是指向仓库的实时链接。源码合并不代表已安装的插件同步更新。升级验收前，应先结束活跃任务，通过宿主的插件流程更新安装包，并比对安装副本的 `lib/core.js`、`lib/runtime.js`、`lib/store.js` 与目标源码；然后重启或重载宿主、刷新 GUI，在临时仓库实测变更行为。仅重启无法更新磁盘上过期的安装副本。

组合包会组合 `subagents`、`workingDirectory`、`llm` 与 `tools`；DSH 常规基础包已经提供它们。

## 快速开始

一个最小的闭环：初始化 tower，添加任务，运行一个 worker 和一个 reviewer，然后 gate、merge 并拆除 worktree。下面每一行都是控制器 Session 的一次 `tower` 工具调用，前提是仓库的 base 分支已检出且主 worktree 干净：

```text
tower({action:"init"})
tower({action:"add", id:"M1", title:"Docs pass", description:"Proofread the README and commit.", scope:["README.md"]})
tower({action:"spawn", mission_id:"M1", role:"worker", provider:"zai-coding-cn", model:"glm-5.3"})
tower({action:"status", mission_id:"M1"})            // 等待 worker_completed（worker 必须先提交）
tower({action:"spawn", mission_id:"M1", role:"reviewer", provider:"zai-coding-cn", model:"glm-5.3-flash"})
tower({action:"gate", mission_id:"M1"})              // merge 之前必须 approved
tower({action:"merge", mission_id:"M1"})
tower({action:"teardown", mission_id:"M1"})
```

说明：

- 示例把 worker 路由到 `zai-coding-cn`/`glm-5.3`，把 reviewer 路由到更轻量的 `zai-coding-cn`/`glm-5.3-flash`。任何宿主能解析的 provider/model 组合都可用，包括在两个角色之间混用不同的 provider。
- `gate` 会解释是什么在阻塞 merge；`changes_requested` 结论需要再跑一轮 worker 并获得新的 review 之后才能 `merge`。
- `merge` 消费被审查的精确 SHA；随后的 `teardown` 只移除干净且已注册的 worktree——任务分支和状态会保留。

## 配置

默认组合包补丁：

```yaml
- insert:
    - id: tower-enhanced
      name: dsh-tower-enhanced
      config:
        provider: spawn
        stateDirectory: .dsh-tower
        branchPrefix: tower
```

- `provider` 默认 `spawn`（DSH 进程内子代理 provider）。
- 状态保存在 `<stateDirectory>/state.json`；每个任务的分支是 `<branchPrefix>/<id 小写>`，worktree 是 `<stateDirectory>/worktrees/<id 小写>`。初始化会把状态目录写入 `.git/info/exclude` 的本地排除，不会改动任何 tracked 文件。

可选的模型策略：

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

路由就是普通的 LLM 适配器路由，因此每个角色可以混用不同的 provider。任何宿主能解析的路由都可用，例如一个纯文本 worker 搭配另一个 provider 的视觉 reviewer：

```yaml
config:
  workerAgentOptions:
    provider: zai-coding-cn
    model: glm-5.3
  reviewerAgentOptions:
    provider: zai-coding-cn
    model: glm-5.3-flash
```

同样的取值也可以按 spawn 传入：`tower({action:"spawn", mission_id:"M1", role:"worker", provider:"...", model:"...", reasoning_effort:"...", max_tokens:...})`。注意 `provider` 与 `model` 必须成对提供，`max_tokens` 必须是正整数。

`allowedModels` 是可选的。存在时，每一组显式/默认的路由覆盖都必须解析为其中某个精确的 provider/model 对；不存在时，路由直接交给 LLM 适配器校验，没有额外的白名单。如果没有角色默认值，也没有按 spawn 的覆盖，子代理会继承控制器的路由。

## 工具流程

可用的 action：`init`、`add`、`edit`、`spawn`、`recover`、`send`、`interrupt`、`status`、`summary`、`gate`、`merge`、`rebase`、`abandon`、`teardown`、`models`。

1. 把 Session 的工作目录切换到目标仓库（`working_directory` 支持 `cd`），检出本地 base 分支，并确保主 worktree 干净。
2. `tower({action:"init"})`。
3. 用完整的描述添加任务，可选 `depends_on`/`scope`。`scope` 必须是仓库相对 glob 字符串的数组；创建时省略或传 `[]` 表示不限制范围，显式 `null`、字符串及其他非数组值均会被拒绝。pattern 保留空白字面量，包括文件名首尾的空格。`edit` 时省略 scope 保持原限制，传 `[]` 才会清除限制。
4. `spawn` 一个 worker。pending 任务首次启动前，会把尚未改动且干净的 worktree 快进到当前 base，确保已合并的依赖文件可用。如果存在本地改动、被忽略文件的覆盖冲突或分叉提交，会拒绝刷新而非覆盖数据；应保留本地文件，对分叉的工作显式执行 `rebase`。worker 结束前必须提交。重新启动已有 worker 不会自动 rebase 它的工作树。
5. 任务变为 `worker_completed` 后，`spawn` 一个 reviewer。reviewer 返回结构化的结论（`clean` 或 `changes_requested`，附 merge 建议）；如果 review 失败（限流、崩溃或没有结构化结论），任务会进入 `review_failed` —— 可以重新 spawn reviewer，也可以直接另派 worker 返工。
6. `status`/`gate` 检查状态。`approved` 的任务可以合并；`changes_requested` 需要再跑一轮 worker；`review_failed` 既非运行中也非终态，因此既可以从中重新 spawn reviewer，也可以直接重新 spawn worker。
7. 如果 base 发生了移动，先 `rebase`，然后在合并前获得新的 review。即使任务 tip 没变，只要审查绑定的 base 变化，旧 verdict 也会失效，`reviewRequired` 同样会报告需要重审。
8. `merge` 会评估门禁并合并被审查的精确 SHA。`teardown` 稍后只移除符合条件的 worktree。

`send` 与 `interrupt` 面向当前活跃的 worker/reviewer。`models` 列出某个 provider 的模型目录，或解析一条精确路由，并在可用时附带 reasoning 元数据。重启之后，持久化的 `worker_running`/`review_running` 记录会故意阻塞新工作，直到控制器显式确认旧运行时已停止并调用 `recover`；这会把过期激活记为 interrupted，而不会接管它们的进程。

## 失败恢复

- 失败一定会通知控制器：每个结束的 worker/reviewer 都会向控制器 Session steer 一条形如 `Tower <role> for <mission> <outcome>: mission status <status>` 的通知；失败/被中断/过期（stale）的结果会附带截断到 500 字符以内的 `reason`（来自记录的 error 或 diagnostic）以及下一步操作提示 —— 即使状态记录或投影发布失败，通知也仍会发出（最坏情况下退化为一条包含 role、mission、run 与错误文本的兜底通知）。
- review 失败是显式状态：reviewer 出错、没有返回结构化结论、或根本没有启动成功时，任务进入 `review_failed`（记录 `error`、`stopReason`、`completedAt`，并写入 `spawn-failed` 事件），而不会再退回难以区分的 `worker_completed`。可以从中重新 spawn reviewer，或直接另派 worker 返工；在干净的 review 批准之前，合并门禁会给出 `NOT_APPROVED`。
- 面板把审查失败与运行中、审查通过区分开，并显示重试建议；过期审查证据优先于旧结论。agent 卡片和任务角色行以纯文本显示错误，最多 500 个 Unicode 码点（含省略号），展开结果仍保留记录的原始输出。没有创建子会话的启动失败会显示在任务视图中，不会虚构 agent，也不会一直显示“正在创建子代理会话”。
- 宿主进程重启后，运行时会从 agent 的当前工作目录定位 Git 仓库根，包括会话曾切换目录或停在仓库子目录的情况。对持久化的 `worker_running`/`review_running` 激活，向所属控制器主动 steer 一次僵尸告警（列出 mission/role/启动时间），提示执行 `tower action=recover`。仅在工作目录服务不可用时，才回退到会话创建时的目录。
- `node scripts/tower-doctor.mjs --repo <路径>` 执行只读的状态与 Git 诊断。合法的 `review_failed` 任务不属于状态损坏；它的分支与工作树仍然必须存在，并继续接受检查。
- `recover` 是显式的，绝不接管旧进程。确认上一个控制器停止后，它把持久化的运行中激活标记为 interrupted（worker 运行变为 `worker_failed`，reviewer 运行变为 `review_failed`），让新代理可以启动。
- 用相同的任务 id 重试 `add` 只会对分支/worktree 产物完全匹配且没有独立提交的情况做调和。有冲突的产物需要人工检查，绝不会自动删除。
- 当被干净审查过的精确 SHA 已经包含在 base 中、且仍是任务 tip 时，`gate` 会报告 `alreadyMerged`；随后的 `merge` 只做账目调和，不会再次合并。
- `merge` 区分 Git 完成与状态记账，当后续观察或持久化需要关注时返回 `postMerge`/`recoveryRequired`。观察失败时返回 `mergeAttempted: true`、`merged: false`、`verified: false`；只有精确 SHA 验证或后续调和才会产生 `merged: true`。
- 重试 `teardown` 会在记录的路径既不在磁盘上、也不在 Git 已注册 worktree 中时，调和一个已终结的任务。已存在的意外路径永远不会被移除。
- 状态先写入同目录临时文件，成功后才替换目标。写入或重命名失败时，只尝试清理本次写入的临时文件并原样抛出原错误，不删除无关临时文件或现有目标。文件系统或权限异常可能导致清理也失败；这项清理不会回滚此前已经执行的 Git 操作。

## 诊断与发布

在源码仓库中运行以下脚本：

```bash
node scripts/tower-doctor.mjs [--repo <路径>] [--json]
node scripts/release.mjs --version <semver> [--date <YYYY-MM-DD>]
node scripts/release.mjs --version <semver> --apply
```

- `scripts/tower-doctor.mjs` 对账 Tower 状态与仓库、worktree 的实际事实，不修改状态或 Git。退出码为 `0`（全部检查通过）、`1`（有 warning）或 `2`（有 error 或参数用法错误）；`--json` 输出机器可读的 findings 与汇总。
- `scripts/release.mjs` 默认执行不写入文件的 dry-run，只打印计划 diff。`--apply` 会在写入前校验版本、日期与 changelog，要求 worktree 干净，并以原子方式更新 `package.json` 与 `CHANGELOG.md`。它绝不会 commit、tag、push，也不访问网络。

诊断 finding、恢复步骤与脚本详情见[运维手册](docs/operations.md)。

## 刻意限制

- 实验性的单进程控制器：归属按仓库在单个 Host 进程内强制执行（一次进行中的调用或 worker/reviewer 激活会阻塞其他 Session），但操作队列不是跨进程的 Git 锁。不要让两个 Host 进程同时对同一仓库状态充当控制器。
- reviewer 的只读行为目前是指令约束，不是受限预设的安全边界。worktree 靠约定隔离写入，并没有沙箱化。
- UI 刻意保持小：一个头部弹层加一个右侧边栏标签页。没有 slash 模式注入、WIP 快照提交、问卷、PR 模式、跨会话接管、自动依赖推断，或干净 rebase 的审查豁免。
- worker 结束时 worktree 脏、或没有结构化 review 的任务，无法通过合并门禁。
- Git 失败可能留下待检查的产物。当 `merge` 的清理无法证明 base 已干净恢复时，会报告 `recoveryRequired`；请人工检查，而不是盲目重试。

## 开发与测试

```bash
pnpm test
pnpm run check
```

测试使用真实的临时 Git 仓库，只 mock 面向 DSH 的运行时边界。CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)）会在每次 push 和 pull request 上安装依赖并运行这两条命令。

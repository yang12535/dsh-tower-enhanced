# dsh-tower-enhanced

[English](README.md) | 简体中文

面向 DeepSeek Harness 的实验性 **Tower-lite** 组合包。它添加了一个 `tower` 控制器工具，提供隔离的 Git worktree、worker/reviewer 子代理、精确 SHA 的审查绑定、合并门禁，以及按 spawn 独立指定的模型路由。

这是一个独立维护的原型，不是 Kimi Tower，也不是 DeepSeek 官方组合包。

## 特性

- 每个任务（mission）在 `.dsh-tower/` 下拥有一个独立分支和 worktree。
- Tower 归属跟随工作区（与 Kimi Code 相同）：任何 Session 都可以接管某个仓库的 Tower；只有当另一个 Session 正持有它时（一次调用进行中，或它启动的 worker/reviewer 仍在运行），第二个 Session 才会被拒绝。没有根/叶 Session 规则。
- 通过 DSH 进程内 `spawn` provider 运行后台 worker 与结构化的独立 review。
- 每次 spawn 可选指定 `provider + model + reasoning_effort + max_tokens`；可配置按角色的默认路由和精确路由白名单。
- 面板位于右侧边栏的 **Tower** 标签页；会话头部的 **Tower** 按钮直接打开它（已打开则切换过去），不再另弹浮层。面板是一个任务一行的列表。顶部的状态芯片（全部 / 进行中 / 待处理 / 已合并 / 已放弃，空的类别自动隐藏）同时是筛选器；进行中与待处理的任务排在最前，下面是**模型用量**排行，最后是可折叠的**历史**。待处理的行直接显示下一步。默认列出整个工作区；勾选 **只看本会话** 只保留含有当前控制器子会话的任务。在 worker/reviewer 会话中只显示该 agent 自己的记录并默认展开：reviewer 不会因为与某个 worker 同属一个任务而获得该 worker 的记录。
- 展开一行可看到依赖、可合并阶段的门禁摘要、执行与审查两行（状态、启动时记录的 provider/model/reasoning effort、耗时、宿主列出时的子会话 token 用量、续接标记、**对话** 链接）、合并提交，以及 **详情**（任务说明、分支、提交、续接来源、记录的输出与 review 检查项）。显示的模型绝不替代主会话的模型选择器。失败、被中断、过期（stale）与 changes-requested 的结果和正常完成始终保持可区分。缺失的子会话不会产生对话链接或用量。
- **模型用量** 按 provider/model 汇总真实子会话：左边是该模型跑过的 Tower 会话次数，中间是按 token 排行的条形，右边是 token 用量（取自宿主为每个子会话列出的 `tokenUsage`；全部未加载时条形改按次数排行，并注明未加载的会话数）。
- 聊天链接与会话成员关系依次使用宿主的子会话目录、列出的谱系、spawn 时记录的控制器，绝不会从面板当前 Session 猜测未知归属。视图使用同一仓库最新可用的投影；这些是已记录的 Tower 激活，不是子会话内部后续每次模型变更的实时流。
- `edit` 可按与 `add` 相同的校验规则修正 pending 任务的标题、描述、scope 与依赖。`summary` 提供只读的紧凑概览，包含全局计数与每个任务一行的条目；可选 `mission_id` 只收窄条目，不改变全局计数。
- reviewer 启动或运行失败会进入显式且可重试的 `review_failed` 状态：可以重新 spawn reviewer，也可以直接另派 worker 返工。每个落定的 worker/reviewer 都会生成结果通知并尝试投递给控制器（首行结果概要、随后下一步操作——run 完全无法落账时 Next 之前另有一行 run 诊断——物理末行报告实际 `stopReason`，缺失记 `unknown`；失败/被中断/过期的结局在同一行附带截断到 500 字符的原因），即使状态记录或投影发布失败也仍会尝试投递；投递本身失败仅记 error 日志，不做重试。
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

也可以在 DSH Web/Desktop UI 的 **Plugins** 中安装本地目录。根据宿主的 HMR 状态，激活可能需要重启或开启新会话。组合包包含 Web 客户端；安装或升级后请刷新现有 GUI。在已运行过控制器的会话中，点会话头部的 **Tower** 按钮或右侧边栏起始页的 **Tower** 入口，都会打开同一个右侧边栏标签页。面板只读，只有在控制器发布首个状态之后才显示模型路由。点击一行展开，用 **对话** 在侧边栏加载对应子会话；**只看本会话** 收窄到当前控制器创建的子会话，取消勾选即可查看更早控制器创建的任务。

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

同样的取值也可以按 spawn 传入：`tower({action:"spawn", mission_id:"M1", role:"worker", provider:"...", model:"...", reasoning_effort:"...", max_tokens:...})`。注意 `provider` 与 `model` 必须成对提供，`max_tokens` 必须是正的安全整数。

`allowedModels` 是可选的。存在时，每一组显式/默认的路由覆盖都必须解析为其中某个精确的 provider/model 对；不存在时，路由直接交给 LLM 适配器校验，没有额外的白名单。如果没有角色默认值，也没有按 spawn 的覆盖，子代理会继承控制器的路由。

## 工具流程

可用的 action：`init`、`add`、`edit`、`spawn`、`recover`、`resume`、`send`、`interrupt`、`status`、`summary`、`gate`、`merge`、`rebase`、`abandon`、`teardown`、`models`。

1. 把 Session 的工作目录切换到目标仓库（`working_directory` 支持 `cd`），检出本地 base 分支，并确保主 worktree 干净。
2. `tower({action:"init"})`。
3. 用完整的描述添加任务，可选 `depends_on`/`scope`。`scope` 必须是仓库相对 glob 字符串的数组；创建时省略或传 `[]` 表示不限制范围，显式 `null`、字符串及其他非数组值均会被拒绝。pattern 保留空白字面量，包括文件名首尾的空格。`edit` 时省略 scope 保持原限制，传 `[]` 才会清除限制。
4. `spawn` 一个 worker。pending 任务首次启动前，会把尚未改动且干净的 worktree 快进到当前 base，确保已合并的依赖文件可用。如果存在本地改动、被忽略文件的覆盖冲突或分叉提交，会拒绝刷新而非覆盖数据；应保留本地文件，对分叉的工作显式执行 `rebase`。worker 结束前必须提交。重新启动已有 worker 不会自动 rebase 它的工作树。
5. 任务变为 `worker_completed` 后，`spawn` 一个 reviewer。reviewer 返回结构化的结论（`clean` 或 `changes_requested`，附 merge 建议）；如果 review 失败（限流、崩溃或没有结构化结论），任务会进入 `review_failed` —— 可以重新 spawn reviewer，也可以直接另派 worker 返工。
6. `status`/`gate` 检查状态。`approved` 的任务可以合并；`changes_requested` 需要再跑一轮 worker；`review_failed` 既非运行中也非终态，因此既可以从中重新 spawn reviewer，也可以直接重新 spawn worker。
7. 如果 base 发生了移动，先 `rebase`，然后在合并前获得新的 review。即使任务 tip 没变，只要审查绑定的 base 变化，旧 verdict 也会失效，`reviewRequired` 同样会报告需要重审。
8. `merge` 会评估门禁并合并被审查的精确 SHA。`teardown` 稍后只移除符合条件的 worktree。

`send` 与 `interrupt` 面向当前活跃的 worker/reviewer。`resume` 把已落定一轮 run 的原 worker/reviewer **原地续接**——通过宿主 `sendMessage` 冷恢复原 child 会话，保留其上下文、descriptor、provider/model/effort 路由与 cwd（拒绝任何路由覆盖；要换路由请重新 spawn）。续接作为全新的 Tower run 跟踪，并先写日志再投递（WAL）：`resumeFrom`（原 runId、childId、会话偏移、以及本次投递 prompt 的 SHA-256 指纹——prompt 原文绝不入 state）在恢复消息发出前就已持久化，因此任何崩溃都只会留下可解释的 run 记录。落定对账 fail-closed：只有绑定到本轮 `subagent/start` 的宿主 run epoch 才能产出结果；被续接的 reviewer 必须以单一 JSON 对象（裸对象或仅一个 ```json 围栏）作答，且对审查 schema 零违规，否则一律 `review_failed`，绝不产生批准。冷恢复不会还原原激活的 `outputSchema` 捕获与 per-activation `max_tokens`。活跃中的 mission 一律 `AGENT_BUSY`（先 `interrupt` 或 `recover`）；`recover` 仍只把过期 run 标记为 interrupted，绝不接管旧执行。`models` 列出某个 provider 的模型目录，或解析一条精确路由，并在可用时附带 reasoning 元数据。重启之后，持久化的 `worker_running`/`review_running` 记录会故意阻塞新工作，直到控制器显式确认旧运行时已停止并调用 `recover`；这会把过期激活记为 interrupted，而不会接管它们的进程。

## 失败恢复

- 失败一定会产生通知，投递是尽力而为、不构成端到端保证：每个结束的 worker/reviewer 都会生成一条通知并尝试 steer 给控制器 Session，常规形态是首行 `Tower <role> for <mission> <outcome>: mission status <status>`、随后是下一步操作行；run 完全无法落账时，Next 之前另有一行 `run <runId> could not be recorded in Tower state` 诊断。无论哪种形态，物理末行固定是 `stopReason: <实际值>`；`failed`（失败）/`interrupted`（被中断）/`stale`（过期）结局在同一行追加 `; reason: <有界原因>`（来自记录的 error 或 diagnostic，最多 500 字符）。stopReason 缺失时末行报告 `unknown`；stopReason 与 reason 内部的换行和连续空白都会折叠成一个空格，末行始终是一行。若模型本身已完成、只是 state 落账失败，末行 stopReason 仍保留 `completed`、把落账错误放进 reason，不会把完成伪写成 error——即使状态记录或投影发布失败，这次尝试也仍会进行（最坏情况下退化为一条包含 role、mission、run 与错误文本的兜底通知）。steer 本身也可能失败，届时仅记 error 日志、没有持久重试；未收到通知时用 `tower action=status` 与日志兜底核对。
- review 失败是显式状态：reviewer 出错、没有返回结构化结论、或根本没有启动成功时，任务进入 `review_failed`（记录 `error`、`stopReason`、`completedAt`，并写入 `spawn-failed` 事件），而不会再退回难以区分的 `worker_completed`。可以从中重新 spawn reviewer，或直接另派 worker 返工；在干净的 review 批准之前，合并门禁会给出 `NOT_APPROVED`。
- 面板把审查失败与运行中、审查通过区分开，并显示重试建议；过期审查证据优先于旧结论。任务的角色行以纯文本显示错误，最多 500 个 Unicode 码点（含省略号），详情仍保留记录的原始输出。没有创建子会话的启动失败会显示在任务行中，不会虚构对话链接，也不会一直显示“正在创建会话”。
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
node scripts/tower-doctor.mjs [--repo <路径>] [--json] [--fail-on-warning]
node scripts/release.mjs --version <semver> [--date <YYYY-MM-DD>]
node scripts/release.mjs --version <semver> --apply
```

- `scripts/tower-doctor.mjs` 对账 Tower 状态与仓库、worktree 的实际事实，不修改状态或 Git。退出码为 `0`（全部检查通过）、`1`（有 warning）或 `2`（有 error 或参数用法错误）；`--fail-on-warning` 会把仅有 warning 的运行升级为退出码 `2`（clean 仍为 `0`，error 仍为 `2`），默认行为不变，用于发布检查 / CI 严格守门。`--json` 输出机器可读的 findings 与汇总，仅在同时给出 `--fail-on-warning` 时才额外携带 `failOnWarning: true`。
- `scripts/release.mjs` 默认执行不写入文件的 dry-run，只打印计划 diff。`--apply` 会在写入前校验版本、日期与 changelog，要求 worktree 干净，并以原子方式更新 `package.json` 与 `CHANGELOG.md`。它绝不会 commit、tag、push，也不访问网络。

诊断 finding、恢复步骤与脚本详情见[运维手册](docs/operations.md)。

## 刻意限制

- 实验性的单进程控制器：归属按仓库在单个 Host 进程内强制执行（一次进行中的调用或 worker/reviewer 激活会阻塞其他 Session），但操作队列不是跨进程的 Git 锁。不要让两个 Host 进程同时对同一仓库状态充当控制器。
- reviewer 的只读行为目前是指令约束，不是受限预设的安全边界。worktree 靠约定隔离写入，并没有沙箱化。
- UI 刻意保持小：一个右侧边栏标签页，加一个打开它的头部按钮。没有 slash 模式注入、WIP 快照提交、问卷、PR 模式、跨会话接管、自动依赖推断，或干净 rebase 的审查豁免。
- worker 结束时 worktree 脏、或没有结构化 review 的任务，无法通过合并门禁。
- Git 失败可能留下待检查的产物。当 `merge` 的清理无法证明 base 已干净恢复时，会报告 `recoveryRequired`；请人工检查，而不是盲目重试。

## 开发与测试

```bash
pnpm test
pnpm run check
```

测试使用真实的临时 Git 仓库，只 mock 面向 DSH 的运行时边界。CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)）会在每次 push 和 pull request 上安装依赖并运行这两条命令。

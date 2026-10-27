# M83：Tower 原会话续接（GPT-6a 交接说明）

> 这份文件是给后续接手者的实现约束，不是完成报告。M83 尚未通过审查，也尚未合并。请保留现有 worktree，按下面的缺陷清单继续，不要把当前实现当成正确版本直接提交。

## 1. 当前断点

- 编写时主线基线：`072ec3f37ebdca40044ba378c41ddb1bcd949221`（M82 已合并）。
- M83 分支/worktree：`.dsh-tower/worktrees/m83`，分支 `tower/m83`。
- 当前 M83 是 `worker_failed / stopReason: aborted`，没有新提交；worktree 保留未提交实现：
  - `lib/core.js`：约 +65 行；
  - `lib/runtime.js`：约 +293 行。
- 不要 `git reset --hard`、`git checkout -- .` 或 `git clean -fd`，这些改动是后续工作的起点。
- 主线最后一次完整验证为 **505/505**；M83 本身尚未跑完整测试，不能宣称全绿。
- 本文提交后 `main` 会前进。M83 有未提交改动时不要强行 rebase；先保留并理解 diff，完成必要修正和提交后再按 Tower 规则 rebase/review。

## 2. 用户真正要的功能

用户要的是 **原 subagent 原样恢复并继续执行**，不是只保留 worktree 后新建一个失忆代理，也不是只向旧 child 发消息而不跟踪结果。

目标动作：`tower({action:"resume", mission_id:"...", role:"worker|reviewer", instructions:"..."})`。

已验证的宿主事实：

- `subagents.startActivation({childId})` 会对已有 child 查重，不能直接用于恢复。
- `subagents.sendMessage(parent, childId, content, {signal})` 在 direct child 不在 resident 时走 `coldResume`，恢复原 Session、descriptor、provider/model/effort、cwd 和 composition。
- `subagent/start` / `subagent/end` 提供 host runId、child id、stopReason 和 lastAssistantMessage。
- `sessionQuery.observeSession` 可以读取指定偏移之后的新事件；`outputSchema` 和上轮 maxTokens 不会随 coldResume 自动恢复。
- 不要修改 DSH 安装目录、全局配置或会话日志；在本插件内完成纳管。

## 3. 必须先修正的已知缺陷

以下行号以交接时的 M83 worktree 为准，后续编辑后以实际代码为准。

### 3.1 JSON 校验会把非法 verdict 放行

`lib/runtime.js` 当前 `parseStructuredReview`（约第 223 行）调用：

```js
validateJsonSchemaValue(REVIEW_OUTPUT_SCHEMA, candidate);
return candidate;
```

这是错的：`validateJsonSchemaValue` **返回违规数组，不是对非法数据抛异常**。必须类似：

```js
const violations = validateJsonSchemaValue(REVIEW_OUTPUT_SCHEMA, candidate);
if (violations.length === 0) return candidate;
```

额外字段、缺 required 字段、错误 enum 都必须进入 `review_failed`，绝不能假 clean/批准。

### 3.2 不能用旧 epoch 的 `subagent/end` 结算

当前 `resumeActivation`（约第 527 行）存在：

```js
if (hostRunId === undefined && !sendAccepted) return;
```

这会在 `sendAccepted=true` 后接受任意 child 的 end，包括可能属于旧 epoch 的结果。恢复后必须绑定本轮 `subagent/start` 的 hostRunId；没有可靠绑定时不得猜测或批准。冷恢复若未观察到本轮 start，应确定失败/中断并清理，而不是接受下一条旧 end。

两轮 resume 的 stopReason、diagnostic、输出和 review verdict 都不能串轮。

### 3.3 reviewer prompt 不能使用旧 base/tip

当前 resume prompt 在 `beginSpawn` 之前生成，可能沿用旧 review binding。正确顺序是：

1. 先 `beginSpawn`，产生本轮新的 `mission.review.baseCommit/reviewedCommit`；
2. 用 `begun.mission.review` 的精确 SHA 生成 resume reviewer prompt；
3. 在 `sendMessage` 前通过 `attachSpawn` 写入 promptHash；
4. 发送恢复消息；
5. 再记录 messageId/hostRunId。

`beginSpawn` 可以暂缺 promptHash，但 **发送前必须落账**，不能让 prompt 在 state 外漂移。普通 `spawn` 的行为不能改变。

### 3.4 活跃 run 的例外不得恢复

之前出现过“previousRunId/childId 相同就允许 active resume”的错误分支，已删除。请保持：

```js
assertTower(!ACTIVE_STATUSES.has(mission.status), 'AGENT_BUSY', ...);
```

普通 spawn 与 resume 都必须拒绝活跃冲突。旧控制器留下的 running 记录必须先 `recover` 标 interrupted，不能用 resume 绕过，避免同一 child 双执行/双纳管。

## 4. 必须保留/完成的正确设计

### WAL（先写日志，再管理执行）

- 在发送恢复消息之前，先记录新 Tower run、`resumeFrom`（原 runId、childId、Session 偏移、prompt 的 SHA-256 指纹）。
- prompt 原文不要写入 Tower state，避免秘密扩散；只存哈希。
- `beginSpawn` 和 `attachSpawn` 的可选 resume 元数据要白名单校验，普通 spawn 不受影响。
- `attachSpawn` 可在发送前记录 promptHash，发送后记录 messageId/hostRunId。

### 恢复与结果

- 使用 `subagents.sendMessage` 冷恢复，不调用 `startActivation`。
- 默认沿用原 descriptor/route；复制 previous role 的 provider/model/reasoningEffort 供统计，不重新解析路由。
- 首版对 provider/model/reasoning_effort/max_tokens 覆盖应明确拒绝，不能静默假装支持。
- 校验 direct parent lineage；父 Session 不对时必须失败，不能跨控制器偷接 child。
- `subagent/start` 关联本轮 hostRunId；`subagent/end` 只结算该 epoch。
- `sessionQuery` 读取偏移后的新事件，取 turn/end diagnostic 和输出。Observation 必须 `[Symbol.dispose]()`。
- 复用现有 `track` / `completeSpawn` / `failSpawn` / publish / settlementNotice。
- send/attach 失败要有 failSpawn 和精确清理；需要时 interrupt，避免恢复出的执行失联。
- activation-compatible `dispose()` 不能只退订：必须让 pending result 以 aborted 落定，否则 `runtime.dispose()` 等 `entry.done` 会悬挂。
- `recover` 仍只标 interrupted，不 adopt 旧进程。

### reviewer 结构化结果

- coldResume 不会自动恢复 `structured_output` capture，因此 resume prompt 要明确要求本轮只返回符合 `REVIEW_OUTPUT_SCHEMA` 的 JSON（可接受仅含 JSON 的 code fence）。
- 从本轮输出取候选后，必须 `validateJsonSchemaValue(...).length === 0` 才能接受。
- 非法/缺失 JSON 走 `review_failed`，不能根据 lastAssistantMessage 猜一个 verdict。
- 新的 resume prompt 必须带 `beginSpawn` 产生的新 base/tip SHA。

### 依赖与文档

- `lib/index.js` 的 action enum 加 `resume`；`sessionQuery` 必须加入 `inject`，否则 Cordis 会拒绝加载。
- 同步 README.md、README.zh-CN.md、docs/architecture.md、docs/operations.md、docs/security-model.md 的 action 列表和 WAL/归属/失败/不 adopt 语义。
- 不改 UI 字典，不新增状态或错误码，不改变普通 spawn/send/recover 的语义。

## 5. 验收要求

至少补齐 `test/resume.test.js` 及以下真实断言：

1. `beginSpawn` 先于 `sendMessage`，resumeFrom/offset/hash 已持久化；发送前 promptHash 也已存在。
2. 使用原 childId，不调用 `startActivation`，不默认替换原路由。
3. start/end hostRunId 对齐；两轮 resume 不串输出、verdict、diagnostic、监听器。
4. worker completed/error diagnostic；reviewer clean 与 changes_requested；额外字段/缺字段/错误 enum/非 JSON 均 review_failed。
5. 活跃冲突（即使 previousRunId/childId 相同）、缺 child、不可恢复、sendMessage 失败、attach 失败清理、controller dispose 不 adopt。
6. 普通 spawn/send/recover 既有测试保持通过。
7. 至少一条真实宿主恢复链验证：使用真实 `SubagentManager.coldResume` 与持久化 Session fixture，可仅将 `materialize`/`submitMaterialized` 做捕获型替身，证明恢复 descriptor/provider/model/effort/composition 与 direct-parent 校验。**不要只用 mock TowerRuntime 就宣称实机恢复成功**；若设施不能复用，必须明确记录缺口。
8. /tmp 反向变异：去掉 WAL-before-send、去掉 epoch 过滤、去掉 JSON schema 校验，新增测试分别变红。

最终质量门槛：

```bash
pnpm test        # 连续两次全绿
pnpm run check
```

提交信息建议：`feat(tower): resume subagents with durable run tracking`。不要 push。

## 6. 审查与交付

- 这类改动涉及恢复执行、状态一致性和审批安全，最终 reviewer 建议使用 **zai-coding-cn/glm-5.3 max**，不要只让 Flash 审批。
- reviewer 必须独立检查 WAL 顺序、epoch 过滤、JSON 校验和 dispose/清理，不能只看测试绿色。
- 当前用户约束：禁用 WorkBuddy，使用 Z.ai GLM；如用户后续改路由，以最新指令为准。
- 完成后必须独立 review → gate → merge，并同步插件安装副本；运行中 Host 不会热重载运行时代码，重启后才生效。

# M83 审查与实现方向

审查日期：2026-10-27（Asia/Shanghai）。范围：交接文档、审查时 M83 未提交 diff、真实 DSH 依赖源码、既有测试和隔离复现。审查阶段没有修改项目代码、Tower state、安装副本，也没有提交实现、合并或派发模型任务；后续仅按用户要求将本报告与证据归档到 main。

**结论：保留原 child 会话冷恢复的总体方案；当前 M83 实现不能合并。** 关键缺口是审批结果校验、提交绑定与运行轮次隔离。无需推翻整个 Tower，也不宜只补 action 入口后立即投入使用。

审查时 `main = 0818acc240f6bcbc951c6bb931b97d2aa0bfe640`，工作区干净。M83 分支 `tower/m83` 基于 `072ec3f37ebdca40044ba378c41ddb1bcd949221`，仅 `lib/core.js`、`lib/runtime.js` 有未提交改动，合计 +353/-5；Tower 状态为 `worker_failed / aborted`。两份改动文件审查前后 SHA-256 相同。

**验证结果与边界**

- 在 M83 worktree 运行一次 `pnpm test`：505/505 通过；`pnpm run check`：exit 0。这是既有回归通过，不是 M83 验收通过。
- 仓库之外建立 6 项针对性断言，全部按预期暴露现有缺陷而失败；其中 JSON 审批复现使用真实 `TowerCore`、临时 Git 仓库及真实 merge gate。
- 生命周期事件、消息发送及查询服务在这些复现中使用可控替身。没有运行真实模型，也没有完成真实持久化 Session 的完整恢复链验证；不能据此声称实机恢复已成功。
- `resume` 尚未注册到公开 action enum，runtime 的 `execute()` 也没有对应分支，`sessionQuery` 没有加入 inject。因此以下审批缺陷属于待接入的 M83 实现，不代表当前 main 已经通过该入口发生误审批。

复现文件：[review-probes.test.mjs](./m83-probes.test.mjs)；原始结果：[定向断言日志](./evidence/m83-probes.log)；[既有回归日志](./evidence/m83-regression.log)。复现脚本默认导入本仓库的 M83 worktree（可用 `TOWER_M83_REVIEW_ROOT` 指向审查快照），重新执行时会创建并清理隔离临时仓库；在当前未修复代码上退出码应为 1。

以下代码行号对应审查时的 M83 文件；代码链接指向保留的未提交 diff，文件哈希见 [source-manifest.json](./evidence/source-manifest.json)。

**需要修复的问题（按影响排序）**

1. **P1：非法 reviewer JSON 可以直接获得合并批准。** [runtime.js:223](./evidence/m83-reviewed.patch) 忽略 `validateJsonSchemaValue()` 返回的违规数组。额外字段、缺少 required 字段、findings 的错误 severity 三种结果都在复现中进入 `approved`，随后 gate 返回 `ready: true`。错误 verdict enum 则被记为 `changes_requested`，同样没有按契约进入 `review_failed`。必须在违规数组为空时才接受结果。

2. **P1：新的审批绑定配上旧的审查提示词。** [runtime.js:627](./evidence/m83-reviewed.patch) 在 `beginSpawn` 前生成 prompt，[runtime.js:195](./evidence/m83-reviewed.patch) 还明确要求检查旧轮相同的提交绑定。复现中先中断 review，再修改并提交 worktree：新的 review record 绑定了新 tip，发送的提示词却没有新 base/tip SHA。若旧 reviewer 沿用旧结论，core 会将其登记在新提交上。正确顺序必须是 beginSpawn → 用新 binding 生成 prompt → 发送前写入 promptHash → sendMessage → 补记 messageId/hostRunId。

3. **P1：没有本轮 start 也接受 end，并可复用旧 verdict。** [runtime.js:524](./evidence/m83-reviewed.patch) 在 `sendAccepted=true` 后接受同 child 的任意 end。复现只发送旧 hostRunId 的 end，没有本轮 start，activation 仍以 completed 和 clean verdict 结束。查询没有新输出时，[runtime.js:554](./evidence/m83-reviewed.patch) 还会采用该 end 的 fallback 输出。必须要求本轮可靠的 hostRunId 绑定；未知轮次不能产生成功或批准。

4. **P1：JSON 抽取会把解释文字中的示例当作最终批准。** [runtime.js:215](./evidence/m83-reviewed.patch) 搜索任意 fence 和首尾花括号，即使修好 schema 返回值也仍有这个问题。复现输入为“这只是示例，不要批准”加合法 clean JSON 代码块，返回的 structured 仍是 clean。应只接受完整响应就是 JSON，或完整响应就是单一 JSON fence；外部非空正文、多个候选、截断响应均应拒绝。

5. **P2：旧轮的清理可能中断同 child 的下一轮。** [runtime.js:508](./evidence/m83-reviewed.patch) 用 `settled` 判断是否 interrupt，但收到 end 后，只有异步 session 查询完成才会设为 settled。复现顺序为旧轮 end → 查询挂起 → 同 child 新轮 start → dispose；旧 activation 对该 child 发出了 interrupt。真实宿主 interrupt 按 childId 找当前 resident，不能指定 hostRunId。应同步标记旧轮已经结束，再异步读取结果；终态边界、结果读取和取消资格不能共用一个 settled 标志。

6. **集成未完成：功能目前不能通过 tower 调用。** [index.js:6](../../../lib/index.js#L6)、[index.js:22](../../../lib/index.js#L22)、[runtime.js:911](./evidence/m83-reviewed.patch) 缺少依赖声明、enum 和 dispatch。index.js 在被审 M83 中未改动，与本次 main 基线相同。复现直接调用 execute 得到 `unknown Tower action resume`。项目尚无 `test/resume.test.js`，README 和运行文档也未同步。

**已经成立的设计，以及要明确的边界**

本地 `@deepseek-ai/dsh-subagent@0.2.1-rc.2` 源码确认：`sendMessage` 在 child 不驻留时走 `coldResume`，读取原会话自身的 descriptor、验证 direct parent，并恢复 provider/model/reasoningEffort 和 composition；materialize 随后调用 `agents.resume`。因此保持原 childId、通过冷恢复继续原会话是合理方向。宿主相关依据是 `node_modules/@deepseek-ai/dsh-subagent/lib/types/manager.js` 的 `deliverFollowup`、`coldResume`、`materializeTracked`，以及 `descriptor.js`。

“原样恢复”需要准确表述为恢复原持久化会话及 descriptor 支持的配置。`outputSchema` 和上一轮 `maxTokens` 不在冷恢复配置中；不要承诺任意运行时状态逐字节复原。

已有 beginSpawn 先于 send 的 WAL 骨架、保留原路由、direct-parent 检查、拒绝活跃 mission、Observation finally dispose、沿用 track/completeSpawn/failSpawn，都值得保留。但还必须明确：

- Tower runId、宿主 hostRunId、消息 messageId 是三个不同身份。childId 只标识长期会话，不标识某轮执行。
- 宿主 start/end 对应一次驻留周期；向已有 resident 发消息不保证出现新 start。第一版应拒绝无法可靠绑定的恢复路径，或明确以既有 send 语义处理，不能猜测其审批结果。若公开宿主 API 无法提供足够关联证据，应记录限制，再决定是否需要扩展宿主接口。
- `recover` 只修复 Tower 记账，不证明真实旧执行已经停止。不能以 recover 成功作为可以接管旧执行的证据。
- 宿主 `interrupt` 对本地 child 使用 `cancel(..., {keepInbox:true})`，且返回前不等待整体 teardown。它不同于原 activation handle 的 dispose；恢复实现不能把“已发送取消请求”当作“该轮资源已经回收”。
- 输出查询当前只有下界；最终实现还应证明不会读入下一轮结果，并且取消后仍能释放查询 lease。缺少可靠证据时应失败，不应依靠历史输出降级批准。

**建议实施顺序**

1. 先把上述定向断言改写为仓库中的正式行为测试，补充正常成功、拒绝及错误诊断路径；保留当前未提交现场作为起点。
2. 明确恢复事务与运行身份：前置检查 → 新 Tower run 落账 → 新提交绑定生成 prompt → hash 落账 → 注册监听 → 发送 → 关联本轮 hostRunId/messageId → 本轮终态结算。没有本轮 start、发送/attach 失败、dispose 竞争都必须有确定结果及清理路径。
3. 修复严格 JSON 校验和 reviewer binding；保持既有 spawn/send/recover 的行为。收到 matched end 时同步封闭该轮的取消资格，异步观察只负责取结果。
4. 接通 action/schema/inject，并同步文档。加入真实 `SubagentManager.coldResume` 与持久化 Session fixture，验证身份、descriptor、路由、composition、两轮输出及 parent lineage；可以替换模型执行边界，但不能只 mock TowerRuntime。
5. 完成 WAL/epoch/schema 三项反向变异，再按交接要求全套测试连续两次、check、独立审查、gate、合并与安装副本同步。当前审查不等于满足这些交付门槛。

本次建议是继续完成 M83，但先修复上述安全与一致性边界。当前阶段不适合合并，也没有理由仅凭 505 项旧测试通过而启动部署。

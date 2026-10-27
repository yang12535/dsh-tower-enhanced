# 进度记忆

更新时间：2026-10-27 22:07 CST（Asia/Shanghai）。M84 与 M83 均已完成本地 Tower 流程并合入 main；没有远程操作或 push。

## 当前主线

- 仓库：`/home/yangtim/dsh-tower-enhanced`。
- 功能 main：`1ed79ce9ce9deccb16c3cd9811263271c729b458`（M83 merge commit）。本进度记录与最后的外援审查 brief 随后作为独立文档提交，最新 HEAD 以 `git log` 为准。
- M84 merge：`6f1457aa10b824e6dc8f1c218f4b258e9396f2f7`。
- M83 最终审查绑定：base `6f1457aa10b824e6dc8f1c218f4b258e9396f2f7`，tip `dc626d5922ff53513634977b3c340d4c41e276ef`。
- M83 merge：`1ed79ce9ce9deccb16c3cd9811263271c729b458`。
- M83 最终独立 reviewer：direct `zai-coding-cn/glm-5.3`、`reasoning_effort=max`，run `70401d9e-0ca9-4f4f-8af2-1bcf3385a425`，结论 `clean / merge=true`，无 P1/P2。
- 不再派生新的功能、UI、发布或重构 mission。

## M84 已交付

1. workspace 调用占用改为 repository → Session → live execute-call count，同 Session 并发调用不会互相释放。
2. 从 `beginSpawn` 起即登记 runtime active ownership；启动中和 rollback `failSpawn` 尚未完成时，`recover` 不得误回收。
3. activation disposal 采用 exactly-once 守卫；普通 spawn/send/recover 语义保持。
4. 原归档 main 对抗探针最终 5/5 通过。

## M83 已交付

1. 新 `tower action=resume`：用 direct parent 的 `subagents.sendMessage()` 走真实宿主 `coldResume`，恢复原 child Session、descriptor、route、cwd、composition，不是新失忆代理。
2. WAL：先读取 child/sessionSeq/lineage，再 `beginSpawn` 持久化 previous runId/childId/sessionSeq；从本轮 binding 构造 prompt，发送前 `sealResumePrompt` 写 SHA-256，随后 sendMessage，再 attach messageId/hostRunId。prompt 原文不进入 Tower 状态。
3. epoch：只接受本轮 `subagent/start` 绑定的 hostRunId 所对应 end；session 读取同时使用 seq 下界与下一 `user/message` 截断，隔离 output/diagnostic/verdict。
4. resumed reviewer：完整回答只能是单 JSON object 或单 JSON fence，`REVIEW_OUTPUT_SCHEMA` 零违规；否则 `review_failed`，merge gate 不放行。
5. rollback/dispose/track exactly-once；旧 epoch 不打断新 epoch；活跃冲突 `AGENT_BUSY`；stale run 先 `recover`，绝不 adopt。
6. coldResume 不恢复旧 activation 的 outputSchema/maxTokens，该首版边界已写入文档。
7. `docs/architecture.md` 已同步 M84 的 counted `inFlight` 和启动/rollback ownership 描述。

## 最终验证证据

- M83 tip 与合并后 main 均独立执行 `pnpm test` 两次：**540/540 ×2，fail 0，cancelled 0**。
- `pnpm run check`：exit 0。
- 归档 M83 probes：**6/6**；归档 main probes：**5/5**。
- Lead 独立 `/tmp` 反向变异：WAL-before-send → 3 红；hostRunId epoch guard → 3 红；JSON schema → 2 红；disposal → no-hang 护栏抓住；event-slice 下一 user/message 截断 → 新回归测试精确取得下一轮 verdict B 并变红。
- 真实宿主链测试经过实际 `SubagentManager.coldResume` 与持久化 `SessionStore`，验证 descriptor/route/composition、direct-parent authorization 和 durable delivery；仅 `materialize/announce` 模型执行边界使用捕获替身。
- 验证边界：真实 coldResume 测试与 TowerRuntime settlement 测试是分段组合，并未在当前运行中的 Web Host 内做完整端到端 resume smoke；不要把测试通过表述成已经完成实机续接演示。

## 安装副本与下一步

已同步到 `/home/yangtim/.dsh/profiles/web/node_modules/dsh-tower-enhanced`：

- `lib/core.js`
- `lib/index.js`
- `lib/runtime.js`
- `README.md`

四个文件与 main 逐字节一致，安装副本三个 runtime 文件均通过 `node --check`。**当前已经运行的 Host 仍需重启才会加载新代码；本次没有重启 Host，避免中断当前会话。**

建议的唯一收尾：下次 Host 重启后，用一个可丢弃的小 mission 做一次真实 resume smoke，确认原 child/sessionSeq、WAL、hostRunId 和最终 settlement。若不是可复现 P1/P2，不继续扩功能或补低价值测试。

## 最后一次外援的方针审查

已准备 `docs/reviews/2026-10-27/对审查员说的话.md`。这次外援用于审查 main 的方针、复杂度和是否应停止，不再重复逐行代码验收，也不要求生成新路线图。

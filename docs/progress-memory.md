# 进度记忆

更新时间：2026-10-28 13:15 CST（Asia/Shanghai）。M85 与 M86 均已完成本地 Tower 流程并合入 main；这些后续提交尚未 push。

## 当前主线

- 仓库：`/home/yangtim/dsh-tower-enhanced`。
- 最新功能 main：`a7516de202a161fc3228c299f1fd55160461474d`（M86 merge commit）；后续文档提交以 `git log` 为准。
- M85 merge：`812b118cb7e496602e8e9e0644687e506cb126a2`； reviewed tip `834cde19e4ad6aaa418f3f596fc97708032bf0e9`。
- M86 merge：`a7516de202a161fc3228c299f1fd55160461474d`； reviewed tip `1f6cad84633a1a8292d968c0371854c58653f4eb`。
- M84 merge：`6f1457aa10b824e6dc8f1c218f4b258e9396f2f7`；M83 merge：`1ed79ce9ce9deccb16c3cd9811263271c729b458`。
- 外援方针结论：转入维护、停止拓展。M85 是其要求的最后正确性修复；M86 是用户随后明确授权的一次小范围 UI 优化。此后只处理实际故障和必要的 DSH 兼容更新。

## M85 已交付

1. 修复 resumed reviewer 同一 host epoch 内追加消息后的 verdict 优先级：匹配 terminal edge 的最终回答在截断歧义时独占 output/verdict；最终拒绝不能被早期 clean 覆盖，最终非法输出不能被早期 clean 挽救。
2. 保留下一 `user/message` 的 epoch 截断与下一 epoch transcript 隔离；edge 无最终消息及未截断场景沿用原回退规则。
3. `beginSpawn` 在 store 串行 mutation 内通过 `onRunning` 登记 ownership；`recover` 在自己的 store mutation 内读取 ownership 快照。spawn/resume 的持久化排队窗口不再被本 runtime 误回收，write 失败会清理登记。
4. 新增 5 个正式回归；独立 GLM-5.3 max reviewer 给出 `clean / merge=true`，并额外通过 10 组对抗场景与更早 mutator 窗口探针。仅记录两个非阻断 P3，不继续扩测试矩阵。

## M86 已交付

1. Agents 视图按 scope、过滤、实际 agent/运行任务、路由用量排序；Mission 布局、折叠偏好、打开会话与任务结果行为保留。
2. `resumeFrom` agent 显示 `续接 / Resumed`，详情展示 previous runId/sessionSeq，不显示 promptHash；普通 spawn 不增加标识。
3. 窄栏路由表改为局部横向滚动，详情长值允许换行；中英文与稳定 data-* 均已覆盖。
4. 使用真实 Chrome `/tmp` harness 渲染并实际查看 before/after-v1/after 截图，根据窄栏整体溢出完成一次 CSS 迭代；不是 Host HMR。截图位于 `/tmp/tower-m86-harness/screenshots/`。
5. 独立 `workbuddy/cn:kimi-k3.1-pro` max 图像 reviewer 逐张复核 desktop/narrow、中英文、resume details、filtered routes 和 Mission/折叠截图，结论 `clean / merge=true`，无 findings。

## M84 已交付

1. workspace 调用占用改为 repository → Session → live execute-call count，同 Session 并发调用不会互相释放。
2. 从 `beginSpawn` 起即登记 runtime active ownership；启动中和 rollback `failSpawn` 尚未完成时，`recover` 不得误回收。
3. activation disposal 采用 exactly-once 守卫；普通 spawn/send/recover 语义保持。
4. 原归档 main 对抗探针最终 5/5 通过。

## M83 已交付

1. 新 `tower action=resume`：用 direct parent 的 `subagents.sendMessage()` 走真实宿主 `coldResume`，恢复原 child Session、descriptor、route、cwd、composition，不是新失忆代理。
2. WAL：先读取 child/sessionSeq/lineage，再 `beginSpawn` 持久化 previous runId/childId/sessionSeq；从本轮 binding 构造 prompt，发送前 `sealResumePrompt` 写 SHA-256，随后 sendMessage，再 attach messageId/hostRunId。prompt 原文不进入 Tower 状态。
3. epoch：只接受本轮 `subagent/start` 绑定的 hostRunId 所对应 end；M85 进一步明确同 epoch followup 与下一 epoch 截断歧义时的 terminal-edge 优先级。
4. resumed reviewer：完整回答只能是单 JSON object 或单 JSON fence，`REVIEW_OUTPUT_SCHEMA` 零违规；否则 `review_failed`，merge gate 不放行。
5. rollback/dispose/track exactly-once；旧 epoch 不打断新 epoch；活跃冲突 `AGENT_BUSY`；stale run 先 `recover`，绝不 adopt。
6. coldResume 不恢复旧 activation 的 outputSchema/maxTokens，该首版边界已写入文档。

## 最终验证证据

- M85 tip 双次全测 **545/545 ×2**，合并后 main **545/545**；M86 rebase 后双次全测 **547/547 ×2**，合并后 main **547/547**。
- 最终 `pnpm run check`：exit 0；两个 merge gate 均 `ready=true / blocks=[]`，changedFiles 均在 scope 内。
- M85 Lead 反向变异：关闭 terminal-edge 优先 → 2 个 verdict 回归精确变红；删除 `onRunning` → spawn/resume race 回归变红。独立 reviewer 另验证旧 verdict fallback 和完整 P2 回退均会被抓住。
- M86 client 聚焦测试 **43/43**；真实浏览器 after-v1 窄栏整体 scrollWidth 293/303 → after 278，与 panel clientWidth 一致，仅路由表保留局部横向滚动。
- M83 历史验证：540/540 双次、归档 M83 probes 6/6、main probes 5/5；WAL/hostRunId/schema/disposal/event-slice 反向变异均曾被抓住。
- 真实 Host 端到端 smoke：原 child `6a5d6838-ea75-451f-bfed-43ff918d8c11` 从 run `46c23e4b-f5ca-4f36-be0e-ecc64a488bf4` 续接到 `60e6d877-a3e6-4386-a558-aa8c51547f3d`，WAL `sessionSeq=55`，hostRunId `7e1ea4d6-7f36-4169-9674-d453cf93ec4f`；第二轮未重复提供路径/token，仍追加 `round-2 ORCHID-731`，commit `8c8c32785fc97e008cacac95f0c731fc1f804c29`。SMOKE 已 abandon + teardown，未合并 main；无需重复正常 smoke。

## 安装副本与运行边界

已同步到 `/home/yangtim/.dsh/profiles/web/node_modules/dsh-tower-enhanced`：

- `lib/core.js`
- `lib/index.js`
- `lib/runtime.js`
- `lib/client.js`
- `README.md`

上述文件与 main 逐字节一致，安装副本 runtime/client 文件均通过 `node --check`。M86 client 已在当前 Host 的新开任务标签页中实际加载并复核：161 个 agent 时任务列表位于路由用量之前，检测到 1 个 `续接 / Resumed` 标识，面板 scrollWidth/clientWidth 均为 351；截图 `/tmp/m86-host-after.png`，标签页已关闭。这不是 HMR 声明。M85 runtime 已写入安装副本，但当前已运行 Host 仍需重启才能加载新 runtime。没有重复正常 resume smoke，也没有 push M85/M86。

项目进入“拿来用，坏了修”的维护阶段；不再主动派生新功能、UI、发布或架构任务。

## 最后一次外援的方针审查与结果

`docs/reviews/2026-10-27/对审查员说的话.md` 已附上审查结果。外援明确选择“仅修阻断项，修完后停止扩张”，并隔离复现 1 个 P1 与 1 个 P2；两项均由 M85 修复、独立审查并合并。完整运行历史、发布设施、插件化架构、UI 扩展和大规模重构不再是交付前置条件。

## GPT-6a 最终独立复核（2026-10-28）

唯一一次 `gpt-6-astra + xhigh` 外援窗口已完成，报告归档于 `docs/reviews/2026-10-28/gpt-6a-main-review.md`。审查精确 HEAD `18fb35aaaf4cd62c951a1287535090226039f25e`，独立探针 **17/17**、定向回归 **175/175**，三种反向变异均被抓住；M85/M86 没有新增 P1/P2，也没有需要追加修复的 P3。主仓、安装副本和真实 Tower state 前后哈希一致。结论：无需补丁，停止扩张，不再占用窗口。

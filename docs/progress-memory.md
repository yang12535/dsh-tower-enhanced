# 进度记忆（compact 前）

更新时间：2026-10-27 19:36 CST（Asia/Shanghai）。这份文件只记录后续接手需要的状态，不代表 M83 已完成。

## 1. 先读哪份文件

1. 先读 [m83-resume-handoff-gpt6a.md](m83-resume-handoff-gpt6a.md)：这是给外援/GPT-6a 的完整 M83 交接说明。
2. 再读本文件：确认主线、未提交现场、路由与验收状态，避免被旧对话中的方案讨论误导。

## 2. 当前主线与运行状态

- 仓库：`/home/yangtim/dsh-tower-enhanced`，无远程，合并均为本地 Tower `--no-ff`，不要 push。
- 写本文件前 `main = a36b1b5`（`docs: hand off M83 resume implementation to GPT-6a`）；本文件提交后主线会继续前进，以 `git log` 为准。
- 最近一次完整验证：**505/505 通过，`pnpm run check` exit 0**。
- `main` 工作区干净；误生成的 `t --count HEAD` 彩色日志已删除。
- Tower 记录共 81 个 mission：72 merged、8 abandoned、仅 M83 未完成（worker_failed/aborted）。
- 当前 **0 worker / 0 reviewer / 0 后台任务**；没有定时续跑提醒。
- 目标 `goal-2600f64e-19e1-4167-aadc-668ef667581e` 已 `complete/disarmed`，不会自动续跑。

## 3. 已完成的最近交付

- M81：面板偏好按会话快照加载，合并提交 `60b7c59c563eb8670d1c9eb41cbe72372d0ca474`。
- M82：通知末行 stopReason、单行化、fallback 与文档同步，合并提交 `072ec3f37ebdca40044ba378c41ddb1bcd949221`。
- M80 的运行时代码和 M81 的客户端代码已同步到 `~/.dsh/profiles/web/node_modules/dsh-tower-enhanced`；当时 9 个 runtime/package 文件哈希一致。M82 主要是文档，M83 尚未合并/同步。
- 运行中 Host 不会热重载这些代码；相关新行为需下次 Host 重启后生效。

## 4. M83：真正状态与交接现场

用户要的是 **原 subagent 原样恢复并继续执行**，不是新开会话，也不是只保留 worktree。

- M83 分支：`tower/m83`。
- worktree：`/home/yangtim/dsh-tower-enhanced/.dsh-tower/worktrees/m83`。
- 当前状态：`worker_failed / stopReason: aborted`，**没有新提交、没有送审、没有合并、没有跑完整测试**。
- worktree 保留未提交实现：`lib/core.js` 约 +65 行、`lib/runtime.js` 约 +293 行（总计约 +353/-5）。这些实现含已知缺陷，不能直接当成正确版本提交。
- 不要 `git reset --hard`、`git checkout -- .`、`git clean -fd`。先理解并修正现有 diff。
- 本文件和交接文档提交后 main 已前进；不要在 M83 未提交时强行 rebase。先保留 diff、完成修正和提交，再按 Tower 规则 rebase/review。

## 5. M83 接手时的必修项

详细背景见 [m83-resume-handoff-gpt6a.md](m83-resume-handoff-gpt6a.md)，最低不能漏掉：

1. `validateJsonSchemaValue` 返回违规数组，不是对非法数据抛异常；只有 `violations.length === 0` 才能接受 reviewer JSON。额外字段/缺字段/错误 enum/非 JSON 都要 review_failed。
2. 缺少本轮 `subagent/start` 的 hostRunId 时，不能接受任意 `subagent/end`；要确定失败/中断，不能把旧 epoch 的输出、诊断或 verdict 算进本轮。
3. reviewer prompt 必须使用 `beginSpawn` 后的新 `mission.review.baseCommit/reviewedCommit`；先 beginSpawn → 用新 binding 生成 prompt → 发送前 `attachSpawn` 写 promptHash → sendMessage → 再记录 messageId/hostRunId。
4. 活跃 run 无论是否 previousRunId/childId 相同都必须 `AGENT_BUSY`；旧控制器的 running 记录先 `recover`，不得通过 resume 绕过。
5. 使用 `subagents.sendMessage` 的 `coldResume`，不要直接 `startActivation({childId})`（会查重）；不要改 DSH 安装目录或全局配置。
6. `lib/index.js` 加 `resume` action 并把 `sessionQuery` 加入 `inject`；同步 README、architecture、operations、security-model 的 action 与安全语义。
7. `sessionQuery` 只读偏移后的新事件，Observation 必须 dispose；activation-compatible `dispose()` 必须让 pending result 以 aborted 落定，不能挂住 track。
8. 原 descriptor/route 保留并复制到统计，不默认重新解析；首版路由覆盖要明确拒绝。coldResume 不恢复 outputSchema/maxTokens，因此 reviewer 必须重新校验 JSON。
9. 新增 `test/resume.test.js`：WAL 顺序、原 child/路由、epoch 对齐、重复 resume、worker error diagnostic、reviewer clean/changes_requested/非法 JSON、活跃冲突、恢复失败、attach/dispose 清理、普通 spawn/send/recover 不回归。
10. 至少一条真实 `SubagentManager.coldResume` + 持久化 Session 的恢复链验证，可只替换 `materialize`/`submitMaterialized` 做捕获；不要把纯 mock TowerRuntime 说成实机恢复成功。
11. /tmp 反向变异（WAL 顺序、epoch 过滤、JSON 校验）必须分别变红；最终 `pnpm test` 连跑两次全绿、`pnpm run check` 通过，再独立 review → gate → merge。

## 6. 路由与审查约束

- 最新用户路由指令：**使用 GLM，WB2API 禁用**。不要派生 WorkBuddy run。
- worker 使用 `zai-coding-cn/glm-5.3`（high/max）。
- M83 涉及恢复执行和审批安全，最终 reviewer 建议 **GLM-5.3 max**，不要只让 Flash 审批。
- 最后一次额度采样（2026-10-27 19:36:31 CST）：GLM 五小时窗口 **70%**、周窗口 **44%**；这是历史读数，续跑前重新查询，不要当作当前保证。
- 续接功能本身的 API 事实已核对：`startActivation` 不能直接恢复已有 child；`sendMessage` 才能走 coldResume。宿主 `subagent/start`/`subagent/end` 和 `sessionQuery` 用于纳管与对账。

## 7. compact 后的第一步

外援/GPT-6a 应先打开交接文档和本文件，核对 M83 worktree 的真实 diff，然后按第 5 节继续实现。不要把“方案已讨论”“代码已写入 worktree”误记为“功能已完成”。

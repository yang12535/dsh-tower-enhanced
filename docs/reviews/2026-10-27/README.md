# 2026-10-27 审查交付

本目录保存一次已完成的源码审查及证据，不表示列出的问题已经修复。按用户要求直接提交到本地 `main`；此次归档不合并 M83 实现，不修改 Tower 任务状态或已安装插件。

- [main 整体架构与发展方向](./main-architecture.md)：优先阅读。基线 `0818acc240f6bcbc951c6bb931b97d2aa0bfe640`；含两个新复现的单 runtime 生命周期缺陷、运行历史与依赖语义分析、状态载荷测量、后续优先级。
- [M83 原会话续接专项审查](./m83-resume.md)：对尚未合并的实现进行审查。它基于 `072ec3f37ebdca40044ba378c41ddb1bcd949221`，审查时仅 core/runtime 存在未提交 diff。
- [审查源码哈希与基线](./evidence/source-manifest.json)、[M83 审查时的 diff](./evidence/m83-reviewed.patch)：固定证据来源。patch 是文档附件，不会被本提交应用到 main。

审查结论是先修 main 的执行所有权与启动登记，再明确任务/运行/会话关系并收敛发布载荷，随后完成 M83。保留 Git worktree、exact-SHA 审查绑定、gate 和保守合并/清理流程。

## 复现

从仓库根目录运行：

```bash
node --test docs/reviews/2026-10-27/main-probes.test.mjs
node --test docs/reviews/2026-10-27/m83-probes.test.mjs
```

这两份脚本是审查证据，刻意放在 `docs`，不加入默认 `pnpm test`。在被审代码上预期分别为 **2 failed / 3 passed** 和 **6 failed / 0 passed**，退出码均为 1；这些失败是需要修复的行为断言，不是交付测试套件出现了新回归。修复后应把相关行为用例迁入正式测试，不能为了保持本报告数字而保留缺陷。

main 脚本通过相对路径导入当前 checkout。M83 脚本默认读取 `.dsh-tower/worktrees/m83`；如果该未提交现场已不存在，可在独立、具有现有依赖的 checkout 中检出上面的 M83 基线，再应用保存的 patch，并指定：

```bash
TOWER_M83_REVIEW_ROOT=/absolute/path/to/review-fixture node --test docs/reviews/2026-10-27/m83-probes.test.mjs
```

不要在当前 main 或任何含未保存改动的工作区应用该证据 patch。复现脚本仅在临时 Git 仓库中写入实验数据，并自行清理；subagent 启动、生命周期事件与模型执行边界使用替身，没有调用真实模型。

## 验证证据

| 对象 | 审查时结果 | 日志 |
| --- | --- | --- |
| main 既有回归 | 505/505，通过 | [main-regression.log](./evidence/main-regression.log) |
| M83 既有回归 | 505/505，通过 | [m83-regression.log](./evidence/m83-regression.log) |
| main 定向复现（归档脚本） | 2 failed / 3 passed，预期 exit 1 | [main-probes.log](./evidence/main-probes.log) |
| M83 定向复现（归档脚本） | 6 failed / 0 passed，预期 exit 1 | [m83-probes.log](./evidence/m83-probes.log) |
| 本次归档后的 main 回归与语法检查 | 505/505，通过；check exit 0 | [archive-validation.log](./evidence/archive-validation.log) |

最初使用临时脚本运行的日志另存为 [main-probes-original.log](./evidence/main-probes-original.log) 与 [m83-probes-original.log](./evidence/m83-probes-original.log)，保留原始路径和栈信息。归档脚本已改用相对路径/显式 fixture 路径，并重新验证预期结果。

既有回归与本轮验证在本机 Node v24.19.0 上执行。没有完成真实宿主 GUI、真实持久化 Session 恢复链、最低 Node 版本矩阵或远端 CI 验收；报告中的这些缺口仍然存在。

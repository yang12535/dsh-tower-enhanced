# 整仓一致性审计：文档 ↔ 代码 ↔ 测试（0.3.1 基线）

- 审计对象：HEAD `2b0180c`（审计时不含本报告）；五份指定文档为 `README.md`、`README.zh-CN.md`、`docs/architecture.md`、`docs/operations.md`、`docs/security-model.md`。
- 环境：本 mission worktree；Node `v24.19.0`，pnpm `12.15.0`。只读源码审计；临时 Git 仓库、doctor/release 故障样例均在 `/tmp`，未修改任何既有仓库文件。
- 口径：`一致`表示已执行的证据支持该项，不表示形式化证明；`漂移`按根因组计数，同一根因落在多个文档不重复计数。分级：p1 = 会产生错误控制流/错误运维操作；p2 = 公共契约、诊断或文档语义失真；p3 = 测试盲点或局部表述问题。B 的覆盖缺口不虚构产品 bug，单列严重度 p3。
- “触达”采用严格口径：测试直接 import 该导出，或 V8 运行时记录其导出函数体确实执行；仅在其他源码里被调用不等于有该 API 的独立契约测试。错误码另区分“有行为路径覆盖”与“按码值断言”。

## 结论摘要

**共确认 8 组漂移：p1 × 2，p2 × 4，p3 × 2。** 另确认 **1 个导出 API 完全未执行、32 个错误/finding code 没有任何测试文本按码值引用**（p3 覆盖缺口，详见 B，不计入上述 8 组文档漂移）。

| 级别 | 结论 |
| --- | --- |
| p1 | `docs/operations.md:61` 的 `add` 示例使用 `dependsOn`，工具实际只读 `depends_on`；真实 runtime 实测 camelCase 得到空依赖，约束被静默省略。 |
| p1 | `docs/operations.md:253` 建议在已经失败落定的 worker 上 `send`；真实测试证明已完成 worker 被拒绝且不调用 subagents。应查看会话记录，或重新 spawn。 |
| p2 | `summary` 的真实返回含全塔 `routes`，但 architecture 与 operations 的字段契约均漏掉它。 |
| p2 | architecture 声称 doctor “当前共有 32 个 finding code”，实现与 JSON 契约测试均为 33；漏 `MISSION_TERMINAL_ACTIVE_ROLE`。 |
| p2 | 两份 README 的英文配置段缺中文已有的 provider/model 成对与 `max_tokens` 正整数约束；这是双语语义不等价，i18n key 测试无法发现。 |
| p2 | `docs/operations.md:29` 的 `changes_requested` 下一步只写 worker，遗漏实现支持的 reviewer 重审与 rebase；与该文件后面的完整集合自相矛盾。 |
| p3 | `docs/architecture.md:96` 声称 scale-smoke 固定“事件上限”的抗退化行为，但该测试只断言预置 200 后仍为 200，没有产生第 201 条事件，不能证明 appendEvent 的 200 截断。 |
| p3 | `README.md:133`、`README.zh-CN.md:136`、`docs/operations.md:15,177` 把结算通知写成“一定/保证送达”，实现只保证生成并尝试投递；`steer` 抛错仅记日志，没有持久重试。architecture 与 security-model 已准确说明这个边界。 |

**正向结果：**15 个 tool action、12 个 mission status、12 个 gate block code、20 种事件类型均与相应文档全集一致；关键上限 `100 / 500 / 10 / 5000 / 7 / 500`，以及 `200 / 20 / 50 / 50,000 / 8192 / 120s / 8MiB / 0o600 / 10min` 均与实现一致。完整基线 `pnpm test` 实测 **416 pass / 0 fail**；`pnpm run check` 通过。C 未发现僵尸断言，D 除上述英文配置段遗漏外，110 对 UI 字典条目未发现语义反向或关键条件丢失。

## A. 文档 → 代码逐项核对表

下表的 E# 是可复跑证据编号；完整命令与原始关键输出集中列在表后，避免每行重复大段命令。所有行号来自本次 `read` 工具读取的文件，所有输出均来自本 worktree 实际执行。

| 断言原文（缩略）与位置 | 实测结果 | 判定 |
| --- | --- | --- |
| README:118、README.zh-CN:121、architecture:36：15 个 action 全集 | E1 得 `actionCount:15`，逐项等于三文档枚举；`node --test test/docs-consistency.test.js` 为 3/3 | 一致 |
| architecture:100-105、operations:19-36：12 个状态及重启集合 | E1 `statusCount:12`；E2 得 `WORKER_RESTARTABLE` 8 项、`REVIEW_RESTARTABLE` 4 项，与集合一致 | 一致（单表遗漏另见 A12） |
| architecture:217-232、operations:468-486：merge gate block 清单 | E1 `gateCodeCount:12`；`node --test test/gate-matrix.test.js` 为 16/16，覆盖注册无僵尸 code | 一致 |
| operations:522-540：事件类型附录 | E1 从 core 的 `appendEvent` 调用点提取 `eventCount:20`，与附录逐项一致 | 一致 |
| architecture:56,92：models 聚合每 provider ≤100、单 provider ≤500 | E1 常量 100/500；models 测试分别用 105、502 条输入得到 100、500 | 一致 |
| architecture:308、operations:337、security-model:104：doctor 样例 ≤10、扫描预算 5000 | E1 常量 10/5000；doctor 实测 `sample.length <= 10`，注入预算 3 得 `count:3,truncated:true` | 一致 |
| client/架构数据布局与 UI 短 SHA：7 字符 | E1 `SHORT_SHA_LENGTH=7`；client 测试“7-char short merge commit”通过 | 一致 |
| README:133、architecture:157、operations:177、security-model:62：通知 reason 上限 500 | E1 `NOTICE_REASON_LIMIT=500`；runtime 测试用 600 个额外字符验证截断 | 一致；但“送达保证”措辞见 A13 |
| README:135、README.zh-CN:138：卡片错误最多 500 Unicode 码点（含省略号） | E1 `MAX_AGENT_ERROR=500`，client 实现 `Array.from`；500/501 个 😀 用例通过 | 一致 |
| architecture:60,89、operations:14,524、security-model:83：事件持久 200、公开 20 | E3 真实产生 205 次 edit，持久 `200`、公开 `20`、`publicEventsAreLast20:true` | 一致 |
| architecture:123、core dirty entries 上限 50 | E1 `dirtyEntries` 取 50；`lib/core.js:620` 与 gate/teardown 同样 `slice(0,50)` | 一致 |
| security-model:29,83：worker 输出 50,000；Git 诊断 8192 | E1 分别得 `50_000`、`8192`；实现位于 runtime:43、git:7-10 | 一致 |
| architecture:75：Git 默认 120s、8MB、无 shell、固定环境 | E20 源码证据为 `git.js:15` 的 `timeoutMs = 120_000`（=120s）与 `git.js:6` 的 `8 * 1024 * 1024`；`git.js:14-29` 为 execFile 数组、`GIT_TERMINAL_PROMPT=0`、`LC_ALL=C` | 一致（120s 仅静态核对；未等待 120s 实测超时） |
| architecture:68-71,263、security-model:50：state 路径、临时文件 + rename、0600 | E1 `stateWriteMode:0o600`；E4 runtime 默认目录 `.dsh-tower`；store 测试实测 `mode & 0o777 === 0o600` | 一致 |
| architecture:273、operations:12：分支/工作树默认 `tower/<id>` 与 `.dsh-tower/worktrees/<id>` | E4 默认 `branchPrefix:tower`；E5 新建 M1 返回 `tower/m1` 与 `.dsh-tower/worktrees/m1` | 一致 |
| architecture:320、operations:388、security-model:60：release 锁龄至少 10 分钟可回收 | E1 常量 10；E6 在临时仓库写入 11 分钟锁，真实接管并提示 “at least 10 minutes old”，新 token 不同、0600，释放后无残留 | 一致 |
| README:30、README.zh-CN:30：Node 22.5+、DSH 0.2.1-rc.2 | `package.json:44-46` engines 一致；本机 Node v24.19.0 满足下限 | 一致 |
| architecture:294、operations:555、README:155：doctor clean/error 退出 0/2，warning 1，`--fail-on-warning` warning 升 2 | E7 clean CLI 进程退出 0；E8 当前 worktree 缺 state 退出 2；E9 临时 warning-only 仓库退出 1、strict 退出 2，JSON 的 summary.exitCode 与进程一致 | 一致 |
| architecture:294：有效 `--json` 只有一个 JSON，stderr 空；非法用法退出 2 到 stderr | E7/E8/E9 均单 JSON、stderr 空；E10 非法 flag 的 `stdout-bytes=0`、stderr `error: unknown option`、退出 2 | 一致 |
| README:156、architecture:314：release dry-run 只打印 diff，不写；目标 package/CHANGELOG | E11 实际 dry-run 返回 `dryRun:true` 与两个目标文件，`git status before/after identical:true` | 一致 |
| operations:61：`add(... dependsOn:["M0"] ...)` | E12 同一真实 runtime 两次 add：`dependsOn` → `returnedDependsOn:[]`；`depends_on` → `["M0"]` | **漂移 p1** |
| operations:110；architecture:92,94：`summary` 字段 `version/repoRoot/baseBranch/baseCommit/counts/missions` | E13 空 tower 实测 keys 为 `[version,repoRoot,baseBranch,baseCommit,counts,routes,missions]`；`core.js:368` 确实返回 `routes` | **漂移 p2**（routes 全塔聚合漏写） |
| architecture:296-306：“当前共有 32 个 finding code” | E14 静态构造 + 动态 code 得 33；`test/doctor-json-schema.test.js:13-47` 白名单也是 33；文档只 32，缺 `MISSION_TERMINAL_ACTIVE_ROLE`。E9 真实触发该 warning | **漂移 p2** |
| operations:29：`changes_requested` 的“允许的下一步”仅 spawn worker | E2 实现 `REVIEW_RESTARTABLE` 包含 `changes_requested`，且该状态可做 no-op rebase；operations:36 自己的完整集合也证明可 reviewer | **漂移 p2** |
| operations:253：失败诊断“需要更多上下文时 `send` 询问仍在线的 agent” | E15 `send`/`interrupt` 对 completed worker 均拒绝且“不调用 subagents”；`core.js:660-663` 要求 running status | **漂移 p1**（落定的失败 run 不能再 send） |
| README:133、README.zh-CN:136、operations:15,177：“失败一定/保证送达、即使失败通知仍会送达” | E16 runtime:413-420 是 try/catch `parent.steer`，失败仅 `logger.error`；runtime 测试明确断言 steer 失败记日志后照常 settle，无重试队列 | **漂移 p3** |
| architecture:96：scale-smoke 固定“事件上限”抗退化 | E17 `test/scale-smoke.test.js:94` 先预置 200，:150 只断言仍 200；没有第 201 次 append。E3 另行真实生成 205 次才验证截断 | **漂移 p3**（测试描述超出实际证明） |
| architecture:296 的白名单 vs operations:424,572 的终态活跃角色 finding | E14 operations 有此 code，architecture 无；实现 doctor:622 在独立多行调用中产生，简单的 `finding\('...'` 正则还会漏算，故本审计同时查动态分支与测试白名单 | **漂移 p2**（与 A22 同组） |
| 五文档所有相对文件链接 | E18 分别扫描 `2/3/48/38/22` 个相对链接，`missing:[]` | 一致 |
| operations:7 的 base `c6080c5` | E19 `git cat-file -t` → `commit`；`git merge-base --is-ancestor c6080c5 HEAD` → 0 | 一致（基线存在且为祖先；逐行为以当前实现复核） |

### A 证据：真实命令与输出

**E1 — 静态可执行枚举/常量探针**（命令为 `node --input-type=module`，脚本读取 `lib/index.js`、`lib/core.js`、`lib/store.js`、`lib/git.js`、`lib/runtime.js`、`lib/client.js`、两个 scripts，并打印 JSON；正则为源码文本提取，不执行被审计仓库以外代码）：

```json
{
  "actionCount": 15,
  "statusCount": 12,
  "gateCodeCount": 12,
  "eventCount": 20,
  "limits": {
    "eventsPersisted": "200", "eventsPublic": "20", "dirtyEntries": "50",
    "gitMaxBuffer": "8 * 1024 * 1024;",
    "gitDiagnosticLimit": "8192", "workerOutput": "50_000",
    "noticeReason": "500", "aggregateCatalog": "100", "providerCatalog": "500",
    "uiErrorCodePoints": "500", "shortSha": "7", "doctorSamples": "10",
    "doctorLstat": "5000", "releaseLockStaleMinutes": "10"
  },
  "stateWriteMode": "0o600",
  "reviewVerdicts": ["clean", "changes_requested"],
  "reviewSeverities": ["p1", "p2", "p3"]
}
```

**E2 — `node --input-type=module` 从 core 提取两个 Set，并读取 runbook 行：**

```text
WORKER_RESTARTABLE ["pending","worker_completed","worker_failed","review_failed","changes_requested","approved","rebase_blocked","merge_blocked"]
REVIEW_RESTARTABLE ["worker_completed","review_failed","approved","changes_requested"]
| `changes_requested` | ... | `spawn` worker 返工（清空既有 review） |
```

**E3 — `node --input-type=module`；真实 `initializedCore` + `addMission` + 205 次 `editMission`：**

```json
{"command":"205 title edits; compare core.store.read().events and core.status().events","persistedEventCount":200,"persistedFirstType":"mission-edited","persistedLastType":"mission-edited","publicEventCount":20,"publicEventsAreLast20":true}
```

**E4/E5 — `new TowerRuntime(...,{})` 与真实 core add：**

```json
{"runtimeDefaults":{"provider":"spawn","stateDirectory":".dsh-tower","branchPrefix":"tower"}}
{"statusKeys":["version","repoRoot","baseBranch","baseCommit","createdAt","updatedAt","missions","events"],"missionBranch":"tower/m1","worktreeSuffix":".dsh-tower/worktrees/m1"}
```

**E6 — 临时 Git 仓库执行 `acquireReleaseLock`，使用实际 11 分钟陈旧锁：**

```json
{"notice":"Taking over stale release lock /tmp/dsh-m67-lock-PjPVox/.git/release-apply.lock: lock is at least 10 minutes old.","newPid":828292,"newTokenIsDifferent":true,"mode":"600"}
{"lockExistsAfterRelease":false,"reclaimLockExistsAfterRelease":false}
```

**E7/E8/E9/E10 — 真实 CLI 进程：**

```text
# 临时健康仓库：node scripts/tower-doctor.mjs --repo <path> --state <path> --json --fail-on-warning
actualExitCode=0; stderr=""; summary={checksPassed:6,warnings:0,errors:0,exitCode:0}; stateUnchanged=true

# 本 worktree（无 tower state）：node scripts/tower-doctor.mjs --json --fail-on-warning
finding=STATE_MISSING(error); summary.errors=1; summary.exitCode=2; 实际进程 exit=2

# 临时 warning-only 仓库（含 MISSION_TERMINAL_ACTIVE_ROLE）
默认：actualExitCode=1; warnings=3; errors=0; failOnWarning 键不存在
严格：actualExitCode=2; warnings=3; errors=0; failOnWarning=true
findings=[MISSION_BRANCH_MISSING, WORKTREE_UNREGISTERED, MISSION_TERMINAL_ACTIVE_ROLE]

node scripts/tower-doctor.mjs --definitely-invalid
stdout-bytes=0; stderr-tail="error: unknown option: --definitely-invalid"; exit=2
```

**E11 — `node scripts/release.mjs --version 9.9.9 --date 2026-10-26 --json`：**

```json
{"ok":true,"dryRun":true,"packageName":"dsh-tower-enhanced","currentVersion":"0.3.0","nextVersion":"9.9.9","files":[{"path":"package.json","action":"update"},{"path":"CHANGELOG.md","action":"update"}]}
[exit code: 0]
[git status before/after identical: true]
```

**E12 — `node --input-type=module`，真实 `TowerRuntime.execute({action:'add'})`，隔离临时仓库：**

```json
{"towerAction":"add","argumentKey":"dependsOn","returnedDependsOn":[]}
{"towerAction":"add","argumentKey":"depends_on","returnedDependsOn":["M0"]}
```

**E13 — `await core.summary()`：**

```json
{"summaryKeys":["version","repoRoot","baseBranch","baseCommit","counts","routes","missions"],"counts":{"missions":0,"workerRunning":0,"reviewRunning":0,"approved":0,"merged":0,"blocked":0,"abandoned":0},"routes":[]}
```

另跑 `node --test test/summary-routes.test.js`：**6 pass / 0 fail**，证明路由计数、排序、过滤后仍全塔、merged/abandoned 计入均有真实行为测试。

**E14 — 动态 doctor 清单比较（含多行 `finding(`、条件 code 和测试白名单）：**

```json
{"literalCount":31,"conditionalCodes":["STATE_MISSING","STATE_READ_FAILED","GIT_METADATA_FOREIGN_OWNER","GIT_METADATA_NOT_WRITABLE"],"implementedCount":33,"testWhitelistCount":33,"documentedCount":32,"missingFromArchitecture":["MISSION_TERMINAL_ACTIVE_ROLE"],"unknownInArchitecture":[],"testVsImplementationDifferences":{"missingFromTest":[],"extraInTest":[]}}
```

**E15 — `node --test --test-name-pattern='send rejects a completed worker|interrupt rejects a completed worker|send rejects a pending mission' test/control-actions.test.js`：**`tests 2, pass 2, fail 0`；输出含 `send rejects a completed worker without calling subagents`、`interrupt rejects a completed worker without calling subagents`。

**E16 — `lib/runtime.js:413-420` 实现读取 + 既有测试 `a failing steer is logged as an error and still settles the run`（完整 416 套件中通过）；security-model:105 与实现一致。**

**E17 — `read test/scale-smoke.test.js:94-99,149-152`：**只预置 200 并检查最终仍为 200；E3 是本次为补足该断言真实性而实际执行的独立探针，不是补测试。

**E18 — Node 链接扫描输出：**

```text
README.md: relativeLinks=2, missing=[]
README.zh-CN.md: relativeLinks=3, missing=[]
docs/architecture.md: relativeLinks=48, missing=[]
docs/operations.md: relativeLinks=38, missing=[]
docs/security-model.md: relativeLinks=22, missing=[]
```

**E19 — `git cat-file -t c6080c5 && git merge-base --is-ancestor c6080c5 HEAD`：**`commit`，ancestor exit `0`。

**E20 — `node --input-type=module` 实际读取并打印源码相关行：**

```json
{"gitTimeoutSource":"const { signal, timeoutMs = 120_000, allowedExitCodes = [0] } = options;","gitMaxBufferSource":"const MAX_BUFFER = 8 * 1024 * 1024;","equivalentTimeoutSeconds":120,"dynamicTimeoutTest":"未执行（不等待 120 秒）"}
```

## B. 代码 → 测试覆盖缺口

### B1. 导出函数/常量

执行过：`NODE_V8_COVERAGE=/tmp/dsh-m67-coverage.wAREcV node --test test/*.test.js`，尾部为 **416 pass / 0 fail**；79 份 JSON 中 1 份进程退出时未完整写出，分析脚本跳过该无效 JSON，仅合并其他记录。客户端用 fake DOM 的 CommonJS 模块导出检查（`exports.apply/inject/missionDependencyState/missionNextStep/missionDependencyDepths`），它们均被执行。

| 文件 | 直接未 import 的导出（不等于未执行） | 运行覆盖结论 / 缺口 |
| --- | --- | --- |
| `lib/errors.js` | `assertTower`, `errorMessage`, `errorDetails` | 前两者经其他模块大量间接触达；**`errorDetails`（errors.js:18）V8 完全未执行，且测试无文本引用，是唯一完全未触达的导出 API**。 |
| `lib/git.js` | `gitOut`, `repoRoot`, `head`, `status`, `assertClean`, `isAncestor`, `changedFiles`, `rebaseInProgress`, `localExcludeFile` | 都被 core 间接执行；只有 `runGit/currentBranch` 在 git.test 中直接导入。**缺各 helper 独立契约测试**，尤其 `gitOut` 的 allowed-nonzero 分支。 |
| `lib/projection.js` | `towerStateSchema` | 被 `towerProjectionDefinition` 间接引用与执行，非完全未覆盖；无直接独立 schema 导出测试。 |
| `lib/runtime.js` | `REVIEW_OUTPUT_SCHEMA` | spawn reviewer 时间接使用；无该导出 schema 的独立字段断言。 |
| `scripts/release.mjs` | `ReleaseError`, `promoteChangelog`, `atomicWrite`, `acquireReleaseLock`, `dirtyWorktreeEntries`, `runRelease`, `parseArgs`, `cliMain` | 多数经 `computePlan`/真实 CLI 间接执行；**陈旧锁回收内部 `lockChangedError/currentLockedError/restoreQuarantinedLock/quarantineStaleLock/acquireReclaimLock` 在全测试中完全未执行**（release.mjs:338,404,412,425,480）。E6 是本次审计额外探针，不计作仓库测试覆盖。 |
| `lib/core.js`, `lib/store.js`, `lib/index.js`, `scripts/tower-doctor.mjs` | 无（按直接 import 名单） | 无“完全未触达导出”；内部异常/回调分支仍不能据此宣称全覆盖。 |
| `lib/client.js` | ESM 文本扫描为 0，实际 CommonJS exports 为 `apply/inject/missionDependencyState/missionNextStep/missionDependencyDepths` | 全部由 client 测试通过 fake DOM 执行；无完全未触达导出。 |

直接 import 对比的实际输出（关键行）：

```text
lib/errors.js: unimported=assertTower, errorMessage, errorDetails
lib/git.js: unimported=gitOut, repoRoot, head, status, assertClean, isAncestor, changedFiles, rebaseInProgress, localExcludeFile
lib/projection.js: unimported=towerStateSchema
lib/runtime.js: unimported=REVIEW_OUTPUT_SCHEMA
scripts/release.mjs: unimported=ReleaseError, promoteChangelog, atomicWrite, acquireReleaseLock, dirtyWorktreeEntries, runRelease, parseArgs, cliMain
```

V8 聚合实际输出（关键行）：

```text
lib/errors.js: errorDetails@18（0 次）
scripts/release.mjs: lockChangedError@338, currentLockedError@404, restoreQuarantinedLock@412, quarantineStaleLock@425, acquireReclaimLock@480（均 0 次）
lib/git.js / lib/projection.js: completelyUncovered=(none)
```

本次审计对 `errorDetails` 的运行时探针（不是测试套件）输出：`{ code: 'X', message: 'message', details: { a: 1 } }`，说明函数存在且基本可用，但仍无回归契约。

### B2. 错误码/finding code 与选项

执行文本闭集扫描：提取 `new TowerError/ReleaseError`、`assertTower`、doctor `finding/fail` 的字面 code，加动态 code，与 `test/*.test.js` 全文比较。输出：

```json
{"sourceErrorFindingCodeCount":93,"notReferencedByAnyTest":["BASE_CONFLICT","CALLING_AGENT_REQUIRED","CHANGELOG_MISSING","CONFIG_INVALID","GIT_ANCESTRY_FAILED","GIT_CHECK_FAILED","GIT_UNAVAILABLE","GIT_UNEXPECTED_EXIT","INVALID_ARG","INVALID_CURRENT_VERSION","INVALID_DATE","INVALID_PACKAGE_JSON","MAX_TOKENS_INVALID","MISSING_PACKAGE_JSON","MISSING_VALUE","MISSING_VERSION","MISSION_ARTIFACT_CONFLICT","MISSION_EXISTS","MISSION_ID_INVALID","MISSION_MERGED","MODEL_ROUTE_INCOMPLETE","MODEL_ROUTE_NOT_ALLOWED","MODEL_ROUTE_REQUIRED","NO_UNRELEASED","RELEASE_LOCK_FAILED","RELEASE_UNLOCK_FAILED","REPO_CHANGED","REPO_NOT_FOUND","RUNTIME_DISPOSED","RUN_NOT_FOUND","UNKNOWN_ARG","WORKTREE_PATH_INVALID"]}
```

这 **32 个** 是“无码值回归断言”，并非全部“路径完全未执行”。例如 CLI 的非法 flag 实测确实到达 `UNKNOWN_ARG`，但测试没有用该 code 固定契约；`MODEL_ROUTE_INCOMPLETE` 的文案有测试，code 本身未固定。本次独立探针的真实结果：

```json
{"args":{"provider":"p"},"accepted":false,"code":"MODEL_ROUTE_INCOMPLETE"}
{"args":{"max_tokens":0},"accepted":false,"code":"MAX_TOKENS_INVALID"}
{"args":{"max_tokens":1.5},"accepted":false,"code":"MAX_TOKENS_INVALID"}
{"args":{"max_tokens":9007199254740992},"accepted":false,"code":"MAX_TOKENS_INVALID"}
{"args":{"max_tokens":1},"accepted":true,"route":{"provider":"p","model":"m","maxTokens":1}}
```

选项覆盖：tool schema 的 action 有完整一致性测试；doctor `--repo/--state/--json/--fail-on-warning/--help` 均有直接或 CLI 测试；release `--version/--date/--apply/--repo/--json/--create-changelog/--help` 由 release 测试触达。**没有发现完全未触达的 CLI 选项**；但 tool schema 的非 action 参数并非每个都有同等级别契约，camelCase `dependsOn` 能被静默忽略正说明这一缺口。

## C. 测试 → 实现（僵尸断言）

| 检查 | 实测结果 | 判定 |
| --- | --- | --- |
| gate 场景注册 code 是否仍存在 | `node --test test/gate-matrix.test.js` → **16 pass / 0 fail**；`stale=[]` | 未发现僵尸 gate code |
| doctor JSON 白名单 vs 实现 | E14 `missingFromTest:[]`, `extraInTest:[]`，两边均 33 | 未发现僵尸 finding code |
| 文档 action 解析与 schema | `node --test test/docs-consistency.test.js` → **3 pass / 0 fail** | 未发现僵尸 action |
| 测试中的大写 code 候选 | 自动差集报 `ADOPT/AFTERDONE/.../MODEL_NOT_FOUND/...`；逐项定位后均为 fixture id、OS errno、状态标签或外部 LLM adapter mock（`MODEL_NOT_FOUND/NO_ADAPTER/AUTH`），不是本仓库已删除常量 | 未发现可证实的僵尸断言 |
| 输出字段/文案 | `summary.routes`、500 码点、`review_failed`、recover、merge/rebase、事件名均能与现行实现对应；完整套件 416 通过 | 未发现僵尸断言 |

注意：C 不是“所有测试都有效”的结论。A24 的 scale-smoke 事件上限描述就是反例：断言不僵尸，但证明力弱于注释；B 也显示多个错误码只有宽泛消息断言。

## D. 双语一致性

### D1. 两份 README

逐节比对 feature、install、quick start、configure、tool flow、failure recovery、diagnostics/release、limits、development。结构行数接近（英文 175 / 中文 178），示例和 action 枚举相同，绝大多数语义等价。

**唯一确认的实质遗漏组（p2）**：`README.md:112` 只有 “The same values can be passed per spawn”，而 `README.zh-CN.md:115` 还明确：

- `provider` 与 `model` 必须成对；
- `max_tokens` 必须是正整数（实现更严格：正安全整数）。

真实文本探针输出：

```json
{"enHasMaxTokenRule":false,"zhHasMaxTokenRule":true,"enHasPairRule":false,"zhHasPairRule":true,"enHasStateLayout":false,"zhHasStateLayout":true,"enUnicodeCodePoints":true,"zhUnicodeCodePoints":true}
```

其中 `enHasStateLayout:false` 对应中文 README:79-80 额外解释默认 state/branch/worktree 路径；英文 README:11 已含 `.dsh-tower/`，其他维护文档也定义完整布局，故作为**信息详略差异**记录，不单列为错误。上述 pair/max_tokens 规则会直接影响调用成功率，因此判为语义漂移。

### D2. zh/en 字典

`lib/client.js:12-235` 共 **110 对** key（不是先前探针字符串里误写的 111；以实际解析输出 `zhEntries:110,enEntries:110` 为准）。逐对检查状态、依赖、门禁、失败/过期、view scope、模型路由、操作按钮等语义；`test/i18n.test.js` 另执行 **5 pass / 0 fail**。输出：

```json
{"zhEntries":110,"enEntries":110,"identicalKeys":["trigger","missions","verdict","mergeCommit","guideTitle","role.worker","role.reviewer","detail.review","detail.mergeCommit","view.agents"]}
```

10 个相同值均为测试白名单中的产品/技术词；未发现额外未翻译文本、占位符错位、状态含义反转或条件丢失。`locale/en.json` 与 `locale/zh.json` 的 `meta.title/description` 也语义等价（英文 “worker/reviewer model routes” 对应中文“异构 worker/reviewer 模型”）。

## 建议后续 mission

1. **修正 runbook 的可执行样例（p1）**：把 `dependsOn` 改为 `depends_on`；将 3.7 的 `send` 改成“查看子代理会话，或重派新 run”；补 `changes_requested` 的 reviewer/rebase 路径。建议加一个抽取 runbook 调用参数、经 schema 白名单验证的测试，防止未知键静默省略。
2. **同步 summary 与 doctor 契约（p2）**：在 architecture/operations 写清 `routes` 的 bucket 字段、计数、排序与全塔过滤语义；将 doctor 清单补到 33，并把 architecture 与 JSON schema 白名单用自动闭集测试绑定，覆盖多行构造和动态 code。
3. **双语 README 对齐（p2）**：英文配置段补 provider/model 成对和正安全整数 max_tokens；同时说明中文多出的 state/branch/worktree 布局是否要有意保留。考虑对关键安全/参数约束做跨语言锚点测试，而不只检查 UI key。
4. **收紧措辞（p3）**：通知改为“每次落定都会生成并尝试通知；前序失败不吞掉；steer 失败记日志”；scale-smoke 描述改为“预置 200 后保持有界”，若要证明 200 截断，另做真实第 201 次 append 的契约测试。
5. **补测试覆盖缺口（本审计未改测试）**：优先 `errorDetails`；release 陈旧锁回收的代际竞争/恢复路径；Git helpers 与 `gitOut` allowed-nonzero；32 个无码值断言中优先公共 API 的 `BASE_CONFLICT`、`MISSION_ARTIFACT_CONFLICT`、`WORKTREE_PATH_INVALID`、`MODEL_ROUTE_*`、`MAX_TOKENS_INVALID` 和 release/doctor 公共错误码。
6. **拒绝未知工具参数**：长期建议在 tool/核心入口拒绝 `dependsOn` 这类近似拼写，而不是静默忽略；这属于行为变更，应单独设计兼容策略，不在本次只读审计中修改。

## 未完成项

- **A 的“每条具体可验证断言”不是逐自然语言句子的形式化穷举。** 已覆盖任务指定的五类核心契约（选项、退出码/错误码、状态、桶、路径、默认值、数字上限）及发现的相关返回字段；未对所有 UI 描述、恢复建议逐句构造独立端到端场景。未实际执行的细项不声称验证。
- **C 采用白名单/事件/action 闭集 + 大写 code 候选差集 + 全测试运行**，没有对所有对象字段做 AST 级存在性证明；未证实项已标为“未发现”，不是“证明不存在”。
- **D 为人工语义审阅 + 机械 key/placeholder 对照**，未使用独立机器翻译或第二模型复核；除已报告的英文配置遗漏和布局详略外，其余标为“未发现语义漂移”，不是双语言形式化等价证明。
- 一次 `node --test --test-name-pattern='...matrix covers...' test/*.test.js` 的筛选命令得到 32 pass / 1 fail，因为只运行覆盖自检而未运行同文件注册场景；随后完整运行 `node --test test/gate-matrix.test.js` 为 16/16，通过且最终全套件为 416/416。它不是产品回归，故未计为漂移。
- 一次手写覆盖分析命令因 V8 记录 JSON 未完成和聚合 range 形状不一致报 `SyntaxError`/`TypeError`，已跳过无效文件、修正聚合后重跑；上述覆盖结论仅来自最后成功命令。一次手写 doctor 清单正则漏掉多行调用，已修正并由 33 项测试白名单与真实 finding 复核。均不把失败探针的数值当证据。

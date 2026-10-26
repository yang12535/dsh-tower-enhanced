# 0.3.1 红队审计：release 锁 / recover / merge gate

- 审计基线：`a5c0daca2148a853ec797dcd386dffb8bda557c5`
- 审计日期：2026-10-26
- 审计方式：只读审查生产代码；全部攻击均在 `/tmp` 中的 Git 仓库副本和 `mkdtemp` 临时仓库执行，没有改动本 worktree 的生产代码、测试、配置或全局 DSH 数据。
- 实测环境：Node `v24.19.0`，Git `2.43.0`，uid 1000；`/tmp` 文件系统由 `stat -f` 报告为 `ext2/ext3`。
- 辅助脚本：为避免干扰仓库，复现脚本放在 `/tmp/dsh-redteam-m66.2WXZJO/`。下文命令中的 `$AUDIT` 均指该目录；这些脚本不是仓库交付物。所有标为“实际输出”的文本均来自已执行命令，没有编造 NFS、提权或网络环境。

## 结论摘要

**发现 1 个高严重度互斥缺陷、1 个低严重度恢复/诊断缺口；未发现 recover 或 send/interrupt 的越权投递，未发现 gate 绕过审查或 scope 的新路径。**

| 编号 | 严重度 | 结论 | 影响 |
| --- | --- | --- | --- |
| RT-01 | 高 | 活进程持有的 release 锁超过 10 分钟后会被接管；旧进程仍能继续原计划的写入，覆盖另一进程已经成功发布的文件 | 两个进程实际同时处于 apply 临界区；一次成功发布可静默丢失，版本与 changelog 最终被旧计划覆盖 |
| RT-02 | 低 | 已批准但尚未合并的 mission worktree 被外部删除后，gate/merge 抛原始 `GIT_FAILED`，且非终态 teardown 无法对账清理 | 不会错误合并，但没有结构化 block 或原地恢复出口；只能人工诊断并 abandon 后 teardown |
| RT-03 | 条件性高风险；未做真实 NFS 证明 | 在“`open('wx')` 对现存文件不返回 `EEXIST`”的 NFS 故障模型中，锁直接获取成功并覆盖 holder | 若部署在不保证排他创建的 NFS 上，互斥不成立；ext 实测不构成对该场景的排除 |

补充边界（不另计为新缺陷）：

- `recover` 不接管 activation，活跃 run 豁免和 send/interrupt 的五字段归属校验均经实测有效。旧控制器未停就 recover 会被旧控制器的晚到结算覆盖状态，但 [operations.md](operations.md) §3.8 已明确要求先停止旧控制器，且 [security-model.md](security-model.md) §4 已声明跨进程互斥缺失。
- 依赖被 `abandon` 后下游可 merge，是 [architecture.md](architecture.md) §4.6 明示的“已解决”语义，不是绕过。
- 未来时间戳可让锁超时判定停滞；但持有 PID 不存在时仍立即接管。同权限外部进程本来就能直接改写锁或发布文件，因此“伪造 token/pid 可篡改文件”不单独作为安全边界突破。

## 逐项验证

### A. 公共准备与复现约定

代码审查对象包括 [release.mjs](../scripts/release.mjs)、[runtime.js](../lib/runtime.js)、[core.js](../lib/core.js)、[store.js](../lib/store.js)、[git.js](../lib/git.js)，以及 [security-model.md](security-model.md)、[architecture.md](architecture.md)、[operations.md](operations.md)。仓库用 Git 导出而不是直接修改：

```bash
audit_root=$(mktemp -d /tmp/dsh-redteam-m66.XXXXXX)
mkdir "$audit_root/repo"
git archive HEAD | tar -x -C "$audit_root/repo"
git -C "$audit_root/repo" init -b main
git -C "$audit_root/repo" config user.name 'Red Team Audit'
git -C "$audit_root/repo" config user.email 'redteam@example.invalid'
git -C "$audit_root/repo" config commit.gpgsign false
git -C "$audit_root/repo" add -A
git -C "$audit_root/repo" commit -m 'audit fixture baseline'
node --version
git --version
id
stat -f -c 'FILESYSTEM=%T' /tmp
```

实际输出（关键行）：

```text
AUDIT_ROOT=/tmp/dsh-redteam-m66.2WXZJO
[main （根提交） eb95ade] audit fixture baseline
v24.19.0
git version 2.43.0
uid=1000(yangtim) gid=1000(yangtim)
FILESYSTEM=ext2/ext3
```

### 1. release 跨进程锁

#### 1.1 20 个真实并发 apply、dry-run 与 reclaim 锁

**攻击方法。** `$AUDIT/release-attacks.mjs` 为每个用例创建真实临时 Git 仓库，直接启动 20 个 `node scripts/release.mjs --apply` 子进程；另以 dry-run、存活/死亡 holder 和存活 reclaim 锁测试。并发用例对应命令：

```bash
node "$AUDIT/release-attacks.mjs" "$AUDIT/repo"
```

辅助脚本中的核心调用（每次均使用不同版本/日期或新仓库，不复用脏 fixture）：

```js
const children = Array.from({ length: 20 }, () => spawn(process.execPath, [
  script, '--repo', repo, '--version', '0.2.0',
  '--date', '2026-10-26', '--json', '--apply',
], { stdio: ['ignore', 'pipe', 'pipe'] }));
const results = await Promise.all(children.map(/* collect stdout/stderr/status */));
```

实际输出：

```text
CONCURRENT {"OK":1,"RELEASE_LOCKED":10,"DIRTY_WORKTREE":0,"VERSION_NOT_GREATER":9,"VERSION_ALREADY_RELEASED":0,"locks":[]}
DRY_RUN {"status":0,"dryRun":true,"locks":[]}
LIVE_FRESH {"holderAlive":true,"status":1,"code":"RELEASE_LOCKED","locks":["release-apply.lock"]}
DEAD_FRESH {"holderAlive":false,"status":0,"code":"OK","notice":"Taking over stale release lock ...: holder pid 999999 no longer exists.","locks":[]}
```

另一个独立 Node heredoc 同时写入死 holder 主锁与当前 PID 的活 reclaim 锁，再执行真实 CLI（核心命令为 `spawnSync(process.execPath, [script, '--repo', repo, '--version', '0.2.0', '--date', '2026-10-26', '--json', '--apply'])`）：

```text
LIVE_RECLAIM_LOCK {"status":1,"payload":{"ok":false,"code":"RELEASE_LOCKED","message":"RELEASE_LOCKED: ... release-apply.reclaim.lock ..."},"main":"dead-main","reclaim":"live-reclaim","artifacts":["release-apply.lock","release-apply.reclaim.lock"]}
```

**判定。** 这些路径**未发现新缺陷**。互斥时恰有一个成功；后到的进程也可能在锁释放后看到已更新版本，得到 `VERSION_NOT_GREATER`，这与测试允许的竞争结果一致。dry-run 不创建锁；活 reclaim 锁阻止主锁接管；成功后无锁残留。

#### 1.2 RT-01：活 holder 超时接管导致两个发布者交叠写

**复现一：不改源码的超时判定。** 在锁 JSON 中保留当前存活 PID，只把 timestamp 分别设为现在与 `Date.now() - 601_000`，然后运行真实 CLI：

```js
writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp, token: 'forged' }));
spawnSync(process.execPath, [script, '--repo', repo, '--version', '0.2.0',
  '--date', '2026-10-26', '--json', '--apply']);
```

实际输出（同一条完整 harness 命令的其余行）：

```text
LIVE_FRESH {"holderAlive":true,"status":1,"code":"RELEASE_LOCKED","locks":["release-apply.lock"]}
LIVE_EXPIRED {"holderAlive":true,"status":0,"code":"OK","notice":"Taking over stale release lock ...: lock is at least 10 minutes old.","locks":[]}
```

**复现二：证明实际丢失一次成功发布。** 执行：

```bash
node "$AUDIT/live-lock-orchestrator.mjs" "$AUDIT/repo" "$AUDIT/live-holder.mjs"
```

`live-holder.mjs` 导入未修改的 `acquireReleaseLock / computePlan / applyPlan`，真实取得锁并计算 `0.1.0 -> 0.3.0` 计划，模拟其在临界区内暂停超过 10 分钟；orchestrator 启动另一个真实 CLI 发布 `0.2.0`，确认成功后再让旧 holder 调用原始 `applyPlan` 和 `release()`。除把锁 timestamp 改成 10 分钟前外，不修改任何生产函数。实际输出：

```text
COMPETITOR 0 {"ok":true,"dryRun":false,"lockNotice":"Taking over stale release lock ...: lock is at least 10 minutes old.","currentVersion":"0.1.0","nextVersion":"0.2.0",...}
VERSION_AFTER_COMPETITOR 0.2.0
LIVE_OVERLAP_FINAL {"aliveBefore":true,"oldHolderExit":0,"aliveAfter":false,"finalVersion":"0.3.0","hasCompetitorSection":false,"hasOldHolderSection":true,"artifacts":[],"holderOutput":""}
```

**判定。** **确认是高严重度 bug，不只是理论窗口或文字问题。** 第二进程已经成功返回后，第一进程仍能覆盖 `package.json` 与 `CHANGELOG.md`；`0.2.0` 段消失，最终无锁文件提示异常。根因是 [release.mjs](../scripts/release.mjs) 的 `inspectStaleLock` 使用 `processGone || expired`，且锁只在创建时写时间，没有区分“崩溃遗留”与“仍在运行但耗时较长”。

**影响面。** 任何一次 apply（包括卡在 Git/文件系统或被人为暂停）超过 10 分钟，另一个正常 `--apply` 都可能接管；跨文件非事务写入会进一步放大覆盖风险。PID 伪造不是利用前提，正常长任务自然可触发。

**建议修复方向。** 不要仅凭“锁龄 >= 10 分钟”接管仍可探测到的活 PID。短期优先采用“PID 存在即不自动接管，仅 `ESRCH` 回收；超龄活锁要求人工确认”，并同步运维文档。若必须支持自动超时，应增加 holder 心跳和进程启动身份/随机实例凭据，接管后让旧 holder 在写入前验证代际，而不能只靠 finally 的 token 保护；单纯缩短/延长 10 分钟阈值不能修复。

#### 1.3 token 不匹配、rename/unlink 交错与外部伪造 PID

**攻击方法。** 执行 `node "$AUDIT/release-attacks.mjs" "$AUDIT/repo"`；其中：

1. 真取锁后把原锁 rename 到快照路径，原位写入 `foreign-token`，调用旧 holder 的 `release()`；
2. 在子进程首次读取主锁后注入一次 `unlinkSync`，随后继续原始 `acquireReleaseLock`，覆盖“检查后、rename 前锁消失”的交错；
3. 伪造 PID `999999` 与当前 PID，分别测试死亡/存活 holder。

实际输出：

```text
TOKEN_MISMATCH_RELEASE {"preserved":true,"current":"foreign-token","locks":["release-apply.lock","release-apply.lock.old-holder-snapshot"]}
RENAME_UNLINK_INTERLEAVE {"status":0,"result":{"code":"ACQUIRED"},"locks":[]}
DEAD_FRESH {"holderAlive":false,"status":0,"code":"OK","notice":"... holder pid 999999 no longer exists.","locks":[]}
```

**判定。** **未发现误删他人锁或 unlink 交错下双持锁。** token 不同即保留外部新锁，实验留下的 `.old-holder-snapshot` 是攻击脚本自己制造的文件，不是 release 泄漏；锁消失后由 `wx` 重新仲裁，最终成功且无残留。死 PID 可立即接管符合设计。伪造 PID 本身不代表突破了同权限文件系统边界。

#### 1.4 时钟回拨、未来时间戳

**攻击方法。** 执行 `node "$AUDIT/release-attacks.mjs" "$AUDIT/repo"`，分别写入未来一天的 timestamp，并搭配活 PID 或死 PID，再执行真实 CLI。

实际输出：

```text
CLOCK_FUTURE {"status":1,"code":"RELEASE_LOCKED","lockAgeMs":-86399972,"message":"RELEASE_LOCKED: another release apply ..."}
CLOCK_FUTURE_DEAD_PID {"status":0,"code":"OK","notice":"Taking over stale release lock ...: holder pid 999999 no longer exists."}
```

**判定。** **确认判定局限，但不是独立于 RT-01 的新写破坏。** `Date.now() - createdAt` 对未来时间为负，锁龄可能永远不达到阈值；时钟向前跳则会提前触发 RT-01。建议用单调时钟维护进程内锁龄，并为持久化锁记录可校验的创建时间/心跳；跨进程恢复仍需以活 PID/实例身份为主，不应信任单独墙钟。

#### 1.5 只读 gitdir、只读根目录与 EROFS 写入

**攻击方法。** 对临时仓库 `.git` 执行 `chmod 0500` 后跑真实 CLI，再恢复 `0700`；对仓库根目录只读时跑 dry-run。另在 `/tmp` 辅助进程中仅对名称包含 `.release-tmp-` 的 `fs.writeFileSync` 注入 `EROFS`，调用原始 `runRelease`，模拟原子写阶段遇到只读文件系统。

```bash
node "$AUDIT/release-attacks.mjs" "$AUDIT/repo"
git -C /tmp/m66-release-attacks-2T9Kvt/future reset --hard
node "$AUDIT/erofs-target.cjs" /tmp/m66-release-attacks-2T9Kvt/future
```

实际输出：

```text
READONLY_GITDIR {"status":1,"payload":{"ok":false,"code":"RELEASE_LOCK_FAILED","message":"cannot create release lock ...: EACCES: permission denied, open '.../release-apply.lock'"},"locks":[]}
READONLY_ROOT_DRY_RUN {"status":0,"dryRun":true,"locks":[]}
{"code":"WRITE_FAILED","message":"failed to write package.json: EROFS: read-only file system, injected; no files had been written yet","blockedWrites":1,"locks":[]}
```

**判定。** **未发现失败后继续写或锁泄漏。** 不可写 gitdir 明确失败；只读目录不妨碍 dry-run；EROFS 在第一份文件写入前失败并释放锁。这里 EROFS 是定点故障注入，不声称完成了内核级只读挂载测试。

#### 1.6 RT-03：NFS 排他创建语义（故障模型，非真实 NFS 挂载）

**攻击方法。** 本机没有可用 NFS 服务端，因此没有声称做 NFS 挂载实测。`$AUDIT/nfs-acquire.cjs` 先在临时仓库写入当前活 PID 的锁，再只对主锁的 `openSync(path, 'wx')` 注入“改为 `'w'` 打开现存文件”的模型，其余获取逻辑仍执行原始 `acquireReleaseLock`：

```bash
node "$AUDIT/nfs-acquire.cjs" /tmp/m66-release-attacks-2T9Kvt/futuredead
```

实际输出：

```text
{"intercepted":1,"result":"ACQUIRED_WITHOUT_RELEASE_LOCKED","notice":null,"tokenAfter":"691250-1792988657712-12im6m0sl5g"}
```

**判定。** 在 `O_EXCL` 不生效的模型下**确认互斥被绕过**；但这不是对所有 NFS 配置的结论，ext 的真实并发成功也不能证明 NFS 安全。影响面是共享 gitdir 且文件系统不保证排他创建/原子 rename 的部署。

**建议修复方向。** 文档明确只支持具有可靠 `O_EXCL` 与原子 rename 的本地文件系统；启动时做排他语义自检。需要支持 NFS 时，应在目标 NFS 服务端做独立集成测试并选用有明确一致性保证的锁服务，而不是把本地文件锁假设扩展为分布式锁保证。

### 2. recover 与旧控制器竞态

#### 2.1 活跃 activation 与僵尸混杂、绝不 adopt

**复现命令。**

```bash
# 仅为 /tmp 副本提供本机已有依赖；没有安装依赖
ln -s /home/yangtim/dsh-tower-enhanced/node_modules "$AUDIT/repo/node_modules"
node "$AUDIT/recover-attacks.mjs" "$AUDIT/repo"
```

辅助脚本使用真实 `TowerCore`、真实 `TowerRuntime` 和临时 Git worktree；只有 subagent 宿主服务是可控 stub。一个 zombie 来自旧 Session 的真实 `beginSpawn/attachSpawn`，另一个 live worker 通过 `runtime.execute({action:'spawn'})` 注册进真实 `active` map，然后执行 `recover`。

实际输出：

```text
MIXED_LIVE_ZOMBIE {"recovered":[{"mission":"ZOMBIE","role":"worker","runId":"cf8d390f-..."}],"missions":{"ZOMBIE":{"status":"worker_failed","runId":"cf8d390f-...","stopReason":"aborted"},"LIVE":{"status":"worker_running","runId":"af285c0e-..."}},"active":["af285c0e-..."],"started":1}
LIVE_AFTER_RECOVER {"sent":true,"childId":"new-1"}
```

`FORGED_ACTIVE_RUNID` 额外直接调用内部 `core.recover(new Set([begun.runId]))`，验证豁免的精确依据：

```text
FORGED_ACTIVE_RUNID {"forgedRecovered":[],"statusAfterForgedExemption":"worker_running","realRecovered":[{"mission":"M1","role":"worker","runId":"b91a4009-..."}],"statusAfterRealRecovery":"worker_failed"}
```

**判定。** **未发现误清理真实活跃 run，未发现 adopt。** recover 只回收 runId 不在本 core 活跃集合中的记录，未启动新 activation，活跃记录和 runId 不变。直接传伪造 activeRunIds 当然能豁免 zombie，但这是内部信任输入；公开 runtime 路径从 `this.active` 构造集合，没有让调用方传 runId 的入口。

#### 2.2 旧控制器仍在写 state：recover 返回值被后续状态推翻

**攻击方法。** 两个 `TowerCore` 实例指向同一真实仓库：旧 core 保留 running run，新 core 执行 recover；随后旧 core 对原 run 执行 `completeSpawn`。这不是 mock state，而是两个真实 store 的顺序写。

实际输出：

```text
OLD_CONTROLLER_LATE_WRITE {"recoverReturned":[{"mission":"M1","role":"worker","runId":"e04114b8-..."}],"statusAtReturn":"worker_failed","stopReasonAtReturn":"aborted","statusAfterLateCompletion":"worker_completed","stopReasonAfterLateCompletion":"completed","lateEvent":5}
```

**判定。** **确认“recover 返回值只代表落账时状态”，但没有把已文档化的双控制器误用重新包装为新漏洞。** 旧 core 合法地将自己的激活结算为 `worker_completed`，推翻刚才的 `worker_failed`。影响是可派生/审查流程被旧控制器继续推进，且并发写入还可能有丢失更新；文档明确要求 recover 前确认旧进程停止。建议后续增加跨进程 controller lease 或在状态写入中校验 controller incarnation；在这些能力落地前，不得把 recover 当作停止旧进程的手段。

#### 2.3 role 记录被改坏、终态残留与返回一致性

**攻击方法。** 执行 `node "$AUDIT/recover-attacks.mjs" "$AUDIT/repo"`，通过 `core.store.update` 写入 schema 合法但语义异常的记录：把 `worker_running` 改成 `review_running`，把 worker 记录复制为 review 并附伪造 childId；另把状态改为 `abandoned` 但保留 running-like record，再 recover。

实际输出：

```text
CORRUPTED_ROLE_RECORD {"recovered":[{"mission":"M1","role":"reviewer","runId":"ae84ef0b-..."}],"status":"review_failed","stale":true,"stopReason":"aborted"}
TERMINAL_LEFTOVER_RECORD {"recovered":[],"status":"abandoned"}
```

**判定。** **未发现 recover 接管或误发控制命令。** 当前实现按 mission status 选择角色，因此改坏的 `review_running` 会按 reviewer 标记失败；终态残留记录不改。返回的 `recovered` 与实际落账一致（§2.2 的旧控制器后续覆盖除外）。这属于损坏状态处置，不是状态真实性证明；[store.js](../lib/store.js) 本来也不声称能抵御同权限人工篡改。

### 3. send / interrupt 五字段归属与状态校验

**攻击方法。** 执行 `node "$AUDIT/recover-attacks.mjs" "$AUDIT/repo"`，在 §2 的同一真实 runtime harness 中分别破坏持久化 runId、active entry 的 core、missionId、childId，选择错误 role，以及把 mission 改为 `merged`。每个失败用例均记录底层 stub 调用计数，随后恢复精确绑定再调用成功路径。

实际输出（runId 缩短展示，不改变结果字段）：

```text
CONTROL_DENIALS [
 {"label":"FORGED_RUN_ID_STATE","code":"AGENT_NOT_RUNNING","sendCalls":0,"interruptCalls":0},
 {"label":"ROLE_MISMATCH","code":"AGENT_NOT_RUNNING","message":"mission M1 has no attached reviewer","sendCalls":0,"interruptCalls":0},
 {"label":"TERMINAL_STATE","code":"AGENT_NOT_RUNNING","message":"mission M1 is merged, not worker_running","sendCalls":0,"interruptCalls":0},
 {"label":"CROSS_CORE_INSTANCE","code":"AGENT_NOT_RUNNING","sendCalls":0,"interruptCalls":0},
 {"label":"MISSION_ID_MISMATCH","code":"AGENT_NOT_RUNNING","sendCalls":0,"interruptCalls":0},
 {"label":"CHILD_ID_MISMATCH","code":"AGENT_NOT_RUNNING","sendCalls":0,"interruptCalls":0},
 {"label":"FORGED_EXTRA_ACTIVE_KEY","result":"SUCCESS_TO_ORIGINAL","runId":"29b7fb14-...","childId":"real-child"}
]
CONTROL_EXACT_SUCCESS {"sent":true,"interrupted":true,"sendCalls":["real-child","real-child"],"interruptCalls":["real-child"]}
```

**判定。** **未发现伪造 runId、跨 core、终态或 role/字段不匹配导致误投递。** 每个拒绝路径的 send/interrupt 调用均为 0。额外塞入一个伪造 active map key 不影响原精确 entry：消息仍发向原 runId 和 `real-child`，不是发给伪造对象。`controlAddress` 的 core、runId、missionId、role、childId 五字段核对均有效。

### 4. mergeGate 与状态机

#### 4.1 base 前移、reviewed tip 已在 base、多个 block 不互相遮蔽

**复现命令。**

```bash
node "$AUDIT/gate-attacks.mjs" "$AUDIT/repo"
```

每个场景创建真实 base、真实 mission worktree/commit，并通过 `beginSpawn/completeSpawn` 产生 `clean + merge=true` 审查记录。base 用独立 Git commit 前移，或 `git merge --ff-only <reviewed-tip>` 包含 reviewed tip。

实际输出：

```text
BASE_ADVANCED {"gateBlocks":["STALE_BASE","REVIEW_BASE_STALE"],"ready":false,"mergeReturned":false,"mergeBlocks":["STALE_BASE","REVIEW_BASE_STALE"],"baseUnchanged":true,...}
BASE_CONTAINS_REVIEWED {"gate":{"ready":false,"alreadyMerged":true,"warnings":["NO_CHANGE","REVIEW_BASE_STALE"]},"merge":{"merged":true,"reconciled":true,"advanced":false},"head":"96c4550b...","reviewedTip":"96c4550b..."}
MULTI_BLOCK {"ready":false,"blocks":["BASE_DIRTY","BASE_MISMATCH","WORKTREE_DIRTY","REVIEW_TIP_STALE"],"observations":{"baseDirty":true,"worktreeDirty":true,"changedFiles":["docs/extra.md","docs/feature.md"]}}
```

**判定。** **未发现 base 前移后沿用旧审查合并。** base 不包含 reviewed tip 时同时报 `STALE_BASE` 和 `REVIEW_BASE_STALE`，merge 返回 false；base 已包含 exact reviewed SHA 且 tip 未动时走 `alreadyMerged` 对账，没有第二次合并。多个独立问题会同时报告。

#### 4.2 scope 通配符绕过尝试

**攻击方法。** 执行 `node "$AUDIT/gate-attacks.mjs" "$AUDIT/repo"`，对同一真实审核流程分别声明 `docs/**`、`*.js`、`src/*`、`**`，在 scope 外或跨目录提交 `lib/evil.js`、`src/lib/evil.js`，读取 gate 的 `changedFiles` 与 blocks。

实际输出：

```text
IN_SCOPE {"scope":["docs/**"],"changedFiles":["docs/pass.md"],"ready":true,"blocks":[]}
OUTSIDE_NARROW_SCOPE {"scope":["docs/**"],"changedFiles":["lib/evil.js"],"ready":false,"blocks":["OUT_OF_SCOPE"]}
ROOT_GLOB_NOT_RECURSIVE {"scope":["*.js"],"changedFiles":["lib/evil.js"],"ready":false,"blocks":["OUT_OF_SCOPE"]}
SINGLE_STAR_NOT_RECURSIVE {"scope":["src/*"],"changedFiles":["src/lib/evil.js"],"ready":false,"blocks":["OUT_OF_SCOPE"]}
DOUBLE_STAR_INTENTIONALLY_ALL {"scope":["**"],"changedFiles":["lib/evil.js"],"ready":true,"blocks":[]}
```

**判定。** **未发现窄 pattern 跨目录放行。** `*` 不匹配路径分隔符；`**` 是显式全放行，与空 scope 一样属于调用方选择的宽授权，不是绕过。scope 只在 gate 做事后检查，worker 执行期间不作文件系统沙箱，这仍是 [security-model.md](security-model.md) 已声明的边界。

#### 4.3 依赖 abandon 后 merge

**攻击方法。** 执行 `node "$AUDIT/gate-attacks.mjs" "$AUDIT/repo"`，先创建 `DOWN dependsOn:['DEP']`，此时 gate 检查未解决依赖；随后 `abandon('DEP')`，再让 DOWN 正常完成 worker 和 clean review，最后 gate/merge。

实际输出：

```text
ABANDONED_DEPENDENCY {"before":{"ready":false,"blocks":["NOT_APPROVED","DEPENDENCIES_NOT_MERGED","NO_CHANGE","NO_CLEAN_REVIEW"]},"after":{"ready":true,"blocks":[]},"merged":true,"dependency":"abandoned","downstream":"merged"}
```

**判定。** **不是 bug：与明示设计一致。** `merged` 和 `abandoned` 都是依赖终态。若产品真正想表达“必须合入依赖产物”而不是“依赖不再阻塞”，需要改变依赖模型，而不是把当前行为称为 gate 绕过。

#### 4.4 RT-02：外部删除 worktree 与正常 teardown 的差异

**攻击方法。** 执行 `node "$AUDIT/gate-attacks.mjs" "$AUDIT/repo"`；已 approved 的 mission 保持 `worktreeRemoved:false`，在临时仓库执行真实 `git worktree remove <path>`，随后调用 gate、merge、teardown；另一个 mission 正常 merge 后 teardown，再调用 gate。

实际输出：

```text
EXTERNAL_WORKTREE_DELETE {"gate":{"threw":"GIT_FAILED","message":"git status ... failed (128): fatal: cannot change to '.../externalremove/.dsh-tower/worktrees/m1': No such file or directory\n"},"merge":{"threw":"GIT_FAILED","message":"git status ... failed (128): ... No such file or directory\n"},"status":"approved","worktreeRemoved":false,"teardown":[{"mission":"M1","removed":false,"reason":"status-approved"}]}
TEARDOWN_REMOVED_GATE {"teardown":[{"mission":"M1","removed":true}],"ready":false,"blocks":["NOT_APPROVED","WORKTREE_REMOVED"]}
```

**判定。** **确认低严重度恢复/可诊断性缺口，不是未经审查合并。** Git 层失败阻止 merge，状态保持 approved，故没有内容安全绕过；但外部删除与显式 `WORKTREE_REMOVED` 走不同路径，错误未转成 gate block，且 [operations.md](operations.md) §3.5 建议的 teardown 对账只适用于终态 mission，不能直接用于这个 approved mission。

**影响面与修复方向。** 用户需人工辨认 `GIT_FAILED`，再选择 abandon + teardown 或恢复 worktree。建议 gate/merge 对缺失 worktree 返回专门结构（例如 `WORKTREE_MISSING`，包含 observed path 与 recovery hint），merge 在 Git 执行前保持失败；另外提供显式、可审计的非终态 worktree 丢失恢复动作，而不是放宽 teardown 删除策略。必须继续区分“目录确实不存在”与“暂时不可读/权限失败”，后者不能标记为已移除。

#### 4.5 12 个 block code 与状态机不可达分支

**复现命令。** 在 `/tmp` 仓库副本执行仓库现有、不 mock Git 的测试：

```bash
cd "$AUDIT/repo"
node --test test/state-machine.test.js test/gate-matrix.test.js
```

实际输出（末段；前面逐条均为 `✔`）：

```text
✔ the matrix covers every block code emitted by evaluateMergeGate
✔ state matrix invariant: every valid status has an exhaustive spawn-guard classification
ℹ tests 106
ℹ suites 0
ℹ pass 106
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9056.556012
```

**判定。** **未发现合法状态绕过到未经审查 merge 的分支。** 12 个 gate code 均有真实场景，12 状态 × 7 动作全部通过。`WORKER_START_BLOCKED` 的防御分支在合法枚举状态下不可达，现有 invariant 对此有显式测试；`NO_CHANGE`、`STALE_BASE` 等 block 的组合不是漏检。RT-02 是外部文件系统事实导致的异常恢复缺口，不改变这一结论。

### 5. 完整仓库回归

在审计 worktree 中执行 `pnpm test`，确认 `/tmp` 攻击没有污染生产代码或测试：

```text
ℹ tests 402
ℹ suites 0
ℹ pass 402
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10390.244948
```

实际测试数为当前基线的 402；任务说明提到的 406 与本分支真实输出不一致，本报告以实测数字为准。

## 建议后续 mission

### M-A：禁止接管仍存活的长时 release holder（高优先级）

- **范围建议**：`scripts/release.mjs`、`test/release-concurrency.test.js`、`docs/security-model.md`、`docs/operations.md`。
- 将“过期”与“holder 消失”拆开：默认只有 `ESRCH` 才自动接管，超龄活 PID 返回带明确诊断的 `RELEASE_LOCKED`，不自动争抢。
- 新增真实双进程回归：holder 暂停超过阈值且 PID 存活，竞争者必须失败；holder 恢复后其写入不能被另一个成功 apply 静默覆盖。覆盖时钟向前/向后与 PID 复用说明。
- 若产品坚持自动接管长任务，先提出 heartbeat + 进程实例身份 + 写前代际复核设计及故障测试，不允许只调整超时值。
- **验收**：RT-01 的两个进程测试不再出现两个成功者交叠写；现有并发、stale dead-PID、token 与 reclaim 测试全绿。

### M-B：为外部缺失的非终态 worktree 增加结构化诊断和显式恢复（低优先级）

- **范围建议**：`lib/core.js`、`lib/git.js`、`test/gate-matrix.test.js`、`test/core.test.js`、`docs/architecture.md`、`docs/operations.md`。
- gate/merge 将“路径不存在”与 EACCES/其它 Git 故障区分，返回明确缺失状态与下一步，不泄漏为难以分类的 `GIT_FAILED`。
- 设计非终态恢复出口：优先指导恢复原 worktree；确需放弃时走显式 abandon 后 teardown 对账。不要自动重建并沿用旧 review，也不要把权限失败标为 removed。
- **验收**：RT-02 场景不执行 merge，返回稳定结构；正常 teardown、外部删除、权限失败均有独立回归。

### M-C：为 Tower 增加跨进程 controller incarnation / lease（中长期）

- **范围建议**：`lib/runtime.js`、`lib/store.js`、`lib/core.js`、恢复与状态测试、架构和运维文档。
- 持久化控制器代际，拒绝旧代际在 recover 后继续写 state；lease 应处理进程崩溃、时钟与续租失败，不得简单复用 RT-01 的“超时即抢锁”。
- 增加两个真实控制器进程竞争、旧控制器晚到 complete/fail、recover 幂等和活跃 activation 豁免测试。
- **验收**：旧控制器的晚到写入不能推翻新控制器的恢复；本 runtime 的活跃 run 不被误清理；recover 仍不 adopt。

### M-D：声明并测试 release 文件系统前置条件（防御性）

- **范围建议**：`docs/operations.md`、`docs/security-model.md`、必要的 release 启动检查与独立集成测试。
- 明确只支持可靠排他创建和原子 rename 的文件系统；不要把 ext 的 20 进程结果当作 NFS 证明。
- 在可控 NFS 服务端/客户端环境验证 `O_EXCL`、rename/link、权限与故障恢复；若不准备支持 NFS，文档明确拒绝该部署并给出诊断。
- **验收**：支持矩阵有真实环境证据；故障注入与真实 NFS 结果分开记录，失败时不会假装获得互斥。

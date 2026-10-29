window.__ModuleLoader__.load({
  id: "dsh-tower-enhanced/client",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const { jsx, jsxs, Fragment } = require("react/jsx-runtime");
    const React = require("react");
    const ReactDOM = require("react-dom");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const NS = "tower-enhanced";
    const zh = {
  "trigger": "Tower",
  "loading": "正在加载 Tower 状态…",
  "unavailable": "当前会话还没有 Tower 状态。运行 tower init 后，这里会显示任务和各子代理的模型。",
  "guideTitle": "Tower",
  "guideDescription": "查看 Tower 任务、子代理与模型用量",
  "notSpawned": "尚未派生",
  "status.pending": "待开始",
  "status.worker_running": "执行中",
  "status.worker_completed": "执行完成",
  "status.worker_failed": "执行失败",
  "status.review_running": "审查中",
  "status.review_failed": "审查失败",
  "status.changes_requested": "需要修改",
  "status.approved": "已通过",
  "status.rebase_blocked": "变基受阻",
  "status.merge_blocked": "合并受阻",
  "status.merged": "已合并",
  "status.abandoned": "已放弃",
  "role.worker": "执行",
  "role.reviewer": "审查",
  "agent.running": "运行中",
  "agent.done": "已完成",
  "agent.failed": "失败",
  "agent.reviewDone": "审查通过",
  "agent.interrupted": "已中断",
  "agent.stale": "结果已过期",
  "agent.changes_requested": "需要修改",
  "agent.unknown": "状态未知",
  "agent.stopReason.completed": "正常结束",
  "agent.stopReason.error": "出错",
  "agent.stopReason.aborted": "已中止",
  "agent.modelUnknown": "模型未记录",
  "agent.open": "对话",
  "agent.selected": "已打开",
  "agent.openFailed": "无法确认这个子代理的归属，暂时不能打开对话。",
  "agent.resumed": "续接",
  "scope.mine": "只看本会话",
  "scope.agentHint": "当前子代理的记录",
  "scope.empty": "本会话没有派生 Tower 子代理。",
  "scope.showAll": "查看全部任务",
  "filter.label": "按状态筛选",
  "filter.all": "全部",
  "filter.running": "进行中",
  "filter.open": "待处理",
  "filter.merged": "已合并",
  "filter.abandoned": "已放弃",
  "filter.empty": "没有符合条件的任务。",
  "section.history": "历史",
  "detail.title": "详情",
  "detail.description": "任务说明",
  "detail.branch": "分支",
  "detail.previousRun": "上次运行",
  "detail.sessionSeq": "会话序号",
  "detail.result": "结果",
  "detail.checks": "检查项",
  "detail.commit": "提交",
  "detail.reviewed": "审查提交",
  "detail.merge": "合并提交",
  "pending.starting": "正在创建会话",
  "mission.empty": "还没有任务。运行 tower add 创建第一个任务。",
  "mission.deps": "依赖",
  "mission.depMissing": "缺失",
  "mission.depJoin": "、",
  "mission.next": "下一步",
  "mission.gate": "合并门禁",
  "mission.gateReady": "状态就绪",
  "mission.gateHint": "只含状态检查；工作区不干净、基线漂移、超出范围、基线变化导致审查过期等 git 检查仍以 tower gate 为准",
  "next.waitDeps": "等待依赖 {ids} 合并",
  "next.spawnWorker": "待派生执行代理",
  "next.workerRunning": "执行代理工作中",
  "next.reviewRunning": "审查代理审查中",
  "next.awaitReview": "待审查：派生审查代理检查执行提交",
  "next.reviewStale": "审查结果已过期：核对基线后重新审查",
  "next.retryReview": "审查失败，请重试审查",
  "next.reviewFailed": "审查失败，可重新派审查或执行代理",
  "next.rework": "需返工并重新审查",
  "next.canMerge": "可合并：等待 tower merge",
  "next.merged": "已合并",
  "next.rebaseManual": "需人工处理：变基冲突待解决",
  "next.mergeManual": "需人工处理：合并受阻待排查",
  "next.workerFailed": "执行失败，可重新派生",
  "next.abandoned": "已放弃",
  "next.unknown": "状态未知，等待 Tower 状态更新",
  "usage.title": "模型用量",
  "usage.colModel": "模型 · 次数",
  "usage.colRank": "排行",
  "usage.colTokens": "token",
  "usage.runs": "{count} 次",
  "usage.summary": "{runs} 次 · {tokens}",
  "usage.unknownTokens": "{count} 个会话的用量未加载",
  "usage.more": "+{count} 个模型"
};
    const en = {
  "trigger": "Tower",
  "loading": "Loading Tower state…",
  "unavailable": "No Tower state in this session yet. Run tower init to see missions and each subagent's model.",
  "guideTitle": "Tower",
  "guideDescription": "Inspect Tower missions, subagents, and model usage",
  "notSpawned": "Not spawned",
  "status.pending": "Pending",
  "status.worker_running": "Worker running",
  "status.worker_completed": "Worker completed",
  "status.worker_failed": "Worker failed",
  "status.review_running": "Review running",
  "status.review_failed": "Review failed",
  "status.changes_requested": "Changes requested",
  "status.approved": "Approved",
  "status.rebase_blocked": "Rebase blocked",
  "status.merge_blocked": "Merge blocked",
  "status.merged": "Merged",
  "status.abandoned": "Abandoned",
  "role.worker": "Worker",
  "role.reviewer": "Reviewer",
  "agent.running": "Running",
  "agent.done": "Done",
  "agent.failed": "Failed",
  "agent.reviewDone": "Review approved",
  "agent.interrupted": "Interrupted",
  "agent.stale": "Outdated result",
  "agent.changes_requested": "Changes requested",
  "agent.unknown": "Unknown status",
  "agent.stopReason.completed": "Completed",
  "agent.stopReason.error": "Error",
  "agent.stopReason.aborted": "Aborted",
  "agent.modelUnknown": "Model not recorded",
  "agent.open": "Chat",
  "agent.selected": "Opened",
  "agent.openFailed": "Cannot establish this subagent’s parent session to open its conversation.",
  "agent.resumed": "Resumed",
  "scope.mine": "This session only",
  "scope.agentHint": "This subagent’s own record",
  "scope.empty": "This session has not created any Tower subagents.",
  "scope.showAll": "Show all missions",
  "filter.label": "Filter by status",
  "filter.all": "All",
  "filter.running": "Running",
  "filter.open": "Open",
  "filter.merged": "Merged",
  "filter.abandoned": "Abandoned",
  "filter.empty": "No missions match this filter.",
  "section.history": "History",
  "detail.title": "Details",
  "detail.description": "Description",
  "detail.branch": "Branch",
  "detail.previousRun": "Previous run",
  "detail.sessionSeq": "Session sequence",
  "detail.result": "Result",
  "detail.checks": "Checks",
  "detail.commit": "Commit",
  "detail.reviewed": "Reviewed commit",
  "detail.merge": "Merge commit",
  "pending.starting": "Creating session",
  "mission.empty": "No missions yet. Run tower add to create the first one.",
  "mission.deps": "Depends on",
  "mission.depMissing": "missing",
  "mission.depJoin": ", ",
  "mission.next": "Next step",
  "mission.gate": "Merge gate",
  "mission.gateReady": "Ready (state checks)",
  "mission.gateHint": "Covers state checks only; git checks for a dirty base, base drift, out-of-scope changes, and reviews made stale by base changes remain with tower gate",
  "next.waitDeps": "Waiting for {ids} to merge",
  "next.spawnWorker": "Spawn the worker",
  "next.workerRunning": "Worker in progress",
  "next.reviewRunning": "Review in progress",
  "next.awaitReview": "Await review: spawn a reviewer for the worker commit",
  "next.reviewStale": "Review result is stale; check the synced baseline, then review again",
  "next.retryReview": "Review failed; retry the review",
  "next.reviewFailed": "Review failed; respawn a reviewer or worker",
  "next.rework": "Rework required, then re-review",
  "next.canMerge": "Ready to merge via tower merge",
  "next.merged": "Merged",
  "next.rebaseManual": "Manual action needed: resolve the rebase conflict",
  "next.mergeManual": "Manual action needed: merge is blocked",
  "next.workerFailed": "Worker failed; may respawn",
  "next.abandoned": "Abandoned",
  "next.unknown": "Unknown status; waiting for Tower state",
  "usage.title": "Model usage",
  "usage.colModel": "Model · runs",
  "usage.colRank": "Rank",
  "usage.colTokens": "Tokens",
  "usage.runs": "{count} runs",
  "usage.summary": "{runs} runs · {tokens}",
  "usage.unknownTokens": "Usage not loaded for {count} sessions",
  "usage.more": "+{count} more models"
};

    const css = "\n.Tw_root{position:relative}\n.Tw_trigger{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:none;border:0;border-radius:6px;align-items:center;gap:5px;padding:3px 7px;font-size:12px;display:inline-flex}\n.Tw_trigger:hover{color:var(--dsw-alias-label-primary)}\n.Tw_panel{z-index:100;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);width:min(440px,100vw - 32px);max-height:min(760px,100vh - 32px);box-shadow:var(--dsw-elevation-prominent);border-radius:12px;position:fixed;overflow:auto;background:var(--dsw-specific-menu)}\n.Tw_workspace{height:100%;min-height:0;overflow-y:auto;box-sizing:border-box;padding:14px 14px 20px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;container-type:inline-size}\n.Tw_workspace *{box-sizing:border-box}\n.Tw_workspace button{font:inherit}\n.Tw_workspace button:focus-visible,.Tw_workspace summary:focus-visible,.Tw_workspace input:focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:2px}\n.Tw_head{display:flex;align-items:baseline;gap:8px;min-width:0;margin-bottom:10px}\n.Tw_head h2{flex:none;font-size:16px;font-weight:600;margin:0}\n.Tw_repo{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.Tw_mine{flex:none;display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;cursor:pointer}\n.Tw_mine input{margin:0;accent-color:#719fdf;cursor:pointer}\n.Tw_hint{margin:-4px 0 10px;color:var(--dsw-alias-label-tertiary);font-size:11px}\n.Tw_notice{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7;padding:14px 2px}\n.Tw_link{display:block;background:none;border:0;color:var(--dsw-alias-label-primary);text-decoration:underline;text-underline-offset:3px;cursor:pointer;padding:6px 0}\n.Tw_filters{display:flex;flex-wrap:wrap;gap:5px;margin:0 0 10px}\n.Tw_filters button{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:none;color:var(--dsw-alias-label-secondary);padding:1px 9px;font-size:11px;line-height:18px;cursor:pointer}\n.Tw_filters button:hover{color:var(--dsw-alias-label-primary)}\n.Tw_filters button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}\n.Tw_count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}\n.Tw_section{margin:0 0 12px}\n.Tw_sectionHead{display:flex;align-items:center;gap:6px;width:100%;padding:2px 0 6px;border:0;background:none;color:var(--dsw-alias-label-secondary);font-size:11px;text-align:left}\nbutton.Tw_sectionHead{cursor:pointer}\n.Tw_sectionHead strong{font-weight:600}\n.Tw_sectionHead small{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}\n.Tw_chevron{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:10px}\n.Tw_rows{border-top:1px solid var(--dsw-alias-border-l2)}\n.Tw_row{border-bottom:1px solid var(--dsw-alias-border-l2)}\n.Tw_rowHead{display:flex;align-items:center;gap:7px;width:100%;min-width:0;padding:7px 4px;border:0;background:none;color:inherit;text-align:left;cursor:pointer}\n.Tw_rowHead:hover{background:var(--dsw-alias-bg-layer-2)}\n.Tw_rowId{flex:none;min-width:30px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}\n.Tw_rowTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.Tw_row[data-expanded=true] .Tw_rowTitle{white-space:normal;overflow-wrap:anywhere;font-weight:500}\n.Tw_rowMeta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}\n.Tw_row[data-bucket=running] .Tw_rowMeta{color:#86afe8}\n.Tw_row[data-warn=true] .Tw_rowMeta{color:#dba76a}\n.Tw_rowNext{margin-top:-4px;padding:0 4px 7px 18px;color:var(--dsw-alias-label-secondary);font-size:11px}\n.Tw_rowNext[data-blocked=true]{color:#dba76a}\n.Tw_tag{flex:none;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;padding:0 4px;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:16px;white-space:nowrap}\n.Tw_rowBody{display:flex;flex-direction:column;gap:7px;padding:2px 4px 10px 18px;font-size:11px}\n.Tw_roles{display:flex;flex-direction:column;gap:5px}\n.Tw_role{display:flex;flex-direction:column;gap:2px;min-width:0;color:var(--dsw-alias-label-secondary)}\n.Tw_roleMain{display:flex;align-items:center;gap:7px;min-width:0}\n.Tw_roleSub{display:flex;align-items:center;flex-wrap:wrap;gap:3px 8px;padding-left:35px}\n.Tw_roleName{flex:none;min-width:28px;color:var(--dsw-alias-label-tertiary)}\n.Tw_roleState{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}\n.Tw_roleState[data-state=failed],.Tw_roleState[data-state=interrupted],.Tw_roleState[data-state=stale],.Tw_roleState[data-state=changes_requested]{color:#dba76a}\n.Tw_roleModel{display:inline-flex;align-items:center;gap:4px;min-width:0;color:var(--dsw-alias-label-primary);font-family:var(--dsw-alias-font-mono);font-size:10.5px}\n.Tw_roleModelName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.Tw_effort{border:1px solid var(--dsw-alias-border-l3);border-radius:4px;padding:0 4px;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:15px}\n.Tw_roleMeta{color:var(--dsw-alias-label-tertiary);font-size:10px;white-space:nowrap;font-variant-numeric:tabular-nums}\n.Tw_stopReason{color:#dba76a}\n.Tw_roleOpen{flex:none;margin-left:auto;border:1px solid var(--dsw-alias-border-l3);border-radius:5px;background:none;color:var(--dsw-alias-label-secondary);padding:1px 7px;font-size:10px;white-space:nowrap;cursor:pointer}\n.Tw_roleOpen:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}\n.Tw_role[data-selected=true] .Tw_roleOpen{border-color:#719fdf;color:#86afe8}\n.Tw_roleError{padding-left:35px;color:#dba76a;font-size:10px;line-height:1.5;overflow-wrap:anywhere}\n.Tw_line{display:flex;align-items:center;flex-wrap:wrap;gap:4px 6px;color:var(--dsw-alias-label-tertiary);font-size:10px}\n.Tw_line strong{color:var(--dsw-alias-label-secondary);font-weight:500}\n.Tw_dep{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;padding:0 5px;color:var(--dsw-alias-label-secondary)}\n.Tw_dep[data-dep-met=false]{border-color:#dba76a;color:#dba76a;background:color-mix(in srgb,#dba76a 8%,transparent)}\n.Tw_gateCode{border:1px solid #dba76a;border-radius:4px;padding:0 5px;color:#dba76a;font-family:var(--dsw-alias-font-mono);background:color-mix(in srgb,#dba76a 8%,transparent)}\n.Tw_gateMore{color:var(--dsw-alias-label-tertiary)}\n.Tw_gateReady,.Tw_gateBlocks[data-ready=true] strong{color:#79b888}\n.Tw_gateHint{flex-basis:100%}\n.Tw_line code{font-family:var(--dsw-alias-font-mono);color:var(--dsw-alias-label-secondary)}\n.Tw_details{font-size:11px}\n.Tw_details summary{color:var(--dsw-alias-label-tertiary);cursor:pointer}\n.Tw_details[open] summary{color:var(--dsw-alias-label-secondary)}\n.Tw_detailBody{padding:6px 0 0;line-height:1.6;overflow-wrap:anywhere}\n.Tw_detailBody dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 10px;margin:0}\n.Tw_detailBody dt{color:var(--dsw-alias-label-tertiary)}\n.Tw_detailBody dd{margin:0;min-width:0;overflow-wrap:anywhere}\n.Tw_detailBody p{margin:8px 0 2px;color:var(--dsw-alias-label-tertiary)}\n.Tw_result{max-height:220px;overflow:auto;margin:0;white-space:pre-wrap;font:inherit;color:var(--dsw-alias-label-secondary)}\n.Tw_checks{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary)}\n.Tw_usage{margin:4px 0 14px}\n.Tw_usageRow{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(40px,1fr) 52px;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l3)}\n.Tw_usageCols{padding:2px 0 4px;white-space:nowrap;border-bottom-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:10px}\n.Tw_usageName{display:flex;flex-direction:column;min-width:0}\n.Tw_usageModel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-alias-font-mono);font-size:11px}\n.Tw_usageName small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:10px}\n.Tw_usageTrack{display:block;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}\n.Tw_usageBar{display:block;height:100%;border-radius:3px;background:#74a7ef}\n.Tw_usageRow [data-numeric=true]{text-align:right;font-variant-numeric:tabular-nums}\n.Tw_usageTokens{color:var(--dsw-alias-label-secondary);font-size:11px}\n.Tw_more{display:block;margin-top:6px;color:var(--dsw-alias-label-tertiary);font-size:10px}\n.Tw_srOnly{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}\n@container (width<300px){.Tw_head{flex-wrap:wrap}.Tw_repo{flex-basis:calc(100% - 60px)}.Tw_rowNext,.Tw_rowBody{padding-left:8px}.Tw_usageRow{grid-template-columns:minmax(0,1fr) minmax(40px,.7fr) 48px}.Tw_roleSub,.Tw_roleError{padding-left:0}}\n";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"dsh-tower-enhanced/client\"]") === null) {
      const tag = document.createElement("style");
      tag.dataset.pluginCss = "dsh-tower-enhanced/client";
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    function statusText(status, t) {
      const key = `status.${status}`;
      return t(key) === key ? status : t(key);
    }

    // A dependency stops blocking once it reaches a terminal status: merged,
    // or abandoned (the gate treats both as "resolved" for depends_on).
    const DEPENDENCY_TERMINAL = new Set(['merged', 'abandoned']);
    const MISSION_DOT = {
      pending: 'idle', worker_running: 'ongoing', worker_completed: 'done', worker_failed: 'error',
      review_running: 'ongoing', review_failed: 'error', changes_requested: 'warning', approved: 'done',
      rebase_blocked: 'warning', merge_blocked: 'warning', merged: 'done', abandoned: 'idle',
    };

    // Pure: classify every dependsOn entry of a mission against its siblings.
    // Returns [{ id, status, met }]; unknown dependencies are met:false.
    function missionDependencyState(mission, missions) {
      const byId = new Map((missions ?? []).map((candidate) => [candidate.id, candidate]));
      return [...(mission?.dependsOn ?? [])].map((id) => {
        const dependency = byId.get(id);
        const met = !!dependency && DEPENDENCY_TERMINAL.has(dependency.status);
        return { id, status: dependency?.status ?? 'missing', met };
      });
    }

    // Pure: derive the next step / blocking reason for one mission from its
    // status, dependencies, and review verdict. Returns { key, ids, blocked }
    // where `key` is a locale key and `ids` lists unmet dependency ids.
    function missionNextStep(mission, missions = []) {
      if (!mission) return { key: 'next.unknown', ids: [], blocked: false };
      const status = mission.status;
      if (status === 'merged') return { key: 'next.merged', ids: [], blocked: false };
      if (status === 'abandoned') return { key: 'next.abandoned', ids: [], blocked: false };
      if (status === 'rebase_blocked') return { key: 'next.rebaseManual', ids: [], blocked: true };
      if (status === 'merge_blocked') return { key: 'next.mergeManual', ids: [], blocked: true };
      if (status === 'worker_running') return { key: 'next.workerRunning', ids: [], blocked: false };
      if (status === 'review_running') return { key: 'next.reviewRunning', ids: [], blocked: false };
      if (status === 'worker_failed') return { key: 'next.workerFailed', ids: [], blocked: false };
      if (status === 'review_failed') return { key: 'next.reviewFailed', ids: [], blocked: false };
      if (status === 'changes_requested') return { key: 'next.rework', ids: [], blocked: false };
      if (status === 'approved') return { key: 'next.canMerge', ids: [], blocked: false };
      const cleanReview = mission.review?.verdict === 'clean' && mission.review?.merge === true;
      const rejectedReview = mission.review != null
        && (mission.review.verdict === 'changes_requested' || mission.review.merge === false);
      if (status === 'worker_completed') {
        if (mission.review?.stale === true) return { key: 'next.reviewStale', ids: [], blocked: false };
        if (mission.review?.error) return { key: 'next.retryReview', ids: [], blocked: false };
        if (rejectedReview) return { key: 'next.rework', ids: [], blocked: false };
        if (cleanReview) return { key: 'next.canMerge', ids: [], blocked: false };
        return { key: 'next.awaitReview', ids: [], blocked: false };
      }
      if (status === 'pending') {
        const ids = missionDependencyState(mission, missions).filter((dep) => !dep.met).map((dep) => dep.id);
        return ids.length
          ? { key: 'next.waitDeps', ids, blocked: true }
          : { key: 'next.spawnWorker', ids: [], blocked: false };
      }
      return { key: 'next.unknown', ids: [], blocked: false };
    }

    // A merged mission confirms itself with the 7-char short form of its merge
    // commit. The full SHA still travels with the chip — as its tooltip and a
    // visually hidden span — so hover, copy-paste, and assistive tech keep the
    // exact commit while the card stays compact.
    const SHORT_SHA_LENGTH = 7;
    function shortSha(commit) {
      return typeof commit === 'string' ? commit.slice(0, SHORT_SHA_LENGTH) : '';
    }

    // At most this many gate block codes are spelled out on a mission card;
    // anything beyond collapses into a "+N" overflow chip. Codes are technical
    // identifiers shared by every locale, like the block codes `tower gate`
    // prints, so they are not translated.
    const MAX_GATE_CODES = 3;

    // Every mission falls into exactly one bucket. The buckets drive both the
    // status chips and the list sections: live stages, open work that waits
    // on the controller, and the two terminal outcomes. An unrecognized
    // status counts as open, so it is never hidden from the default view.
    const RUNNING_STATUSES = new Set(['worker_running', 'review_running']);
    const MISSION_BUCKETS = ['running', 'open', 'merged', 'abandoned'];
    const FILTERS = ['all', ...MISSION_BUCKETS];
    function missionBucket(mission) {
      const status = mission?.status;
      if (RUNNING_STATUSES.has(status)) return 'running';
      if (status === 'merged' || status === 'abandoned') return status;
      return 'open';
    }
    // Open statuses that need a decision rather than the next routine step.
    const MISSION_WARN = new Set(['worker_failed', 'review_failed', 'changes_requested', 'rebase_blocked', 'merge_blocked']);
    // Statuses whose next step is the merge, where the gate summary informs.
    const GATE_STATUSES = new Set(['approved', 'merge_blocked']);

    // The latest recorded moment of a mission (merge, role end or start,
    // creation). ISO timestamps compare as strings, so the newest sorts last.
    function missionActivity(mission) {
      return [
        mission?.merge?.mergedAt, mission?.review?.completedAt, mission?.review?.startedAt,
        mission?.worker?.completedAt, mission?.worker?.startedAt, mission?.createdAt,
      ].filter((value) => typeof value === 'string').sort().pop() ?? '';
    }

    function shortDate(iso) {
      const time = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
      if (!Number.isFinite(time)) return '';
      const date = new Date(time);
      return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    // Sum of the four disjoint durable usage buckets of a Session's
    // `tokenUsage` projection: the same total the Host's subagent catalog
    // shows for a child Session. Anything malformed is "not loaded".
    function tokenTotal(usage) {
      if (usage == null || typeof usage !== 'object') return undefined;
      const parts = [usage.uncachedInputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
      if (!parts.every((part) => typeof part === 'number' && Number.isFinite(part) && part >= 0)) return undefined;
      return parts.reduce((sum, part) => sum + part, 0);
    }

    // Compact token counts: 950, 9.5K, 95K, 9.5M, 1.2B. A value that would
    // round up to 1000 of a unit moves to the next unit instead.
    const TOKENS_MISSING = '—';
    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return TOKENS_MISSING;
      if (value < 1e3) return String(Math.round(value));
      const [scale, suffix] = value < 999.5e3 ? [1e3, 'K'] : value < 999.5e6 ? [1e6, 'M'] : [1e9, 'B'];
      const scaled = value / scale;
      return `${scaled < 9.95 ? scaled.toFixed(1) : Math.round(scaled)}${suffix}`;
    }

    // Pure: per-model usage over agent records. Every record with a child
    // Session counts as one Tower run of its provider/model (reasoning effort
    // folds in); the child's token total joins when the Host listing carries
    // its `tokenUsage`, otherwise the run is counted as not loaded. Sorted by
    // tokens, then runs, then model and provider, so the bar reads as a rank.
    function modelUsage(agents, rows = {}) {
      const buckets = new Map();
      for (const agent of agents ?? []) {
        if (typeof agent?.childId !== 'string' || !agent.childId) continue;
        const provider = agent.provider ?? null;
        const model = agent.model ?? null;
        const key = JSON.stringify([provider, model]);
        let bucket = buckets.get(key);
        if (bucket === undefined) {
          bucket = { provider, model, runs: 0, tokens: 0, unknown: 0 };
          buckets.set(key, bucket);
        }
        bucket.runs += 1;
        const total = tokenTotal(rows?.[agent.childId]?.projectionValues?.tokenUsage);
        if (total === undefined) bucket.unknown += 1;
        else bucket.tokens += total;
      }
      const text = (value) => value ?? '';
      return [...buckets.values()].sort((a, b) => b.tokens - a.tokens || b.runs - a.runs
        || (text(a.model) < text(b.model) ? -1 : text(a.model) > text(b.model) ? 1 : 0)
        || (text(a.provider) < text(b.provider) ? -1 : text(a.provider) > text(b.provider) ? 1 : 0));
    }

    // At most this many models render in the usage ranking; the rest fold
    // into a "+N" note.
    const MAX_USAGE_ROWS = 10;

    function TowerAction({ sessionId, useSession, useSessions, t, resolveAddress, openAgent }) {
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null);
      const triggerRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const position = primitives.useAnchoredPosition({ open, anchorRef: triggerRef, panelRef, gap: 5, margin: 16 });
      React.useEffect(() => setOpen(false), [sessionId]);
      React.useLayoutEffect(() => {
        if (open && position !== null) panelRef.current?.focus();
      }, [open, position]);
      primitives.useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
      React.useEffect(() => {
        if (!open) return undefined;
        const dismiss = (event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          setOpen(false);
          if (panelRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
        };
        document.addEventListener("keydown", dismiss);
        return () => document.removeEventListener("keydown", dismiss);
      }, [open]);
      return jsxs("div", {
        ref: rootRef,
        className: "Tw_root",
        "data-tower-action": true,
        children: [
          jsxs("button", {
            type: "button",
            ref: triggerRef,
            className: "Tw_trigger",
            "aria-label": t("trigger"),
            "aria-haspopup": "dialog",
            "aria-expanded": open,
            onClick: () => setOpen(!open),
            children: [
              jsx(primitives.IconUsersOutlineRegular, { size: 14 }),
              jsx("span", { children: t("trigger") }),
            ],
          }),
          open && ReactDOM.createPortal(jsxs("div", {
            ref: panelRef,
            className: "Tw_panel",
            style: position ?? { visibility: "hidden", left: 0, top: 0 },
            role: "dialog",
            tabIndex: -1,
            "aria-label": t("trigger"),
            "data-tower-panel": true,
            children: jsx(TowerWorkspace, { sessionId, useSession, useSessions, t, resolveAddress, openAgent }),
          }), document.body),
        ],
      });
    }

    const SUBAGENT_CHAT_ADDRESS = 'dsh-resource://subagentchat/session/';

    function subagentChatAddress(address) {
      const query = new URLSearchParams({ parent: address.parentSessionId, mode: address.mode });
      return `${SUBAGENT_CHAT_ADDRESS}${encodeURIComponent(address.childSessionId)}?${query}`;
    }

    function durationText(startedAt, completedAt) {
      if (typeof startedAt !== 'string') return '';
      const started = Date.parse(startedAt);
      const finished = typeof completedAt === 'string' ? Date.parse(completedAt) : Date.now();
      if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return '';
      const seconds = Math.max(0, Math.round((finished - started) / 1000));
      if (seconds < 60) return `${seconds}s`;
      return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
    }

    // An agent is a real child Session. Mission stages and empty role records
    // must never manufacture a second agent or a clickable placeholder.
    function agentEntries(tower, resolveAddress) {
      const byChild = new Map();
      for (const mission of tower?.missions ?? []) {
        for (const role of ['worker', 'reviewer']) {
          const agent = role === 'worker' ? mission.worker : mission.review;
          if (typeof agent?.childId !== 'string' || !agent.childId) continue;
          const entry = { mission, role, agent, address: resolveAddress(agent.childId, agent.controllerSessionId) };
          const prior = byChild.get(agent.childId);
          if (!prior || (agent.startedAt ?? '') > (prior.agent.startedAt ?? '')) byChild.set(agent.childId, entry);
        }
      }
      return [...byChild.values()];
    }

    function agentState({ mission, role, agent }) {
      if (['aborted', 'interrupted'].includes(agent.stopReason)) return 'interrupted';
      if (agent.stale) return 'stale';
      if (agent.error || (agent.stopReason && agent.stopReason !== 'completed')) return 'failed';
      const missionFailed = (role === 'worker' && mission.status === 'worker_failed')
        || (role === 'reviewer' && mission.status === 'review_failed');
      if (missionFailed) return 'failed';
      if (role === 'reviewer' && (agent.verdict === 'changes_requested' || agent.merge === false)) return 'changes_requested';
      if (agent.completedAt || agent.stopReason === 'completed' || agent.verdict || agent.headCommit) return 'done';
      if (agent.startedAt && mission.status === (role === 'worker' ? 'worker_running' : 'review_running')) return 'running';
      return 'unknown';
    }
    const ATTENTION = new Set(['failed', 'interrupted', 'stale', 'changes_requested', 'unknown']);
    const AGENT_DOT = { running: 'ongoing', done: 'done', failed: 'error', interrupted: 'warning', stale: 'warning', changes_requested: 'warning', unknown: 'idle' };
    const STOP_REASON_DOT = { completed: 'done', error: 'error', aborted: 'warning' };
    const MAX_AGENT_ERROR = 500;
    function agentErrorText(agent) {
      const raw = [agent?.error, agent?.diagnostic].find((value) => typeof value === 'string' && value.length > 0);
      if (raw === undefined) return null;
      const points = Array.from(raw);
      if (points.length <= MAX_AGENT_ERROR) return { text: raw, truncated: false };
      return { text: `${points.slice(0, MAX_AGENT_ERROR - 1).join('')}…`, truncated: true };
    }

    function resumeOf(agent) {
      return agent?.resumeFrom && typeof agent.resumeFrom === 'object' ? agent.resumeFrom : null;
    }

    // One role of a mission on one line: state, launch model, elapsed time,
    // the child Session's tokens when listed, and a link to its chat.
    function RoleLine({ mission, role, agent, rows, selected, onSelect, t, openAgent }) {
      const [openFailed, setOpenFailed] = React.useState(false);
      // A record without childId is a launch in progress only while its
      // role's stage is active; ended records still report their state.
      const spawned = typeof agent?.childId === 'string' && agent.childId.length > 0;
      const missionFailed = (role === 'worker' && mission.status === 'worker_failed')
        || (role === 'reviewer' && mission.status === 'review_failed');
      const ended = !!agent && (!!agent.error || agent.completedAt != null || agent.stopReason != null
        || agent.stale === true || agent.verdict != null || agent.headCommit != null || missionFailed);
      const launching = !!agent && !spawned && !ended
        && mission.status === (role === 'worker' ? 'worker_running' : 'review_running');
      const state = spawned || ended ? agentState({ mission, role, agent }) : undefined;
      const stateLabel = !agent
        ? t('notSpawned')
        : state
          ? t(state === 'done' && role === 'reviewer' && agent.verdict === 'clean' ? 'agent.reviewDone' : `agent.${state}`)
          : launching ? t('pending.starting') : t('agent.unknown');
      const duration = agent && (agent.completedAt || state === 'running') ? durationText(agent.startedAt, agent.completedAt) : '';
      // A normal end is already the state label; only unusual ends get a badge.
      const stopReason = typeof agent?.stopReason === 'string' && agent.stopReason && agent.stopReason !== 'completed'
        ? agent.stopReason
        : undefined;
      const knownStopReason = ['error', 'aborted'].includes(stopReason);
      const tokens = spawned ? tokenTotal(rows?.[agent.childId]?.projectionValues?.tokenUsage) : undefined;
      const resumed = resumeOf(agent) !== null;
      const errorText = agentErrorText(agent);
      const canOpen = spawned && typeof openAgent === 'function';
      const hasSub = !!duration || tokens !== undefined || resumed || !!stopReason;
      // Two fixed lines keep narrow panes tidy: who and with what model on
      // top (chat link at the end), the run's numbers underneath.
      return jsxs('div', {
        className: 'Tw_role', 'data-mission-role': role, 'data-spawned': spawned, 'data-selected': selected,
        'data-agent-session': spawned ? agent.childId : undefined,
        children: [
          jsxs('div', { className: 'Tw_roleMain', children: [
            jsx('span', { className: 'Tw_roleName', children: t(`role.${role}`) }),
            jsxs('span', { className: 'Tw_roleState', 'data-state': state ?? 'notSpawned', children: [
              jsx(primitives.StateDot, { state: state ? AGENT_DOT[state] ?? 'idle' : 'idle' }),
              stateLabel,
            ] }),
            (agent?.provider || agent?.model) && jsxs('span', {
              className: 'Tw_roleModel', title: `${agent.provider ?? '?'} / ${agent.model ?? '?'}`,
              children: [
                jsx('span', { className: 'Tw_roleModelName', children: agent.model ?? t('agent.modelUnknown') }),
                agent.reasoningEffort && jsx('span', { className: 'Tw_effort', children: agent.reasoningEffort }),
              ],
            }),
            canOpen && jsx('button', {
              type: 'button', className: 'Tw_roleOpen', 'data-open-agent': role, 'data-tower-agent': `${mission.id}:${role}`,
              'aria-pressed': selected, title: agent.childId,
              'aria-label': `${t('agent.open')} · ${t(`role.${role}`)} · ${mission.title} · ${agent.model ?? t('agent.modelUnknown')}`,
              onClick: () => {
                const opened = openAgent(agent.childId, agent.controllerSessionId);
                setOpenFailed(opened === false);
                if (opened !== false) onSelect(agent.childId);
              },
              children: `${t(selected ? 'agent.selected' : 'agent.open')} ↗`,
            }),
          ] }),
          hasSub && jsxs('div', { className: 'Tw_roleSub', children: [
            duration && jsx('span', { className: 'Tw_roleMeta', 'data-agent-elapsed': role, children: duration }),
            tokens !== undefined && jsx('span', { className: 'Tw_roleMeta', 'data-agent-tokens': tokens, children: `${formatTokens(tokens)} tok` }),
            resumed && jsx('span', { className: 'Tw_tag', 'data-agent-resumed': role, children: t('agent.resumed') }),
            stopReason && jsxs('span', {
              className: 'Tw_roleState Tw_stopReason', 'data-agent-stop-reason': stopReason,
              'data-state': knownStopReason ? stopReason : 'unknown',
              children: [
                jsx(primitives.StateDot, { state: STOP_REASON_DOT[stopReason] ?? 'idle' }),
                knownStopReason ? t(`agent.stopReason.${stopReason}`) : stopReason,
              ],
            }),
          ] }),
          openFailed && jsx('span', { className: 'Tw_roleError', role: 'alert', 'data-open-error': role, children: t('agent.openFailed') }),
          errorText && jsx('span', {
            className: 'Tw_roleError', 'data-agent-error': role, 'data-error-truncated': errorText.truncated,
            children: errorText.text,
          }),
        ],
      });
    }

    // One mission per row. The head always fits one line (dot, id, title,
    // status or date); open and running missions add their next step below
    // it; expanding reveals dependencies, the gate summary, both roles, the
    // merge commit, and the recorded details. `roles` is what this Session
    // may see: both roles for a controller, only its own record for a child.
    function MissionRow({ mission, missions, roles, expanded, onToggle, selected, onSelect, rows, t, openAgent }) {
      const bucket = missionBucket(mission);
      const active = bucket === 'running' || bucket === 'open';
      const next = missionNextStep(mission, missions);
      const deps = missionDependencyState(mission, missions);
      const warn = MISSION_WARN.has(mission.status) || next.blocked;
      const live = roles.find(({ role }) => mission.status === (role === 'worker' ? 'worker_running' : 'review_running'))?.agent;
      const elapsed = bucket === 'running' ? durationText(live?.startedAt) : '';
      const meta = active
        ? [statusText(mission.status, t), elapsed].filter(Boolean).join(' · ')
        : shortDate(missionActivity(mission));
      const resumed = roles.some(({ agent }) => resumeOf(agent) !== null);
      // The merge commit only confirms missions that actually merged; other
      // statuses never show it even if a merge record lingers in the state.
      const mergeCommit = mission.status === 'merged' ? mission.merge?.commit : undefined;
      // `gateBlocks` is derived read-only by the projection (lib/projection.js);
      // an older projection without it degrades to no summary instead of
      // guessing. The ready verdict covers state checks only, so the label
      // is qualified and a hint names the git checks left to `tower gate`.
      const gateBlocks = Array.isArray(mission.gateBlocks)
        ? mission.gateBlocks.filter((code) => typeof code === 'string' && code.length > 0)
        : null;
      // Only a mission whose next step is the merge itself shows the summary;
      // earlier stages would just repeat their status as NOT_APPROVED.
      const gateReady = gateBlocks !== null && gateBlocks.length === 0 && mission.status === 'approved';
      const showGateSummary = gateBlocks !== null && GATE_STATUSES.has(mission.status);
      const gateOverflow = gateBlocks === null ? 0 : Math.max(0, gateBlocks.length - MAX_GATE_CODES);
      const detailRows = [
        [t('detail.branch'), mission.branch],
        ...roles.flatMap(({ role, agent }) => [
          [`${t(`role.${role}`)} · ${t('detail.commit')}`, role === 'worker' ? agent?.headCommit : undefined],
          [`${t(`role.${role}`)} · ${t('detail.reviewed')}`, role === 'reviewer' ? agent?.reviewedCommit : undefined],
          [`${t(`role.${role}`)} · ${t('detail.previousRun')}`, typeof resumeOf(agent)?.runId === 'string' ? resumeOf(agent).runId : undefined],
          [`${t(`role.${role}`)} · ${t('detail.sessionSeq')}`, Number.isInteger(resumeOf(agent)?.sessionSeq) ? String(resumeOf(agent).sessionSeq) : undefined],
        ]),
      ].filter(([, value]) => typeof value === 'string' && value.length > 0);
      const results = roles
        .map(({ role, agent }) => ({ role, text: agent?.error ?? agent?.summary ?? agent?.output, checks: agent?.checks }))
        .filter(({ text, checks }) => (typeof text === 'string' && text.length > 0) || checks?.length > 0);
      return jsxs('article', {
        className: 'Tw_row', 'data-mission-id': mission.id, 'data-mission-status': mission.status,
        'data-bucket': bucket, 'data-warn': warn, 'data-expanded': expanded,
        children: [
          jsxs('button', {
            type: 'button', className: 'Tw_rowHead', 'data-mission-toggle': mission.id,
            'aria-expanded': expanded, title: mission.title, onClick: onToggle,
            children: [
              jsx(primitives.StateDot, { state: MISSION_DOT[mission.status] ?? 'idle' }),
              jsx('span', { className: 'Tw_rowId', children: mission.id }),
              jsx('span', { className: 'Tw_rowTitle', children: mission.title }),
              resumed && jsx('span', { className: 'Tw_tag', 'data-mission-resumed': true, children: t('agent.resumed') }),
              meta && jsx('span', { className: 'Tw_rowMeta', 'data-state': mission.status, children: meta }),
            ],
          }),
          // A running row's status already says what happens next.
          bucket === 'open' && jsxs('div', {
            className: 'Tw_rowNext', 'data-mission-next': next.key, 'data-blocked': next.blocked,
            children: [`${t('mission.next')}: `, t(next.key, { ids: next.ids.join(t('mission.depJoin')) })],
          }),
          expanded && jsxs('div', { className: 'Tw_rowBody', children: [
            deps.length > 0 && jsxs('div', { className: 'Tw_line', 'data-mission-deps': true, children: [
              jsx('strong', { children: t('mission.deps') }),
              ...deps.map((dep) => jsxs('span', {
                className: 'Tw_dep', 'data-dep-id': dep.id, 'data-dep-met': dep.met,
                children: [dep.id, ' · ', dep.status === 'missing' ? t('mission.depMissing') : statusText(dep.status, t)],
              }, dep.id)),
            ] }),
            showGateSummary && jsxs('div', {
              className: 'Tw_line Tw_gateBlocks', 'data-gate-blocks': gateBlocks.length, 'data-ready': gateReady,
              children: [
                jsx('strong', { children: t('mission.gate') }),
                gateReady
                  ? jsx('span', { className: 'Tw_gateReady', children: t('mission.gateReady') })
                  : jsxs(Fragment, { children: [
                    ...gateBlocks.slice(0, MAX_GATE_CODES).map((code) => jsx('span', {
                      className: 'Tw_gateCode', 'data-block-code': code, children: code,
                    }, code)),
                    gateOverflow > 0 && jsx('span', {
                      className: 'Tw_gateMore', 'data-block-overflow': gateOverflow, children: `+${gateOverflow}`,
                    }),
                  ] }),
                jsx('span', { className: 'Tw_gateHint', 'data-gate-hint': true, children: t('mission.gateHint') }),
              ],
            }),
            jsx('div', { className: 'Tw_roles', children: roles.map(({ role, agent }) => jsx(RoleLine, {
              mission, role, agent, rows, t, openAgent, onSelect,
              selected: typeof agent?.childId === 'string' && agent.childId === selected,
            }, role)) }),
            mergeCommit && jsxs('div', {
              className: 'Tw_line', 'data-merge-commit': mergeCommit, title: mergeCommit,
              children: [
                jsx('strong', { children: t('detail.merge') }),
                jsx('code', { 'data-merge-short': shortSha(mergeCommit), children: shortSha(mergeCommit) }),
                // Full SHA for screen readers and text-level assertions; hidden
                // visually so the row shows only the short form.
                jsx('span', { className: 'Tw_srOnly', children: mergeCommit }),
              ],
            }),
            jsxs('details', { className: 'Tw_details', children: [
              jsx('summary', { children: t('detail.title') }),
              jsxs('div', { className: 'Tw_detailBody', children: [
                detailRows.length > 0 && jsx('dl', { children: detailRows.map(([key, value]) => jsxs(Fragment, { children: [
                  jsx('dt', { children: key }), jsx('dd', { children: value }),
                ] }, key)) }),
                typeof mission.description === 'string' && mission.description && jsxs(Fragment, { children: [
                  jsx('p', { children: t('detail.description') }),
                  jsx('pre', { className: 'Tw_result', 'data-mission-description': true, children: mission.description }),
                ] }),
                ...results.map(({ role, text, checks }) => jsxs(Fragment, { children: [
                  typeof text === 'string' && text && jsxs(Fragment, { children: [
                    jsx('p', { children: `${t(`role.${role}`)} · ${t('detail.result')}` }),
                    jsx('pre', { className: 'Tw_result', 'data-agent-result': role, children: text }),
                  ] }),
                  checks?.length > 0 && jsxs(Fragment, { children: [
                    jsx('p', { children: `${t(`role.${role}`)} · ${t('detail.checks')}` }),
                    jsx('ul', { className: 'Tw_checks', children: checks.map((check, index) => jsx('li', { children: check }, index)) }),
                  ] }),
                ] }, role)),
              ] }),
            ] }),
          ] }),
        ],
      });
    }

    // Per-model usage ranking: runs on the left, a bar in the middle, tokens
    // on the right. The bar ranks by tokens; when no child Session's usage is
    // loaded at all it falls back to runs, so the ranking never goes blank.
    function UsageSection({ usage, collapsed, onToggle, t }) {
      if (usage.length === 0) return null;
      const runs = usage.reduce((sum, row) => sum + row.runs, 0);
      const unknown = usage.reduce((sum, row) => sum + row.unknown, 0);
      const tokens = usage.reduce((sum, row) => sum + row.tokens, 0);
      const anyTokens = unknown < runs;
      const metric = anyTokens ? 'tokens' : 'runs';
      const top = Math.max(1, ...usage.map((row) => row[metric]));
      const overflow = Math.max(0, usage.length - MAX_USAGE_ROWS);
      return jsxs('section', {
        className: 'Tw_usage', 'data-tower-usage': true, 'data-usage-collapsed': collapsed, 'data-usage-metric': metric,
        children: [
          jsxs('button', {
            type: 'button', className: 'Tw_sectionHead', 'data-usage-toggle': true, 'aria-expanded': !collapsed, onClick: onToggle,
            children: [
              jsx('strong', { children: t('usage.title') }),
              jsx('small', { children: t('usage.summary', { runs, tokens: anyTokens ? `${formatTokens(tokens)} tok` : TOKENS_MISSING }) }),
              jsx('span', { className: 'Tw_chevron', 'aria-hidden': true, children: collapsed ? '▸' : '▾' }),
            ],
          }),
          !collapsed && jsxs('div', { className: 'Tw_usageBody', role: 'table', 'aria-label': t('usage.title'), children: [
            jsxs('div', { className: 'Tw_usageRow Tw_usageCols', role: 'row', children: [
              jsx('span', { role: 'columnheader', children: t('usage.colModel') }),
              jsx('span', { role: 'columnheader', children: t('usage.colRank') }),
              jsx('span', { role: 'columnheader', 'data-numeric': true, children: t('usage.colTokens') }),
            ] }),
            ...usage.slice(0, MAX_USAGE_ROWS).map((row, index) => {
              const loaded = row.unknown < row.runs;
              const share = row[metric] / top;
              return jsxs('div', {
                className: 'Tw_usageRow', role: 'row', title: `${row.provider ?? TOKENS_MISSING} / ${row.model ?? TOKENS_MISSING}`,
                'data-usage-row': index, 'data-usage-model': row.model ?? '', 'data-usage-provider': row.provider ?? '',
                'data-usage-runs': row.runs, 'data-usage-tokens': loaded ? row.tokens : undefined,
                children: [
                  jsxs('span', { className: 'Tw_usageName', role: 'cell', children: [
                    jsx('span', { className: 'Tw_usageModel', children: row.model ?? t('agent.modelUnknown') }),
                    jsx('small', { children: [t('usage.runs', { count: row.runs }), row.provider].filter(Boolean).join(' · ') }),
                  ] }),
                  jsx('span', { className: 'Tw_usageTrack', role: 'cell', children: jsx('span', {
                    className: 'Tw_usageBar', 'data-usage-share': Math.round(share * 100),
                    style: { width: `${share > 0 ? Math.max(2, Math.round(share * 100)) : 0}%` },
                  }) }),
                  jsx('span', { className: 'Tw_usageTokens', role: 'cell', 'data-numeric': true, children: loaded ? formatTokens(row.tokens) : TOKENS_MISSING }),
                ],
              }, `${String(row.provider)}/${String(row.model)}`);
            }),
            overflow > 0 && jsx('span', { className: 'Tw_more', 'data-usage-overflow': overflow, children: t('usage.more', { count: overflow }) }),
            unknown > 0 && jsx('span', { className: 'Tw_more', 'data-usage-unknown': unknown, children: t('usage.unknownTokens', { count: unknown }) }),
          ] }),
        ],
      });
    }

    // --- Panel preference persistence (two tiers) ---
    //
    // The right-sidebar tab unmounts its body whenever the user switches
    // tabs, so React state alone forgets the scope, filter, folds, expanded
    // rows, selection, and the list scroll on every detour. Two tolerant
    // layers keep them:
    //
    //   a. `panelPrefsCache`, a module-scoped Map keyed by sessionId. It uses
    //      no browser storage API at all, so an unmount/remount within the
    //      same page always restores state — the minimum guarantee, working
    //      even where localStorage is unavailable.
    //   b. `localStorage`, best-effort under the `dsh-tower:prefs:v2`
    //      namespace: one global record for the UI preferences (session-only
    //      scope, filter, history and usage folds) and one per-session record
    //      for the expanded rows, the selected agent, and the list scroll.
    //      Every access is guarded, so a missing or throwing storage (private
    //      mode, sandboxed iframe, QuotaExceededError, SecurityError)
    //      silently degrades to tier (a) and the panel never crashes.
    //      Records of the earlier v1 layout are simply not read.
    const PREFS_NS = 'dsh-tower:prefs:v2';
    const PREFS_GLOBAL_KEY = `${PREFS_NS}:global`;
    const panelPrefsSessionKey = (sessionId) => `${PREFS_NS}:session:${sessionId}`;
    // Defaults: every mission of the workspace, the all filter, nothing
    // folded or selected. `expanded: null` means "never chosen", which lets a
    // child Session open its own mission by default.
    const DEFAULT_PANEL_PREFS = { mine: false, filter: 'all', historyCollapsed: false, usageCollapsed: false, expanded: null, selected: null, scrollTop: null };
    const PREFS_FILTERS = new Set(FILTERS);
    const PREFS_GLOBAL_FIELDS = ['mine', 'filter', 'historyCollapsed', 'usageCollapsed'];
    const PREFS_SESSION_FIELDS = ['expanded', 'selected', 'scrollTop'];
    const PREFS_FIELDS = [...PREFS_GLOBAL_FIELDS, ...PREFS_SESSION_FIELDS];
    const panelPrefsCache = new Map();

    function prefsStorage() {
      try {
        const area = typeof localStorage === 'undefined' ? undefined : localStorage;
        return area != null && typeof area.getItem === 'function' && typeof area.setItem === 'function' ? area : null;
      } catch {
        return null; // touching the property itself can throw in sandboxed iframes
      }
    }

    function readPrefsRecord(area, key) {
      if (!area) return null;
      try {
        const raw = area.getItem(key);
        if (typeof raw !== 'string' || raw.length === 0) return null;
        const parsed = JSON.parse(raw);
        return parsed != null && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null; // unreadable or corrupt records simply do not exist
      }
    }

    // Validate `changes` field by field onto `base`: an absent or invalid
    // value never overwrites what is already there, so restored state stays
    // self-consistent (junk ids or an unknown filter cannot leak in).
    function mergePanelPrefs(base, changes, fields = PREFS_FIELDS) {
      const record = { ...base };
      if (changes == null || typeof changes !== 'object') return record;
      for (const field of ['mine', 'historyCollapsed', 'usageCollapsed']) {
        if (fields.includes(field) && typeof changes[field] === 'boolean') record[field] = changes[field];
      }
      if (fields.includes('filter') && PREFS_FILTERS.has(changes.filter)) record.filter = changes.filter;
      if (fields.includes('expanded')) {
        if (Array.isArray(changes.expanded)) {
          record.expanded = [...new Set(changes.expanded.filter((id) => typeof id === 'string' && id.length > 0))];
        } else if (changes.expanded === null) record.expanded = null;
      }
      if (fields.includes('selected')) {
        if (typeof changes.selected === 'string' && changes.selected.length > 0) record.selected = changes.selected;
        else if (changes.selected === null) record.selected = null;
      }
      if (fields.includes('scrollTop') && typeof changes.scrollTop === 'number'
        && Number.isFinite(changes.scrollTop) && changes.scrollTop >= 0) record.scrollTop = changes.scrollTop;
      return record;
    }

    // Load the persisted preferences for one session: defaults, overlaid with
    // the storage records (global UI prefs, then this session's record),
    // overlaid with this page's memory cache (the freshest values win). Also
    // seeds the cache so a later save never starts from stale data. Never
    // throws. `expanded` comes back as a Set (or null) for direct useState use.
    function loadPanelPrefs(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return { ...DEFAULT_PANEL_PREFS };
      const area = prefsStorage();
      let record = mergePanelPrefs(DEFAULT_PANEL_PREFS, readPrefsRecord(area, PREFS_GLOBAL_KEY), PREFS_GLOBAL_FIELDS);
      record = mergePanelPrefs(record, readPrefsRecord(area, panelPrefsSessionKey(sessionId)), PREFS_SESSION_FIELDS);
      record = mergePanelPrefs(record, panelPrefsCache.get(sessionId));
      panelPrefsCache.set(sessionId, record);
      return { ...record, expanded: record.expanded === null ? null : new Set(record.expanded) };
    }

    function savePanelPrefs(sessionId, changes) {
      if (typeof sessionId !== 'string' || sessionId.length === 0 || changes == null) return;
      const record = mergePanelPrefs(panelPrefsCache.get(sessionId) ?? DEFAULT_PANEL_PREFS, changes);
      panelPrefsCache.set(sessionId, record);
      const area = prefsStorage();
      if (!area) return;
      const pick = (fields) => Object.fromEntries(fields.map((field) => [field, record[field]]));
      // Both records are rewritten whole from the merged record; a failure on
      // either write leaves tier (a) holding the value regardless.
      try {
        area.setItem(PREFS_GLOBAL_KEY, JSON.stringify(pick(PREFS_GLOBAL_FIELDS)));
      } catch { /* quota or security: best-effort only */ }
      try {
        area.setItem(panelPrefsSessionKey(sessionId), JSON.stringify(pick(PREFS_SESSION_FIELDS)));
      } catch { /* quota or security: best-effort only */ }
    }

    // One callback after the next paint: requestAnimationFrame in a browser,
    // a 0ms timer as a fallback host, inline as a last resort. Never throws.
    function scheduleFrame(callback) {
      try {
        if (typeof requestAnimationFrame === 'function') return { kind: 'frame', id: requestAnimationFrame(callback) };
        if (typeof setTimeout === 'function') return { kind: 'timer', id: setTimeout(callback, 0) };
      } catch { /* scheduling failed; apply inline */ }
      callback();
      return null;
    }

    function cancelFrame(ticket) {
      if (ticket == null) return;
      try {
        if (ticket.kind === 'frame' && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(ticket.id);
        else if (ticket.kind === 'timer' && typeof clearTimeout === 'function') clearTimeout(ticket.id);
      } catch { /* nothing to undo */ }
    }

    function TowerWorkspace({ sessionId, useSession, useSessions, t, resolveAddress, openAgent }) {
      const parentSessionId = useSession((snapshot) => snapshot.subagent?.address.parentSessionId);
      const projections = useSessions((state) => state.projectionsBySession);
      const rows = useSessions((state) => state.byId) ?? {};
      const listing = useSessions((state) => state.phase === 'pending');
      const ownTower = projections?.[sessionId]?.values.tower;
      const parentTower = projections?.[parentSessionId]?.values.tower;
      // A review-only Session may have no projection of its own. Its parent
      // provides task context, never permission to impersonate its sibling worker.
      const candidates = Object.values(projections ?? {}).map((p) => p?.values.tower).filter(Boolean);
      const seed = ownTower ?? parentTower ?? candidates.find((tower) => tower.missions.some((m) => m.worker?.childId === sessionId || m.review?.childId === sessionId));
      const tower = seed && candidates.filter((candidate) => candidate.repoRoot === seed.repoRoot).reduce((latest, candidate) => candidate.updatedAt > latest.updatedAt ? candidate : latest, seed);
      // One preference snapshot per sessionId, shared by every lazy state
      // initializer below and by both [sessionId] effects: computed during
      // the render that first sees a session (mount or switch) and reused
      // for the session's other renders. A mount or session switch therefore
      // reads storage exactly twice (global record + this session's record).
      const prefsRef = React.useRef(null);
      if (prefsRef.current?.sessionId !== sessionId) {
        prefsRef.current = { sessionId, prefs: loadPanelPrefs(sessionId) };
      }
      const prefs = prefsRef.current.prefs;
      // Lazy initial values: the very first render already shows the
      // persisted preferences, with no default-then-overwrite flash.
      const [mine, setMine] = React.useState(() => prefs.mine);
      const [filter, setFilter] = React.useState(() => prefs.filter);
      const [historyCollapsed, setHistoryCollapsed] = React.useState(() => prefs.historyCollapsed);
      const [usageCollapsed, setUsageCollapsed] = React.useState(() => prefs.usageCollapsed);
      const [expanded, setExpanded] = React.useState(() => prefs.expanded);
      const [selected, setSelected] = React.useState(() => prefs.selected);
      const [, tick] = React.useState(0);
      const listRef = React.useRef(null);
      const scrollPendingRef = React.useRef(null);
      const scrollFrameRef = React.useRef(null);
      // A session switch reloads that session's own preferences; the
      // snapshot was recomputed by this render's keyed ref above, so the
      // effect only redistributes it into state — no second load.
      React.useEffect(() => {
        setMine(prefs.mine);
        setFilter(prefs.filter);
        setHistoryCollapsed(prefs.historyCollapsed);
        setUsageCollapsed(prefs.usageCollapsed);
        setExpanded(prefs.expanded);
        setSelected(prefs.selected);
      }, [sessionId]);
      // Restore the saved scroll position once, after the container and its
      // content have been laid out; scrollTop comes from the same snapshot.
      React.useEffect(() => {
        const top = prefs.scrollTop;
        if (typeof top !== 'number') return undefined;
        let cancelled = false;
        const ticket = scheduleFrame(() => {
          if (cancelled || listRef.current == null) return;
          try { listRef.current.scrollTop = top; } catch { /* detached node */ }
        });
        return () => { cancelled = true; cancelFrame(ticket); };
      }, [sessionId]);
      const all = agentEntries(tower, resolveAddress);
      // Inside a worker or reviewer Session the panel shows only that
      // agent's own record: a reviewer never sees its sibling worker's run.
      const self = all.filter((entry) => entry.agent.childId === sessionId);
      const agentMode = self.length > 0;
      const scoped = agentMode ? self
        : mine ? all.filter((entry) => entry.address?.parentSessionId === sessionId)
          : all;
      const hasRunning = all.some((entry) => agentState(entry) === 'running');
      React.useEffect(() => {
        if (!hasRunning) return undefined;
        const timer = setInterval(() => tick((n) => n + 1), 1000);
        return () => clearInterval(timer);
      }, [hasRunning]);
      const missionList = tower?.missions ?? [];
      const scopedIds = agentMode || mine ? new Set(scoped.map((entry) => entry.mission.id)) : null;
      const missions = (scopedIds ? missionList.filter((mission) => scopedIds.has(mission.id)) : [...missionList])
        .sort((a, b) => (missionActivity(b) < missionActivity(a) ? -1 : missionActivity(b) > missionActivity(a) ? 1 : 0));
      const rolesOf = (mission) => agentMode
        ? self.filter((entry) => entry.mission.id === mission.id).map(({ role, agent }) => ({ role, agent }))
        : [{ role: 'worker', agent: mission.worker }, { role: 'reviewer', agent: mission.review }];
      const counts = { all: missions.length, running: 0, open: 0, merged: 0, abandoned: 0 };
      for (const mission of missions) counts[missionBucket(mission)] += 1;
      const visible = filter === 'all' ? missions : missions.filter((mission) => missionBucket(mission) === filter);
      const usage = modelUsage(scoped.map((entry) => entry.agent), rows);
      const repoName = tower ? tower.repoRoot.split(/[\\/]/).filter(Boolean).pop() : '';
      const title = rows[sessionId]?.displayTitle ?? rows[sessionId]?.title;
      // Expanded rows the user never chose fall back to the agent's own
      // mission inside a child Session, and to nothing for a controller.
      const openIds = expanded ?? new Set(agentMode ? self.map((entry) => entry.mission.id) : []);
      // Self-healing selection: a restored id whose agent no longer exists
      // renders as "nothing selected".
      const activeSelected = selected != null && all.some((entry) => entry.agent.childId === selected) ? selected : null;
      // Scroll persistence: coalesce a scroll burst into one write per frame
      // instead of writing on every scroll event.
      const handleListScroll = () => {
        const top = listRef.current?.scrollTop;
        if (typeof top !== 'number' || !Number.isFinite(top)) return;
        scrollPendingRef.current = top;
        if (scrollFrameRef.current != null) return;
        scrollFrameRef.current = scheduleFrame(() => {
          scrollFrameRef.current = null;
          const pendingTop = scrollPendingRef.current;
          scrollPendingRef.current = null;
          if (typeof pendingTop === 'number') savePanelPrefs(sessionId, { scrollTop: pendingTop });
        });
      };
      React.useEffect(() => () => {
        // Leaving the panel (tab switch) or switching session must not lose
        // the last position: cancel the pending frame and flush it now.
        const pendingTop = scrollPendingRef.current;
        scrollPendingRef.current = null;
        cancelFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
        if (typeof pendingTop === 'number') savePanelPrefs(sessionId, { scrollTop: pendingTop });
      }, [sessionId]);
      // Every change writes through both persistence tiers immediately.
      const changeMine = (next) => {
        setMine(next); setFilter('all');
        savePanelPrefs(sessionId, { mine: next, filter: 'all' });
      };
      const changeFilter = (next) => { setFilter(next); savePanelPrefs(sessionId, { filter: next }); };
      const toggleHistory = () => {
        setHistoryCollapsed(!historyCollapsed);
        savePanelPrefs(sessionId, { historyCollapsed: !historyCollapsed });
      };
      const toggleUsage = () => {
        setUsageCollapsed(!usageCollapsed);
        savePanelPrefs(sessionId, { usageCollapsed: !usageCollapsed });
      };
      const toggleMission = (id) => {
        const next = new Set(openIds);
        if (next.has(id)) next.delete(id); else next.add(id);
        setExpanded(next);
        savePanelPrefs(sessionId, { expanded: [...next] });
      };
      const selectAgent = (childId) => { setSelected(childId); savePanelPrefs(sessionId, { selected: childId }); };
      const renderRows = (list) => jsx('div', { className: 'Tw_rows', children: list.map((mission) => jsx(MissionRow, {
        mission, missions: missionList, roles: rolesOf(mission), expanded: openIds.has(mission.id),
        onToggle: () => toggleMission(mission.id), selected: activeSelected, onSelect: selectAgent, rows, t, openAgent,
      }, mission.id)) });
      // With the all filter, live and open work lead and the terminal history
      // follows; section heads appear only when there is more than one.
      const sections = filter === 'all'
        ? [
          ['running', visible.filter((mission) => missionBucket(mission) === 'running')],
          ['open', visible.filter((mission) => missionBucket(mission) === 'open')],
          ['history', visible.filter((mission) => ['merged', 'abandoned'].includes(missionBucket(mission)))],
        ].filter(([, list]) => list.length > 0)
        : [[filter, visible]];
      // Heads appear when more than one section shows; the history keeps its
      // foldable head whenever the all filter lists it, below the usage ranking.
      const headed = sections.length > 1;
      // Live and open work stay ahead of the usage ranking; the long terminal
      // history follows it, so the ranking never hides behind every past row.
      const usageSection = tower && jsx(UsageSection, { usage, collapsed: usageCollapsed, onToggle: toggleUsage, t }, 'usage');
      return jsxs('section', {
        ref: listRef,
        onScroll: handleListScroll,
        className: 'Tw_workspace', 'data-tower-workspace': true,
        'data-tower-scope': agentMode ? 'agent' : mine ? 'session' : 'workspace',
        children: [
          jsxs('div', { className: 'Tw_head', children: [
            jsx('h2', { title, children: t('trigger') }),
            tower && jsx('span', { className: 'Tw_repo', title: tower.repoRoot, children: `${repoName} · ${tower.baseBranch}` }),
            tower && !agentMode && jsxs('label', { className: 'Tw_mine', children: [
              jsx('input', { type: 'checkbox', checked: mine, 'data-tower-mine': true, onChange: () => changeMine(!mine) }),
              t('scope.mine'),
            ] }),
          ] }),
          agentMode && jsx('p', { className: 'Tw_hint', children: t('scope.agentHint') }),
          !tower && jsx('div', { className: 'Tw_notice', role: 'status', children: t(listing ? 'loading' : 'unavailable') }),
          tower && missionList.length === 0 && jsx('div', { className: 'Tw_notice', role: 'status', children: t('mission.empty') }),
          tower && missionList.length > 0 && missions.length === 0 && jsxs('div', { className: 'Tw_notice', role: 'status', children: [
            jsx('div', { children: t('scope.empty') }),
            jsx('button', { type: 'button', className: 'Tw_link', 'data-tower-show-all': true, onClick: () => changeMine(false), children: t('scope.showAll') }),
          ] }),
          missions.length > 0 && jsx('div', {
            className: 'Tw_filters', role: 'group', 'aria-label': t('filter.label'),
            // Empty buckets stay out of the way unless they are the active filter.
            children: FILTERS.filter((value) => value === 'all' || value === filter || counts[value] > 0).map((value) => jsxs('button', {
              type: 'button', 'aria-pressed': filter === value, 'data-tower-filter': value, 'data-count': counts[value],
              onClick: () => changeFilter(value),
              children: [t(`filter.${value}`), jsx('span', { className: 'Tw_count', children: counts[value] })],
            }, value)),
          }),
          missions.length > 0 && visible.length === 0 && jsx('div', { className: 'Tw_notice', role: 'status', children: t('filter.empty') }),
          ...sections.flatMap(([key, list]) => {
            const foldable = filter === 'all' && key === 'history';
            const folded = foldable && historyCollapsed;
            const label = key === 'history' ? t('section.history') : t(`filter.${key}`);
            return [key === 'history' && usageSection, jsxs('section', { className: 'Tw_section', 'data-tower-section': key, children: [
              (headed || foldable) && (foldable
                ? jsxs('button', {
                  type: 'button', className: 'Tw_sectionHead', 'data-history-toggle': true, 'aria-expanded': !folded, onClick: toggleHistory,
                  children: [
                    jsx('strong', { children: label }), jsx('small', { children: list.length }),
                    jsx('span', { className: 'Tw_chevron', 'aria-hidden': true, children: folded ? '▸' : '▾' }),
                  ],
                })
                : jsxs('div', { className: 'Tw_sectionHead', children: [jsx('strong', { children: label }), jsx('small', { children: list.length })] })),
              !folded && renderRows(list),
            ] }, key)];
          }),
          !sections.some(([key]) => key === 'history') && usageSection,
        ],
      });
    }

    // Cordis validates every service access against this list: each name below is
    // read through `ctx`, and a missing entry fails activation with
    // `cannot get property "<service>" without inject`.
    const inject = ["sessions", "slots", "locale", "sidebarRightTabs", "sidebarRight"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "client-ui-tower: dictionaries");
      const t = ctx.locale.bind(NS);
      // Open a Tower child Session as the product's native embedded chat: the
      // `subagentchat` resource owned by @deepseek-ai/dsh-client-ui-subagent.
      //
      // The address carries the child's REAL direct parent, because the Host
      // authorizes the transcript against it. Missions spawned by another
      // controller Session therefore resolve through the session catalog first
      // (`subagentAddress`), then the listed row, then the mission's recorded
      // controller. The panel's Session is never a guessed parent.
      const usableAddress = (address, childId) =>
        address != null && address.childSessionId === childId
        && typeof address.parentSessionId === 'string' && address.parentSessionId.length > 0
        && typeof address.mode === 'string' && !['unknown', 'external', ''].includes(address.mode);
      const resolveAddress = (childId, recordedParentSessionId) => {
        let address;
        try { address = ctx.sessions.subagentAddress?.(childId); } catch { /* Catalog may not be loaded. */ }
        if (usableAddress(address, childId)) return address;
        const row = ctx.sessions.list.getSnapshot().byId?.[childId];
        const listed = row?.projectionValues?.subagent?.address;
        if (usableAddress(listed, childId)) return listed;
        const parent = row?.parentId ?? recordedParentSessionId;
        if (typeof parent === 'string' && parent) return { parentSessionId: parent, childSessionId: childId, mode: 'continuable' };
        return undefined;
      };
      const openAgentAside = (childId, recordedParentSessionId) => {
        const address = resolveAddress(childId, recordedParentSessionId);
        if (!address) return false;
        ctx.sidebarRight.openResource(subagentChatAddress(address), { kind: 'subagentchat', preferNewPane: true });
        return true;
      };
      ctx.effect(() => ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
        name: "conversation.session.header.actions",
        id: "tower-enhanced",
        order: -19,
        locale: NS,
        inject: () => ({ openAgent: openAgentAside, resolveAddress }),
      }, TowerAction)), "ui-tower: header action");
      // Stage one: what the "tower" tab type is, plus the guide-page entry that
      // lets it be opened from the right Sidebar's start page. Stage two: the
      // keyed body seat below, under this definition's `id`.
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: "dsh-tower-enhanced",
        kind: "tower",
        priority: "extension",
        title: () => t("trigger"),
        guide: [{
          id: "tower",
          order: 25,
          title: () => t("guideTitle"),
          description: () => t("guideDescription"),
          icon: primitives.IconUsersOutlineRegular,
        }],
      }), "ui-tower: tab type");
      ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
        name: "sidebar.right.pane.tab",
        key: "dsh-tower-enhanced",
        locale: NS,
        inject: () => ({ openAgent: openAgentAside, resolveAddress }),
      }, TowerWorkspace)), "ui-tower: tab body");
    }
    exports.apply = apply;
    exports.inject = inject;
    exports.missionDependencyState = missionDependencyState;
    exports.missionNextStep = missionNextStep;
    exports.missionBucket = missionBucket;
    exports.modelUsage = modelUsage;
    exports.tokenTotal = tokenTotal;
    exports.formatTokens = formatTokens;
    return module.exports;
  },
});

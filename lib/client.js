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
  "unavailable": "当前会话还没有 Tower 状态。运行 tower init 后，这里会显示 mission 和各子 Agent 的模型。",
  "missions": "Missions",
  "worker": "Worker 模型",
  "reviewer": "Reviewer 模型",
  "notSpawned": "尚未派生",
  "verdict": "Review",
  "mergeCommit": "mergeCommit",
  "worktreeRemoved": "worktree 已清理",
  "guideTitle": "Tower",
  "guideDescription": "查看 Tower mission 与各子 Agent 模型",
  "status.pending": "待开始",
  "status.worker_running": "Worker 运行中",
  "status.worker_completed": "Worker 已完成",
  "status.worker_failed": "Worker 失败",
  "status.review_running": "Review 运行中",
  "status.changes_requested": "需要修改",
  "status.approved": "已通过",
  "status.rebase_blocked": "Rebase 受阻",
  "status.merge_blocked": "Merge 受阻",
  "status.merged": "已合并",
  "status.abandoned": "已放弃",
  "tree.controller": "主代理",
  "tree.work": "执行 · Work",
  "tree.review": "审查 · Review",
  "tree.agents": "{count} 个子代理",
  "tree.agentsRunning": "{count} 个子代理 · {running} 运行中",
  "tree.expandAll": "全部展开",
  "tree.collapseAll": "全部收起",
  "role.worker": "Worker",
  "role.reviewer": "Reviewer",
  "agent.running": "运行中",
  "agent.done": "执行完成",
  "agent.failed": "失败",
  "agent.idle": "空闲",
  "agent.notSpawned": "尚未派生",
  "agent.open": "查看对话",
  "detail.review": "Review",
  "detail.mergeCommit": "mergeCommit",
  "detail.worktreeRemoved": "worktree 已清理",
  "scope.session": "本会话",
  "scope.workspace": "工作区",
  "scope.sessionHint": "仅显示本会话派生的子代理",
  "scope.agentHint": "当前子代理的记录",
  "scope.workspaceHint": "整个工作区的子代理，包含其他会话",
  "scope.empty": "本会话没有派生 Tower 子代理。",
  "scope.workspaceEmpty": "这个工作区还没有子代理会话。",
  "scope.viewWorkspace": "查看工作区记录",
  "agent.reviewDone": "审查通过",
  "agent.interrupted": "已中断",
  "agent.stale": "结果已过期",
  "agent.changes_requested": "需要修改",
  "agent.unknown": "状态未知",
  "agent.modelUnknown": "模型未记录",
  "agent.selected": "已打开",
  "agent.openFailed": "无法确认这个子代理的归属，暂时不能打开对话。",
  "agent.owner": "来自",
  "agent.model": "启动模型",
  "filter.all": "全部",
  "filter.running": "运行中",
  "filter.attention": "需处理",
  "filter.empty": "没有符合条件的子代理。",
  "detail.title": "任务与结果",
  "detail.task": "任务",
  "detail.branch": "分支",
  "detail.session": "会话",
  "detail.result": "结果",
  "detail.checks": "检查",
  "detail.commit": "提交",
  "detail.reviewed": "审查提交",
  "detail.merge": "合并提交",
  "summary.agents": "{count} 个子代理",
  "summary.running": "{count} 运行中",
  "summary.attention": "{count} 需处理",
  "pending.title": "尚未产生会话的任务",
  "pending.starting": "正在创建子代理会话",
  "view.label": "视图",
  "view.missions": "任务",
  "view.agents": "Agents",
  "mission.count": "{count} 个任务",
  "mission.empty": "还没有任务。运行 tower add 创建第一个任务。",
  "mission.deps": "依赖",
  "mission.depMissing": "缺失",
  "mission.depJoin": "、",
  "mission.next": "下一步",
  "next.waitDeps": "等待依赖 {ids} 合并",
  "next.spawnWorker": "待派生 worker",
  "next.workerRunning": "进行中 · worker 执行中",
  "next.reviewRunning": "进行中 · review 审查中",
  "next.awaitReview": "待审查：派生 reviewer 审查 worker 提交",
  "next.rework": "需返工并重新审查",
  "next.canMerge": "可合并：等待 tower merge",
  "next.merged": "已合并",
  "next.rebaseManual": "需人工处理：rebase 冲突待解决",
  "next.mergeManual": "需人工处理：merge 受阻待排查",
  "next.workerFailed": "worker 失败，可重新派生",
  "next.abandoned": "已放弃",
  "next.unknown": "状态未知，等待 Tower 状态更新"
};
    const en = {
  "trigger": "Tower",
  "loading": "Loading Tower state…",
  "unavailable": "No Tower state in this session yet. Run tower init to see missions and each subagent's model.",
  "missions": "Missions",
  "worker": "Worker model",
  "reviewer": "Reviewer model",
  "notSpawned": "Not spawned",
  "verdict": "Review",
  "mergeCommit": "mergeCommit",
  "worktreeRemoved": "Worktree removed",
  "guideTitle": "Tower",
  "guideDescription": "Inspect Tower missions and each subagent's model",
  "status.pending": "Pending",
  "status.worker_running": "Worker running",
  "status.worker_completed": "Worker completed",
  "status.worker_failed": "Worker failed",
  "status.review_running": "Review running",
  "status.changes_requested": "Changes requested",
  "status.approved": "Approved",
  "status.rebase_blocked": "Rebase blocked",
  "status.merge_blocked": "Merge blocked",
  "status.merged": "Merged",
  "status.abandoned": "Abandoned",
  "tree.controller": "Controller",
  "tree.work": "Work",
  "tree.review": "Review",
  "tree.agents": "{count} subagents",
  "tree.agentsRunning": "{count} subagents · {running} running",
  "tree.expandAll": "Expand all",
  "tree.collapseAll": "Collapse all",
  "role.worker": "Worker",
  "role.reviewer": "Reviewer",
  "agent.running": "Running",
  "agent.done": "Work completed",
  "agent.failed": "Failed",
  "agent.idle": "Idle",
  "agent.notSpawned": "Not spawned",
  "agent.open": "View conversation",
  "detail.review": "Review",
  "detail.mergeCommit": "mergeCommit",
  "detail.worktreeRemoved": "Worktree removed",
  "scope.session": "This session",
  "scope.workspace": "Workspace",
  "scope.sessionHint": "Subagents created by this session only",
  "scope.agentHint": "This subagent’s own record",
  "scope.workspaceHint": "All workspace subagents, including other sessions",
  "scope.empty": "This session has not created any Tower subagents.",
  "scope.workspaceEmpty": "No subagent sessions in this workspace yet.",
  "scope.viewWorkspace": "View workspace records",
  "agent.reviewDone": "Review approved",
  "agent.interrupted": "Interrupted",
  "agent.stale": "Outdated result",
  "agent.changes_requested": "Changes requested",
  "agent.unknown": "Unknown status",
  "agent.modelUnknown": "Model not recorded",
  "agent.selected": "Opened",
  "agent.openFailed": "Cannot establish this subagent’s parent session to open its conversation.",
  "agent.owner": "From",
  "agent.model": "Launch model",
  "filter.all": "All",
  "filter.running": "Running",
  "filter.attention": "Needs attention",
  "filter.empty": "No matching subagents.",
  "detail.title": "Task & result",
  "detail.task": "Task",
  "detail.branch": "Branch",
  "detail.session": "Session",
  "detail.result": "Result",
  "detail.checks": "Checks",
  "detail.commit": "Commit",
  "detail.reviewed": "Reviewed commit",
  "detail.merge": "Merge commit",
  "summary.agents": "{count} subagents",
  "summary.running": "{count} running",
  "summary.attention": "{count} need attention",
  "pending.title": "Tasks without a session",
  "pending.starting": "Creating subagent session",
  "view.label": "View",
  "view.missions": "Missions",
  "view.agents": "Agents",
  "mission.count": "{count} missions",
  "mission.empty": "No missions yet. Run tower add to create the first one.",
  "mission.deps": "Depends on",
  "mission.depMissing": "missing",
  "mission.depJoin": ", ",
  "mission.next": "Next step",
  "next.waitDeps": "Waiting for {ids} to merge",
  "next.spawnWorker": "Spawn the worker",
  "next.workerRunning": "In progress · worker running",
  "next.reviewRunning": "In progress · review running",
  "next.awaitReview": "Await review: spawn a reviewer for the worker commit",
  "next.rework": "Rework required, then re-review",
  "next.canMerge": "Ready to merge via tower merge",
  "next.merged": "Merged",
  "next.rebaseManual": "Manual action needed: resolve the rebase conflict",
  "next.mergeManual": "Manual action needed: merge is blocked",
  "next.workerFailed": "Worker failed; may respawn",
  "next.abandoned": "Abandoned",
  "next.unknown": "Unknown status; waiting for Tower state"
};

    const css = "\n.Tw_root{position:relative}.Tw_trigger{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:none;border:0;border-radius:6px;align-items:center;gap:5px;padding:3px 7px;font-size:12px;display:inline-flex}.Tw_trigger:hover{color:var(--dsw-alias-label-primary)}\n.Tw_panel{z-index:100;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);width:min(480px,100vw - 32px);max-height:min(760px,100vh - 32px);box-shadow:var(--dsw-elevation-prominent);border-radius:12px;position:fixed;overflow:auto;background:var(--dsw-specific-menu)}\n.Tw_workspace{height:100%;min-height:0;overflow-y:auto;box-sizing:border-box;padding:16px;color:var(--dsw-alias-label-primary);font-size:12px;container-type:inline-size}.Tw_workspace *{box-sizing:border-box}.Tw_workspace button{font:inherit}.Tw_workspace button:focus-visible,.Tw_workspace summary:focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:2px}\n.Tw_workspaceHeader{display:flex;align-items:baseline;gap:10px;margin-bottom:4px}.Tw_workspaceHeader h2{font-size:17px;font-weight:600;margin:0}.Tw_repo{min-width:0;color:var(--dsw-alias-label-secondary);font-size:11px;overflow-wrap:anywhere}.Tw_owner{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:14px}\n.Tw_scope{display:flex;background:var(--dsw-alias-bg-layer-2);padding:3px;border-radius:8px;gap:3px}.Tw_scope button{flex:1;padding:6px 8px;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}.Tw_scope button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 3px #0002;font-weight:600}.Tw_hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5;margin:7px 0 12px}\n.Tw_summary{display:flex;gap:5px 12px;flex-wrap:wrap;margin:0 0 12px;color:var(--dsw-alias-label-secondary);font-size:11px}.Tw_summary strong{color:var(--dsw-alias-label-primary);font-weight:500}.Tw_filters{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 16px}.Tw_filters button{border:1px solid transparent;background:none;color:var(--dsw-alias-label-tertiary);border-radius:20px;padding:4px 9px;cursor:pointer;font-size:11px}.Tw_filters button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}\n.Tw_group{margin:0 0 18px}.Tw_groupHead{display:flex;align-items:center;gap:8px;width:100%;padding:4px 0 8px;border:0;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;text-align:left}.Tw_groupHead strong{font-size:12px;font-weight:600}.Tw_groupHead small{color:var(--dsw-alias-label-tertiary);font-size:11px}.Tw_chevron{margin-left:auto;font-size:10px}.Tw_groupMark{width:6px;height:6px;border-radius:2px;background:#74a7ef}.Tw_group[data-tower-group=reviewer] .Tw_groupMark{background:#bc9ae7}.Tw_groupBody{border-left:1px solid var(--dsw-alias-border-l2);margin-left:3px;padding-left:12px;display:flex;flex-direction:column;gap:8px}\n.Tw_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:9px;overflow:hidden}.Tw_card[data-selected=true]{border-color:#719fdf;background:color-mix(in srgb,#719fdf 6%,var(--dsw-alias-bg-layer-1))}.Tw_agent{border:0;background:none;color:inherit;display:block;width:100%;padding:11px 12px;text-align:left;cursor:pointer}.Tw_agent:hover{background:var(--dsw-alias-bg-layer-2)}.Tw_agentTop{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:6px}.Tw_agentId{font-size:10px;font-weight:600;color:var(--dsw-alias-label-tertiary)}.Tw_agentState{display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--dsw-alias-label-secondary);margin-left:auto}.Tw_agentState[data-state=failed],.Tw_agentState[data-state=interrupted],.Tw_agentState[data-state=changes_requested],.Tw_agentState[data-state=stale]{color:#dba76a}.Tw_duration{color:var(--dsw-alias-label-tertiary);font-size:10px}.Tw_agentTitle{display:block;font-size:13px;line-height:1.5;font-weight:500;overflow-wrap:anywhere;margin-bottom:7px}.Tw_model{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:11px;line-height:1.5}.Tw_modelName{font-family:var(--dsw-alias-font-mono);overflow-wrap:anywhere}.Tw_effort{color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l3);border-radius:4px;padding:0 4px;font-size:10px}.Tw_provider{display:block;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.5;overflow-wrap:anywhere;margin-top:3px}.Tw_agentFoot{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:5px;color:var(--dsw-alias-label-tertiary);font-size:10px}.Tw_agentFoot .Tw_provider{margin:0;flex:1}.Tw_open{white-space:nowrap;color:var(--dsw-alias-label-secondary)}.Tw_card[data-selected=true] .Tw_agentFoot .Tw_provider{margin:0;flex:1}.Tw_open{white-space:nowrap;color:#86afe8}\n.Tw_details{border-top:1px solid var(--dsw-alias-border-l2);font-size:11px}.Tw_details summary{padding:6px 12px;color:var(--dsw-alias-label-tertiary);cursor:pointer}.Tw_details[open] summary{color:var(--dsw-alias-label-secondary)}.Tw_detailBody{padding:4px 12px 12px;line-height:1.6;overflow-wrap:anywhere}.Tw_detailBody dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;margin:0}.Tw_detailBody dt{color:var(--dsw-alias-label-tertiary)}.Tw_detailBody dd{margin:0}.Tw_result{white-space:pre-wrap;max-height:240px;overflow:auto;font:inherit;margin:8px 0 0;color:var(--dsw-alias-label-secondary)}.Tw_checks{padding-left:18px;color:var(--dsw-alias-label-secondary)}.Tw_notice{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7;padding:16px 2px}.Tw_error{color:#dba76a;font-size:11px;padding:0 12px 8px;line-height:1.5}.Tw_link{background:none;border:0;color:var(--dsw-alias-label-primary);text-decoration:underline;text-underline-offset:3px;cursor:pointer;padding:8px 0}.Tw_footer{display:flex;justify-content:flex-end;gap:10px}.Tw_footer button{background:none;border:0;color:var(--dsw-alias-label-tertiary);font-size:11px;cursor:pointer;padding:4px 0}.Tw_pending{margin-top:14px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px;color:var(--dsw-alias-label-tertiary);font-size:11px}.Tw_pending p{display:flex;gap:8px;justify-content:space-between;line-height:1.5}\n.Tw_viewToggle{display:flex;background:var(--dsw-alias-bg-layer-2);padding:3px;border-radius:8px;gap:3px;margin:0 0 12px}.Tw_viewToggle button{flex:1;padding:6px 8px;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}.Tw_viewToggle button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 3px #0002;font-weight:600}\n.Tw_missions{display:flex;flex-direction:column;gap:10px}\n.Tw_mission{padding:11px 12px}\n.Tw_missionHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}.Tw_missionId{font-size:10px;font-weight:600;color:var(--dsw-alias-label-tertiary)}.Tw_missionStatus{display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--dsw-alias-label-secondary);margin-left:auto}.Tw_missionTitle{display:block;font-size:13px;line-height:1.5;font-weight:500;overflow-wrap:anywhere;margin-bottom:7px}\n.Tw_deps{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:10px;color:var(--dsw-alias-label-tertiary);margin-bottom:7px}.Tw_dep{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;padding:0 5px;color:var(--dsw-alias-label-secondary)}.Tw_dep[data-dep-met=false]{border-color:#dba76a;color:#dba76a;background:color-mix(in srgb,#dba76a 8%,transparent)}\n.Tw_next{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin-bottom:7px}.Tw_next strong{color:var(--dsw-alias-label-primary);font-weight:600}.Tw_next[data-blocked=true]{color:#dba76a}.Tw_next[data-blocked=true] strong{color:#dba76a}\n.Tw_missionRoles{display:flex;flex-direction:column;gap:4px;margin-bottom:7px}.Tw_roleRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}.Tw_roleName{display:inline-flex;align-items:center;gap:5px}.Tw_roleState{display:inline-flex;align-items:center;gap:4px;font-size:10px}.Tw_roleModel{font-family:var(--dsw-alias-font-mono);font-size:10px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}.Tw_mergeCommit{font-size:10px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}.Tw_mergeCommit code{font-family:var(--dsw-alias-font-mono)}\n@container (width<330px){.Tw_workspaceHeader{flex-wrap:wrap;gap:4px}.Tw_agent{padding:10px}.Tw_groupBody{padding-left:8px}.Tw_agentTitle{font-size:12px}.Tw_agentFoot{gap:4px 6px}}\n";
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
      review_running: 'ongoing', changes_requested: 'warning', approved: 'done',
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
      if (status === 'changes_requested') return { key: 'next.rework', ids: [], blocked: false };
      if (status === 'approved') return { key: 'next.canMerge', ids: [], blocked: false };
      const cleanReview = mission.review?.verdict === 'clean' && mission.review?.merge === true;
      const rejectedReview = mission.review != null
        && (mission.review.verdict === 'changes_requested' || mission.review.merge === false);
      if (status === 'worker_completed') {
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
      if (role === 'reviewer' && (agent.verdict === 'changes_requested' || agent.merge === false)) return 'changes_requested';
      if (agent.completedAt || agent.stopReason === 'completed' || agent.verdict || agent.headCommit) return 'done';
      if (agent.startedAt && mission.status === (role === 'worker' ? 'worker_running' : 'review_running')) return 'running';
      return 'unknown';
    }
    const ATTENTION = new Set(['failed', 'interrupted', 'stale', 'changes_requested', 'unknown']);
    const AGENT_DOT = { running: 'ongoing', done: 'done', failed: 'error', interrupted: 'warning', stale: 'warning', changes_requested: 'warning', unknown: 'idle' };

    function AgentLeaf({ entry, rows, t, openAgent, selected, onSelect, workspace }) {
      const { mission, role, agent, address } = entry;
      const [error, setError] = React.useState(false);
      const state = agentState(entry);
      const label = rows[agent.childId]?.projectionValues?.subagent?.label ?? `${mission.id}:${role}`;
      const parentId = address?.parentSessionId;
      const parent = rows[parentId]?.displayTitle ?? rows[parentId]?.title ?? parentId;
      const duration = agent.completedAt || state === 'running' ? durationText(agent.startedAt, agent.completedAt) : '';
      const result = agent.error ?? agent.summary ?? agent.output;
      const detailRows = [
        [t('detail.task'), `${mission.id} · ${statusText(mission.status, t)}`],
        [t('detail.session'), label],
        [t('detail.branch'), mission.branch],
        [t('agent.model'), `${agent.provider ?? '?'} / ${agent.model ?? '?'}${agent.reasoningEffort ? ` · ${agent.reasoningEffort}` : ''}`],
        [t('detail.commit'), role === 'worker' ? agent.headCommit : undefined],
        [t('detail.reviewed'), role === 'reviewer' ? agent.reviewedCommit : undefined],
        [t('detail.merge'), mission.merge?.commit],
      ].filter(([, value]) => value !== undefined);
      return jsxs('article', {
        className: 'Tw_card', 'data-selected': selected, 'data-agent-session': agent.childId,
        children: [
          jsxs('button', {
            type: 'button', className: 'Tw_agent', 'data-tower-agent': `${mission.id}:${role}`,
            'aria-label': `${t('agent.open')} · ${t(`role.${role}`)} · ${mission.title} · ${agent.model ?? t('agent.modelUnknown')}`,
            'aria-pressed': selected,
            title: `${label}\n${agent.provider ?? '?'} / ${agent.model ?? '?'}${agent.reasoningEffort ? ` · ${agent.reasoningEffort}` : ''}`,
            onClick: () => {
              const opened = openAgent(agent.childId, agent.controllerSessionId);
              setError(opened === false);
              if (opened !== false) onSelect(agent.childId);
            },
            children: [
              jsxs('span', { className: 'Tw_agentTop', children: [
                jsx('span', { className: 'Tw_agentId', children: `${mission.id} · ${t(`role.${role}`)}` }),
                jsxs('span', { className: 'Tw_agentState', 'data-state': state, children: [
                  jsx(primitives.StateDot, { state: AGENT_DOT[state] }),
                  t(state === 'done' && role === 'reviewer' && agent.verdict === 'clean' ? 'agent.reviewDone' : `agent.${state}`),
                ] }),
              ] }),
              jsx('span', { className: 'Tw_agentTitle', children: mission.title }),
              jsxs('span', { className: 'Tw_model', children: [
                jsx('span', { className: 'Tw_modelName', children: agent.model ?? t('agent.modelUnknown') }),
                agent.reasoningEffort && jsx('span', { className: 'Tw_effort', children: agent.reasoningEffort }),
              ] }),
              workspace && parent && jsx('span', { className: 'Tw_provider', title: parentId, children: `${t('agent.owner')} ${parent}` }),
              jsxs('span', { className: 'Tw_agentFoot', children: [
                jsx('span', { className: 'Tw_provider', children: agent.provider }),
                jsx('span', { className: 'Tw_duration', children: duration }),
                jsx('span', { className: 'Tw_open', children: `${t(selected ? 'agent.selected' : 'agent.open')} ↗` }),
              ] }),
            ],
          }),
          error && jsx('div', { className: 'Tw_error', role: 'alert', children: t('agent.openFailed') }),
          jsxs('details', { className: 'Tw_details', children: [
            jsx('summary', { children: t('detail.title') }),
            jsxs('div', { className: 'Tw_detailBody', children: [
              jsx('dl', { children: detailRows.map(([key, value]) => jsxs(Fragment, { children: [jsx('dt', { children: key }), jsx('dd', { children: value })] }, key)) }),
              result && jsx('pre', { className: 'Tw_result', children: result }),
              agent.checks?.length > 0 && jsxs(Fragment, { children: [
                jsx('p', { children: t('detail.checks') }),
                jsx('ul', { className: 'Tw_checks', children: agent.checks.map((check, i) => jsx('li', { children: check }, i)) }),
              ] }),
            ] }),
          ] }),
        ],
      });
    }

    // Mission-first card: stage, dependency chips, next-step hint, and role
    // rows. Display-only; opening conversations stays in the agents view.
    function MissionCard({ mission, missions, t }) {
      const deps = missionDependencyState(mission, missions);
      const next = missionNextStep(mission, missions);
      return jsxs('article', {
        className: 'Tw_card Tw_mission', 'data-mission-id': mission.id, 'data-mission-status': mission.status,
        children: [
          jsxs('div', { className: 'Tw_missionHead', children: [
            jsx('span', { className: 'Tw_missionId', children: mission.id }),
            jsxs('span', { className: 'Tw_missionStatus', 'data-state': mission.status, children: [
              jsx(primitives.StateDot, { state: MISSION_DOT[mission.status] ?? 'idle' }),
              statusText(mission.status, t),
            ] }),
          ] }),
          jsx('span', { className: 'Tw_missionTitle', children: mission.title }),
          deps.length > 0 && jsxs('div', { className: 'Tw_deps', 'data-mission-deps': true, children: [
            jsxs('span', { children: [t('mission.deps'), ':'] }),
            ...deps.map((dep) => jsxs('span', {
              className: 'Tw_dep', 'data-dep-id': dep.id, 'data-dep-met': dep.met,
              children: [dep.id, ' · ', dep.status === 'missing' ? t('mission.depMissing') : statusText(dep.status, t)],
            }, dep.id)),
          ] }),
          jsxs('div', { className: 'Tw_next', 'data-mission-next': next.key, 'data-blocked': next.blocked, children: [
            jsxs('strong', { children: [t('mission.next'), ': '] }),
            t(next.key, { ids: next.ids.join(t('mission.depJoin')) }),
          ] }),
          jsxs('div', { className: 'Tw_missionRoles', children: [['worker', mission.worker], ['reviewer', mission.review]].map(([role, agent]) => {
            // A role record without childId is a launch in progress, not a session yet.
            const spawned = typeof agent?.childId === 'string' && agent.childId.length > 0;
            const state = spawned ? agentState({ mission, role, agent }) : undefined;
            const stateLabel = !spawned
              ? (agent ? t('pending.starting') : t('notSpawned'))
              : t(state === 'done' && role === 'reviewer' && agent.verdict === 'clean' ? 'agent.reviewDone' : `agent.${state}`);
            return jsxs('div', {
              className: 'Tw_roleRow', 'data-mission-role': role, 'data-spawned': spawned,
              children: [
                jsxs('span', { className: 'Tw_roleName', children: [
                  t(`role.${role}`),
                  jsxs('span', { className: 'Tw_roleState', 'data-state': state ?? 'notSpawned', children: [
                    jsx(primitives.StateDot, { state: spawned ? AGENT_DOT[state] ?? 'idle' : 'idle' }),
                    stateLabel,
                  ] }),
                ] }),
                (agent?.provider || agent?.model) && jsx('span', {
                  className: 'Tw_roleModel',
                  children: `${agent.provider ?? '?'} / ${agent.model ?? '?'}`,
                }),
              ],
            }, role);
          }) }),
          mission.merge?.commit && jsxs('div', { className: 'Tw_mergeCommit', 'data-merge-commit': mission.merge.commit, children: [
            `${t('detail.merge')}: `,
            jsx('code', { children: mission.merge.commit }),
          ] }),
        ],
      });
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
      const [view, setView] = React.useState('agents');
      const [scope, setScope] = React.useState('session');
      const [filter, setFilter] = React.useState('all');
      const [collapsed, setCollapsed] = React.useState(new Set());
      const [selected, setSelected] = React.useState(null);
      const [, tick] = React.useState(0);
      React.useEffect(() => { setView('agents'); setScope('session'); setFilter('all'); setSelected(null); setCollapsed(new Set()); }, [sessionId]);
      const all = agentEntries(tower, resolveAddress);
      const self = all.filter((entry) => entry.agent.childId === sessionId);
      const entries = scope === 'workspace' ? all : self.length ? self : all.filter((entry) => entry.address?.parentSessionId === sessionId);
      const running = entries.filter((entry) => agentState(entry) === 'running').length;
      const attention = entries.filter((entry) => ATTENTION.has(agentState(entry))).length;
      React.useEffect(() => {
        if (!running) return undefined;
        const timer = setInterval(() => tick((n) => n + 1), 1000);
        return () => clearInterval(timer);
      }, [running]);
      const visible = entries.filter((entry) => filter === 'all' || (filter === 'running' ? agentState(entry) === 'running' : ATTENTION.has(agentState(entry))));
      const groups = ['worker', 'reviewer'].filter((role) => visible.some((entry) => entry.role === role));
      const title = rows[sessionId]?.displayTitle ?? rows[sessionId]?.title ?? t('tree.controller');
      // The tower projection is repo-wide, so the missions view always shows
      // every mission of the workspace; scope only filters the agents view.
      const missionList = tower?.missions ?? [];
      const pending = scope === 'workspace' ? missionList.filter((m) => !m.worker?.childId && !m.review?.childId) : [];
      const changeScope = (next) => { setScope(next); setFilter('all'); setSelected(null); };
      const changeCollapsed = (role) => {
        const next = new Set(collapsed);
        if (next.has(role)) next.delete(role); else next.add(role);
        setCollapsed(next);
      };
      return jsxs('section', {
        className: 'Tw_workspace', 'data-tower-workspace': true, 'data-tower-scope': scope,
        children: [
          jsxs('div', { className: 'Tw_workspaceHeader', children: [
            jsx('h2', { children: t('trigger') }),
            tower && jsx('span', { className: 'Tw_repo', title: tower.repoRoot, children: `${tower.repoRoot.split(/[\\/]/).filter(Boolean).pop()} · ${tower.baseBranch}` }),
          ] }),
          jsx('div', { className: 'Tw_owner', title, children: title }),
          !tower && jsx('div', { className: 'Tw_notice', role: 'status', children: t(listing ? 'loading' : 'unavailable') }),
          tower && jsxs(Fragment, { children: [
            jsxs('div', { className: 'Tw_viewToggle', role: 'group', 'aria-label': t('view.label'), children: ['missions', 'agents'].map((value) => jsx('button', {
              type: 'button', 'aria-pressed': view === value, 'data-tower-view-button': value,
              onClick: () => setView(value), children: t(`view.${value}`),
            }, value)) }),
            view === 'missions' && jsxs('section', { className: 'Tw_missions', 'data-tower-mission-view': true, children: [
              jsxs('div', { className: 'Tw_summary', children: [
                jsx('strong', { children: t('mission.count', { count: missionList.length }) }),
              ] }),
              missionList.length === 0 && jsx('div', { className: 'Tw_notice', role: 'status', children: t('mission.empty') }),
              missionList.map((mission) => jsx(MissionCard, { mission, missions: missionList, t }, mission.id)),
            ] }),
            view === 'agents' && jsxs(Fragment, { children: [
              jsx('div', { className: 'Tw_scope', children: ['session', 'workspace'].map((value) => jsx('button', {
                type: 'button', 'aria-pressed': scope === value, 'data-tower-scope-button': value,
                onClick: () => changeScope(value), children: t(`scope.${value}`),
              }, value)) }),
              jsx('p', { className: 'Tw_hint', children: t(scope === 'workspace' ? 'scope.workspaceHint' : self.length ? 'scope.agentHint' : 'scope.sessionHint') }),
              entries.length > 0 && jsxs(Fragment, { children: [
                jsxs('div', { className: 'Tw_summary', children: [
                  jsx('strong', { children: t('summary.agents', { count: entries.length }) }),
                  jsx('span', { children: t('summary.running', { count: running }) }),
                  attention > 0 && jsx('span', { children: t('summary.attention', { count: attention }) }),
                ] }),
                jsx('div', { className: 'Tw_filters', children: ['all', 'running', 'attention'].map((value) => jsx('button', {
                  type: 'button', 'aria-pressed': filter === value, 'data-tower-filter': value,
                  onClick: () => setFilter(value), children: t(`filter.${value}`),
                }, value)) }),
                visible.length === 0 && jsx('div', { className: 'Tw_notice', role: 'status', children: t('filter.empty') }),
              ] }),
              entries.length === 0 && jsxs('div', { className: 'Tw_notice', role: 'status', children: [
                jsx('div', { children: t(scope === 'session' ? 'scope.empty' : 'scope.workspaceEmpty') }),
                scope === 'session' && all.length > 0 && jsx('button', { type: 'button', className: 'Tw_link', onClick: () => changeScope('workspace'), children: t('scope.viewWorkspace') }),
              ] }),
              groups.map((role) => jsxs('section', { className: 'Tw_group', 'data-tower-group': role, children: [
                jsxs('button', { className: 'Tw_groupHead', type: 'button', 'aria-expanded': !collapsed.has(role), onClick: () => changeCollapsed(role), children: [
                  jsx('span', { className: 'Tw_groupMark', 'aria-hidden': true }),
                  jsx('strong', { children: t(role === 'worker' ? 'tree.work' : 'tree.review') }),
                  jsx('small', { children: visible.filter((entry) => entry.role === role).length }),
                  jsx('span', { className: 'Tw_chevron', 'aria-hidden': true, children: collapsed.has(role) ? '▸' : '▾' }),
                ] }),
                !collapsed.has(role) && jsx('div', { className: 'Tw_groupBody', children: visible.filter((entry) => entry.role === role).map((entry) => jsx(AgentLeaf, {
                  entry, rows, t, openAgent, selected: selected === entry.agent.childId, onSelect: setSelected, workspace: scope === 'workspace',
                }, entry.agent.childId)) }),
              ] }, role)),
              groups.length > 0 && jsxs('div', { className: 'Tw_footer', children: [
                jsx('button', { type: 'button', onClick: () => setCollapsed(new Set()), children: t('tree.expandAll') }),
                jsx('button', { type: 'button', onClick: () => setCollapsed(new Set(groups)), children: t('tree.collapseAll') }),
              ] }),
              pending.length > 0 && jsxs('div', { className: 'Tw_pending', children: [
                jsx('strong', { children: t('pending.title') }),
                pending.map((m) => jsxs('p', { children: [jsx('span', { children: `${m.id} · ${m.title}` }), jsx('span', { children: statusText(m.status, t) })] }, m.id)),
              ] }),
            ] }),
          ] }),
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
    return module.exports;
  },
});

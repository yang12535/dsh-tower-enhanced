import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TOWER_RECORD_TYPE } from './projection.js';
import { repoRoot } from './git.js';
import { TowerCore } from './core.js';
import { assertTower, errorMessage } from './errors.js';

export const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['clean', 'changes_requested'] },
    merge: { type: 'boolean' },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['p1', 'p2', 'p3'] },
          path: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['severity', 'message'],
      },
    },
    checks: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'merge', 'summary', 'findings', 'checks'],
};

function required(value, field) {
  assertTower(typeof value === 'string' && value.trim().length > 0, 'ARGUMENT_INVALID', `${field} must be a non-empty string`);
  return value.trim();
}

function outputText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n').slice(0, 50_000);
}

/** Stop reasons meaning the run was stopped rather than errored. */
const INTERRUPTED_STOP_REASONS = new Set(['interrupted', 'aborted', 'cancelled', 'canceled']);

/** Upper bound for the reason text carried inside a settlement notice. */
const NOTICE_REASON_LIMIT = 500;

function boundedReason(value) {
  const text = typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'no reason recorded';
  return text.length <= NOTICE_REASON_LIMIT ? text : `${text.slice(0, NOTICE_REASON_LIMIT - 1)}…`;
}

/** Derive the outcome word for the settlement summary line. */
function settlementOutcome(mission, role, stopReason) {
  const status = mission?.status;
  if (status === undefined) return 'failed';
  if (status === 'approved') return 'approved';
  if (status === 'changes_requested') return 'rejected';
  if (status === 'worker_failed' || status === 'review_failed') {
    return INTERRUPTED_STOP_REASONS.has(stopReason) ? 'interrupted' : 'failed';
  }
  if (status === 'worker_completed' && role === 'reviewer' && mission.review?.stale === true) return 'stale';
  return 'completed';
}

/** Next-action hint for outcomes the controller must react to. */
function nextActionFor(outcome, status) {
  if (status === 'worker_failed') return 'spawn a fresh worker when ready (tower action=spawn role=worker)';
  if (status === 'review_failed') return 'spawn a fresh reviewer when ready (tower action=spawn role=reviewer)';
  if (status === 'changes_requested') return 'spawn a worker to address the findings, then review again (tower action=spawn role=worker)';
  if (outcome === 'stale') return 'rebase the mission onto the current base, then obtain a fresh review (tower action=rebase)';
  if (status === 'approved') return 'run the merge gate and merge when ready (tower action=gate, then action=merge)';
  return undefined;
}

/**
 * Build the controller notice for one settled run. The summary line follows
 * `Tower <role> for <mission> <outcome>: mission status <status>`; failure,
 * interrupted, and stale outcomes add a bounded reason plus the next action.
 * When the run could not even be recorded (`mission` undefined) the notice
 * degrades to a fallback that still names role, mission, run, and error.
 */
function settlementNotice({ role, missionId, runId, mission, stopReason, settleError }) {
  const status = mission?.status ?? 'unknown';
  const outcome = settlementOutcome(mission, role, stopReason);
  const summary = `Tower ${role} for ${missionId} ${outcome}: mission status ${status}`;
  const lines = [summary];
  if (mission === undefined) {
    lines.push(`run ${runId} could not be recorded in Tower state`);
    lines.push(`reason: ${boundedReason(settleError === undefined ? undefined : errorMessage(settleError))}`);
    lines.push('Next: inspect the mission with tower action=status before respawning anything.');
    return { summary, text: lines.join('\n') };
  }
  const attention = outcome === 'failed' || outcome === 'interrupted' || outcome === 'stale';
  if (attention) {
    const record = role === 'reviewer' ? mission.review : mission.worker;
    lines.push(`reason: ${boundedReason(record?.error ?? record?.diagnostic)}`);
  }
  const action = nextActionFor(outcome, status);
  lines.push(action === undefined
    ? 'Review the recorded output and use tower action=status or the appropriate next action.'
    : `Next: ${action}.`);
  return { summary, text: lines.join('\n') };
}

function assertCallingAgent(agent) {
  assertTower(agent, 'CALLING_AGENT_REQUIRED', 'tower requires a calling agent');
  assertTower('session' in agent && typeof agent.session?.id === 'string' && agent.session.id.length > 0, 'CALLING_AGENT_REQUIRED', 'tower requires an agent Session');
}

function roleDefaults(config, role) {
  const value = role === 'worker' ? config.workerAgentOptions : config.reviewerAgentOptions;
  assertTower(value === undefined || (typeof value === 'object' && value !== null && !Array.isArray(value)), 'CONFIG_INVALID', `${role}AgentOptions must be an object`);
  return value ?? {};
}

function routeKey(route) {
  return `${route.provider}\0${route.model}`;
}

/** Deterministic ascending order for provider routes and model ids, independent of host locale. */
function ascending(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Maximum catalog entries reported for one provider in the single-provider listing. */
const PROVIDER_CATALOG_LIMIT = 500;

/** Maximum catalog entries reported per provider in the no-provider aggregate listing. */
const AGGREGATE_CATALOG_LIMIT_PER_PROVIDER = 100;

/**
 * Contain one provider's catalog failure for the aggregate models listing.
 * Keeps the LLM layer's stable error code (e.g. `NO_ADAPTER`, `AUTH`) when the
 * thrown error carries one, and degrades to a generic code otherwise.
 */
function providerCatalogError(error) {
  return {
    code: typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'MODEL_CATALOG_FAILED',
    message: errorMessage(error),
  };
}

function workerBrief(mission, instructions, previousReview) {
  const scope = mission.scope.length > 0 ? mission.scope.join(', ') : 'no explicit path restriction';
  const prior = previousReview ? `\nPrevious review feedback (address it before committing):\n${JSON.stringify({ summary: previousReview.summary, findings: previousReview.findings, checks: previousReview.checks })}\n` : '';
  return `You are the Tower worker for mission ${mission.id}: ${mission.title}.\n\nWork only in the current mission worktree. Do not change the base checkout, create another worktree, merge, or rebase unless the controller explicitly asks you to resolve a rebase conflict here. Mission scope: ${scope}.\n\nMission description:\n${mission.description}\n${prior}\nAdditional controller instructions:\n${instructions ?? '(none)'}\n\nImplement the mission and run relevant checks. Review your own diff, stage only intended files, and create a Git commit in this worktree. Do not leave uncommitted or untracked artifacts. Finish with a concise report containing the commit SHA, changes, and checks run.`;
}

function reviewerBrief(mission, instructions) {
  const review = mission.review;
  return `You are the independent Tower reviewer for mission ${mission.id}: ${mission.title}.\n\nReview the exact commit binding:\n- base: ${review.baseCommit}\n- reviewed: ${review.reviewedCommit}\n\nUse read-only inspection. Do not edit files, stage, commit, merge, rebase, or otherwise mutate Git state. Review the diff with git diff ${review.baseCommit}...${review.reviewedCommit}, inspect relevant context, and run only checks that do not alter tracked files. Mission scope: ${mission.scope.length > 0 ? mission.scope.join(', ') : 'no explicit path restriction'}.\n\nMission description:\n${mission.description}\n\nAdditional controller instructions:\n${instructions ?? '(none)'}\n\nA clean verdict with merge=true is approval to merge. Use changes_requested with merge=false for any correctness, scope, security, or test issue. Report findings and checks through the required structured output.`;
}

export class TowerRuntime {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.provider = config.provider ?? 'spawn';
    this.stateDirectory = config.stateDirectory ?? '.dsh-tower';
    this.branchPrefix = config.branchPrefix ?? 'tower';
    this.config = config;
    this.cores = new Map();
    this.active = new Map();
    /**
     * Session that currently holds each repository's tower. Tower membership
     * follows the workspace, not the Session's lineage (Kimi Code likewise lets
     * any Session own a workspace tower and refuses a second owner while one is
     * live), so this map is the whole of the ownership policy: it is claimed
     * while a call runs and while any worker/reviewer activation it started is
     * still in flight.
     */
    this.inFlight = new Map();
    /**
     * Run ids already reported by the agent/created stale-run probe. The probe
     * must not nag: one notice per persisted run per runtime is enough for the
     * controller to notice a restart left zombies behind.
     */
    this.staleNotified = new Set();
    this.abort = new AbortController();
    this.disposed = false;
    assertTower(config.allowedModels === undefined || Array.isArray(config.allowedModels), 'CONFIG_INVALID', 'allowedModels must be an array of exact routes');
    this.allowedModels = config.allowedModels === undefined ? undefined : new Map(config.allowedModels.map((route) => {
      assertTower(route && typeof route.provider === 'string' && route.provider && typeof route.model === 'string' && route.model, 'CONFIG_INVALID', 'every allowedModels entry requires provider and model');
      return [routeKey(route), { provider: route.provider, model: route.model }];
    }));
  }

  async publish(agent, core) {
    try {
      const state = await core.status({ observe: false });
      appendPluginRecord(agent.session, TOWER_RECORD_TYPE, { version: 1, state });
      await this.ctx.sessions.flush(agent.session);
    } catch (error) {
      this.ctx.logger.warn(`Tower projection publication failed: ${errorMessage(error)}`);
    }
  }

  async resolveRoot(agent, signal) {
    const cwd = await this.ctx.workingDirectory.ensure(agent, signal);
    return await repoRoot(cwd, signal);
  }

  async coreAt(root, signal, initialize = false, baseBranch = undefined) {
    let core = this.cores.get(root);
    if (!core) {
      core = new TowerCore({ cwd: root, stateDirectory: this.stateDirectory, branchPrefix: this.branchPrefix });
      this.cores.set(root, core);
    }
    if (initialize) await core.init({ baseBranch, signal });
    else await core.open(signal);
    return core;
  }

  /**
   * Read which Session owns one repository's tower right now.
   * @param root - canonical repository root.
   * @returns the owning Session id, or undefined when the repository is free.
   */
  workspaceOwner(root) {
    const call = this.inFlight.get(root);
    if (call !== undefined) return call;
    for (const entry of this.active.values()) {
      if (entry.core === undefined || entry.parent?.session?.id === undefined) continue;
      const entryRoot = entry.core.store?.repoRoot;
      if (entryRoot === root) return entry.parent.session.id;
    }
    return undefined;
  }

  /**
   * Claim a repository for one Session, refusing a live foreign owner.
   * @param root - canonical repository root.
   * @param sessionId - Session making the call.
   */
  claimWorkspace(root, sessionId) {
    const owner = this.workspaceOwner(root);
    assertTower(owner === undefined || owner === sessionId, 'WORKSPACE_BUSY', `another Session (${String(owner)}) owns this workspace tower; finish or release it there, or wait for its worker/reviewer to settle`);
    this.inFlight.set(root, sessionId);
  }

  /**
   * Release this call's claim without dropping one another call still holds.
   * @param root - canonical repository root.
   * @param sessionId - Session that made the call.
   */
  releaseWorkspace(root, sessionId) {
    if (this.inFlight.get(root) === sessionId) this.inFlight.delete(root);
  }

  async resolveRoute(agent, role, args, signal) {
    const parentOptions = parentAgentOptionsForDelegation(agent);
    assertTower(args.provider === undefined || args.model !== undefined, 'MODEL_ROUTE_INCOMPLETE', 'provider and model must be supplied together');
    assertTower(args.model === undefined || args.provider !== undefined, 'MODEL_ROUTE_INCOMPLETE', 'provider and model must be supplied together');
    assertTower(args.max_tokens === undefined || (Number.isSafeInteger(args.max_tokens) && args.max_tokens > 0), 'MAX_TOKENS_INVALID', 'max_tokens must be a positive safe integer');
    const defaults = roleDefaults(this.config, role);
    const requested = {
      ...defaults,
      ...(args.provider === undefined ? {} : { provider: args.provider, model: args.model }),
      ...(args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort }),
      ...(args.max_tokens === undefined ? {} : { maxTokens: args.max_tokens }),
    };
    if (Object.keys(requested).length === 0) {
      return {
        agentOptions: undefined,
        route: {
          ...(parentOptions.provider === undefined ? {} : { provider: parentOptions.provider }),
          ...(parentOptions.model === undefined ? {} : { model: parentOptions.model }),
          ...(parentOptions.reasoningEffort === undefined ? {} : { reasoningEffort: parentOptions.reasoningEffort }),
        },
      };
    }
    const baselineProvider = defaults.provider ?? parentOptions.provider;
    const baselineModel = defaults.model ?? parentOptions.model;
    const provider = requested.provider ?? parentOptions.provider;
    const model = requested.model ?? parentOptions.model;
    assertTower(provider && model, 'MODEL_ROUTE_REQUIRED', 'a provider and model are required when agent options are overridden');
    const sameRoute = provider === parentOptions.provider && model === parentOptions.model;
    const explicitRouteChanged = provider !== baselineProvider || model !== baselineModel;
    const reasoningEffort = args.reasoning_effort ?? (explicitRouteChanged ? undefined : requested.reasoningEffort ?? (sameRoute ? parentOptions.reasoningEffort : undefined));
    if (this.allowedModels) {
      assertTower(this.allowedModels.has(routeKey({ provider, model })), 'MODEL_ROUTE_NOT_ALLOWED', `route ${provider}/${model} is not in tower.allowedModels`, { allowedModels: [...this.allowedModels.values()] });
    }
    const resolved = await this.ctx.llm.resolveCallConfig({
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }, signal);
    return {
      agentOptions: {
        provider,
        model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
        ...(requested.maxTokens === undefined ? {} : { maxTokens: requested.maxTokens }),
      },
      route: {
        provider,
        model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
        ...(requested.maxTokens === undefined ? {} : { maxTokens: requested.maxTokens }),
      },
    };
  }

  async spawn(core, agent, args, signal) {
    assertTower(!this.disposed, 'RUNTIME_DISPOSED', 'Tower runtime is disposed');
    const role = required(args.role, 'role');
    const missionId = required(args.mission_id, 'mission_id');
    const selection = await this.resolveRoute(agent, role, args, signal);
    const previous = await core.mission(missionId);
    const begun = await core.beginSpawn({ missionId, role, controllerSessionId: agent.session.id, ...selection.route, signal });
    const mission = begun.mission;
    const prompt = role === 'worker' ? workerBrief(mission, args.instructions, previous.review) : reviewerBrief(mission, args.instructions);
    let activation;
    try {
      activation = await this.ctx.subagents.startActivation({
        provider: this.provider,
        label: `tower:${missionId}:${role}`,
        delivery: 'caller',
        signal,
        request: {
          parent: agent,
          cwd: mission.worktree,
          prompt: [{ type: 'text', text: prompt }],
          ...(selection.agentOptions === undefined ? {} : { agentOptions: selection.agentOptions }),
          ...(role === 'reviewer' ? { outputSchema: REVIEW_OUTPUT_SCHEMA } : {}),
        },
      });
    } catch (error) {
      await core.failSpawn(begun.runId, error);
      throw error;
    }
    try {
      await core.attachSpawn(begun.runId, activation.childId);
      assertTower(!this.disposed, 'RUNTIME_DISPOSED', 'Tower runtime is disposed');
      const entry = { activation, core, parent: agent, missionId, role, runId: begun.runId, childId: activation.childId, done: undefined };
      this.active.set(begun.runId, entry);
      entry.done = this.track(entry);
      return {
        mission: missionId,
        role,
        runId: begun.runId,
        childId: activation.childId,
        status: mission.status,
        worktree: mission.worktree,
        route: selection.route,
        ...(role === 'reviewer' ? { binding: { baseCommit: mission.review.baseCommit, reviewedCommit: mission.review.reviewedCommit } } : {}),
      };
    } catch (error) {
      this.active.delete(begun.runId);
      await activation.dispose().catch((disposeError) => this.ctx.logger.warn(`Tower activation rollback failed for ${begun.runId}: ${errorMessage(disposeError)}`));
      await core.failSpawn(begun.runId, error).catch((stateError) => this.ctx.logger.warn(`Tower spawn rollback recording failed for ${begun.runId}: ${errorMessage(stateError)}`));
      throw error;
    }
  }

  async track(entry) {
    const { activation, core, parent, missionId, role, runId, childId } = entry;
    let mission;
    let stopReason;
    let settleError;
    try {
      const result = await activation.result;
      stopReason = result.stopReason;
      mission = await core.completeSpawn(runId, {
        stopReason: result.stopReason,
        diagnostic: result.diagnostic,
        structured: result.structured,
        output: outputText(result.output),
      });
    } catch (error) {
      settleError = error;
      mission = await core.failSpawn(runId, error).catch((stateError) => {
        this.ctx.logger.error(`Tower could not record failed ${role} run ${runId}: ${errorMessage(stateError)}`);
        return undefined;
      });
    } finally {
      this.active.delete(runId);
      await activation.dispose().catch((error) => this.ctx.logger.warn(`Tower activation cleanup failed for ${runId}: ${errorMessage(error)}`));
    }
    // Guaranteed notification: the controller hears about this run even when
    // recording failed. Publication and steering are each contained so one
    // failing step can never silence the notice; a failed steer is at least
    // logged as an error instead of disappearing.
    try {
      await this.publish(parent, core);
    } catch (error) {
      this.ctx.logger.warn(`Tower projection publication failed for ${runId}: ${errorMessage(error)}`);
    }
    const notice = settlementNotice({ role, missionId, runId, mission, stopReason, settleError });
    try {
      parent.steer(createUserMessage({
        content: [{ type: 'text', text: notice.text }],
        source: { kind: 'subagent-settled', form: 'notice', summary: boundContextSummary(notice.summary), senderSessionId: childId },
      }));
    } catch (error) {
      this.ctx.logger.error(`Tower settlement notification failed for ${runId}: ${errorMessage(error)}`);
    }
  }

  /**
   * Resolve the repository root for the stale-run probe. The working directory
   * service knows the Session's current effective cwd (including a later `cd`),
   * which is where Tower state actually lives; the Session header records only
   * the creation-time project. The header is kept as a fallback for hosts
   * without the service. A failed service resolution returns undefined instead
   * of falling back, because probing the old repository could warn about
   * unrelated state. A cwd outside Git is the ordinary "no tower here" case.
   * @returns canonical repository root, or undefined when none is resolvable.
   */
  async probeRepoRoot(agent, session) {
    const service = this.ctx.workingDirectory;
    if (service === undefined || typeof service.ensure !== 'function') {
      const headerCwd = session?.header?.cwd ?? session?.cwd;
      if (typeof headerCwd !== 'string' || headerCwd.length === 0) return undefined;
      try {
        return await repoRoot(headerCwd, this.abort.signal);
      } catch {
        return undefined;
      }
    }
    let cwd;
    try {
      cwd = await service.ensure(agent, this.abort.signal);
    } catch (error) {
      this.ctx.logger.warn(`Tower stale-run probe could not resolve the current working directory: ${errorMessage(error)}`);
      return undefined;
    }
    if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
    try {
      return await repoRoot(cwd, this.abort.signal);
    } catch {
      return undefined;
    }
  }

  /**
   * Probe one newly created agent for stale Tower activations. When the agent's
   * effective working directory resolves to a repository with Tower state, and that state
   * records runs still `worker_running`/`review_running` that this runtime does
   * not own but that session started, steer one notice listing them and advise
   * `tower action=recover`. Each run is reported at most once per runtime; any
   * read, parse, or steering failure only warns, never affecting agent creation
   * (agent/created is a serial host event, so a throw would break the host).
   */
  async onAgentCreated(payload) {
    if (this.disposed) return;
    try {
      const agent = payload?.agent;
      const session = agent?.session;
      const sessionId = session?.id;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;
      const root = await this.probeRepoRoot(agent, session);
      if (root === undefined) return;
      let state;
      try {
        state = JSON.parse(await readFile(path.resolve(root, this.stateDirectory, 'state.json'), 'utf8'));
      } catch (error) {
        // A missing state file is the common "no tower here" case, not a failure.
        if (error?.code !== 'ENOENT') this.ctx.logger.warn(`Tower stale-run probe could not read tower state below ${root}: ${errorMessage(error)}`);
        return;
      }
      if (!state || !Array.isArray(state.missions)) {
        this.ctx.logger.warn(`Tower stale-run probe found unreadable tower state below ${root}: missions array missing`);
        return;
      }
      const stale = [];
      for (const mission of state.missions) {
        for (const [role, status, record] of [['worker', 'worker_running', mission?.worker], ['reviewer', 'review_running', mission?.review]]) {
          if (mission?.status !== status || typeof record?.runId !== 'string') continue;
          if (this.active.has(record.runId) || record.controllerSessionId !== sessionId) continue;
          stale.push({ mission: mission.id, role, runId: record.runId, startedAt: record.startedAt });
        }
      }
      const unreported = stale.filter((run) => !this.staleNotified.has(run.runId));
      if (unreported.length === 0) return;
      for (const run of unreported) this.staleNotified.add(run.runId);
      const summary = `Tower restart left ${unreported.length} run(s) recorded as running`;
      const listing = unreported.map((run) => `- ${run.mission} ${run.role} started ${run.startedAt ?? 'at an unknown time'} (run ${run.runId})`).join('\n');
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: `${summary}:\n${listing}\nThese activations belong to a previous controller process and will never settle on their own. Run tower action=recover to mark them interrupted, then respawn agents as needed.` }],
        source: { kind: 'tower', form: 'notice', summary: boundContextSummary(summary) },
      }));
    } catch (error) {
      this.ctx.logger.warn(`Tower stale-run probe failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Read spawn route catalogs from the LLM adapter, from broadest to most exact:
   *
   * - no `provider`: one `listProviders()` call names every registered route,
   *   then one `listModels()` per provider fills each catalog. Entries sort by
   *   provider route and model id for stable output, each provider keeps at
   *   most AGGREGATE_CATALOG_LIMIT_PER_PROVIDER models with a `truncated` flag,
   *   and one provider's catalog failure becomes a structured `error` on its
   *   own entry instead of failing the whole summary. Catalog entries carry
   *   only the fields the adapter disclosed (provider/id/name/description/
   *   inputModalities); exact-route metadata (context, defaultMaxTokens,
   *   reasoning) is never fabricated per entry — request provider+model to
   *   resolve it for one route.
   * - `provider` only: that provider's catalog, capped at
   *   PROVIDER_CATALOG_LIMIT entries.
   * - `provider` + `model`: exact route metadata resolved by the owning
   *   adapter, including context and reasoning information.
   *
   * Catalog forms never resolve each advertised model's call config: catalogs
   * exist for discovery, and per-model resolution would be expensive and
   * pointless when only one route is eventually spawned.
   */
  async models(args, signal) {
    if (args.provider === undefined) {
      const providers = [...this.ctx.llm.listProviders()].sort((left, right) => ascending(left.id, right.id));
      const entries = await Promise.all(providers.map(async (info) => {
        const entry = {
          provider: info.id,
          ...(typeof info.name === 'string' && info.name.length > 0 ? { name: info.name } : {}),
          truncated: false,
          models: [],
        };
        try {
          const models = await this.ctx.llm.listModels(info.id);
          const sorted = [...models].sort((left, right) => ascending(left.id, right.id));
          entry.truncated = sorted.length > AGGREGATE_CATALOG_LIMIT_PER_PROVIDER;
          entry.models = JSON.parse(JSON.stringify(sorted.slice(0, AGGREGATE_CATALOG_LIMIT_PER_PROVIDER)));
        } catch (error) {
          // A cancelled call must surface as cancellation, not as one
          // provider's catalog failure; anything else is contained to this
          // provider's entry so the aggregate summary still returns.
          if (signal?.aborted) throw error;
          entry.error = providerCatalogError(error);
        }
        return entry;
      }));
      return { providers: entries, ...(this.allowedModels ? { allowedModels: [...this.allowedModels.values()] } : {}) };
    }
    if (args.model) {
      const info = await this.ctx.llm.resolveModelInfo(args.provider, args.model, signal);
      return { provider: args.provider, models: [JSON.parse(JSON.stringify(info))], ...(this.allowedModels ? { allowedModels: [...this.allowedModels.values()] } : {}) };
    }
    const models = await this.ctx.llm.listModels(args.provider);
    return { provider: args.provider, models: JSON.parse(JSON.stringify(models.slice(0, PROVIDER_CATALOG_LIMIT))), ...(this.allowedModels ? { allowedModels: [...this.allowedModels.values()] } : {}) };
  }

  async execute(args, exec) {
    assertCallingAgent(exec.agent);
    assertTower(!this.disposed, 'RUNTIME_DISPOSED', 'Tower runtime is disposed');
    const agent = exec.agent;
    const signal = AbortSignal.any([exec.signal, this.abort.signal]);
    const action = required(args.action, 'action');
    if (action === 'models') return await this.models(args, signal);
    const root = await this.resolveRoot(agent, signal);
    // Ownership is per repository, not per Session lineage: any Session may take
    // a free workspace, and a second Session is refused only while another one
    // is operating it or still has a worker/reviewer in flight. The claim comes
    // before `init`/`open`, so a refused second Session never touches state.
    this.claimWorkspace(root, agent.session.id);
    let core;
    let result;
    try {
      core = await this.coreAt(root, signal, action === 'init', args.base_branch);
      switch (action) {
        case 'init':
          result = await core.status({ observe: false });
          break;
        case 'add':
          result = { mission: await core.addMission({ id: args.id, title: args.title, description: args.description, dependsOn: args.depends_on, scope: args.scope, signal }) };
          break;
        case 'edit':
          // Metadata correction for pending missions. Only fields the caller
          // actually supplied reach the core, so an omitted field keeps its
          // stored value instead of being blanked by an explicit undefined.
          result = { mission: await core.editMission({
            missionId: required(args.mission_id, 'mission_id'),
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.description === undefined ? {} : { description: args.description }),
            ...(args.scope === undefined ? {} : { scope: args.scope }),
            ...(args.depends_on === undefined ? {} : { dependsOn: args.depends_on }),
          }) };
          break;
        case 'spawn':
          result = await this.spawn(core, agent, args, signal);
          break;
        case 'recover': {
          const activeRunIds = new Set([...this.active.values()].filter((entry) => entry.core === core).map((entry) => entry.runId));
          result = await core.recover(activeRunIds);
          break;
        }
        case 'status':
          result = args.mission_id ? { mission: await core.mission(args.mission_id) } : await core.status({ observe: args.observe === true, signal });
          break;
        case 'summary':
          // Read-only like status: an omitted mission_id passes through as
          // undefined so the core reports every mission.
          result = { summary: await core.summary({ missionId: args.mission_id }) };
          break;
        case 'gate':
          result = await core.mergeGate(required(args.mission_id, 'mission_id'), signal);
          break;
        case 'merge':
          result = await core.merge(required(args.mission_id, 'mission_id'), signal);
          break;
        case 'rebase':
          result = await core.rebase(required(args.mission_id, 'mission_id'), signal);
          break;
        case 'abandon':
          result = { mission: await core.abandon(required(args.mission_id, 'mission_id')) };
          break;
        case 'teardown':
          result = await core.teardown({ missionId: args.mission_id, signal });
          break;
        case 'send': {
          const address = await core.agentAddress(required(args.mission_id, 'mission_id'), required(args.role, 'role'));
          const messageId = await this.ctx.subagents.sendMessage(agent, address.childId, [{ type: 'text', text: required(args.message, 'message') }], { signal });
          result = { sent: true, messageId, ...address };
          break;
        }
        case 'interrupt': {
          const address = await core.agentAddress(required(args.mission_id, 'mission_id'), required(args.role, 'role'));
          this.ctx.subagents.interrupt(address.childId, { kind: 'ancestor', agent });
          result = { interrupted: true, ...address };
          break;
        }
        default:
          throw new Error(`unknown Tower action ${action}`);
      }
    } catch (error) {
      if (core !== undefined) await this.publish(agent, core);
      throw error;
    } finally {
      this.releaseWorkspace(root, agent.session.id);
    }
    if (!['status', 'summary', 'gate', 'send', 'interrupt'].includes(action)) await this.publish(agent, core);
    return result;
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort(new Error('Tower plugin disposed'));
    const entries = [...this.active.values()];
    await Promise.allSettled(entries.map((entry) => entry.activation.dispose()));
    await Promise.allSettled(entries.map((entry) => entry.done));
  }
}

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { finalAssistantOutput, parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TOWER_RECORD_TYPE } from './projection.js';
import { repoRoot } from './git.js';
import { TowerCore } from './core.js';
import { assertTower, errorMessage, TowerError } from './errors.js';

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

/** Collapse all whitespace, including line breaks, so a notice field stays on one physical line. */
function singleLine(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function boundedReason(value) {
  const text = typeof value === 'string' && value.trim().length > 0 ? singleLine(value) : 'no reason recorded';
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

/** Resolve the stop reason to report, preferring the live activation result. */
function noticeStopReason(stopReason, record) {
  for (const candidate of [stopReason, record?.stopReason]) {
    if (typeof candidate !== 'string') continue;
    const text = singleLine(candidate);
    if (text.length > 0) return text;
  }
  return 'unknown';
}

/**
 * Build the controller notice for one settled run. The summary line follows
 * `Tower <role> for <mission> <outcome>: mission status <status>`; the final
 * physical line always reports the actual stop reason (normalized to a single
 * line), and failure, interrupted, and stale outcomes also carry a bounded
 * reason there. When the run could not even be recorded (`mission` undefined)
 * the notice degrades to a fallback that still names role, mission, run, and
 * error.
 */
function settlementNotice({ role, missionId, runId, mission, stopReason, settleError }) {
  const status = mission?.status ?? 'unknown';
  const record = mission === undefined ? undefined : (role === 'reviewer' ? mission.review : mission.worker);
  const effectiveStopReason = noticeStopReason(stopReason, record);
  const outcome = settlementOutcome(mission, role, effectiveStopReason);
  const summary = `Tower ${role} for ${missionId} ${outcome}: mission status ${status}`;
  const attention = outcome === 'failed' || outcome === 'interrupted' || outcome === 'stale';
  const reason = settleError === undefined ? record?.error ?? record?.diagnostic : errorMessage(settleError);
  const lines = [summary];
  if (mission === undefined) {
    lines.push(`run ${runId} could not be recorded in Tower state`);
    lines.push('Next: inspect the mission with tower action=status before respawning anything.');
  } else {
    const action = nextActionFor(outcome, status);
    lines.push(action === undefined
      ? 'Review the recorded output and use tower action=status or the appropriate next action.'
      : `Next: ${action}.`);
  }
  const final = [`stopReason: ${effectiveStopReason}`];
  if (attention) final.push(`reason: ${boundedReason(reason)}`);
  lines.push(final.join('; '));
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

/**
 * Brief for resuming the worker of a mission: the agent keeps its original
 * session, so this only adds the new round's instructions instead of
 * restating the whole mission.
 */
function resumeWorkerBrief(mission, instructions) {
  return `You are resuming the Tower worker run for mission ${mission.id}: ${mission.title}, continuing your existing session with all prior mission context. The mission worktree, scope rules, and reporting contract from your original briefing still apply.\n\nAdditional controller instructions for this resume round:\n${instructions ?? '(none)'}\n\nContinue the mission from where you left off, run relevant checks, review your own diff, and commit in this worktree. Do not leave uncommitted or untracked artifacts. Finish with a concise report containing the commit SHA, changes, and checks run.`;
}

/**
 * Brief for resuming the reviewer of a mission. A resumed reviewer has no
 * per-activation structured-output capture (that belongs to the original
 * activation), so the round must be answered with a plain JSON message that
 * Tower parses and validates against REVIEW_OUTPUT_SCHEMA itself. The binding
 * is the one this resume round's own beginSpawn recorded — never a previous
 * round's — so the prompt is generated only after that run exists.
 */
function resumeReviewerBrief(mission, instructions) {
  const review = mission.review;
  return `You are resuming the Tower reviewer run for mission ${mission.id}: ${mission.title}, continuing your existing session with all prior review context.\n\nReview the exact commit binding of THIS resume round:\n- base: ${review.baseCommit}\n- reviewed: ${review.reviewedCommit}\n\nUse read-only inspection. Do not edit files, stage, commit, merge, rebase, or otherwise mutate Git state. Review the diff with git diff ${review.baseCommit}...${review.reviewedCommit}, inspect relevant context, and run only checks that do not alter tracked files.\n\nAdditional controller instructions for this resume round:\n${instructions ?? '(none)'}\n\nAnswer this round with ONLY a JSON object conforming to the required structured output schema: {"verdict":"clean"|"changes_requested","merge":boolean,"summary":string,"findings":[{"severity":"p1"|"p2"|"p3","path":string,"message":string}],"checks":[string]}. Do not write any prose outside the JSON; a single fenced \`\`\`json code block containing just the object is acceptable.`;
}

/**
 * Extract one structured review verdict from a resumed reviewer's output.
 * The complete response must BE the verdict: either one bare JSON object, or
 * one single ```json fence holding one JSON object with nothing but whitespace
 * outside it. Prose around a fence, several candidates, truncated or
 * otherwise invalid JSON, and schema violations (missing or extra fields,
 * wrong enums) are all rejected by returning undefined, so the run settles as
 * review_failed instead of lending a quoted example or a malformed object the
 * authority of an approval.
 */
function parseStructuredReview(blocks) {
  const text = outputText(blocks).trim();
  if (text.length === 0) return undefined;
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(text);
  const payload = fence === null ? text : fence[1].trim();
  let candidate;
  try {
    candidate = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  return validateJsonSchemaValue(REVIEW_OUTPUT_SCHEMA, candidate).length === 0 ? candidate : undefined;
}

/**
 * Slice one resumed epoch's own events out of the events observed after the
 * durable resume offset. The delivered resume prompt is the first user
 * message in that suffix; every later user message opens a following epoch
 * (another delivery to the same child), so the slice ends right before it
 * and a next round that already wrote its transcript can never leak its
 * assistant output, verdict, or diagnostics into this round's settlement.
 */
function epochEvents(events, sessionSeq) {
  const suffix = events.filter((event) => sessionSeq < 0 || (typeof event?.seq === 'number' && event.seq > sessionSeq));
  const own = [];
  let prompt = undefined;
  for (const event of suffix) {
    if (event.type === 'user/message') {
      if (prompt !== undefined) break;
      prompt = event;
    }
    own.push(event);
  }
  return own;
}

/**
 * Read the failure diagnostic from one epoch's own events: the last recorded
 * turn ending wins, and only error endings carry a diagnostic.
 */
function diagnosticOf(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'turn/end') continue;
    const failure = event.data?.reason?.kind === 'error' ? event.data.reason.error : undefined;
    if (failure === undefined || typeof failure.message !== 'string' || failure.message.length === 0) return undefined;
    return typeof failure.code === 'string' && failure.code.length > 0 ? `${failure.code}: ${failure.message}` : failure.message;
  }
  return undefined;
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
     * Tower call claims per repository, the first source of ownership. Tower
     * membership follows the workspace, not the Session's lineage (Kimi Code
     * likewise lets any Session own a workspace tower and refuses a second
     * owner while one is live). The value is normally a table of
     * `sessionId → count of live execute calls`, so every call holds its own
     * claim: one Session's concurrent calls stack instead of releasing each
     * other, a foreign Session is refused while any count is positive, and the
     * entry disappears with its last claim (no residue accumulates). A plain
     * sessionId written directly into the map is honored as one pre-existing
     * claim by that Session: `releaseWorkspace` ignores it, and once that
     * Session claims through `claimWorkspace` the entry becomes a counted
     * table.
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
   * Read which Session owns one repository's tower right now: the first
   * Session with a live call claim (or a directly seeded single claim), else a
   * Session with an activation this runtime started.
   * @param root - canonical repository root.
   * @returns the owning Session id, or undefined when the repository is free.
   */
  workspaceOwner(root) {
    const claims = this.inFlight.get(root);
    if (typeof claims === 'string') return claims;
    if (claims !== undefined) {
      for (const [sessionId, count] of claims) {
        if (count > 0) return sessionId;
      }
    }
    for (const entry of this.active.values()) {
      if (entry.core === undefined || entry.parent?.session?.id === undefined) continue;
      const entryRoot = entry.core.store?.repoRoot;
      if (entryRoot === root) return entry.parent.session.id;
    }
    return undefined;
  }

  /**
   * Claim a repository for one Session's current call, refusing a live foreign
   * owner. Each execute call claims and releases exactly once, so concurrent
   * calls from one Session stack instead of evicting each other.
   * @param root - canonical repository root.
   * @param sessionId - Session making the call.
   */
  claimWorkspace(root, sessionId) {
    const owner = this.workspaceOwner(root);
    assertTower(owner === undefined || owner === sessionId, 'WORKSPACE_BUSY', `another Session (${String(owner)}) owns this workspace tower; finish or release it there, or wait for its worker/reviewer to settle`);
    const claims = this.inFlight.get(root);
    if (claims instanceof Map) claims.set(sessionId, (claims.get(sessionId) ?? 0) + 1);
    else this.inFlight.set(root, new Map([[sessionId, 1]]));
  }

  /**
   * Release one call's claim without dropping claims its sibling calls from
   * the same Session still hold. The root entry disappears only with its last
   * claim, so neither sibling eviction nor unbounded residue is possible.
   * @param root - canonical repository root.
   * @param sessionId - Session that made the call.
   */
  releaseWorkspace(root, sessionId) {
    const claims = this.inFlight.get(root);
    if (!(claims instanceof Map)) return;
    const count = claims.get(sessionId);
    if (count === undefined) return;
    if (count > 1) claims.set(sessionId, count - 1);
    else {
      claims.delete(sessionId);
      if (claims.size === 0) this.inFlight.delete(root);
    }
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
    // The run belongs to this runtime from the moment running state is
    // persisted, not from when a fully attached activation exists: recover and
    // the stale-run probe must exempt it across startActivation, attachSpawn,
    // and settling. Fields fill in as startup progresses, and the disposal
    // guard keeps activation cleanup exactly once across the rollback paths,
    // track(), and dispose(). Rollback paths keep the registration until their
    // failure recording has ended, so concurrent recovers never reap a run
    // this runtime is still settling.
    const entry = { activation: undefined, core, parent: agent, missionId, role, runId: begun.runId, childId: undefined, done: undefined };
    let activationDisposed = false;
    entry.disposeActivation = async () => {
      if (entry.activation === undefined || activationDisposed) return;
      activationDisposed = true;
      await entry.activation.dispose();
    };
    this.active.set(begun.runId, entry);
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
      // The run stays this runtime's responsibility until its failure is
      // recorded: dropping the registration before failSpawn would let a
      // concurrent recover reap the still-running persisted state while this
      // rollback is settling it. The registration is removed only after the
      // recording attempt ends, and even an attempt that throws cannot leak it.
      try {
        await core.failSpawn(begun.runId, error);
      } catch (stateError) {
        this.ctx.logger.warn(`Tower spawn rollback recording failed for ${begun.runId}: ${errorMessage(stateError)}`);
      } finally {
        this.active.delete(begun.runId);
      }
      throw error;
    }
    entry.activation = activation;
    try {
      await core.attachSpawn(begun.runId, activation.childId);
      assertTower(!this.disposed, 'RUNTIME_DISPOSED', 'Tower runtime is disposed');
      entry.childId = activation.childId;
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
      // Same ownership rule as a failed start: the activation is disposed and
      // the failure recorded while the run is still registered, so a
      // concurrent recover cannot reap a rollback this runtime owns. The
      // registration is dropped only after both recording attempts have ended,
      // leak-free even when they throw.
      try {
        await entry.disposeActivation().catch((disposeError) => this.ctx.logger.warn(`Tower activation rollback failed for ${begun.runId}: ${errorMessage(disposeError)}`));
        await core.failSpawn(begun.runId, error).catch((stateError) => this.ctx.logger.warn(`Tower spawn rollback recording failed for ${begun.runId}: ${errorMessage(stateError)}`));
      } finally {
        this.active.delete(begun.runId);
      }
      throw error;
    }
  }

  async controlAddress(core, args) {
    const missionId = required(args.mission_id, 'mission_id');
    const role = required(args.role, 'role');
    assertTower(role === 'worker' || role === 'reviewer', 'ARGUMENT_INVALID', 'role must be worker or reviewer');
    const address = await core.agentAddress(missionId, role);
    const entry = this.active.get(address.runId);
    // Persisted running state can outlive the process that owned its activation.
    // Never steer or cancel a child unless this exact runtime still owns the run.
    assertTower(
      entry?.core === core
        && entry.runId === address.runId
        && entry.missionId === missionId
        && entry.role === role
        && entry.childId === address.childId,
      'AGENT_NOT_RUNNING',
      `run ${address.runId} for mission ${missionId} (${role}) is not an active activation in this runtime`,
    );
    return { mission: missionId, role, ...address };
  }

  /**
   * Bind one resumed child to its `subagent/start`/`subagent/end` lifecycle
   * edges and expose an activation-compatible handle for {@link track}.
   *
   * `sendMessage` returns only a message id, so the run's result is observed
   * through the host lifecycle events plus a session read bounded by the
   * durable offset captured before the message was sent. Epoch binding is
   * fail-closed:
   *
   * - the FIRST `subagent/start` for the child after registration binds the
   *   cold-resumed epoch's host run id;
   * - an end edge may settle the run ONLY when its host run id equals the
   *   bound epoch's. Ends of older or foreign epochs — including any end
   *   observed before this round's own start — are dropped, and an accepted
   *   message id never substitutes for the binding, so outputs, verdicts,
   *   and diagnostics cannot cross resume rounds and an unbindable round can
   *   never approve anything;
   * - the matched end edge and the result settlement are separate: the edge
   *   synchronously closes the epoch (no interrupt eligibility from then on,
   *   because the same child may already be running a later epoch and host
   *   interrupt targets the child, not one epoch), then the observation
   *   asynchronously folds the epoch's own events into the result;
   * - `dispose()` unsubscribes and settles a still-pending result without
   *   hanging: before the terminal edge it interrupts the epoch and records
   *   `aborted`; after the terminal edge it settles from that edge's own
   *   stop reason and last assistant message, never touching the child.
   */
  resumeActivation(agent, { runId, childId, role, sessionSeq }) {
    let settled = false;
    let ended = false;
    let hostRunId;
    let endEdge;
    let resolveResult;
    const result = new Promise((resolve) => { resolveResult = resolve; });
    const disposers = [];
    const unsubscribe = () => {
      for (const dispose of disposers.splice(0)) {
        try { dispose(); } catch { /* host disposers must not break settlement */ }
      }
    };
    const settle = (value) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolveResult(value);
    };
    const edgeOutcome = () => ({
      stopReason: typeof endEdge?.stopReason === 'string' && endEdge.stopReason.length > 0 ? endEdge.stopReason : 'unknown',
      output: Array.isArray(endEdge?.lastAssistantMessage) ? endEdge.lastAssistantMessage : [],
    });
    const activation = {
      childId,
      result,
      hostRunId: () => hostRunId,
      // Deliberate no-op kept for the activation call surface: an accepted
      // message id NEVER substitutes for this epoch's own start binding.
      accepted: () => {},
      dispose: async ({ interrupt = true } = {}) => {
        unsubscribe();
        if (settled) return;
        if (ended) {
          // The terminal edge already arrived: the child may by now be running
          // a LATER epoch, and interrupting by childId would cancel that
          // unrelated work. Settle from this epoch's own edge instead.
          settle(edgeOutcome());
          return;
        }
        if (interrupt) {
          try {
            this.ctx.subagents.interrupt(childId, { kind: 'ancestor', agent });
          } catch (error) {
            this.ctx.logger?.warn(`Tower resume interrupt during disposal failed for ${runId}: ${errorMessage(error)}`);
          }
        }
        settle({ stopReason: 'aborted', diagnostic: 'Tower resume activation was disposed before the child settled', output: [] });
      },
    };
    disposers.push(this.ctx.on('subagent/start', (info) => {
      if (ended || settled || info?.id !== childId || hostRunId !== undefined) return;
      if (typeof info.runId !== 'string' || info.runId.length === 0) return;
      hostRunId = info.runId;
    }));
    disposers.push(this.ctx.on('subagent/end', (info) => {
      if (ended || settled || info?.id !== childId) return;
      if (hostRunId === undefined || info.runId !== hostRunId) return;
      ended = true;
      endEdge = info;
      unsubscribe();
      void this.settleResumedRun({ childId, role, sessionSeq, fallback: info, settle });
    }));
    return activation;
  }

  /**
   * Observe the child session's events after the resume offset and fold this
   * epoch's own slice into one run result: its assistant output (the same
   * selection rule the host applies), the error diagnostic of its last turn
   * ending, and — for a reviewer — the structured verdict parsed and strictly
   * validated against REVIEW_OUTPUT_SCHEMA. The matched end edge's own last
   * assistant message is the only fallback (it belongs to this epoch); when
   * the session cannot be read at all, the edge's stop reason and message are
   * used as-is, which for a reviewer without a verifiable verdict means
   * review_failed, never a guess.
   */
  async settleResumedRun({ childId, role, sessionSeq, fallback, settle }) {
    const stopReason = typeof fallback.stopReason === 'string' && fallback.stopReason.length > 0 ? fallback.stopReason : 'unknown';
    const fallbackOutput = Array.isArray(fallback.lastAssistantMessage) ? fallback.lastAssistantMessage : [];
    let outcome = { stopReason, output: fallbackOutput };
    try {
      const query = this.ctx.sessionQuery;
      if (query !== undefined) {
        const observation = await query.observeSession(childId, {});
        try {
          const own = epochEvents(observation.events, sessionSeq);
          const diagnostic = diagnosticOf(own);
          const output = finalAssistantOutput(own) ?? fallbackOutput;
          const structured = role === 'reviewer'
            ? parseStructuredReview(output) ?? parseStructuredReview(fallbackOutput)
            : undefined;
          outcome = {
            stopReason,
            ...(diagnostic === undefined ? {} : { diagnostic }),
            ...(structured === undefined ? {} : { structured }),
            output,
          };
        } finally {
          try { observation[Symbol.dispose]?.(); } catch { /* observation release is best-effort */ }
        }
      }
    } catch (error) {
      this.ctx.logger?.warn(`Tower resume observation failed for child ${childId}; using the lifecycle edge only: ${errorMessage(error)}`);
    }
    settle(outcome);
  }

  /**
   * Resume the previous worker or reviewer agent of a mission in place: the
   * original child session is cold-resumed through `subagents.sendMessage`
   * (no new activation is started, the original route is copied verbatim, not
   * re-resolved), and the continuation is tracked as a fresh Tower run.
   *
   * Write-ahead ordering is the contract of this method:
   *
   * 1. WAL read — the child's durable event offset and direct-parent lineage
   *      are verified BEFORE any Tower state changes, so an unreadable or
   *      foreign session can never leave a fake running run behind;
   * 2. beginSpawn — the new run, its `resumeFrom` intent, and the copied
   *      original route are persisted; for a reviewer this also records this
   *      round's exact base/tip binding;
   * 3. the resume prompt is generated from the run that beginSpawn returned
   *      (a reviewer prompt names the NEW binding, never a previous round's)
   *      and only its SHA-256 fingerprint is persisted, via sealResumePrompt;
   * 4. the listeners of the new epoch are registered, THEN the message is
   *      delivered (the host publishes the epoch's `subagent/start` during
   *      delivery, before sendMessage returns);
   * 5. messageId and the observed hostRunId are attached to the run.
   *
   * Only settled records can be resumed: a mission whose status is still
   * running — including one left behind by a dead controller — is AGENT_BUSY
   * exactly like a plain spawn; run `recover` first. The run stays registered
   * in this runtime from beginSpawn until it settles or its rollback failure
   * has been recorded, so a concurrent recover can never reap it mid-start.
   */
  async resume(core, agent, args, signal) {
    assertTower(!this.disposed, 'RUNTIME_DISPOSED', 'Tower runtime is disposed');
    const role = required(args.role, 'role');
    assertTower(role === 'worker' || role === 'reviewer', 'ARGUMENT_INVALID', 'role must be worker or reviewer');
    const missionId = required(args.mission_id, 'mission_id');
    for (const [field, name] of [['provider', 'provider'], ['model', 'model'], ['reasoning_effort', 'reasoning_effort'], ['max_tokens', 'max_tokens']]) {
      assertTower(args[field] === undefined, 'ARGUMENT_INVALID', `resume keeps the original ${role} route; ${name} cannot be overridden (spawn a fresh agent to change the route)`);
    }
    assertTower(typeof this.ctx.on === 'function', 'CONFIG_INVALID', 'resume requires the host event bus to observe subagent lifecycle edges');
    const query = this.ctx.sessionQuery;
    assertTower(query !== undefined && typeof query.observeSession === 'function', 'CONFIG_INVALID', 'resume requires the sessionQuery service to read the child session');
    const mission = await core.mission(missionId);
    const previous = role === 'worker' ? mission.worker : mission.review;
    const childId = previous?.childId ?? previous?.resumeFrom?.childId;
    assertTower(typeof childId === 'string' && childId.length > 0, 'AGENT_NOT_RUNNING', `mission ${missionId} has no attached ${role} child to resume`);
    for (const entry of this.active.values()) {
      assertTower(
        !(entry.core === core && entry.missionId === missionId && entry.role === role),
        'AGENT_BUSY',
        `mission ${missionId} already runs a ${role} activation in this runtime; send or interrupt it instead of resuming`,
      );
    }
    let observation;
    try {
      observation = await query.observeSession(childId, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TowerError('AGENT_NOT_RUNNING', `mission ${missionId} ${role} child session ${childId} is not readable; the agent cannot be resumed`, { childId }, { cause: error });
    }
    let sessionSeq;
    try {
      assertTower(
        observation.header?.parentSession === agent.session.id,
        'AGENT_NOT_RUNNING',
        `subagent "${childId}" belongs to another parent session; this controller cannot resume it`,
      );
      // A malformed observation without a usable cursor would silently destroy
      // the epoch lower bound, so it is refused instead of guessed around.
      sessionSeq = observation.cursor;
      assertTower(Number.isSafeInteger(sessionSeq) && sessionSeq >= -1, 'AGENT_NOT_RUNNING', `child session ${childId} did not report a usable event offset; the agent cannot be resumed`);
    } finally {
      try { observation[Symbol.dispose]?.(); } catch { /* observation release is best-effort */ }
    }
    const begun = await core.beginSpawn({
      missionId,
      role,
      controllerSessionId: agent.session.id,
      ...(previous.provider === undefined ? {} : { provider: previous.provider }),
      ...(previous.model === undefined ? {} : { model: previous.model }),
      ...(previous.reasoningEffort === undefined ? {} : { reasoningEffort: previous.reasoningEffort }),
      signal,
      resume: { previousRunId: previous.runId, childId, sessionSeq },
    });
    // From here the run belongs to this runtime until it settles or its
    // rollback failure recording ends (same ownership rule as a spawn).
    // The disposal guard is the same exactly-once contract as spawn():
    // runtime dispose, settlement cleanup in track(), and the rollback
    // below share one activation disposal. For a resume activation this
    // is what lets runtime dispose settle a still-pending epoch result
    // (no matched subagent/end will ever arrive for it) instead of
    // hanging on entry.done forever, and keeps track()'s cleanup from
    // touching a disposal that already happened.
    const entry = { activation: undefined, core, parent: agent, missionId, role, runId: begun.runId, childId, done: undefined };
    let activationDisposed = false;
    entry.disposeActivation = async (options) => {
      if (entry.activation === undefined || activationDisposed) return;
      activationDisposed = true;
      await entry.activation.dispose(options);
    };
    this.active.set(begun.runId, entry);
    const activation = this.resumeActivation(agent, { runId: begun.runId, childId, role, sessionSeq });
    entry.activation = activation;
    const rollback = async (error) => {
      // Interrupt only when this round's epoch verifiably started; otherwise
      // there is nothing of ours to cancel and a stray interrupt could hit
      // whatever else the child is doing. Disposal still always settles the
      // pending result, so nothing can hang or leak.
      try {
        await entry
          .disposeActivation({ interrupt: activation.hostRunId() !== undefined })
          .catch((disposeError) => this.ctx.logger?.warn(`Tower resume rollback failed for ${begun.runId}: ${errorMessage(disposeError)}`));
        await core.failSpawn(begun.runId, error).catch((stateError) => this.ctx.logger?.warn(`Tower spawn rollback recording failed for ${begun.runId}: ${errorMessage(stateError)}`));
      } finally {
        this.active.delete(begun.runId);
      }
      throw error;
    };
    let messageId;
    let promptHash;
    try {
      const prompt = role === 'worker' ? resumeWorkerBrief(begun.mission, args.instructions) : resumeReviewerBrief(begun.mission, args.instructions);
      promptHash = createHash('sha256').update(prompt).digest('hex');
      await core.sealResumePrompt(begun.runId, promptHash);
      messageId = await this.ctx.subagents.sendMessage(agent, childId, [{ type: 'text', text: prompt }], { signal });
      await core.attachSpawn(begun.runId, childId, {
        messageId,
        ...(activation.hostRunId() === undefined ? {} : { hostRunId: activation.hostRunId() }),
      });
      assertTower(!this.disposed, 'RUNTIME_DISPOSED', 'Tower runtime is disposed');
    } catch (error) {
      await rollback(error);
    }
    entry.done = this.track(entry);
    return {
      mission: missionId,
      role,
      runId: begun.runId,
      childId,
      resumed: true,
      resumeFrom: { runId: previous.runId, childId, sessionSeq, ...(promptHash === undefined ? {} : { promptHash }) },
      messageId,
      ...(activation.hostRunId() === undefined ? {} : { hostRunId: activation.hostRunId() }),
      ...(role === 'reviewer' ? { binding: { baseCommit: begun.mission.review.baseCommit, reviewedCommit: begun.mission.review.reviewedCommit } } : {}),
      status: begun.mission.status,
      worktree: begun.mission.worktree,
    };
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
      await entry.disposeActivation().catch((error) => this.ctx.logger.warn(`Tower activation cleanup failed for ${runId}: ${errorMessage(error)}`));
    }
    // Generate the settlement notice and attempt delivery: state recording and
    // projection publishing failures are contained so they cannot suppress this
    // attempt, and a failed steer is only logged as an error (no persistent
    // retry queue).
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
        case 'resume':
          result = await this.resume(core, agent, args, signal);
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
          const address = await this.controlAddress(core, args);
          const messageId = await this.ctx.subagents.sendMessage(agent, address.childId, [{ type: 'text', text: required(args.message, 'message') }], { signal });
          result = { sent: true, messageId, ...address };
          break;
        }
        case 'interrupt': {
          const address = await this.controlAddress(core, args);
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
    // Entries registered while a spawn is still starting may not have an
    // activation yet; their spawn call disposes on its own rollback path, and
    // the per-entry guard makes any disposal exactly once.
    await Promise.allSettled(entries.map((entry) => entry.disposeActivation?.()));
    await Promise.allSettled(entries.map((entry) => entry.done));
  }
}

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
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
    try {
      const result = await activation.result;
      mission = await core.completeSpawn(runId, {
        stopReason: result.stopReason,
        diagnostic: result.diagnostic,
        structured: result.structured,
        output: outputText(result.output),
      });
    } catch (error) {
      mission = await core.failSpawn(runId, error).catch((stateError) => {
        this.ctx.logger.error(`Tower could not record failed ${role} run ${runId}: ${errorMessage(stateError)}`);
        return undefined;
      });
    } finally {
      this.active.delete(runId);
      await activation.dispose().catch((error) => this.ctx.logger.warn(`Tower activation cleanup failed for ${runId}: ${errorMessage(error)}`));
    }
    if (mission) {
      await this.publish(parent, core);
      try {
        const summary = `Tower ${role} for ${missionId} settled with mission status ${mission.status}`;
        parent.steer(createUserMessage({
          content: [{ type: 'text', text: `${summary}. Review the recorded output and use tower action=status or the appropriate next action.` }],
          source: { kind: 'subagent-settled', form: 'notice', summary: boundContextSummary(summary), senderSessionId: childId },
        }));
      } catch (error) {
        this.ctx.logger.warn(`Tower completion notification failed for ${runId}: ${errorMessage(error)}`);
      }
    }
  }

  async models(agent, args, signal) {
    const provider = args.provider ?? parentAgentOptionsForDelegation(agent).provider;
    assertTower(provider, 'MODEL_PROVIDER_REQUIRED', 'provider is required when the parent has no provider route');
    if (args.model) {
      const info = await this.ctx.llm.resolveModelInfo(provider, args.model, signal);
      return { provider, models: [JSON.parse(JSON.stringify(info))], ...(this.allowedModels ? { allowedModels: [...this.allowedModels.values()] } : {}) };
    }
    const models = await this.ctx.llm.listModels(provider);
    return { provider, models: JSON.parse(JSON.stringify(models.slice(0, 500))), ...(this.allowedModels ? { allowedModels: [...this.allowedModels.values()] } : {}) };
  }

  async execute(args, exec) {
    assertCallingAgent(exec.agent);
    assertTower(!this.disposed, 'RUNTIME_DISPOSED', 'Tower runtime is disposed');
    const agent = exec.agent;
    const signal = AbortSignal.any([exec.signal, this.abort.signal]);
    const action = required(args.action, 'action');
    if (action === 'models') return await this.models(agent, args, signal);
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
    if (!['status', 'gate', 'send', 'interrupt'].includes(action)) await this.publish(agent, core);
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

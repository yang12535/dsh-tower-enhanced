import { defineTool } from '@deepseek-ai/dsh-tools';
import { towerProjectionDefinition } from './projection.js';
import { TowerRuntime } from './runtime.js';

const name = 'tower-enhanced';
const inject = ['tools', 'subagents', 'workingDirectory', 'llm', 'sessions', 'sessionProjections'];

function apply(ctx, config = {}) {
  const runtime = new TowerRuntime(ctx, config);
  ctx.tools.register(defineTool({
    name: 'tower',
    description: 'Run an experimental Tower-lite Git mission controller. Typical flow: init on a clean local base branch; add independent missions (edit corrects the title/description/scope/depends_on of a mission that has not spawned a worker yet); spawn a worker for each; when worker_completed spawn a reviewer; when approved run gate and merge. Every mission gets an isolated branch/worktree. Reviews bind exact base and tip SHAs; base/tip movement or any rebase requires fresh review. Spawn accepts optional provider+model and reasoning_effort for heterogeneous workers/reviewers. status reads state, recover explicitly marks stale running activations interrupted after the old controller stops (never adopts them), send steers an active agent, interrupt cancels one, rebase updates a branch, abandon preserves artifacts, and teardown removes only clean merged/abandoned registered worktrees. Any Session may be the controller: tower membership follows the repository, not the Session lineage, and one workspace tower has one owner at a time (a second Session is refused while the owner is operating it or still has a worker/reviewer in flight). The repository is the Session working directory, so change it first when the Session is not rooted in the mission repository. This is not a security sandbox or full Kimi Tower.',
    parameters: {
      action: {
        type: 'string',
        enum: ['init', 'add', 'edit', 'spawn', 'recover', 'send', 'interrupt', 'status', 'gate', 'merge', 'rebase', 'abandon', 'teardown', 'models'],
        required: true,
        description: 'Tower operation to perform.',
      },
      base_branch: { type: 'string', description: 'init: local branch already checked out in the main worktree. Defaults to the current branch.' },
      id: { type: 'string', description: 'add: optional uppercase mission id such as M1 or API.' },
      title: { type: 'string', description: 'add: short mission title. edit: replacement title for a pending mission.' },
      description: { type: 'string', description: 'add: complete self-contained mission objective and acceptance checks. edit: replacement objective for a pending mission.' },
      depends_on: { type: 'array', items: { type: 'string' }, description: 'add/edit: mission ids that must merge or be abandoned before a worker can start. edit: ids must exist, exclude the mission itself, contain no repeats, and form no dependency cycle.' },
      scope: { type: 'array', items: { type: 'string' }, description: 'add/edit: repository-relative glob patterns the mission may change; empty means unrestricted.' },
      mission_id: { type: 'string', description: 'Mission id for spawn/status/gate/merge/rebase/abandon/teardown/send/interrupt/edit.' },
      role: { type: 'string', enum: ['worker', 'reviewer'], description: 'Agent role for spawn/send/interrupt.' },
      instructions: { type: 'string', description: 'spawn: extra instructions appended to the generated role briefing.' },
      message: { type: 'string', description: 'send: message delivered to the active worker or reviewer.' },
      provider: { type: 'string', description: 'spawn/models: LLM provider route. For spawn, provider and model must be supplied together.' },
      model: { type: 'string', description: 'spawn/models: exact model id. For spawn, provider and model must be supplied together.' },
      reasoning_effort: { type: 'string', description: 'spawn: adapter-owned reasoning effort for this new agent.' },
      max_tokens: { type: 'integer', description: 'spawn: optional positive output-token cap for this new agent.' },
      observe: { type: 'boolean', description: 'status: also inspect current Git branches, tips, and dirty state.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      return await runtime.execute(args, exec);
    },
    presentCall: (args) => ({ card: 'generic', title: `tower: ${args.action}`, rawInput: args }),
  }));
  const disposeProjection = ctx.root.sessionProjections.register(towerProjectionDefinition);
  ctx.effect(() => async () => {
    try {
      await runtime.dispose();
    } finally {
      disposeProjection();
    }
  }, 'tower-enhanced.runtime');
}

export { apply, inject, name };

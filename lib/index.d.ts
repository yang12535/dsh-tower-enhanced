import type { Context } from '@deepseek-ai/cordis';

export interface TowerModelRoute {
  provider: string;
  model: string;
}

export interface TowerAgentOptions extends TowerModelRoute {
  reasoningEffort?: string;
  maxTokens?: number;
}

export interface TowerConfig {
  provider?: string;
  stateDirectory?: string;
  branchPrefix?: string;
  allowedModels?: TowerModelRoute[];
  workerAgentOptions?: Partial<TowerAgentOptions>;
  reviewerAgentOptions?: Partial<TowerAgentOptions>;
}

export declare const name = 'tower-enhanced';
export declare const inject: string[];
export declare function apply(ctx: Context, config?: TowerConfig): void;

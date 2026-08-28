/** Shared protocol types mirrored from src/geocore/protocol.py. */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

export interface WireError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface Envelope<T = Record<string, unknown>> {
  ok: boolean;
  result?: T;
  error?: WireError;
}

export type GisAction = 'inspect' | 'analyze' | 'visualize' | 'show' | 'operations';

/**
 * Harness 宿主提供的 tools service（dsh-tools ToolRuntime）。register 接受单个
 * ToolDefinition 并返回反注册函数（lib/types/index.d.ts:603）。
 */
export interface ToolRuntimeLike {
  register(definition: ToolDefinition): () => void;
}

export interface GeoCorePluginConfig {
  /** Python interpreter that can `import geocore`. Defaults to `python`. */
  pythonCmd?: string;
  /** Directory holding artifacts/ and any relative datasets. Defaults to cwd. */
  workdir?: string;
  /** Per-call timeout for the Python subprocess. Default 300000 ms. */
  timeoutMs?: number;
}

export interface ResolvedConfig extends Required<GeoCorePluginConfig> {}

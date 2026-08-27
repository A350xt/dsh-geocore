/** Shared protocol types mirrored from src/geocore/protocol.py. */

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
 * Harness `tools` service surface used by this plugin (best-effort contract
 * documented at deepseek-harness docs/user/develop/framework/subsystems/core.md;
 * see tools.ts for the shape-tolerant registration call).
 */
export interface HarnessToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ToolRuntimeLike {
  register: ((def: HarnessToolDef) => unknown) &
    ((name: string, def: Omit<HarnessToolDef, 'name'>) => unknown);
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by the DeepSeek Harness host, not by cordis core itself. */
    tools?: ToolRuntimeLike;
  }
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

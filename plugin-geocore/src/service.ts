/** GeoCore 的 gis service：持有 bridge 配置与生命周期。 */

import { Service, type Context } from '@deepseek-ai/cordis';
import { PythonBridge, assertSafeExecutable } from './bridge.js';
import type { GeoCorePluginConfig, ResolvedConfig } from './types.js';

export class GisService extends Service<never> {
  static readonly provide = 'gis';
  static readonly inject = ['tools'] as const;

  readonly config: ResolvedConfig;
  private _bridge: PythonBridge | null = null;

  constructor(ctx: Context, config: GeoCorePluginConfig = {}) {
    // cordis 的类 Context 与其聚合 d.ts 的接口是两个声明符号；此处单一接缝做桥接
    super(ctx as never, 'gis');
    const pythonRaw = config.pythonCmd ?? process.env.GEOCORE_PYTHON ?? 'python';
    this.config = {
      pythonCmd: assertSafeExecutable(pythonRaw),
      workdir: config.workdir ?? process.cwd(),
      timeoutMs: config.timeoutMs ?? 300_000,
    };
    this._bridge = new PythonBridge(this.config);
  }

  /** 惰性创建，供 ctx.gis.* 直接调用方复用。 */
  get bridge(): PythonBridge {
    if (!this._bridge) {
      this._bridge = new PythonBridge(this.config);
    }
    return this._bridge;
  }

  async call<T = Record<string, unknown>>(
    action: Parameters<PythonBridge['call']>[0],
    payload?: Record<string, unknown>,
  ): Promise<T> {
    return this.bridge.call<T>(action, payload);
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    gis?: GisService;
  }
}

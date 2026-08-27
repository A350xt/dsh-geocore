/**
 * DSH GeoCore 插件入口。
 *
 * 用法（在 DeepSeek Harness 宿主中）：
 *   import geocorePlugin from '@dsh/plugin-geocore';
 *   await ctx.plugin(geocorePlugin, { workdir: 'D:/data/gis' });
 */

import type { Context } from '@deepseek-ai/cordis';
import { GisService } from './service.js';
import { buildToolDefs, registerTools } from './tools.js';
import type { GeoCorePluginConfig } from './types.js';

export interface GeoCorePluginShape {
  name: string;
  inject: string[];
  provide: string[];
  apply(ctx: Context, config?: GeoCorePluginConfig): void;
}

const plugin: GeoCorePluginShape = {
  name: 'dsh-plugin-geocore',
  // 本体不依赖外部服务：gis 由本插件创建并提供；tools 通过 ctx.inject 延迟挂接
  inject: [],
  provide: ['gis'],
  apply(ctx: Context, config: GeoCorePluginConfig = {}): void {
    const svc = new GisService(ctx, config);

    // 工具注册依赖宿主的 tools service：尚未就绪时挂起，可用后自动执行。
    const attachTools = (): void => {
      if (!ctx.tools) return;
      registerTools(ctx.tools, buildToolDefs(svc.bridge));
    };
    (ctx as any).inject(['tools'], () => attachTools());
    attachTools();
  },
};

export function apply(ctx: Context, config?: GeoCorePluginConfig): void {
  plugin.apply(ctx, config);
}

export default plugin;
export { GisService } from './service.js';
export { PythonBridge, BridgeError } from './bridge.js';
export type { Envelope, WireError, GeoCorePluginConfig, HarnessToolDef }
  from './types.js';

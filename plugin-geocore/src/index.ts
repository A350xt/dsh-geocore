/**
 * DSH GeoCore 插件入口。
 *
 * 用法（在 DeepSeek Harness 宿主中）：
 *   import geocore from '@dsh/plugin-geocore';
 *   await ctx.plugin(geocore, { workdir: 'D:/data/gis' });
 */

import type { Context } from '@deepseek-ai/cordis';
import { GisService } from './service.js';
import { buildToolDefs } from './tools.js';
import type { GeoCorePluginConfig } from './types.js';

export interface GeoCorePluginShape {
  name: string;
  inject: string[];
  provide: string[];
  apply(ctx: Context, config?: GeoCorePluginConfig): unknown;
}

const plugin: GeoCorePluginShape = {
  name: 'dsh-plugin-geocore',
  // 本体不依赖外部服务：gis 由本插件创建并提供；tools 通过 ctx.inject 延迟挂接
  inject: [],
  provide: ['gis'],
  apply(ctx: Context, config: GeoCorePluginConfig = {}): unknown {
    const svc = new GisService(ctx, config);
    const disposers: Array<() => void> = [];
    let attached = false;

    // 工具注册依赖宿主的 tools service：尚未就绪时挂起，就绪后自动注册。
    const attachTools = (): void | (() => void) => {
      if (!ctx.tools || attached) return;
      attached = true;
      for (const def of buildToolDefs(svc.bridge)) {
        disposers.push(ctx.tools.register(def));
      }
      // 卸载回调：tools 注销 + 恢复挂接能力
      return () => {
        while (disposers.length) disposers.pop()!();
        attached = false;
      };
    };

    (ctx as any).inject(['tools'], () => attachTools());
    const immediate = attachTools();
    // cordis 函数/对象插件的 apply 返回值即卸载回调
    return () => {
      immediate?.();
    };
  },
};

export function apply(ctx: Context, config?: GeoCorePluginConfig): unknown {
  return plugin.apply(ctx, config);
}

export default plugin;
export { GisService } from './service.js';
export { PythonBridge, BridgeError } from './bridge.js';
export type { Envelope, WireError, GeoCorePluginConfig } from './types.js';

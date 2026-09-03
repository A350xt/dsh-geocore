/**
 * DSH GeoCore 插件入口。
 *
 * 用法（在 DeepSeek Harness 宿主中）：
 *   import geocore from '@dsh/plugin-geocore';
 *   await ctx.plugin(geocore, { workdir: 'D:/data/gis' });
 *
 * inject: ['tools'] —— loader 等 tools 服务就绪后才 apply（cordis 属性
 * 读取契约：未声明 inject 的服务不可读）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { GisService } from './service.js'
import { buildToolDefs } from './tools.js'
import type { GeoCorePluginConfig } from './types.js'

export interface GeoCorePluginShape {
  name: string
  inject: string[]
  provide: string[]
  apply(ctx: Context, config?: GeoCorePluginConfig): unknown
}

const plugin: GeoCorePluginShape = {
  name: 'dsh-plugin-geocore',
  inject: ['tools'],
  provide: ['gis'],
  apply(ctx: Context, config: GeoCorePluginConfig = {}): unknown {
    const svc = new GisService(ctx, config)
    const disposers: Array<() => void> = []
    for (const def of buildToolDefs(svc.bridge)) {
      disposers.push((ctx as any).tools.register(def))
    }
    return () => {
      while (disposers.length) disposers.pop()!()
    }
  },
}

export function apply(ctx: Context, config?: GeoCorePluginConfig): unknown {
  return plugin.apply(ctx, config)
}

export default plugin;
export { GisService } from './service.js';
export { PythonBridge, BridgeError } from './bridge.js';
export type { Envelope, WireError, GeoCorePluginConfig } from './types.js';

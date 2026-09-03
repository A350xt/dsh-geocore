/**
 * GeoCore Studio —— dsh profile 插件入口。
 *
 * 一个插件同时完成三件事：
 * 1) 把 gis_inspect/gis_analyze/gis_visualize 注册进宿主 tools 服务
 *    （复用 plugin-geocore 的桥与工具定义，供 Agent 调用）；
 * 2) 启动 HTTP 服务：REST（清单/读取/分析/制图）+ 聊天流 + 静态前端；
 * 3) 惰性创建并长期持有交互式 DSH Agent（多轮 followup，事件按 seq 增量下发）。
 *
 * inject: ['tools'] —— 声明依赖后 loader 等 tools 服务就绪才 apply，
 * 此时 ctx.tools 才允许读取（cordis 对未声明 inject 的属性直接抛错）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { PythonBridge, assertSafeExecutable } from '../../../plugin-geocore/src/bridge.js'
import { buildToolDefs } from '../../../plugin-geocore/src/tools.js'
import { StudioAgent } from './agent.js'
import { startStudioServer, type StudioConfig } from './server.js'

export const name = 'geocore-studio'
export const inject = ['tools']

export type { StudioConfig }

export function apply(ctx: Context, config: StudioConfig = {} as StudioConfig): () => void {
  const pythonCmd = assertSafeExecutable(config.pythonCmd ?? 'python')
  const bridge = new PythonBridge({
    pythonCmd,
    workdir: config.geocoreWorkdir ?? process.cwd(),
    timeoutMs: config.timeoutMs ?? 300_000,
  })

  const disposers: Array<() => void> = []
  for (const def of buildToolDefs(bridge)) {
    disposers.push((ctx as any).tools.register(def))
  }

  const agent = new StudioAgent(ctx, config.geocoreWorkdir ?? process.cwd())
  const stopServer = startStudioServer(ctx, config, bridge, agent)

  return () => {
    stopServer()
    while (disposers.length) disposers.pop()!()
  }
}

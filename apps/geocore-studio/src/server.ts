/** Studio HTTP 服务：REST + 聊天流 + 静态前端。默认仅绑定本机回环。 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PythonBridge } from '../../../plugin-geocore/src/bridge.js'
import type { StudioAgent } from './agent.js'

export interface StudioConfig {
  /** 监听端口，默认 4173。 */
  port?: number
  /** 绑定地址，默认 127.0.0.1（刻意不暴露局域网）。 */
  host?: string
  /** Python 解释器（须可 import geocore）。 */
  pythonCmd?: string
  /** geocore 工作目录：artifacts 落盘处，也是 Agent 的 cwd。 */
  geocoreWorkdir?: string
  /** 图层面板可见的数据集目录。 */
  datasetsDir?: string
  /** 前端静态目录；缺省用包内 web-dist。 */
  webDist?: string
  /** 单次 Python 调用超时。 */
  timeoutMs?: number
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MAX_BODY_BYTES = 16 * 1024 * 1024

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

function errBody(exc: unknown): { ok: false; error: { code: string; message: string } } {
  const anyExc = exc as { code?: string; message?: string }
  return {
    ok: false,
    error: {
      code: anyExc?.code ?? 'E_INTERNAL',
      message: anyExc?.message ?? String(exc),
    },
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('请求体过大'), { code: 'E_BAD_REQUEST' })
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw Object.assign(new Error('请求体必须是 JSON 对象'), { code: 'E_BAD_REQUEST' })
  }
  return parsed as Record<string, unknown>
}

/** 路径包含性校验：resolved 必须落在 root 之下（防目录穿越）。 */
function contained(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function startStudioServer(
  ctx: Context,
  config: StudioConfig,
  bridge: PythonBridge,
  agent: StudioAgent,
): () => void {
  const port = config.port ?? 4173
  const host = config.host ?? '127.0.0.1'
  const workdirReal = path.resolve(config.geocoreWorkdir ?? process.cwd())
  const datasetsReal = config.datasetsDir ? path.resolve(config.datasetsDir) : null
  const webDistReal = path.resolve(
    config.webDist ?? path.join(HERE, '..', 'web-dist'),
  )

  async function serveStatic(urlPath: string, res: ServerResponse): Promise<void> {
    const clean = urlPath.split('?')[0].replace(/^\/+/, '')
    let target = clean === '' ? 'index.html' : clean
    const resolved = path.resolve(webDistReal, target)
    if (!contained(webDistReal, resolved)) {
      json(res, 403, errBody(new Error('路径越界')))
      return
    }
    try {
      const st = await stat(resolved)
      if (st.isDirectory()) target = 'index.html'
    } catch {
      target = 'index.html' // SPA 回退
    }
    const finalPath = path.resolve(webDistReal, target)
    if (!contained(webDistReal, finalPath)) {
      json(res, 403, errBody(new Error('路径越界')))
      return
    }
    try {
      const data = await readFile(finalPath)
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(finalPath)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      res.end(data)
    } catch {
      json(res, 404, errBody(new Error(`前端资源缺失：${target}（请先 npm run build）`)))
    }
  }

  /** 产物文件服务：仅允许 workdir/datasetsDir 内的图片。 */
  async function serveArtifactFile(rawPath: string | null, res: ServerResponse): Promise<void> {
    if (!rawPath) {
      json(res, 400, errBody(new Error('缺少 path 参数')))
      return
    }
    const resolved = path.resolve(rawPath)
    const allowed =
      (contained(workdirReal, resolved) || (datasetsReal && contained(datasetsReal, resolved))) &&
      /\.(png|svg)$/i.test(resolved)
    if (!allowed) {
      json(res, 403, errBody(new Error('仅允许访问工作目录内的图片产物')))
      return
    }
    try {
      const data = await readFile(resolved)
      res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved).toLowerCase()] ?? 'image/png' })
      res.end(data)
    } catch {
      json(res, 404, errBody(new Error('文件不存在')))
    }
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    try {
      // ---- 聊天：ndjson 流 ----
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const body = await readBody(req)
        const text = String(body.text ?? '')
        if (!text.trim()) {
          json(res, 400, errBody(new Error('text 不能为空')))
          return
        }
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        })
        const write = (obj: unknown): void => {
          res.write(JSON.stringify(obj) + '\n')
        }
        try {
          await agent.send(text, (ev) => write(ev))
        } catch (exc) {
          write({ type: 'studio/error', data: { message: (exc as Error).message } })
        }
        write({ type: 'studio/done' })
        res.end()
        return
      }

      // ---- REST ----
      if (url.pathname === '/api/config' && req.method === 'GET') {
        // 允许 DSH Web 页面（不同源）探活：只暴露只读运行信息
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify({
          ok: true,
          result: {
            workdir: workdirReal,
            datasetsDir: datasetsReal,
            model: agent.model,
            agentReady: agent.ready,
          },
        }))
        return
      }

      if (url.pathname === '/api/inventory' && req.method === 'GET') {
        const result = await bridge.call('list', {
          datasets_dir: datasetsReal ?? '',
        })
        json(res, 200, { ok: true, result: { ...result, model: agent.model } })
        return
      }

      if (url.pathname === '/api/read' && req.method === 'POST') {
        const body = await readBody(req)
        const result = await bridge.call('read', body)
        json(res, 200, { ok: true, result })
        return
      }

      if (url.pathname === '/api/analyze' && req.method === 'POST') {
        const body = await readBody(req)
        const result = await bridge.call('analyze', body)
        json(res, 200, { ok: true, result })
        return
      }

      if (url.pathname === '/api/visualize' && req.method === 'POST') {
        const body = await readBody(req)
        const result = await bridge.call('visualize', body)
        json(res, 200, { ok: true, result })
        return
      }

      if (url.pathname === '/api/file' && req.method === 'GET') {
        await serveArtifactFile(url.searchParams.get('path'), res)
        return
      }

      if (url.pathname.startsWith('/api/')) {
        json(res, 404, errBody(new Error(`未知接口：${url.pathname}`)))
        return
      }

      await serveStatic(url.pathname, res)
    } catch (exc) {
      if (!res.headersSent) json(res, 500, errBody(exc))
      else res.end()
    }
  })

  // 端口被占用等监听错误只降级为告警：绝不拖垮宿主（DSH web）启动
  server.on('error', (err: NodeJS.ErrnoException) => {
    const logger = (ctx as any).logger
    const line = `geocore-studio: HTTP 服务启动失败（${err.code ?? ''} ${err.message}）——地图界面不可用，其余功能不受影响`
    if (logger) logger('warn', line)
    else console.warn(line)
  })

  server.listen(port, host, () => {
    const logger = (ctx as any).logger
    const line = `geocore-studio: http://${host}:${port} （地图 + Agent 双标签页）`
    if (logger) logger('info', line)
    else console.log(line)
  })

  return () => {
    server.close()
    server.closeAllConnections?.()
  }
}

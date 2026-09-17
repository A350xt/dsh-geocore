/**
 * 等价宿主冒烟：用 DSH 安装目录内的 cordis 启动最小宿主，
 * 装载 GeoCore 插件并伪造 tools service，验证注册与执行链路。
 * 仅开发验证用，不属于运行时依赖。
 *
 * 环境变量：
 *   CORDIS_LIB  —— cordis/lib/index.js 的绝对路径
 *   REPO        —— 仓库根目录（默认取本文件上三级）
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const cordisLib = (process.env.CORDIS_LIB
  ?? `${process.env.USERPROFILE ?? process.env.HOME}/.dsh/profiles/node_modules/@deepseek-ai/cordis/lib/index.js`
).replace(/\\/g, '/')
const { Context } = await import(`file:///${cordisLib}`)

const REPO = process.env.REPO
  ?? resolve(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const registered = []

// 伪造宿主 tools service：register 存下定义并返回反注册函数（与 dsh-tools 相同形态）
const toolsStub = {
  register(def) {
    registered.push(def)
    return () => {
      const i = registered.indexOf(def)
      if (i >= 0) registered.splice(i, 1)
    }
  },
}

const ctx = new Context()
ctx.reflect.provide('tools', toolsStub)

const mod = await import(`file:///${(REPO + '/plugin-geocore/lib/index.js').replace(/\\/g, '/')}`)
const dispose = await ctx.plugin(mod.default, {
  pythonCmd: 'python',
  workdir: REPO + '/dsh-work',
  timeoutMs: 120000,
})

// 等待 ctx.inject(['tools']) 回调完成
await new Promise((r) => setTimeout(r, 1500))

console.log('registered tools:', registered.map((d) => d.name).sort())
if (registered.length !== 3) {
  console.error('FAIL: 期望注册 3 个工具')
  process.exit(1)
}

const inspect = registered.find((d) => d.name === 'gis_inspect')
const res = await inspect.execute(
  { path: REPO + '/datasets/synthetic/hospitals.geojson' },
  { signal: undefined },
)
console.log('gis_inspect 执行结果 count =', res.count, '| crs =', res.crs)
if (res.count !== 12) process.exit(1)

// gis service 应已由插件提供（provide: ['gis']）
const gis = ctx.gis
console.log('ctx.gis service =', gis ? 'present' : 'MISSING')
if (!gis) process.exit(1)

// 卸载经宿主 Fiber 生命周期管理，此处不手动触发
console.log('SMOKE OK')
process.exit(0)

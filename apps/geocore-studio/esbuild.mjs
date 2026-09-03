/** 构建脚本：服务插件（Node ESM，dsh 包外部化）+ 前端（浏览器 bundle）。 */

import { build, context } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

const DSH_EXTERNAL = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
]

mkdirSync(path.join(HERE, 'dist'), { recursive: true })
mkdirSync(path.join(HERE, 'web-dist'), { recursive: true })

const plugin = {
  entryPoints: [path.join(HERE, 'src/index.ts')],
  outfile: path.join(HERE, 'dist/studio-plugin.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: DSH_EXTERNAL,
  sourcemap: false,
  logLevel: 'info',
}

const web = {
  entryPoints: [path.join(HERE, 'web/app.ts')],
  outdir: path.join(HERE, 'web-dist'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  sourcemap: false,
  splitting: false,
  minify: false,
  loader: { '.png': 'dataurl' },
  logLevel: 'info',
}

if (watch) {
  const p = await context(plugin)
  const w = await context(web)
  await Promise.all([p.watch(), w.watch()])
  console.log('watching...')
} else {
  await build(plugin)
  await build(web)
  copyFileSync(path.join(HERE, 'web/index.html'), path.join(HERE, 'web-dist/index.html'))
  console.log('studio build done')
}

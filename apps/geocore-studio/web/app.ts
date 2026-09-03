/** GeoCore Studio 前端入口：单页地图工作台（Agent 对话由 DSH 主界面承担）。 */

import './ui.css'
import { initMapView, mapView } from './mapview.js'
import { initOpsBar } from './ops.js'
import { apiGet } from './api.js'

async function main(): Promise<void> {
  // DSH ⇄ Studio 同标签页往返：携带 ?from= 记住来源页，供"返回 DSH"按钮使用
  const fromParam = new URLSearchParams(location.search).get('from')
  if (fromParam && /^https?:\/\//i.test(fromParam)) {
    try {
      sessionStorage.setItem('geocore.dshUrl', fromParam)
    } catch { /* 隐私模式等场景忽略 */ }
  }
  let dshUrl: string | null = null
  try {
    dshUrl = sessionStorage.getItem('geocore.dshUrl')
  } catch { /* ignore */ }
  const backBtn = document.getElementById('btn-back-dsh')
  if (backBtn && dshUrl) {
    backBtn.classList.remove('hidden')
    backBtn.addEventListener('click', () => {
      location.href = dshUrl as string
    })
  }

  initMapView()
  initOpsBar()

  // 内核健康检查
  try {
    const cfg = await apiGet<{ workdir: string; datasetsDir: string | null }>('/api/config')
    const dot = document.getElementById('bridge-status')!
    dot.classList.add('ok')
    dot.title = `geocore 内核就绪 · workdir=${cfg.workdir}`
  } catch {
    const dot = document.getElementById('bridge-status')!
    dot.classList.add('bad')
    dot.title = 'geocore 内核不可用'
  }

  await mapView.refreshInventory()

  // 预热：默认载入行政区与河流，给用户一个可感知的初始地图
  const preloads = ['districts.geojson', 'river.geojson']
  for (const name of preloads) {
    const opt = mapView.sourceOptions().find((o) => o.value.endsWith(name))
    if (opt) await mapView.addLayer(opt.value, opt.label, { quiet: true })
  }
  mapView.refreshInventory()
}

main().catch((exc) => {
  console.error('studio init failed', exc)
})

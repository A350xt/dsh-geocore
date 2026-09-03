/** GeoCore Studio 前端入口。 */

import './ui.css'
import { switchTab } from './state.js'
import { initMapView, mapView } from './mapview.js'
import { initOpsBar } from './ops.js'
import { initChatView } from './chatview.js'
import { apiGet } from './api.js'

async function main(): Promise<void> {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab as 'map' | 'chat'))
  }

  initMapView()
  initOpsBar()
  initChatView()

  // 内核健康检查
  try {
    const cfg = await apiGet<{ workdir: string; datasetsDir: string | null; model: string }>('/api/config')
    const dot = document.getElementById('bridge-status')!
    dot.classList.add('ok')
    dot.title = `geocore 内核就绪 · workdir=${cfg.workdir}`
    if (cfg.model) document.getElementById('model-badge')!.textContent = cfg.model
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

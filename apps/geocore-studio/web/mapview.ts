/** 地图标签页：Leaflet 图层管理、图层树、样式、弹窗。 */

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { apiGet, apiPost, type Inventory, type ReadResult } from './api.js'
import { fmtBytes, h, switchTab, toast, type SourceOption } from './state.js'

interface LayerEntry {
  key: string
  label: string
  source: string
  leaflet: L.GeoJSON
  meta: ReadResult['meta'] | null
  visible: boolean
  styleField: string
  styleMode: 'none' | 'categorical' | 'quantile'
  breaks: number[] | null
  categories: Map<string, string> | null
}

const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2',
  '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#b45309']
const RAMP = ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026']

class MapView {
  map: L.Map
  private layers = new Map<string, LayerEntry>()
  private inventory: Inventory | null = null
  private basemap: L.TileLayer | null = null
  private firstFit = true

  constructor() {
    this.map = L.map('map', { preferCanvas: true }).setView([31.24, 121.55], 11)
    this.initBasemap(localStorage.getItem('geocore.basemap') ?? 'osm')
    const select = document.getElementById('basemap-select') as HTMLSelectElement
    select.value = localStorage.getItem('geocore.basemap') ?? 'osm'
    select.addEventListener('change', () => {
      localStorage.setItem('geocore.basemap', select.value)
      this.initBasemap(select.value)
    })
    window.addEventListener('geocore:map-resize', () => this.map.invalidateSize())
  }

  private initBasemap(mode: string): void {
    if (this.basemap) {
      this.map.removeLayer(this.basemap)
      this.basemap = null
    }
    if (mode === 'osm') {
      this.basemap = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(this.map)
    }
  }

  // ------------------------------------------------------------ 图层操作

  async addLayer(source: string, label?: string, opts: { quiet?: boolean } = {}): Promise<void> {
    const key = source
    if (this.layers.has(key)) {
      if (!opts.quiet) toast('图层已在地图上')
      return
    }
    try {
      const data = await apiPost<ReadResult>('/api/read', { source, max_features: 8000 })
      const entry = this.buildLayerEntry(key, label ?? this.labelFor(source), data)
      entry.leaflet.addTo(this.map)
      this.layers.set(key, entry)
      if (data.warnings?.length && !opts.quiet) {
        toast(data.warnings[0], 'warn')
      }
      if (this.firstFit || !opts.quiet) {
        this.fitTo(key)
        this.firstFit = false
      }
      this.renderTree()
    } catch (exc: any) {
      toast(`加载图层失败：${exc.message ?? exc}`, 'err')
    }
  }

  private buildLayerEntry(key: string, label: string, data: ReadResult): LayerEntry {
    const entry: LayerEntry = {
      key, label, source: data.source,
      leaflet: L.geoJSON(data.geojson, {
        pointToLayer: (_f: any, latlng: L.LatLng): L.Layer =>
          L.circleMarker(latlng, { radius: 5, weight: 1.2 } as any),
        style: (): L.PathOptions => ({}),
        onEachFeature: (f, layer) => {
          layer.bindPopup(this.popupHtml(f))
        },
      }),
      meta: data.meta,
      visible: true,
      styleField: '',
      styleMode: 'none',
      breaks: null,
      categories: null,
    }
    entry.leaflet.setStyle((f) => this.baseStyle(f, entry))
    return entry
  }

  /** 按几何族给出基础样式；着色字段启用时覆盖颜色。 */
  private baseStyle(feature: any, entry: LayerEntry): L.PathOptions {
    const t = feature?.geometry?.type ?? 'Point'
    const isLine = t.includes('LineString')
    const isPoint = t.includes('Point')
    let color = isLine ? '#7c3aed' : isPoint ? '#f59e0b' : '#3b82f6'
    if (entry.styleMode !== 'none' && entry.styleField) {
      const v = feature?.properties?.[entry.styleField]
      if (entry.styleMode === 'categorical' && entry.categories) {
        color = entry.categories.get(String(v)) ?? '#94a3b8'
      } else if (entry.styleMode === 'quantile' && entry.breaks) {
        const num = Number(v)
        let idx = entry.breaks.findIndex((b) => num <= b)
        if (idx < 0) idx = entry.breaks.length - 1
        const pos = entry.breaks.length > 1 ? idx / (entry.breaks.length - 1) : 0
        color = RAMP[Math.min(RAMP.length - 1, Math.round(pos * (RAMP.length - 1)))]
      }
    }
    if (isPoint) {
      return { color: '#fff', weight: 1.2, fillColor: color, fillOpacity: 0.95, radius: 5 } as L.PathOptions
    }
    if (isLine) return { color, weight: 2.4, opacity: 0.9 }
    return { color, weight: 1.2, fillColor: color, fillOpacity: 0.35 }
  }

  private popupHtml(feature: any): HTMLElement {
    const table = h('table', { class: 'popup-table' })
    for (const [k, v] of Object.entries(feature.properties ?? {})) {
      table.append(h('tr', {}, h('td', { text: k }), h('td', { text: String(v ?? '') })))
    }
    return h('div', {}, table)
  }

  removeLayer(key: string): void {
    const entry = this.layers.get(key)
    if (!entry) return
    this.map.removeLayer(entry.leaflet)
    this.layers.delete(key)
    this.renderTree()
  }

  toggleVisible(key: string): void {
    const entry = this.layers.get(key)
    if (!entry) return
    entry.visible = !entry.visible
    if (entry.visible) entry.leaflet.addTo(this.map)
    else this.map.removeLayer(entry.leaflet)
    this.renderTree()
  }

  fitTo(key: string): void {
    const entry = this.layers.get(key)
    if (!entry) return
    const bounds = entry.leaflet.getBounds()
    if (bounds.isValid()) this.map.fitBounds(bounds.pad(0.08))
  }

  /** 字段样式重算（样式编辑器调用）。 */
  restyle(key: string, field: string, mode: LayerEntry['styleMode']): void {
    const entry = this.layers.get(key)
    if (!entry) return
    entry.styleField = field
    entry.styleMode = mode
    entry.breaks = null
    entry.categories = null
    if (mode !== 'none' && field) {
      const values: unknown[] = (entry.leaflet.toGeoJSON() as any).features
        .map((f: any) => f?.properties?.[field])
        .filter((v: unknown) => v !== null && v !== undefined)
      if (mode === 'categorical') {
        const uniqSet = ([...new Set(values.map((v: unknown): string => String(v)))] as string[])
          .slice(0, PALETTE.length)
        entry.categories = new Map<string, string>(uniqSet.map((v: string, i: number): [string, string] => [v, PALETTE[i % PALETTE.length]]))
      } else {
        const nums = values.map(Number).filter((n: number) => Number.isFinite(n))
          .sort((a: number, b: number) => a - b)
        const classes = 5
        entry.breaks = Array.from({ length: classes }, (_, i) =>
          nums[Math.floor((nums.length - 1) * (i / classes))] ?? 0)
      }
    }
    entry.leaflet.setStyle((f) => this.baseStyle(f, entry))
  }

  // ------------------------------------------------------------ 图层树

  async refreshInventory(): Promise<void> {
    try {
      this.inventory = await apiGet<Inventory>('/api/inventory')
      const badge = document.getElementById('model-badge')
      if (badge && this.inventory.model) badge.textContent = this.inventory.model
      this.renderTree()
    } catch (exc: any) {
      document.getElementById('layer-tree')!.innerHTML =
        `<p class="tree-hint">清单加载失败：${exc.message ?? exc}</p>`
    }
  }

  labelFor(source: string): string {
    if (!this.inventory) return source
    const ds = this.inventory.datasets.find((d) => d.path === source)
    if (ds) return ds.name
    const stepRef = source.match(/^(ar_[A-Za-z0-9]+)#(.+)$/)
    if (stepRef) {
      const art = this.inventory.artifacts.find((a) => a.artifact_id === stepRef[1])
      return `${art?.title ?? stepRef[1]} · ${stepRef[2]}`
    }
    const art = this.inventory.artifacts.find((a) => a.artifact_id === source)
    return art ? `${art.title}（结果）` : source
  }

  /** 操作表单/聊天“查看地图”用的全部可选图层源。 */
  sourceOptions(): SourceOption[] {
    const out: SourceOption[] = []
    for (const d of this.inventory?.datasets ?? []) {
      out.push({ value: d.path, label: d.name, group: '数据集', count: undefined })
    }
    for (const a of this.inventory?.artifacts ?? []) {
      out.push({
        value: a.artifact_id,
        label: `${a.title}（结果 ${a.count}）`,
        group: 'Artifacts',
        count: a.count,
        geometry_types: a.geometry_types,
      })
      for (const [step, info] of Object.entries(a.intermediate_layers ?? {})) {
        out.push({
          value: `${a.artifact_id}#${step}`,
          label: `${a.title} · ${step}（${info.count}）`,
          group: 'Artifacts',
          count: info.count,
        })
      }
    }
    return out
  }

  private renderTree(): void {
    const tree = document.getElementById('layer-tree')!
    tree.innerHTML = ''
    if (!this.inventory) {
      tree.append(h('p', { class: 'tree-hint' }, '清单加载中…'))
      return
    }

    // —— 已加载图层（样式编辑） ——
    if (this.layers.size > 0) {
      tree.append(h('div', { class: 'tree-group-title' }, '已加载'))
      for (const entry of this.layers.values()) {
        const row = h('div', { class: 'tree-item loaded' },
          h('button', {
            class: 'icon-btn', title: '显隐',
            onclick: () => this.toggleVisible(entry.key),
          }, entry.visible ? '👁' : '🚫'),
          h('span', {
            class: 'item-name', title: entry.source,
            onclick: () => this.fitTo(entry.key),
          }, entry.label),
          h('span', { class: 'item-meta' }, String(entry.meta?.count_returned ?? '')),
          h('button', {
            class: 'icon-btn', title: '移除',
            onclick: () => this.removeLayer(entry.key),
          }, '✕'),
        )
        tree.append(row, this.styleEditor(entry))
      }
    }

    // —— 数据集 ——
    tree.append(h('div', { class: 'tree-group-title' }, '数据集'))
    for (const d of this.inventory.datasets) {
      const loaded = this.layers.has(d.path)
      tree.append(h('div', { class: `tree-item ${loaded ? 'loaded' : ''}` },
        h('span', {
          class: 'item-name', title: d.path,
          onclick: () => (loaded ? this.removeLayer(d.path) : this.addLayer(d.path, d.name)),
        }, `${this.formatIcon(d.format)} ${d.name}`),
        h('span', { class: 'item-meta' }, fmtBytes(d.size_bytes)),
      ))
    }

    // —— Artifacts ——
    tree.append(h('div', { class: 'tree-group-title' },
      `分析产物（${this.inventory.artifacts.length}）`))
    if (this.inventory.artifacts.length === 0) {
      tree.append(h('p', { class: 'tree-hint' }, '暂无——用工具条或 Agent 产生分析结果'))
    }
    for (const a of this.inventory.artifacts) {
      const resultKey = a.artifact_id
      const children = h('div', { class: 'tree-children' })
      for (const [step, info] of Object.entries(a.intermediate_layers ?? {})) {
        const stepKey = `${a.artifact_id}#${step}`
        children.append(h('div', { class: `tree-item ${this.layers.has(stepKey) ? 'loaded' : ''}` },
          h('span', {
            class: 'item-name',
            onclick: () => this.layers.has(stepKey)
              ? this.removeLayer(stepKey)
              : this.addLayer(stepKey, `${a.title} · ${step}`),
          }, `${step}（${info.count}）`),
        ))
      }
      const warnMark = a.warnings > 0 ? ` ⚠${a.warnings}` : ''
      tree.append(h('div', { class: `tree-item ${this.layers.has(resultKey) ? 'loaded' : ''}` },
        h('span', {
          class: 'item-name', title: a.title,
          onclick: () => this.layers.has(resultKey)
            ? this.removeLayer(resultKey)
            : this.addLayer(resultKey, `${a.title}（结果）`),
        }, `▲ ${a.title}${warnMark}`),
        h('span', { class: 'item-meta' }, `${a.count}`),
      ), children)
    }
  }

  private styleEditor(entry: LayerEntry): HTMLElement {
    const fields = entry.meta?.fields ?? []
    const fieldSel = h('select') as HTMLSelectElement
    fieldSel.append(h('option', { value: '' }, '— 无 —'))
    for (const f of fields) fieldSel.append(h('option', { value: f }, f))
    fieldSel.value = entry.styleField
    const modeSel = h('select') as HTMLSelectElement
    modeSel.append(
      h('option', { value: 'none' }, '单色'),
      h('option', { value: 'categorical' }, '分类'),
      h('option', { value: 'quantile' }, '分级'),
    )
    modeSel.value = entry.styleMode
    const apply = (): void => this.restyle(entry.key, fieldSel.value, modeSel.value as any)
    fieldSel.addEventListener('change', apply)
    modeSel.addEventListener('change', apply)
    return h('div', { class: 'tree-children' },
      h('div', { class: 'tree-item' },
        h('span', { class: 'item-meta' }, '样式'),
        fieldSel, modeSel))
  }

  private formatIcon(fmt: string): string {
    return { geojson: '📍', gpkg: '📦', shapefile: '🗂', csv: '📄' }[fmt] ?? '📄'
  }

  /** 聊天卡片“在地图中查看”入口。 */
  async viewArtifact(artifactId: string, step?: string): Promise<void> {
    switchTab('map')
    await this.refreshInventory()
    const source = step ? `${artifactId}#${step}` : artifactId
    await this.addLayer(source)
  }
}

export let mapView: MapView

export function initMapView(): MapView {
  mapView = new MapView()
  return mapView
}

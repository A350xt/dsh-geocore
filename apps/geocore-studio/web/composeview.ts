/** 制图模式：所见即所得版面编辑器。

 * 架构：浏览器只编辑版面规格（elements 的分数坐标 + 属性），
 * 预览与导出都由内核 compose 渲染器完成——预览即成品（真 WYSIWYG）。
 * 拖动/缩放/改属性 → 防抖刷新预览（低 dpi）；导出用高 dpi 重渲染。
 */

import { apiPost } from './api.js'
import { h, toast } from './state.js'
import { mapView } from './mapview.js'

interface LayoutEl {
  id: string
  type: 'map' | 'title' | 'text' | 'legend' | 'scalebar' | 'north'
  x: number; y: number; w: number; h: number
  text?: string
  size?: number
  extent?: [number, number, number, number]
  layers?: Array<Record<string, unknown>>
  [k: string]: unknown
}

const ELEMENT_LABELS: Record<string, string> = {
  map: '地图框', title: '标题', text: '文本', legend: '图例',
  scalebar: '比例尺', north: '指北针',
}

const PAGE_MM: Record<string, [number, number]> = {
  A4: [210, 297], A3: [297, 420], A2: [420, 594],
}

let seq = 0
const nextId = (t: string): string => `${t}_${++seq}`

function defaultEl(type: LayoutEl['type']): LayoutEl {
  const base: LayoutEl = { id: nextId(type), type, x: .08, y: .08, w: .3, h: .2 }
  switch (type) {
    case 'map':
      return { ...base, x: .05, y: .1, w: .6, h: .8, layers: [] }
    case 'title':
      return { ...base, x: .05, y: .02, w: .9, h: .06, text: '地图标题', size: 16 }
    case 'text':
      return { ...base, x: .7, y: .88, w: .26, h: .08, text: '数据：…\n制图：GeoCore', size: 7 }
    case 'legend':
      return { ...base, x: .7, y: .12, w: .26, h: .42 }
    case 'scalebar':
      return { ...base, x: .08, y: .92, w: .22, h: .04 }
    case 'north':
      return { ...base, x: .9, y: .84, w: .05, h: .1 }
  }
}

class ComposeView {
  private root: HTMLElement | null = null
  private paper!: HTMLElement
  private previewImg!: HTMLImageElement
  private propsPanel!: HTMLElement
  private elsPanel!: HTMLElement
  private elements: LayoutEl[] = []
  private selected: string | null = null
  private page = { size: 'A4', orientation: 'landscape' as 'landscape' | 'portrait' }
  private title = '制图'
  private debounceTimer = 0
  private dirty = true

  open(): void {
    if (!this.root) this.build()
    this.root!.classList.remove('hidden')
    if (this.elements.length === 0) this.seedFromMap()
    this.renderAll()
    this.refreshPreview()
  }

  close(): void {
    this.root?.classList.add('hidden')
  }

  // ------------------------------------------------------------ 构建 DOM

  private build(): void {
    this.root = h('div', { id: 'layout-root', class: 'hidden' })
    const topbar = h('div', { class: 'layout-topbar' },
      h('button', { class: 'ghost-pill', onclick: () => this.close() }, '↩ 返回浏览'),
      h('span', { class: 'layout-brand' }, '◈ 制图模式'),
      h('label', { class: 'layout-field' }, '页面',
        this.sel(['A4', 'A3', 'A2'], this.page.size, (v) => { this.page.size = v; this.onChanged() })),
      h('label', { class: 'layout-field' }, '方向',
        this.sel(['landscape', 'portrait'], this.page.orientation, (v) => { this.page.orientation = v as 'landscape' | 'portrait'; this.onChanged() })),
      h('label', { class: 'layout-field' }, '图名',
        (() => { const i = h('input', { class: 'layout-title-input', type: 'text', value: this.title }) as HTMLInputElement; i.addEventListener('input', () => { this.title = i.value; this.onChanged() }); return i })()),
      h('button', { class: 'btn-primary', onclick: () => this.exportPng() }, '导出 PNG'),
    )
    const sidebar = h('div', { class: 'layout-sidebar' },
      h('div', { class: 'tree-group-title' }, '添加要素'),
      ...(['map', 'title', 'text', 'legend', 'scalebar', 'north'] as const).map((t) =>
        h('button', {
          class: 'layout-add-btn',
          onclick: () => this.addElement(t),
        }, `＋ ${ELEMENT_LABELS[t]}`)),
      h('div', { class: 'tree-group-title', style: 'margin-top:14px' }, '要素列表'),
      this.elsPanel = h('div', { class: 'layout-el-list' }),
    )
    this.paper = h('div', { class: 'layout-paper' },
      this.previewImg = h('img', { class: 'layout-preview', alt: '版面预览' }) as HTMLImageElement,
    )
    const propsWrap = h('div', { class: 'layout-props' },
      h('div', { class: 'tree-group-title' }, '属性'),
      this.propsPanel = h('div', {},
        h('p', { class: 'tree-hint' }, '选中一个要素编辑')),
    )
    const main = h('div', { class: 'layout-main' }, sidebar, this.paper, propsWrap)
    this.root.append(topbar, main)
    document.body.append(this.root)
  }

  private sel(options: string[], value: string, onchange: (v: string) => void): HTMLSelectElement {
    const s = h('select') as HTMLSelectElement
    for (const o of options) s.append(h('option', { value: o }, o))
    s.value = value
    s.addEventListener('change', () => onchange(s.value))
    return s
  }

  // ------------------------------------------------------------ 初始版面

  private seedFromMap(): void {
    const mapEl = defaultEl('map')
    mapEl.layers = mapView.buildLayoutLayers()
    mapEl.extent = mapView.currentExtent()
    this.elements = [
      { ...defaultEl('title'), text: this.title === '制图' ? 'GeoCore 专题图' : this.title },
      mapEl,
      defaultEl('legend'),
      defaultEl('scalebar'),
      defaultEl('north'),
      defaultEl('text'),
    ]
    this.dirty = true
  }

  private addElement(t: LayoutEl['type']): void {
    this.elements.push(defaultEl(t))
    this.selected = this.elements[this.elements.length - 1].id
    this.onChanged()
  }

  // ------------------------------------------------------------ 渲染

  private renderAll(): void {
    this.renderPaperBoxes()
    this.renderList()
    this.renderProps()
  }

  private aspect(): number {
    const [w, h] = PAGE_MM[this.page.size] ?? PAGE_MM.A4
    return this.page.orientation === 'landscape' ? h / w : w / h
  }

  private renderPaperBoxes(): void {
    for (const b of Array.from(this.paper.querySelectorAll('.layout-box'))) b.remove()
    for (const el of this.elements) {
      const box = h('div', {
        class: `layout-box${el.id === this.selected ? ' selected' : ''}`,
        style: `left:${el.x * 100}%;top:${el.y * 100}%;width:${el.w * 100}%;height:${el.h * 100}%`,
      },
        h('span', { class: 'layout-box-tag' }, ELEMENT_LABELS[el.type] ?? el.type),
        h('span', { class: 'layout-box-resize' }),
      )
      box.addEventListener('pointerdown', (ev) => {
        if ((ev.target as HTMLElement).classList.contains('layout-box-resize')) {
          this.startResize(ev, el)
        } else {
          this.startDrag(ev, el)
        }
      })
      this.paper.append(box)
    }
  }

  private startDrag(ev: PointerEvent, el: LayoutEl): void {
    ev.preventDefault()
    this.selected = el.id
    this.renderList(); this.renderProps()
    const rect = this.paper.getBoundingClientRect()
    const startX = ev.clientX, startY = ev.clientY
    const ox = el.x, oy = el.y
    const move = (e: PointerEvent): void => {
      el.x = clamp01(ox + (e.clientX - startX) / rect.width)
      el.y = clamp01(oy + (e.clientY - startY) / rect.height)
      this.renderPaperBoxes()
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      this.onChanged()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  private startResize(ev: PointerEvent, el: LayoutEl): void {
    ev.preventDefault()
    this.selected = el.id
    const rect = this.paper.getBoundingClientRect()
    const startX = ev.clientX, startY = ev.clientY
    const ow = el.w, oh = el.h
    const move = (e: PointerEvent): void => {
      el.w = clamp01(ow + (e.clientX - startX) / rect.width)
      el.h = clamp01(oh + (e.clientY - startY) / rect.height)
      this.renderPaperBoxes()
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      this.onChanged()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  private renderList(): void {
    this.elsPanel.innerHTML = ''
    for (const el of this.elements) {
      const row = h('div', {
        class: `tree-item${el.id === this.selected ? ' loaded' : ''}`,
        onclick: () => { this.selected = el.id; this.renderAll() },
      },
        h('span', { class: 'item-name' }, ELEMENT_LABELS[el.type] ?? el.type),
        h('button', {
          class: 'icon-btn', title: '删除',
          onclick: (e: Event) => { e.stopPropagation(); this.removeElement(el.id) },
        }, '✕'),
      )
      this.elsPanel.append(row)
    }
  }

  private removeElement(id: string): void {
    this.elements = this.elements.filter((e) => e.id !== id)
    if (this.selected === id) this.selected = null
    this.onChanged()
  }

  private renderProps(): void {
    this.propsPanel.innerHTML = ''
    const el = this.elements.find((e) => e.id === this.selected)
    if (!el) {
      this.propsPanel.append(h('p', { class: 'tree-hint' }, '选中一个要素编辑'))
      return
    }
    const row = (label: string, child: HTMLElement): HTMLElement =>
      h('div', { class: 'form-row' }, h('label', {}, label), child)

    if ('text' in el || el.type === 'title' || el.type === 'text') {
      const ta = h('textarea', { rows: '2' }) as HTMLTextAreaElement
      ta.value = String(el.text ?? '')
      ta.addEventListener('input', () => { el.text = ta.value; this.onChanged() })
      this.propsPanel.append(row('文本', ta))
      const num = h('input', { type: 'number', min: '6', max: '48' }) as HTMLInputElement
      num.value = String(el.size ?? (el.type === 'title' ? 16 : 7))
      num.addEventListener('input', () => { el.size = Number(num.value) || 12; this.onChanged() })
      this.propsPanel.append(row('字号', num))
    }
    if (el.type === 'map') {
      const useExtent = h('button', { class: 'btn-secondary', style: 'width:100%' },
        '用当前地图视图范围')
      useExtent.addEventListener('click', () => {
        el.extent = mapView.currentExtent()
        toast('已更新地图框范围')
        this.onChanged()
      })
      this.propsPanel.append(row('范围', useExtent))
      const syncLayers = h('button', { class: 'btn-secondary', style: 'width:100%' },
        '同步当前已加载图层')
      syncLayers.addEventListener('click', () => {
        el.layers = mapView.buildLayoutLayers()
        toast('已同步图层')
        this.onChanged()
      })
      this.propsPanel.append(row('图层', syncLayers))
      const n = (el.layers ?? []).length
      this.propsPanel.append(h('p', { class: 'form-hint' }, `当前 ${n} 个图层（自下而上叠加）`))
    }
    // 位置数值（所有要素通用）
    const grid = h('div', { class: 'layout-xy' })
    for (const key of ['x', 'y', 'w', 'h'] as const) {
      const inp = h('input', { type: 'number', step: '0.01', min: '0', max: '1' }) as HTMLInputElement
      inp.value = el[key].toFixed(2)
      inp.addEventListener('input', () => {
        el[key] = clamp01(Number(inp.value) || 0)
        this.renderPaperBoxes(); this.onChanged()
      })
      grid.append(h('label', {}, key, inp))
    }
    this.propsPanel.append(row('位置/尺寸', grid))
  }

  // ------------------------------------------------------------ 预览与导出

  private spec(): Record<string, unknown> {
    return {
      title: this.title,
      page: { ...this.page },
      elements: this.elements.map((e) => ({ ...e })),
    }
  }

  private onChanged(): void {
    this.dirty = true
    this.renderPaperBoxes()
    this.renderList()
    this.renderProps()
    this.refreshPreview()
  }

  private refreshPreview(): void {
    window.clearTimeout(this.debounceTimer)
    this.debounceTimer = window.setTimeout(async () => {
      try {
        const r = await apiPost<{ image_path: string }>('/api/compose',
          { spec: this.spec(), dpi: 60 })
        // 破缓存刷新预览图
        this.previewImg.src = `/api/file?path=${encodeURIComponent(r.image_path)}&t=${Date.now()}`
        this.paper.style.aspectRatio = String(this.aspect())
        this.dirty = false
      } catch (exc: any) {
        toast(`预览失败：${exc.message ?? exc}`, 'err')
      }
    }, 500)
  }

  private async exportPng(): Promise<void> {
    try {
      const r = await apiPost<{ image_path: string; artifact_id: string }>('/api/compose',
        { spec: this.spec(), dpi: 220 })
      toast(`已导出（${r.artifact_id}），正在打开…`)
      window.open(`/api/file?path=${encodeURIComponent(r.image_path)}`, '_blank')
      mapView.refreshInventory()
    } catch (exc: any) {
      toast(`导出失败：${exc.message ?? exc}`, 'err')
    }
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

export let composeView: ComposeView

export function initComposeView(): ComposeView {
  composeView = new ComposeView()
  return composeView
}

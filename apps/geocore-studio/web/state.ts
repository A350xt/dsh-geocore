/** 全局共享状态与工具函数（跨标签页通信走这里，不用框架）。 */

export function h(tag: string, attrs: Record<string, string | EventListener> = {}, ...children: unknown[]): HTMLElement {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2), v as EventListener)
    } else if (k === 'class') {
      el.className = String(v)
    } else if (k === 'text') {
      el.textContent = String(v)
    } else {
      el.setAttribute(k, String(v))
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

export function toast(message: string, kind: '' | 'warn' | 'err' = '', ms = 3600): void {
  const root = document.getElementById('toast-root')!
  const el = h('div', { class: `toast ${kind}` }, message)
  root.append(el)
  setTimeout(() => el.remove(), ms)
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 极简 markdown：粗体/行内代码/代码块/段落。避免引入 markdown 依赖。 */
export function renderLite(text: string): HTMLElement {
  const container = h('div')
  const lines = text.split('\n')
  let inCode = false
  let codeBuf: string[] = []
  let paraBuf: string[] = []

  const flushPara = (): void => {
    if (!paraBuf.length) return
    container.append(inline(h('p', {}), paraBuf.join('\n')))
    paraBuf = []
  }
  const flushCode = (): void => {
    if (!codeBuf.length) return
    container.append(h('pre', { class: 'lite-code' }, codeBuf.join('\n')))
    codeBuf = []
  }

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        flushCode()
        inCode = false
      } else {
        flushPara()
        inCode = true
      }
      continue
    }
    if (inCode) codeBuf.push(line)
    else if (line.trim() === '') flushPara()
    else paraBuf.push(line)
  }
  flushPara()
  flushCode()
  return container
}

function inline(el: HTMLElement, text: string): HTMLElement {
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)/g
  let last = 0
  for (const m of text.matchAll(pattern)) {
    el.append(text.slice(last, m.index))
    const token = m[0]
    if (token.startsWith('`')) el.append(h('code', { class: 'lite-code-inline' }, token.slice(1, -1)))
    else el.append(h('strong', {}, token.slice(2, -2)))
    last = (m.index ?? 0) + token.length
  }
  el.append(text.slice(last))
  return el
}

// ---------------- 标签页切换 ----------------

export type TabId = 'map' | 'chat'

export function switchTab(tab: TabId): void {
  for (const t of ['map', 'chat'] as TabId[]) {
    document.getElementById(`panel-${t}`)?.classList.toggle('active', t === tab)
    document.getElementById(`tab-btn-${t}`)?.classList.toggle('active', t === tab)
  }
  if (tab === 'map') {
    // Leaflet 在隐藏容器中初始化后需要手动校正尺寸
    window.dispatchEvent(new Event('geocore:map-resize'))
    document.getElementById('chat-input')?.blur()
  } else {
    document.getElementById('chat-input')?.focus()
  }
}

// ---------------- 图层源选择项（操作表单/图层面板共用） ----------------

export interface SourceOption {
  value: string // dataset 路径 | artifact_id | artifact_id#step
  label: string
  group: string
  count?: number
  geometry_types?: string[]
}

/** 全局共享状态与工具函数（轻量 DOM/提示助手，不用框架）。 */

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

// ---------------- 图层源选择项（操作表单/图层面板共用） ----------------

export interface SourceOption {
  value: string // dataset 路径 | artifact_id | artifact_id#step
  label: string
  group: string
  count?: number
  geometry_types?: string[]
}

/**
 * GeoCore Studio 客户端覆盖层：把 GIS 工作台嵌入 DSH Web 主界面。
 *
 * 行为：右上角悬浮按钮（🗺）在 DSH 页面内铺开一个全屏嵌入层（iframe 加载
 * Studio 服务），再次点击收起——DSH 会话状态原地保留，不发生页面导航。
 * 展开前先对 Studio 服务探活（GET /api/config），服务未启动时显示提示而非空白。
 *
 * 风格：按钮直接引用 DSH 宿主页面的 --dsw-alias-* 设计令牌（带回退值），
 * 自动跟随 DSH 亮/暗主题；展开时读取 body[data-ds-dark-theme] 把主题
 * 透传给 Studio（iframe ?theme=dark|light）。
 *
 * 打包协议（对齐 @deepseek-ai 客户端包产物）：
 * 经典脚本执行时向 window.__ModuleLoader__ 注册 {id, factory}；
 * factory(require) 返回 cordis 插件对象（apply 在浏览器上下文运行）。
 */

const STUDIO_URL = 'http://127.0.0.1:4173/'
const PROBE_URL = `${STUDIO_URL}api/config`
const PROBE_TIMEOUT_MS = 4000

/** DSH 用 body[data-ds-dark-theme] 标记暗色主题。 */
function hostTheme(): 'dark' | 'light' {
  return document.body?.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
}

/** Studio 入口地址（带主题参数，主题切换后重开即生效）。 */
function studioUrl(): string {
  return `${STUDIO_URL}?theme=${hostTheme()}`
}

interface FactoryModule {
  exports: Record<string, unknown>
}

function createOverlay(): { root: HTMLDivElement; iframe: HTMLIFrameElement; hint: HTMLDivElement } {
  const root = document.createElement('div')
  root.id = 'geocore-studio-overlay'
  Object.assign(root.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483000',
    background: 'var(--dsw-alias-bg-base, #ffffff)',
    display: 'flex',
    flexDirection: 'column',
  })

  const iframe = document.createElement('iframe')
  iframe.title = 'GeoCore Studio 地图工作台'
  Object.assign(iframe.style, {
    flex: '1',
    width: '100%',
    border: 'none',
    background: '#fff',
  })

  const hint = document.createElement('div')
  hint.id = 'geocore-studio-hint'
  Object.assign(hint.style, {
    margin: 'auto',
    padding: '28px 36px',
    background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
    border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))',
    borderRadius: '12px',
    boxShadow: '0 8px 28px rgba(15,23,42,.16)',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    fontSize: '14px',
    color: 'var(--dsw-alias-label-secondary, #334155)',
    lineHeight: '1.8',
    display: 'none',
    textAlign: 'center',
  })
  hint.textContent =
    'GeoCore Studio 服务未响应（127.0.0.1:4173）。请确认 DSH 已随 geocore-studio 插件启动后重试。'

  root.append(iframe, hint)
  return { root, iframe, hint }
}

function buildFactoryModule(): FactoryModule {
  const module: FactoryModule = { exports: {} }
  const exports = module.exports

  exports.name = 'geocore-studio-overlay'

  exports.apply = (_ctx: unknown): (() => void) => {
    let btn: HTMLButtonElement | null = null
    let overlay: { root: HTMLDivElement; iframe: HTMLIFrameElement; hint: HTMLDivElement } | null = null
    let open = false
    let probing = false

    const styleButton = (text: string): void => {
      if (btn) btn.textContent = text
    }

    /** 展开前探活：服务在线才挂 iframe，否则显示提示。 */
    const probeAndOpen = (): void => {
      if (probing) return
      probing = true
      styleButton('…')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
      fetch(PROBE_URL, { signal: controller.signal, cache: 'no-store' })
        .then((res) => {
          showOverlay(res.ok)
        })
        .catch(() => showOverlay(false))
        .finally(() => {
          clearTimeout(timer)
          probing = false
          styleButton(open ? '✕' : '🗺')
        })
    }

    const showOverlay = (serviceUp: boolean): void => {
      if (!overlay) overlay = createOverlay()
      if (!document.getElementById('geocore-studio-overlay')) {
        document.body.appendChild(overlay.root)
      }
      overlay.root.style.display = 'flex'
      overlay.hint.style.display = serviceUp ? 'none' : 'block'
      overlay.iframe.style.display = serviceUp ? 'block' : 'none'
      // 每次展开按当前 DSH 主题取地址；主题变化后重开会自动刷新
      if (serviceUp) overlay.iframe.src = studioUrl()
      open = true
      styleButton('✕')
    }

    const hideOverlay = (): void => {
      if (overlay) overlay.root.style.display = 'none'
      open = false
      styleButton('🗺')
    }

    const mount = (): (() => void) => {
      if (document.getElementById('geocore-studio-launcher')) {
        return () => document.getElementById('geocore-studio-launcher')?.remove()
      }

      btn = document.createElement('button')
      btn.id = 'geocore-studio-launcher'
      btn.type = 'button'
      btn.textContent = '🗺'
      btn.title = 'GeoCore 地图工作台（点击展开 / 收起）'
      // 复用 DSH 宿主的设计令牌：跟随其亮/暗主题与品牌色，缺省回退到亮色值
      Object.assign(btn.style, {
        position: 'fixed',
        top: '12px',
        right: '16px',
        zIndex: '2147483647',
        width: '40px',
        height: '40px',
        padding: '0',
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
        color: 'var(--dsw-alias-state-business-primary, #4176e6)',
        fontSize: '18px',
        lineHeight: '38px',
        textAlign: 'center',
        fontFamily: '"Segoe UI Emoji", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
        cursor: 'pointer',
        boxShadow: '0 2px 10px rgba(15, 17, 21, .12)',
        transition: 'background .15s ease, transform .15s ease',
      })
      btn.addEventListener('mouseenter', () => {
        if (btn) {
          btn.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06))'
          btn.style.transform = 'translateY(-1px)'
        }
      })
      btn.addEventListener('mouseleave', () => {
        if (btn) {
          btn.style.background = 'var(--dsw-alias-bg-layer-2, #ffffff)'
          btn.style.transform = 'none'
        }
      })
      btn.addEventListener('click', () => {
        if (open) {
          hideOverlay()
        } else {
          probeAndOpen()
        }
      })
      document.body.appendChild(btn)
      return () => {
        btn?.remove()
        overlay?.root.remove()
      }
    }

    if (document.body) return mount()
    const onReady = (): void => {
      mount()
    }
    document.addEventListener('DOMContentLoaded', onReady, { once: true })
    return () => document.removeEventListener('DOMContentLoaded', onReady)
  }

  return module
}

// DSH 客户端模块注册协议：向宿主安装的模块装载器登记本包工厂
const moduleLoader = (globalThis as { __ModuleLoader__?: { load?: unknown } }).__ModuleLoader__
const registerFactory = moduleLoader?.load
if (typeof registerFactory === 'function') {
  const registration = {
    id: '@geocore/studio-surface',
    factory: (_require: unknown): Record<string, unknown> => buildFactoryModule().exports,
  }
  ;(registerFactory as (reg: unknown) => void)(registration)
} else {
  // 不在 DSH Web 宿主内（例如直接打开本文件）时静默跳过
  console.warn('geocore-studio-overlay: __ModuleLoader__ 不可用，覆盖层未注册')
}

/**
 * GeoCore Studio 客户端覆盖层：在 DSH Web 主界面注入悬浮切换按钮。
 *
 * 点击后**同一浏览器标签页**导航到 Studio 地图工作台，并携带 ?from= 记录
 * 当前 DSH 页面地址，Studio 侧据此显示"返回 DSH"按钮。
 *
 * 打包协议（对齐 @deepseek-ai 客户端包产物）：
 * 经典脚本执行时向 window.__ModuleLoader__ 注册 {id, factory}；
 * factory(require) 返回 cordis 插件对象（apply 在浏览器上下文运行）。
 */

const STUDIO_URL = 'http://127.0.0.1:4173/'

interface FactoryModule {
  exports: Record<string, unknown>
}

function buildFactoryModule(): FactoryModule {
  const module: FactoryModule = { exports: {} }
  const exports = module.exports

  exports.name = 'geocore-studio-overlay'

  exports.apply = (_ctx: unknown): (() => void) => {
    let btn: HTMLButtonElement | null = null

    const mount = (): (() => void) => {
      const existing = document.getElementById('geocore-studio-launcher')
      if (existing) return () => existing.remove()

      btn = document.createElement('button')
      btn.id = 'geocore-studio-launcher'
      btn.type = 'button'
      btn.textContent = '🗺 GeoCore 地图'
      btn.title = '切换到 GeoCore Studio 地图工作台（本标签页内来回切换）'
      Object.assign(btn.style, {
        position: 'fixed',
        right: '20px',
        bottom: '20px',
        zIndex: '2147483647',
        padding: '10px 18px',
        border: 'none',
        borderRadius: '999px',
        background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
        color: '#fff',
        fontSize: '14px',
        fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
        fontWeight: '600',
        cursor: 'pointer',
        boxShadow: '0 6px 20px rgba(37, 99, 235, 0.45)',
        transition: 'transform .15s ease, box-shadow .15s ease',
      })
      btn.addEventListener('mouseenter', () => {
        if (btn) {
          btn.style.transform = 'translateY(-2px)'
          btn.style.boxShadow = '0 10px 26px rgba(37, 99, 235, 0.55)'
        }
      })
      btn.addEventListener('mouseleave', () => {
        if (btn) {
          btn.style.transform = 'none'
          btn.style.boxShadow = '0 6px 20px rgba(37, 99, 235, 0.45)'
        }
      })
      btn.addEventListener('click', () => {
        const from = encodeURIComponent(location.href)
        location.href = `${STUDIO_URL}?from=${from}`
      })
      document.body.appendChild(btn)
      return () => btn?.remove()
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

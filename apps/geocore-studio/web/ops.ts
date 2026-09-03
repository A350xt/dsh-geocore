/** 地图标签页的可视化操作：表单 → /api/analyze → 结果面板 + 自动上图。 */

import { apiPost, type AnalyzeResult } from './api.js'
import { h, toast } from './state.js'
import { mapView } from './mapview.js'

type OpKind = 'filter' | 'buffer' | 'within' | 'overlay' | 'zonal' | 'measure'

const OP_TITLES: Record<OpKind, string> = {
  filter: '属性筛选',
  buffer: '缓冲区分析',
  within: '邻近筛选',
  overlay: '叠加分析',
  zonal: '分区统计',
  measure: '度量（面积 / 长度）',
}

/** 各操作构建 operations（参数校验失败抛 Error）。 */
function buildOperations(kind: OpKind, v: (name: string) => string): any[] {
  switch (kind) {
    case 'filter':
      if (!v('input') || !v('where')) throw new Error('请选择图层并填写条件')
      return [{ id: 'f', op: 'query.filter', input: v('input'), where: v('where') }]
    case 'buffer':
      if (!v('input') || !v('distance_m')) throw new Error('请选择图层并填写距离')
      return [{
        id: 'b', op: 'proximity.buffer', input: v('input'),
        distance_m: Number(v('distance_m')),
        dissolve: v('dissolve') === 'true',
      }]
    case 'within':
      if (!v('input') || !v('ref') || !v('distance_m')) throw new Error('请选择图层、参照层与距离')
      return [{
        id: 'w', op: 'proximity.within_distance',
        input: v('input'), ref: v('ref'), distance_m: Number(v('distance_m')),
      }]
    case 'overlay': {
      if (!v('a') || !v('b')) throw new Error('请选择两个输入图层')
      const op = `overlay.${v('overlay_op')}`
      return v('overlay_op') === 'clip'
        ? [{ id: 'o', op, a: v('a'), b: v('b') }]
        : [{ id: 'o', op, a: v('a'), b: v('b') }]
    }
    case 'zonal': {
      if (!v('regions') || !v('data')) throw new Error('请选择区域层与数据层')
      const stats = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="zstat"]:checked'))
        .map((el) => el.value)
      if (stats.length === 0) throw new Error('请至少勾选一个统计量')
      const op: any = { id: 'z', op: 'zonal.summarize', regions: v('regions'), data: v('data'), stats }
      const field = v('field')
      if (field) op.field = field
      return [op]
    }
    case 'measure': {
      if (!v('input')) throw new Error('请选择图层')
      const kinds = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="mkind"]:checked'))
        .map((el) => el.value)
      if (kinds.length === 0) throw new Error('请至少勾选一种度量')
      return [{ id: 'm', op: 'query.measure', input: v('input'), measures: kinds }]
    }
  }
}

export function openOpDialog(kind: OpKind): void {
  const options = mapView.sourceOptions()
  if (options.length === 0) {
    toast('没有可用图层源：请先生成合成数据集', 'warn')
    return
  }
  const root = document.getElementById('modal-root')!
  root.classList.remove('hidden')
  root.innerHTML = ''

  const sel = (name: string): HTMLSelectElement => {
    const s = h('select', { name }) as HTMLSelectElement
    let lastGroup = ''
    for (const opt of options) {
      if (opt.group !== lastGroup) {
        s.append(h('option', { disabled: 'disabled' }, `── ${opt.group} ──`))
        lastGroup = opt.group
      }
      s.append(h('option', { value: opt.value }, opt.label))
    }
    return s
  }
  const row = (label: string, control: HTMLElement, hint = ''): HTMLElement =>
    h('div', { class: 'form-row' }, h('label', {}, label), control,
      hint ? h('div', { class: 'form-hint' }, hint) : null)

  const body = h('div', { class: 'modal-body' })
  const needInput = kind !== 'overlay' || true
  if (['filter', 'buffer', 'within', 'measure'].includes(kind) || kind === 'zonal') {
    // 统一的“输入图层”行
  }

  switch (kind) {
    case 'filter':
      body.append(
        row('输入图层', sel('input')),
        row('筛选条件（pandas query 语法）',
          h('input', { name: 'where', placeholder: "`landuse` == '工业' 或 pop_density > 10000" }),
          '关键字列名用反引号包裹，如 `class`'),
      )
      break
    case 'buffer':
      body.append(
        row('输入图层', sel('input')),
        row('缓冲距离（米）', h('input', { name: 'distance_m', type: 'number', value: '1000' })),
        row('融合方式', (() => {
          const s = h('select', { name: 'dissolve' }) as HTMLSelectElement
          s.append(h('option', { value: 'false' }, '保留每个要素的缓冲面'))
          s.append(h('option', { value: 'true' }, '融合为单一覆盖面'))
          return s
        })()),
      )
      break
    case 'within':
      body.append(
        row('筛选对象', sel('input')),
        row('参照层（如医院、道路）', sel('ref')),
        row('距离（米）', h('input', { name: 'distance_m', type: 'number', value: '2000' })),
      )
      break
    case 'overlay':
      body.append(
        row('图层 A（主体）', sel('a')),
        row('图层 B（参照/掩膜）', sel('b')),
        row('叠加方式', (() => {
          const s = h('select', { name: 'overlay_op' }) as HTMLSelectElement
          s.append(h('option', { value: 'intersection' }, '交集（A ∩ B）'))
          s.append(h('option', { value: 'difference' }, '扣除（A − B）'))
          s.append(h('option', { value: 'union' }, '合并（A ∪ B）'))
          s.append(h('option', { value: 'clip' }, '裁剪（B 掩膜，保留 A 属性）'))
          return s
        })()),
      )
      break
    case 'zonal': {
      body.append(
        row('区域层（面）', sel('regions')),
        row('数据层（点/线/面）', sel('data')),
        row('统计量', (() => {
          const box = h('div', {})
          const items: Array<[string, string]> = [
            ['count', '数量'], ['sum', '属性求和'], ['mean', '均值'],
            ['total_length_km', '线总长'], ['total_area_sqkm', '面总面积'], ['share_pct', '占比 %'],
          ]
          for (const [val, label] of items) {
            box.append(h('label', { class: 'zstat-label' },
              h('input', { type: 'checkbox', name: 'zstat', value: val }), ` ${label}`))
          }
          return box
        })()),
        row('数值字段（sum/mean 时必填）', h('input', { name: 'field', placeholder: '如 beds / population' })),
      )
      break
    }
    case 'measure':
      body.append(
        row('输入图层', sel('input')),
        row('度量项', (() => {
          const box = h('div', {})
          const items: Array<[string, string]> = [
            ['area_sqkm', '面积（km²）'], ['length_km', '长度（km）'], ['count', '要素数量'],
          ]
          for (const [val, label] of items) {
            box.append(h('label', { class: 'zstat-label' },
              h('input', { type: 'checkbox', name: 'mkind', value: val }), ` ${label}`))
          }
          return box
        })()),
      )
      break
  }

  const runBtn = h('button', { class: 'btn-primary' }, '运行分析') as HTMLButtonElement
  const cancelBtn = h('button', { class: 'btn-secondary' }, '取消')
  const close = (): void => { root.classList.add('hidden'); root.innerHTML = '' }
  cancelBtn.addEventListener('click', close)
  root.addEventListener('click', (e) => { if (e.target === root) close() })
  runBtn.addEventListener('click', async () => {
    const getter = (name: string): string =>
      (body.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement | null)?.value ?? ''
    let operations: any[]
    try {
      operations = buildOperations(kind, getter)
    } catch (exc: any) {
      toast(exc.message, 'warn')
      return
    }
    runBtn.disabled = true
    runBtn.textContent = '分析中…'
    try {
      const result = await apiPost<AnalyzeResult>('/api/analyze', {
        title: OP_TITLES[kind], operations,
      })
      showResultPanel(result)
      await mapView.refreshInventory()
      await mapView.addLayer(result.artifact_id, `${result.title}（结果）`, { quiet: true })
      toast(`完成：${result.summary[result.summary.length - 1] ?? ''}`)
    } catch (exc: any) {
      toast(`分析失败 [${exc.code ?? ''}] ${exc.message ?? exc}`, 'err', 6000)
    } finally {
      close()
    }
  })

  root.append(h('div', { class: 'modal' },
    h('div', { class: 'modal-head' }, h('h3', {}, OP_TITLES[kind])),
    body,
    h('div', { class: 'modal-actions' }, cancelBtn, runBtn),
  ))
}

export function showResultPanel(result: AnalyzeResult): void {
  const panel = document.getElementById('result-panel')!
  panel.classList.remove('hidden')
  document.getElementById('result-title')!.textContent = result.title
  const body = document.getElementById('result-body')!
  body.innerHTML = ''

  body.append(h('div', {},
    h('div', { class: 'form-hint' },
      `产物 ${result.artifact_id} · ${result.result.count} 要素 · 分析坐标系 ${result.crs.analysis}`)))

  const steps = h('ol', { class: 'result-steps' })
  for (const s of result.steps) steps.append(h('li', {}, `${s.summary}`))
  body.append(steps)

  if (result.warnings.length > 0) {
    const warns = h('ul', { class: 'warn-list' })
    for (const w of result.warnings) warns.append(h('li', {}, w))
    body.append(h('div', {}, h('strong', {}, '数据准备与告警：')), warns)
  }
}

export function initOpsBar(): void {
  document.getElementById('result-close')!.addEventListener('click', () => {
    document.getElementById('result-panel')!.classList.add('hidden')
  })
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.op-btn')) {
    btn.addEventListener('click', () => openOpDialog(btn.dataset.op as OpKind))
  }
}

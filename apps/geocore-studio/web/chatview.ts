/** 对话标签页：ndjson 事件流渲染（流式文本、工具卡片、产物上图）。 */

import { chatStream } from './api.js'
import { h, renderLite, toast } from './state.js'
import { mapView } from './mapview.js'

interface ToolCardState {
  el: HTMLElement
  bodyEl: HTMLElement | null
  filled: boolean
}

class ChatView {
  private messages = document.getElementById('chat-messages')!
  private input = document.getElementById('chat-input') as HTMLTextAreaElement
  private sendBtn = document.getElementById('chat-send') as HTMLButtonElement
  private busy = false

  /** 流式文本聚合：`${turn}:${step}` → 当前气泡元素 */
  private streamBubbles = new Map<string, HTMLElement>()
  private toolCards = new Map<string, ToolCardState>()

  constructor() {
    this.sendBtn.addEventListener('click', () => this.submit())
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        this.submit()
      }
    })
    for (const btn of document.querySelectorAll<HTMLButtonElement>('.sample')) {
      btn.addEventListener('click', () => {
        this.input.value = btn.textContent ?? ''
        this.submit()
      })
    }
  }

  private submit(): void {
    const text = this.input.value.trim()
    if (!text || this.busy) return
    this.busy = true
    this.sendBtn.disabled = true
    this.input.value = ''

    this.appendUser(text)
    this.messages.querySelector('.chat-welcome')?.remove()
    this.streamBubbles.clear()
    this.toolCards.clear()

    chatStream(text, (ev) => this.onEvent(ev))
      .catch((exc: any) => {
        this.appendNote(`发送失败：${exc.message ?? exc}`)
      })
      .finally(() => {
        this.busy = false
        this.sendBtn.disabled = false
        this.input.focus()
      })
  }

  private onEvent(ev: any): void {
    switch (ev.type) {
      case 'assistant/chunk': {
        const chunk = ev.data?.chunk
        if (chunk?.type === 'text-delta' && chunk.text) {
          const key = `${ev.data.turn}:${ev.data.step}`
          let bubble = this.streamBubbles.get(key)
          if (!bubble) {
            bubble = this.appendAssistantStreaming()
            this.streamBubbles.set(key, bubble)
          }
          bubble.append(document.createTextNode(chunk.text))
          this.scrollDown()
        }
        return
      }
      case 'assistant/message': {
        const key = `${ev.data.turn}:${ev.data.step}`
        const texts = (ev.data.message?.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
        if (texts) {
          const bubble = this.streamBubbles.get(key)
          if (bubble) {
            // 用最终消息替换流式聚合文本（含富文本渲染）
            bubble.innerHTML = ''
            bubble.append(renderLite(texts))
          } else {
            this.appendAssistant(texts)
          }
          this.streamBubbles.get(key)?.closest('.msg')?.classList.remove('streaming')
          this.streamBubbles.delete(key)
        } else {
          // 纯工具调用步骤：收掉空流式气泡
          this.streamBubbles.get(key)?.closest('.msg')?.remove()
          this.streamBubbles.delete(key)
        }
        this.scrollDown()
        return
      }
      case 'tool/call': {
        this.appendToolCall(ev.data.callId, ev.data.name, ev.data.arguments)
        this.scrollDown()
        return
      }
      case 'tool/result': {
        this.fillToolResult(ev.data)
        this.scrollDown()
        return
      }
      case 'turn/end': {
        const reason = ev.data?.reason
        if (reason?.kind === 'error') {
          this.appendNote(`回合出错：${reason.error?.code ?? ''} ${reason.error?.message ?? ''}`)
        }
        // 兜底：清掉所有残留的流式指示
        for (const el of this.messages.querySelectorAll('.msg.streaming')) {
          el.classList.remove('streaming')
        }
        this.streamBubbles.clear()
        return
      }
      case 'studio/error': {
        this.appendNote(`Agent 错误：${ev.data?.message ?? ''}`)
        return
      }
      default:
        return
    }
  }

  // ------------------------------------------------------------ DOM 装配

  private appendUser(text: string): void {
    this.messages.append(h('div', { class: 'msg user' },
      h('div', { class: 'bubble' }, text)))
    this.scrollDown()
  }

  private appendAssistantStreaming(): HTMLElement {
    const bubble = h('div', { class: 'bubble' })
    this.messages.append(h('div', { class: 'msg assistant streaming' }, bubble))
    return bubble
  }

  private appendAssistant(text: string): void {
    this.messages.append(h('div', { class: 'msg assistant' },
      h('div', { class: 'bubble' }, renderLite(text))))
  }

  private appendNote(text: string): void {
    this.messages.append(h('div', { class: 'chat-note' }, text))
    this.scrollDown()
  }

  private appendToolCall(callId: string, name: string, argsRaw: string): void {
    const pretty = this.prettyArgs(name, argsRaw)
    const argsEl = h('div', { class: 'tc-args' }, pretty)
    const body = h('div', { class: 'tc-body' }, argsEl)
    const card = h('div', { class: 'tool-card' },
      h('div', { class: 'tc-head' },
        h('span', { class: 'tc-name' }, name),
        h('span', { class: 'tc-state' }, '运行中…')),
      body)
    this.messages.append(card)
    this.toolCards.set(callId, { el: card, bodyEl: body, filled: false })
  }

  private fillToolResult(data: any): void {
    // message 是完整 assistant 消息；其 content[0] 是 tool-result 块，
    // 块内 toolCallId 配对调用，块内 content 才是面向模型的文本。
    const block = (data.message?.content ?? []).find((b: any) => b.type === 'tool-result')
    if (!block) return
    const card = this.toolCards.get(block.toolCallId)
    if (!card || card.filled) return
    card.filled = true
    card.el.querySelector('.tc-state')!.textContent = data.error ? `失败：${data.error.code}` : '完成'

    const textBlocks = (block.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')

    const container = h('div', {})
    // gis_* 工具结果是 JSON 文本（我们的 output.render 投影）：解析出人话摘要与产物
    if (textBlocks.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(textBlocks)
        const summary: string[] = parsed.summary ?? []
        if (summary.length > 0) {
          const ul = h('ul', { class: 'tc-summary' })
          for (const line of summary) ul.append(h('li', {}, line))
          container.append(ul)
        }
        if (parsed.artifact_id) {
          container.append(this.artifactBadge(parsed.artifact_id, parsed.title))
          const steps = Object.keys(parsed.intermediate_layers ?? {})
          for (const step of steps.slice(0, 6)) {
            container.append(this.artifactBadge(parsed.artifact_id, `步骤 ${step}`, step))
          }
        }
        const warns = parsed.warnings ?? []
        if (warns.length > 0) {
          const ul = h('ul', { class: 'warn-list' })
          for (const w of warns) ul.append(h('li', {}, w))
          container.append(ul)
        }
        if (container.childElementCount > 0) {
          card.bodyEl!.append(container)
          return
        }
      } catch {
        // 解析失败按原文展示
      }
    }
    const preview = textBlocks.length > 700 ? textBlocks.slice(0, 700) + '…' : textBlocks
    card.bodyEl!.append(h('div', { class: 'tc-args' }, preview || '（无输出）'))
  }

  private artifactBadge(artifactId: string, label: string, step?: string): HTMLElement {
    const btn = h('button', {}, '在地图中查看')
    btn.addEventListener('click', () => {
      mapView.viewArtifact(artifactId, step).then(
        () => toast('已加入地图图层'),
        (exc: any) => toast(`上图失败：${exc.message ?? exc}`, 'err'),
      )
    })
    return h('span', { class: 'artifact-badge' },
      `${label ?? ''} ${step ? '#' + step : ''}`.trim(), btn)
  }

  private prettyArgs(name: string, argsRaw: string): string {
    try {
      const parsed = JSON.parse(argsRaw)
      if (name === 'gis_analyze' && Array.isArray(parsed.operations)) {
        const lines = parsed.operations.map((op: any) => `${op.id}: ${op.op}`)
        return (parsed.title ? `「${parsed.title}」\n` : '') + lines.join('\n')
      }
      if (name === 'gis_inspect' && parsed.path) {
        return parsed.path
      }
      if (name === 'gis_visualize') {
        return `${parsed.source ?? ''} → ${parsed.style?.mode ?? ''}`
      }
      return JSON.stringify(parsed, null, 1)
    } catch {
      return argsRaw
    }
  }

  private scrollDown(): void {
    this.messages.scrollTop = this.messages.scrollHeight
  }
}

export function initChatView(): ChatView {
  return new ChatView()
}

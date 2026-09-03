/**
 * 交互式 DSH Agent：dsh-headless 一次性驱动的多轮化改造。
 *
 * 生命周期（对齐 @deepseek-ai/dsh-headless lib/index.js 的官方用法）：
 *   agents.create({sessionId, meta.cwd, agentOptions, setup: installModelSelection})
 *   → whenIdle → followup(createUserMessage(...)) → whenIdle → sessions.flush
 * 本类让 Agent 常驻：每条用户消息一次 followup；事件以 120ms 轮询按 seq
 * 增量外发（含 assistant/chunk 流式、tool/call、tool/result、turn/end）。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

const SKIP_EVENT_TYPES = new Set(['request/header'])

export interface AgentEventLike {
  seq: number
  type: string
  data?: unknown
}

export class StudioAgent {
  private agent: any = null
  private sessions: any = null
  private selection: { provider: string; model: string } | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private sentSeq = 0

  constructor(private readonly ctx: Context, private readonly cwd: string) {}

  get ready(): boolean {
    return this.agent !== null
  }

  get model(): string {
    return this.selection ? `${this.selection.provider}/${this.selection.model}` : ''
  }

  /** 首次使用时创建 Agent；模型选择读取宿主 agentDefaultModel 当前值。 */
  private async ensure(): Promise<void> {
    if (this.agent) return
    const get = (this.ctx as any).get?.bind(this.ctx)
    await get?.('loader')?.await?.()

    const agents = get?.('agents')
    const defaultModel = get?.('agentDefaultModel')
    const sessions = get?.('sessions')
    if (!agents || !defaultModel || !sessions) {
      throw new Error(
        'Agent 服务不可用（需要 dsh-base 提供 agents/agentDefaultModel/sessions）',
      )
    }

    const selection = defaultModel.currentSelection()
    const [{ installModelSelection }, { SessionId }] = await Promise.all([
      import('@deepseek-ai/dsh-agent'),
      import('@deepseek-ai/dsh-session'),
    ])

    const { agent } = await agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: this.cwd },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx: any) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
      },
    })
    await agent.whenIdle()

    this.agent = agent
    this.sessions = sessions
    this.selection = { provider: selection.provider, model: selection.model }
  }

  /** 串行提交一条用户消息；onEvent 在轮询间隔内收到增量会话事件。 */
  send(text: string, onEvent: (ev: AgentEventLike) => void): Promise<void> {
    this.queue = this.queue.then(() => this.#send(text, onEvent))
    return this.queue as Promise<void>
  }

  async #send(text: string, onEvent: (ev: AgentEventLike) => void): Promise<void> {
    await this.ensure()
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const agent = this.agent

    const poll = setInterval(() => this.#drain(onEvent), 120)
    try {
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }),
      )
      await agent.whenIdle()
      await this.sessions.flush(agent.session)
    } finally {
      clearInterval(poll)
    }
    this.#drain(onEvent)
  }

  #drain(onEvent: (ev: AgentEventLike) => void): void {
    if (!this.agent) return
    let events: AgentEventLike[]
    try {
      events = this.agent.session.events as AgentEventLike[]
    } catch {
      return
    }
    for (const ev of events) {
      if (typeof ev.seq !== 'number' || ev.seq <= this.sentSeq) continue
      this.sentSeq = ev.seq
      if (SKIP_EVENT_TYPES.has(ev.type)) continue
      try {
        onEvent(ev)
      } catch {
        // 单个事件渲染失败不终止流
      }
    }
  }
}

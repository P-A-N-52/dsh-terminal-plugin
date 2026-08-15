import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import {
  deferred,
  extractTextBlocks,
  mergeUsage,
  parseProviderModel,
  sessionTitle,
  truncate,
} from './utils.js'
import { DshRpcError } from './rpc-client.js'
import { InputInterrupted } from './input.js'

export class SessionController extends EventEmitter {
  constructor({ client, renderer, input, approvalPolicy = 'ask', showHistory = true } = {}) {
    super()
    this.client = client
    this.renderer = renderer
    this.input = input
    this.approvalPolicy = approvalPolicy
    this.showHistory = showHistory
    this.sessionId = undefined
    this.cwd = process.cwd()
    this.agentPreset = undefined
    this.model = undefined
    this.modelsSnapshot = undefined
    this.projections = {}
    this.hostCommands = []
    this.routable = undefined
    this.hostDescription = undefined
    this.running = false
    this.closed = false
    this.seenSeq = new Map()
    this.pendingMux = []
    this.eventChain = Promise.resolve()
    this.interactionChain = Promise.resolve()
    this.activeTurn = undefined
    this.streamedSteps = new Set()
    this.answeredInteractionIds = new Set()
    this.pendingInteractionIds = new Set()
    this.boundMux = envelope => this.onMux(envelope)
    this.boundHost = envelope => this.onHost(envelope)
    this.boundTransport = event => this.onTransport(event)
    this.boundStreamError = error => this.onStreamError(error)
    client.on('mux', this.boundMux)
    client.on('host', this.boundHost)
    client.on('transport', this.boundTransport)
    client.on('stream-error', this.boundStreamError)
  }

  async initialize({ resume, cwd, agentPreset, model, reasoning, showHistory = this.showHistory } = {}) {
    this.hostDescription = await this.client.call('host.describe', {})
    if (resume) {
      await this.switchSession(resume, { showHistory, initial: true })
    } else {
      await this.newSession(cwd ?? this.hostDescription.cwd, { agentPreset, showHistory: false, initial: true })
    }
    if (model) {
      const selection = parseProviderModel(model)
      await this.selectModel(selection.provider, selection.model, reasoning)
    }
    return this.statusInfo()
  }

  async newSession(cwd = this.cwd, { agentPreset, showHistory = false, initial = false } = {}) {
    this.assertIdle('创建新会话')
    const absoluteCwd = resolve(cwd)
    const value = await this.client.call('session.create', {
      cwd: absoluteCwd,
      ...(agentPreset ? { agentPreset } : {}),
    })
    this.agentPreset = value.agentPreset
    await this.activateSession(value.sessionId, {
      cwd: absoluteCwd,
      agentPreset: value.agentPreset,
      showHistory,
      initial,
    })
    if (!initial) this.renderer.success(`已创建会话 ${value.sessionId}`)
    return value.sessionId
  }

  async switchSession(sessionId, { showHistory = this.showHistory, initial = false } = {}) {
    this.assertIdle('切换会话')
    const list = await this.client.call('session.list', {})
    const summary = list.items.find(item => item.sessionId === sessionId)
    if (!summary) throw new Error(`找不到会话 ${sessionId}`)
    await this.activateSession(sessionId, {
      cwd: summary.cwd ?? this.hostDescription?.cwd ?? process.cwd(),
      agentPreset: summary.agentPreset,
      running: summary.running,
      showHistory,
      initial,
    })
    if (!initial) this.renderer.success(`已恢复会话 ${sessionId}`)
  }

  async activateSession(sessionId, { cwd, agentPreset, running = false, showHistory, initial } = {}) {
    this.renderer.clearActivity()
    this.renderer.finishAssistantStream()
    this.sessionId = sessionId
    this.cwd = cwd
    this.agentPreset = agentPreset
    this.running = running
    this.streamedSteps.clear()
    this.seenSeq.set(sessionId, -1)

    const history = await this.client.call('session.history', {
      sessionId,
      maxMessages: showHistory ? 50 : 1,
    })
    this.projections = { ...(history.projections?.values ?? {}) }
    const entries = [...history.events].sort((a, b) => a.event.seq - b.event.seq)
    await this.refreshModels({ quiet: true })
    await this.refreshHostCommands()
    this.renderer.banner(this.statusInfo())
    for (const entry of entries) {
      await this.processEvent(entry.event, entry.view, { history: true, render: showHistory })
    }
    if (showHistory && entries.length > 0) {
      this.renderer.notice(initial ? '已载入最近会话历史' : '已载入会话历史')
    }

    const buffered = this.pendingMux
    this.pendingMux = []
    for (const envelope of buffered) {
      if (envelope.frame.sessionId === sessionId || envelope.frame.type === 'stream/error') this.onMux(envelope)
      else this.pendingMux.push(envelope)
    }
  }

  async send(text) {
    const prompt = String(text)
    if (prompt.trim() === '') return
    if (!this.sessionId) throw new Error('还没有活动会话')
    this.assertIdle('发送消息')
    const active = {
      deferred: deferred(),
      startedAt: Date.now(),
      turn: undefined,
      stepUsage: new Map(),
    }
    this.activeTurn = active
    this.renderer.user(prompt)
    this.renderer.activityStart('Harness 正在处理')
    try {
      const value = await this.client.call('session.prompt', {
        sessionId: this.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
        clientTimeZone: currentTimeZone(),
      }, { timeoutMs: 60_000 })
      if (prompt.startsWith('/')) {
        this.renderer.activityStop()
        if (value.command?.text) this.renderer.notice(value.command.text)
        active.deferred.resolve({ kind: 'command' })
        if (this.activeTurn === active) this.activeTurn = undefined
        return { kind: 'command' }
      }
      return await active.deferred.promise
    } catch (error) {
      this.renderer.activityStop()
      if (this.activeTurn === active) this.activeTurn = undefined
      throw error
    }
  }

  async cancel() {
    if (!this.sessionId || (!this.running && !this.activeTurn)) return false
    this.renderer.notice('正在取消当前回合…')
    try {
      await this.client.call('session.cancel', { sessionId: this.sessionId })
      return true
    } catch (error) {
      if (error instanceof DshRpcError && (error.code === 'agent-busy' || error.code === 'session-not-found')) return false
      throw error
    }
  }

  async listSessions() {
    const value = await this.client.call('session.list', {})
    return value.items
      .filter(item => item.origin !== 'subagent')
      .map(item => ({
        ...item,
        title: sessionTitle(item),
      }))
  }

  async refreshModels({ quiet = false } = {}) {
    if (!this.sessionId) return undefined
    try {
      const value = await this.client.call('session.models', { sessionId: this.sessionId })
      this.modelsSnapshot = value
      this.model = value.current
      this.routable = value.routable
      this.renderer.updateHeader({ model: this.model })
      if (!quiet && value.failures.length > 0) {
        for (const failure of value.failures) this.renderer.warning(`${failure.name}：${failure.message}`)
      }
      return value
    } catch (error) {
      this.modelsSnapshot = undefined
      this.routable = false
      if (!quiet) this.renderer.warning(`无法读取模型目录：${error.message}`)
      return undefined
    }
  }

  modelOptions() {
    const groups = this.modelsSnapshot?.groups ?? []
    return groups.flatMap(group => group.models.map(model => ({
      provider: group.id,
      providerName: group.name,
      model: model.id,
      name: model.name,
      description: model.description,
      reasoning: model.reasoning,
    })))
  }

  reasoningOptions(provider = this.model?.provider, model = this.model?.model) {
    const item = this.modelOptions().find(candidate => candidate.provider === provider && candidate.model === model)
    return item?.reasoning
  }

  async selectModel(provider, model, reasoningEffort) {
    if (!this.sessionId) throw new Error('还没有活动会话')
    this.assertIdle('切换模型')
    const value = await this.client.call('session.selectModel', {
      sessionId: this.sessionId,
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    })
    this.model = value.selected
    await this.refreshModels({ quiet: true })
    this.renderer.success(`模型已切换为 ${provider}/${model}${reasoningEffort ? ` · ${reasoningEffort}` : ''}`)
    return value.selected
  }

  async rename(title) {
    if (!this.sessionId) throw new Error('还没有活动会话')
    const value = await this.client.call('session.rename', { sessionId: this.sessionId, title })
    this.renderer.success(`会话已重命名为「${value.title}」`)
  }

  async fork() {
    if (!this.sessionId) throw new Error('还没有活动会话')
    this.assertIdle('分叉会话')
    const value = await this.client.call('session.fork', { sessionId: this.sessionId })
    await this.switchSession(value.sessionId, { showHistory: true })
    return value.sessionId
  }

  setApprovalPolicy(policy) {
    if (!['ask', 'allow', 'deny'].includes(policy)) throw new Error('审批策略只能是 ask、allow 或 deny')
    this.approvalPolicy = policy
    this.renderer.updateHeader({ approvalPolicy: policy })
    this.renderer.success(`审批策略已设为 ${policy}`)
  }

  /** The permissions projection: options plus the session's current preset. */
  permissionView() {
    return this.projections?.permissions
  }

  /** Token usage, turn stats, and context breakdown from session projections. */
  usageView() {
    return {
      tokenUsage: this.projections?.tokenUsage,
      sessionStats: this.projections?.sessionStats,
      contextBreakdown: this.projections?.contextBreakdown,
      contextPressure: this.projections?.contextPressure,
    }
  }

  /** Harness-native slash commands registered on this session's agent. */
  async refreshHostCommands() {
    if (!this.sessionId) return []
    try {
      const value = await this.client.call('commands/list', { args: { agentId: this.sessionId } })
      this.hostCommands = Array.isArray(value) ? value : []
    } catch {
      // Hosts without the commands registry (older or minimal compositions)
      // leave the local command set as the only completion source.
      this.hostCommands = []
    }
    return this.hostCommands
  }

  /**
   * Run a Harness-native slash command on the current session through the
   * commands registry (the same channel the web UI uses for /permission etc).
   * @param line - the full command line, including the leading slash.
   * @returns the command result `{ kind: 'success' | 'error', text? }`.
   */
  async executeHostCommand(line) {
    if (!this.sessionId) throw new Error('还没有活动会话')
    this.assertIdle(`执行命令 ${line}`)
    const value = await this.client.call('commands/execute', {
      args: { agentId: this.sessionId, line },
    })
    return value?.result ?? { kind: 'success' }
  }

  /** All agent presets visible to this host (system plus user roots). */
  async listAgentPresets() {
    const value = await this.client.call('agentPreset.list', {})
    return {
      presets: Array.isArray(value?.presets) ? value.presets : [],
      authorable: Boolean(value?.authorable),
    }
  }

  /**
   * Switch the current session's agent preset. The host locks the preset once
   * a session leaves the blank state (`agent-preset-locked`).
   * @param agentPreset - preset id from `listAgentPresets`.
   */
  async selectAgentPreset(agentPreset) {
    if (!this.sessionId) throw new Error('还没有活动会话')
    this.assertIdle('切换 Agent 预设')
    await this.client.call('agentPreset.select', { sessionId: this.sessionId, agentPreset })
    this.agentPreset = agentPreset
    await this.refreshHostCommands()
  }

  statusInfo() {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      model: this.model,
      routable: this.routable,
      running: this.running,
      hostVersion: this.hostDescription?.version,
      baseUrl: String(this.client.baseUrl),
      approvalPolicy: this.approvalPolicy,
      agentPreset: this.agentPreset,
      permission: this.projections?.permissions?.currentValue,
      planActive: Boolean(this.projections?.plan?.active),
      goal: goalSummary(this.projections?.goal),
    }
  }

  assertIdle(action) {
    if (this.running || this.activeTurn) throw new Error(`当前回合还在运行，不能${action}；先按 Ctrl+C 或输入 /cancel`)
  }

  onMux(envelope) {
    const { frame } = envelope
    if (!this.sessionId) {
      if (this.pendingMux.length < 500) this.pendingMux.push(envelope)
      return
    }
    if (frame.sessionId && frame.sessionId !== this.sessionId) return
    switch (frame.type) {
      case 'session/event':
        this.eventChain = this.eventChain
          .then(() => this.handleLiveEvent(frame.event, frame.view))
          .catch(error => this.handleAsyncError(error))
        break
      case 'session/subscribed':
        if (frame.lastSeq > (this.seenSeq.get(this.sessionId) ?? -1)) {
          this.eventChain = this.eventChain
            .then(() => this.syncHistory())
            .catch(error => this.handleAsyncError(error))
        }
        break
      case 'approval/requested':
        this.enqueueInteraction(envelope.rpcId, () => this.handleApproval(envelope.rpcId, frame))
        break
      case 'question/requested':
        this.enqueueInteraction(envelope.rpcId, () => this.handleQuestion(envelope.rpcId, frame))
        break
      case 'session/queue':
        this.renderer.queueStatus(frame.items.length)
        break
      case 'session/projection':
        if (typeof frame.key === 'string') {
          const previous = this.projections[frame.key]
          this.projections[frame.key] = frame.value
          this.notifyProjectionChange(frame.key, previous, frame.value)
        }
        break
      default:
        break
    }
  }

  onHost({ frame }) {
    if (!this.sessionId || frame.sessionId !== this.sessionId) return
    switch (frame.type) {
      case 'host/session-status':
        this.running = frame.running
        if (frame.running) this.renderer.activityUpdate('Harness 正在工作')
        break
      case 'host/agent-error': {
        this.running = false
        const error = new Error(frame.message)
        this.renderer.error(`Agent 错误：${frame.message}`)
        this.rejectActive(error)
        break
      }
      case 'host/session-removed':
        this.running = false
        this.rejectActive(new Error(`会话 ${frame.sessionId} 已被删除`))
        break
      default:
        break
    }
  }

  onTransport(event) {
    if (event.state === 'reconnecting' || event.state === 'closed') {
      this.renderer.activityUpdate('连接中断，正在重连')
    } else if (event.state === 'reconnected') {
      this.renderer.notice(`${event.kind} 事件流已重连`)
    } else if (event.state === 'error' || event.state === 'malformed') {
      this.renderer.debug(`${event.kind} transport: ${event.error?.message ?? event.state}`)
    }
  }

  onStreamError(error) {
    this.renderer.error(`Harness 事件流错误：${error.message}`)
    this.rejectActive(error)
  }

  /** Echo mode-relevant projection changes (plan mode, goal) as they happen. */
  notifyProjectionChange(key, previous, value) {
    if (key === 'plan') {
      const was = Boolean(previous?.active)
      const active = Boolean(value?.active)
      if (active !== was) this.renderer.notice(active ? '已进入计划模式' : '已退出计划模式')
      return
    }
    if (key === 'goal') {
      const was = previous?.objective ?? null
      const now = value?.objective ?? null
      if (now === was) return
      if (now) this.renderer.notice(`目标已更新：${truncate(now, 60)}`)
      else this.renderer.notice('目标已清除')
    }
  }

  async handleLiveEvent(event, view) {
    if (!this.sessionId) return
    const last = this.seenSeq.get(this.sessionId) ?? -1
    if (event.seq <= last) return
    if (event.seq > last + 1) {
      this.renderer.debug(`检测到事件缺口：${last} → ${event.seq}`)
      await this.syncHistory()
      if (event.seq <= (this.seenSeq.get(this.sessionId) ?? -1)) return
    }
    await this.processEvent(event, view, { history: false, render: true })
  }

  async syncHistory() {
    if (!this.sessionId) return
    const sessionId = this.sessionId
    const afterSeq = this.seenSeq.get(sessionId) ?? -1
    const pages = []
    let beforeSeq
    for (let page = 0; page < 20; page += 1) {
      const value = await this.client.call('session.history', {
        sessionId,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        maxMessages: 50,
      })
      if (page === 0) this.projections = { ...(value.projections?.values ?? {}) }
      const entries = [...value.events].sort((a, b) => a.event.seq - b.event.seq)
      pages.unshift(entries)
      const earliest = entries[0]?.event.seq
      if (earliest === undefined || earliest <= afterSeq + 1 || !value.hasMore) break
      beforeSeq = earliest
    }
    const entries = pages.flat().sort((a, b) => a.event.seq - b.event.seq)
    for (const entry of entries) {
      if (sessionId !== this.sessionId) return
      if (entry.event.seq > (this.seenSeq.get(sessionId) ?? -1)) {
        await this.processEvent(entry.event, entry.view, { history: false, render: true })
      }
    }
  }

  async processEvent(event, view, { history, render }) {
    if (!this.sessionId) return
    const sessionId = this.sessionId
    const last = this.seenSeq.get(sessionId) ?? -1
    if (event.seq <= last) return
    this.seenSeq.set(sessionId, event.seq)
    const data = event.data ?? {}

    switch (event.type) {
      case 'turn/start':
        this.running = true
        if (this.activeTurn) this.activeTurn.turn = data.turn
        if (render && !history) this.renderer.activityUpdate('模型正在思考')
        break
      case 'turn/end': {
        this.running = false
        const active = this.activeTurn
        const usage = active ? aggregateStepUsage(active.stepUsage) : undefined
        if (render && !history) {
          this.renderer.turnEnd(data.reason, {
            elapsedMs: active ? Date.now() - active.startedAt : undefined,
            usage,
          })
        }
        if (active && (active.turn === undefined || active.turn === data.turn)) {
          active.deferred.resolve({ kind: 'turn', reason: data.reason, usage })
          if (this.activeTurn === active) this.activeTurn = undefined
        }
        break
      }
      case 'step/start':
        if (render && !history) {
          this.renderer.resetStepPresentation()
          this.renderer.activityUpdate('模型正在思考')
        }
        break
      case 'assistant/chunk':
        if (history || !render) break
        this.handleChunk(data, stepKey(data.turn, data.step))
        break
      case 'assistant/message': {
        const key = stepKey(data.turn, data.step)
        const text = extractTextBlocks(data.message?.content)
        if (this.activeTurn && data.usage) this.activeTurn.stepUsage.set(key, data.usage)
        if (render) {
          if (history) this.renderer.assistant(text, { history: true })
          else if (this.streamedSteps.has(key)) this.renderer.finishAssistantStream()
          else this.renderer.assistant(text)
        }
        break
      }
      case 'user/message': {
        if (!render) break
        const source = data.source
        if (history && source?.kind === 'user') this.renderer.user(extractTextBlocks(data.content))
        else if (!history && source?.kind === 'plugin' && source.form === 'notice') this.renderer.contextNotice(source.summary)
        break
      }
      case 'tool/call':
        if (render) this.renderer.toolCall(data.callId, data.name, data.arguments, view)
        break
      case 'tool/result': {
        const text = extractTextBlocks(data.message?.content)
        const resultBlock = data.message?.content?.find?.(block => block?.type === 'tool-result')
        const error = data.error ?? (resultBlock?.isError ? { message: '工具返回了错误结果' } : undefined)
        if (render) this.renderer.toolResult(data.message?.source?.callId ?? data.callId, {
          text,
          error,
          view,
        })
        break
      }
      case 'todo/write':
        if (render) this.renderer.todos(data.todos)
        break
      case 'request/header': {
        const config = data.header?.config
        if (config && typeof config.provider === 'string' && typeof config.model === 'string') {
          this.model = {
            provider: config.provider,
            model: config.model,
            ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
          }
        }
        break
      }
      default:
        break
    }
  }

  handleChunk(data, key) {
    const chunk = data.chunk
    if (!chunk || typeof chunk.type !== 'string') return
    switch (chunk.type) {
      case 'text-delta':
        if (chunk.text) {
          this.streamedSteps.add(key)
          this.renderer.assistantDelta(chunk.text)
        }
        break
      case 'reasoning-delta':
        if (chunk.text) this.renderer.reasoningPulse()
        break
      case 'usage':
        if (this.activeTurn) this.activeTurn.stepUsage.set(key, chunk.usage)
        break
      default:
        break
    }
  }

  enqueueInteraction(rpcId, task) {
    if (this.answeredInteractionIds.has(rpcId) || this.pendingInteractionIds.has(rpcId)) return
    this.pendingInteractionIds.add(rpcId)
    const run = async () => {
      try {
        await task()
      } finally {
        this.pendingInteractionIds.delete(rpcId)
      }
    }
    this.interactionChain = this.interactionChain.then(run, run).catch(error => this.handleAsyncError(error))
  }

  async handleApproval(rpcId, frame) {
    let outcome
    if (this.approvalPolicy === 'allow') outcome = 'allowed-once'
    else if (this.approvalPolicy === 'deny') outcome = 'rejected'
    else {
      this.renderer.approvalRequest(frame)
      try {
        const allowed = await this.input.confirm('允许这次操作吗？', { defaultValue: false, context: 'approval' })
        outcome = allowed ? 'allowed-once' : 'rejected'
      } catch (error) {
        if (error instanceof InputInterrupted) outcome = 'rejected'
        else throw error
      }
    }
    const receipt = await this.respondInteraction(rpcId, () => this.client.respond(rpcId, {
      sessionId: frame.sessionId,
      approvalId: frame.approvalId,
      outcome,
    }))
    if (!receipt.accepted) this.renderer.warning(`审批响应未被接受：${receipt.reason}`)
    else this.renderer.notice(outcome === 'allowed-once' ? '已允许一次' : '已拒绝')
  }

  async handleQuestion(rpcId, frame) {
    const answers = []
    try {
      for (let index = 0; index < frame.questions.length; index += 1) {
        const question = frame.questions[index]
        this.renderer.question(question, index, frame.questions.length)
        answers.push(await this.answerQuestion(question))
      }
    } catch (error) {
      if (error instanceof InputInterrupted) {
        const receipt = await this.respondInteraction(rpcId, () => this.client.respondError(rpcId, {
          code: 'cancelled',
          message: 'question cancelled by user',
          details: {},
        }))
        if (!receipt.accepted) this.renderer.warning(`取消问题未被接受：${receipt.reason}`)
        else this.renderer.notice('已取消回答')
        return
      }
      throw error
    }
    const receipt = await this.respondInteraction(rpcId, () => this.client.respond(rpcId, {
      sessionId: frame.sessionId,
      answer: { answers },
    }))
    if (!receipt.accepted) this.renderer.warning(`问题响应未被接受：${receipt.reason}`)
  }

  async respondInteraction(rpcId, operation) {
    this.rememberInteraction(rpcId)
    try {
      return await operation()
    } catch (error) {
      // A transport failure means the host may still replay this stable rpcId.
      this.answeredInteractionIds.delete(rpcId)
      throw error
    }
  }

  rememberInteraction(rpcId) {
    this.answeredInteractionIds.add(rpcId)
    if (this.answeredInteractionIds.size <= 1000) return
    const oldest = this.answeredInteractionIds.values().next().value
    this.answeredInteractionIds.delete(oldest)
  }

  async answerQuestion(question) {
    const options = Array.isArray(question.options) ? question.options : []
    if (options.length === 0) {
      const custom = await this.input.question('回答 › ', { context: 'question', trim: true })
      return { id: question.id, selected: [], custom }
    }
    if (question.multiSelect) {
      while (true) {
        const answer = await this.input.question('选择多个编号（逗号分隔），或输入自定义回答 › ', { context: 'question', trim: true })
        const parsed = parseMultiChoice(answer, options)
        if (parsed) return { id: question.id, ...parsed }
        this.renderer.warning(`请输入 1-${options.length} 的编号，多个编号用逗号分隔`)
      }
    }
    const answer = await this.input.question('选择编号，或输入自定义回答 › ', { context: 'question', trim: true })
    const number = Number(answer)
    if (Number.isInteger(number) && number >= 1 && number <= options.length) {
      return { id: question.id, selected: [options[number - 1].label] }
    }
    return { id: question.id, selected: [], custom: answer }
  }

  rejectActive(error) {
    const active = this.activeTurn
    if (!active) return
    active.deferred.reject(error)
    if (this.activeTurn === active) this.activeTurn = undefined
    this.renderer.activityStop()
  }

  handleAsyncError(error) {
    this.renderer.error(error instanceof Error ? error.message : String(error))
    this.rejectActive(error instanceof Error ? error : new Error(String(error)))
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.client.off('mux', this.boundMux)
    this.client.off('host', this.boundHost)
    this.client.off('transport', this.boundTransport)
    this.client.off('stream-error', this.boundStreamError)
    this.rejectActive(new Error('CLI closed'))
    await Promise.allSettled([this.eventChain, this.interactionChain])
  }
}

function currentTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

/** One-line summary of the goal projection for /status, if a goal is set. */
function goalSummary(goal) {
  if (goal === null || typeof goal !== 'object') return undefined
  const text = goal.objective ?? goal.title ?? goal.text
  if (typeof text !== 'string' || text.trim() === '') return undefined
  const status = typeof goal.status === 'string' && goal.status !== '' ? `（${goal.status}）` : ''
  return `${truncate(text, 40)}${status}`
}

function stepKey(turn, step) {
  return `${String(turn)}:${String(step)}`
}

function aggregateStepUsage(stepUsage) {
  let result = {}
  for (const usage of stepUsage.values()) result = mergeUsage(result, usage)
  return result
}

function parseMultiChoice(answer, options) {
  if (answer === '') return { selected: [] }
  const parts = answer.split(/[,，\s]+/).filter(Boolean)
  if (parts.every(part => /^\d+$/.test(part))) {
    const indexes = [...new Set(parts.map(part => Number(part) - 1))]
    if (indexes.every(index => index >= 0 && index < options.length)) {
      return { selected: indexes.map(index => options[index].label) }
    }
    return undefined
  }
  return { selected: [], custom: truncate(answer, 4000) }
}

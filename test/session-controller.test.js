import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { Renderer } from '../src/renderer.js'
import { SessionController } from '../src/session-controller.js'
import { InputInterrupted } from '../src/input.js'

class Capture extends Writable {
  constructor() {
    super()
    this.text = ''
    this.isTTY = false
    this.columns = 100
  }

  _write(chunk, _encoding, callback) {
    this.text += chunk.toString()
    callback()
  }
}

class FakeClient extends EventEmitter {
  constructor() {
    super()
    this.baseUrl = new URL('http://127.0.0.1:3080')
    this.calls = []
    this.responses = []
    this.errorResponses = []
  }

  async call(method, payload) {
    this.calls.push({ method, payload })
    switch (method) {
      case 'host.describe':
        return { version: '0.1.0-rc.5', cwd: '/workspace', attachedSessions: 0, canOpenPath: false }
      case 'session.create':
        return { sessionId: 's1', agentPreset: 'coding' }
      case 'session.history':
        return {
          events: [],
          hasMore: false,
          projections: {
            asOfSeq: 3,
            values: {
              permissions: {
                options: [{ value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'workspace-write' }],
                currentValue: 'workspace-write',
              },
              tokenUsage: { uncachedInputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 0 },
            },
          },
        }
      case 'session.models':
        return {
          current: { provider: 'deepseek', model: 'deepseek-chat' },
          routable: true,
          groups: [{
            id: 'deepseek',
            name: 'DeepSeek',
            models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
          }],
          failures: [],
        }
      case 'session.prompt':
        setImmediate(() => this.emitTurn())
        return { accepted: true }
      case 'session.cancel':
        return { accepted: true }
      case 'commands/list':
        return [{ name: 'plan', description: 'Enter or leave plan mode' }]
      case 'commands/execute':
        return { commandId: 'cmd-1', result: { kind: 'success', text: 'preset read-only' } }
      case 'agentPreset.list':
        return { presets: [{ id: 'coding', trust: 'user', isDefault: true }], authorable: true, hasDocument: true }
      case 'agentPreset.select':
        return {}
      default:
        throw new Error(`unexpected call ${method}`)
    }
  }

  async respond(rpcId, value) {
    this.responses.push({ rpcId, value })
    return { accepted: true }
  }

  async respondError(rpcId, error) {
    this.errorResponses.push({ rpcId, error })
    return { accepted: true }
  }

  emitTurn() {
    this.emit('host', { frame: { type: 'host/session-status', sessionId: 's1', running: true } })
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'assistant/chunk', seq: 1, time: 2,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'world' } },
      },
      {
        type: 'assistant/message', seq: 2, time: 3,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'm1', role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
            content: [{ type: 'text', text: 'world' }],
          },
          usage: { inputTokens: 5, outputTokens: 1 },
        },
      },
      { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    for (const event of events) {
      this.emit('mux', {
        rpcId: `event-${event.seq}`,
        frame: { type: 'session/event', sessionId: 's1', event },
      })
    }
    this.emit('host', { frame: { type: 'host/session-status', sessionId: 's1', running: false } })
  }
}

async function createController(input = { confirm: async () => true, question: async () => 'answer' }) {
  const client = new FakeClient()
  const output = new Capture()
  const renderer = new Renderer({ output, errorOutput: output })
  const controller = new SessionController({ client, renderer, input })
  await controller.initialize({ cwd: '/workspace' })
  return { client, output, renderer, controller }
}

test('session controller streams one assistant answer and settles on turn/end', async t => {
  const context = await createController()
  t.after(() => context.controller.close())
  const result = await context.controller.send('go')
  assert.equal(result.reason.kind, 'completed')
  assert.equal(result.usage.inputTokens, 5)
  assert.equal(result.usage.outputTokens, 1)
  assert.equal((context.output.text.match(/world/g) ?? []).length, 1, 'final message must not duplicate streamed text')
  assert.match(context.output.text, /6 tokens/)
})

test('replayed approvals with the same rpcId are answered only once', async t => {
  let confirms = 0
  const context = await createController({
    confirm: async () => { confirms += 1; return true },
    question: async () => 'answer',
  })
  t.after(() => context.controller.close())
  const envelope = {
    rpcId: 'approval-1',
    frame: {
      type: 'approval/requested',
      sessionId: 's1',
      approvalId: 'a1',
      toolName: 'bash',
      reason: 'run tests',
    },
  }
  context.client.emit('mux', envelope)
  context.client.emit('mux', envelope)
  await context.controller.interactionChain
  assert.equal(confirms, 1)
  assert.equal(context.client.responses.length, 1)
  assert.equal(context.client.responses[0].value.outcome, 'allowed-once')
})

test('Ctrl+C during a Harness question returns a cancelled RPC result', async t => {
  const context = await createController({
    confirm: async () => true,
    question: async () => { throw new InputInterrupted('question') },
  })
  t.after(() => context.controller.close())
  context.client.emit('mux', {
    rpcId: 'question-1',
    frame: {
      type: 'question/requested',
      sessionId: 's1',
      questions: [{ id: 'q1', question: 'Continue?' }],
    },
  })
  await context.controller.interactionChain
  assert.equal(context.client.errorResponses.length, 1)
  assert.equal(context.client.errorResponses[0].error.code, 'cancelled')
})

test('controller keeps projections from history and live projection frames', async t => {
  const context = await createController()
  t.after(() => context.controller.close())
  assert.equal(context.controller.permissionView()?.currentValue, 'workspace-write')
  assert.equal(context.controller.usageView().tokenUsage?.outputTokens, 4)
  context.client.emit('mux', {
    rpcId: 'projection-1',
    frame: {
      type: 'session/projection',
      sessionId: 's1',
      key: 'permissions',
      value: { options: [], currentValue: 'read-only' },
      seq: 9,
    },
  })
  assert.equal(context.controller.permissionView()?.currentValue, 'read-only')
  assert.equal(context.controller.statusInfo().permission, 'read-only')
})

test('executeHostCommand posts agentId and line to commands/execute', async t => {
  const context = await createController()
  t.after(() => context.controller.close())
  const result = await context.controller.executeHostCommand('/permission read-only')
  assert.equal(result.kind, 'success')
  const call = context.client.calls.find(item => item.method === 'commands/execute')
  assert.deepEqual(call.payload, { args: { agentId: 's1', line: '/permission read-only' } })
})

test('selectAgentPreset switches preset and refreshes host commands', async t => {
  const context = await createController()
  t.after(() => context.controller.close())
  await context.controller.selectAgentPreset('coding')
  assert.equal(context.controller.agentPreset, 'coding')
  const select = context.client.calls.find(item => item.method === 'agentPreset.select')
  assert.deepEqual(select.payload, { sessionId: 's1', agentPreset: 'coding' })
  assert.ok(context.controller.hostCommands.some(command => command.name === 'plan'))
})

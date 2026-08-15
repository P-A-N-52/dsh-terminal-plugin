import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      case 'session.search':
        return { items: [{ sessionId: 's1', snippet: '…命中…' }], hasMore: false }
      case 'workspace.list':
        return { items: [] }
      case 'skill.list':
        return { skills: [{ name: 'code-style', description: '代码风格', modelInvocable: true }] }
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

test('plan projection changes surface a live notice and reach statusInfo', async t => {
  const context = await createController()
  t.after(() => context.controller.close())
  context.client.emit('mux', {
    rpcId: 'projection-plan',
    frame: {
      type: 'session/projection',
      sessionId: 's1',
      key: 'plan',
      value: { active: true, pending: false },
      seq: 10,
    },
  })
  assert.match(context.output.text, /已进入计划模式/)
  assert.equal(context.controller.statusInfo().planActive, true)
  context.client.emit('mux', {
    rpcId: 'projection-plan-off',
    frame: {
      type: 'session/projection',
      sessionId: 's1',
      key: 'plan',
      value: { active: false, pending: false },
      seq: 11,
    },
  })
  assert.match(context.output.text, /已退出计划模式/)
})

test('send while a turn runs injects a steering message instead of rejecting', async t => {
  const context = await createController()
  t.after(() => context.controller.close())
  context.controller.running = true
  const result = await context.controller.send('换个方向')
  assert.equal(result.kind, 'steer')
  const prompt = context.client.calls.find(item => item.method === 'session.prompt')
  assert.equal(prompt.payload.mode, 'steer')
  assert.equal(context.controller.activeTurn, undefined, 'steer must not hijack the in-flight turn')
})

test('session/jobs frames mirror jobs and summarize settled tasks', async t => {
  const context = await createController()
  t.after(() => context.controller.close())
  context.client.emit('mux', {
    rpcId: 'jobs-1',
    frame: {
      type: 'session/jobs',
      sessionId: 's1',
      jobs: [{ id: 'job1', kind: 'bash', label: 'npm test', status: 'running', startedAt: 1000 }],
    },
  })
  assert.equal(context.controller.jobs.length, 1)
  context.client.emit('mux', {
    rpcId: 'jobs-2',
    frame: {
      type: 'session/jobs',
      sessionId: 's1',
      jobs: [{ id: 'job1', kind: 'bash', label: 'npm test', status: 'completed', startedAt: 1000, endedAt: 60000 }],
    },
  })
  assert.match(context.output.text, /后台任务结束：npm test（59s）/)
})

test('commands/change refreshes the host command cache', async t => {
  const context = await createController()
  t.after(() => context.controller.close())
  const before = context.client.calls.filter(item => item.method === 'commands/list').length
  context.client.emit('host', {
    frame: { type: 'host/remote-event', sessionId: 's1', event: 'commands/change', args: [] },
  })
  await new Promise(resolve => setImmediate(resolve))
  const after = context.client.calls.filter(item => item.method === 'commands/list').length
  assert.ok(after > before, 'commands/change re-pulls commands/list')
})

test('exportSession downloads the zip and writes it to the session cwd', async t => {
  const context = await createController()
  t.after(() => context.controller.close())
  const dir = await mkdtemp(join(tmpdir(), 'dsh-export-'))
  context.controller.cwd = dir
  context.client.downloadSessionZip = async sessionId => {
    assert.equal(sessionId, 's1')
    return Buffer.from('PK\x03\x04fake')
  }
  const { path, bytes } = await context.controller.exportSession()
  const written = await readFile(path)
  assert.equal(bytes, written.length)
  assert.ok(path.startsWith(dir))
  assert.match(path, /dsh-session-.*\.zip$/)
})

test('skill.list feeds the controller skill cache', async t => {
  const context = await createController()
  t.after(() => context.controller.close())
  assert.deepEqual(context.controller.skills.map(skill => skill.name), ['code-style'])
})

test('approval request shows the paired tool call command', async t => {
  const context = await createController({
    confirm: async () => true,
    question: async () => 'answer',
  })
  t.after(() => context.controller.close())
  context.client.emit('mux', {
    rpcId: 'ev-call',
    frame: {
      type: 'session/event',
      sessionId: 's1',
      event: {
        type: 'tool/call', seq: 5, time: 5,
        data: { turn: 1, step: 1, callId: 'call1', name: 'bash', arguments: '{"command":"rm -rf /tmp/x"}' },
      },
    },
  })
  await context.controller.eventChain
  context.client.emit('mux', {
    rpcId: 'approval-c1',
    frame: { type: 'approval/requested', sessionId: 's1', approvalId: 'a1', toolName: 'bash', callId: 'call1', reason: 'run' },
  })
  await context.controller.interactionChain
  assert.match(context.output.text, /rm -rf \/tmp\/x/)
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

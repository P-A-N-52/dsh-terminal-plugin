import test from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { Renderer } from '../src/renderer.js'

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

function createRenderer() {
  const output = new Capture()
  return { output, renderer: new Renderer({ output, errorOutput: output }) }
}

test('session list shows the uuid prefix instead of a bare session-', () => {
  const { output, renderer } = createRenderer()
  renderer.sessionList([{
    sessionId: 'session-91e495b8-797d-4fcf-9348-550ed7e397a8',
    title: 'demo',
    running: false,
    blank: false,
    cwd: '/tmp',
  }])
  assert.match(output.text, /91e495b8/)
  assert.doesNotMatch(output.text, /session-91e/)
})

test('banner carries preset and permission rows', () => {
  const { output, renderer } = createRenderer()
  renderer.banner({
    sessionId: 'session-91e495b8-797d-4fcf-9348-550ed7e397a8',
    cwd: '/tmp',
    model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' },
    approvalPolicy: 'ask',
    agentPreset: 'standard',
    permission: 'workspace-write',
  })
  assert.match(output.text, /预设 standard/)
  assert.match(output.text, /权限 workspace-write/)
  assert.match(output.text, /91e495b8/)
})

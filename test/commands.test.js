import test from 'node:test'
import assert from 'node:assert/strict'
import { CommandRouter } from '../src/commands.js'

test('unknown slash commands pass through to Harness', async () => {
  const router = new CommandRouter({ controller: {}, renderer: {}, input: {} })
  assert.deepEqual(await router.handle('/plan on'), { handled: false })
})

test('local approval command changes only the CLI policy', async () => {
  let policy
  const router = new CommandRouter({
    controller: { setApprovalPolicy(value) { policy = value } },
    renderer: {},
    input: {},
  })
  assert.deepEqual(await router.handle('/approval deny'), { handled: true })
  assert.equal(policy, 'deny')
})

test('quoted rename titles are preserved', async () => {
  let title
  const router = new CommandRouter({
    controller: { async rename(value) { title = value } },
    renderer: {},
    input: {},
  })
  await router.handle('/rename "terminal experiment"')
  assert.equal(title, 'terminal experiment')
})

test('bare slash shows help instead of reaching Harness', async () => {
  let helped = 0
  const router = new CommandRouter({ controller: {}, renderer: { help() { helped += 1 } }, input: {} })
  assert.deepEqual(await router.handle('/'), { handled: true })
  assert.equal(helped, 1)
})

test('permission command switches preset through the host registry', async () => {
  const executed = []
  const router = new CommandRouter({
    controller: {
      permissionView: () => ({
        options: [{ value: 'read-only' }, { value: 'workspace-write' }],
        currentValue: 'workspace-write',
      }),
      async executeHostCommand(line) { executed.push(line); return { kind: 'success' } },
    },
    renderer: { success() {}, notice() {} },
    input: {},
  })
  assert.deepEqual(await router.handle('/permission read-only'), { handled: true })
  assert.deepEqual(executed, ['/permission read-only'])
})

test('permission command rejects unknown preset names', async () => {
  const router = new CommandRouter({
    controller: { permissionView: () => ({ options: [{ value: 'read-only' }], currentValue: 'read-only' }) },
    renderer: {},
    input: {},
  })
  await assert.rejects(() => router.handle('/permission nope'), /未知权限预设/)
})

test('preset command on a locked session offers a new session on that preset', async () => {
  const created = []
  const lockedController = {
    agentPreset: 'standard',
    cwd: '/workspace',
    async listAgentPresets() { return { presets: [{ id: 'standard' }, { id: 'code', name: 'PTC 模式' }], authorable: true } },
    async selectAgentPreset() {
      const error = new Error('preset locked')
      error.code = 'agent-preset-locked'
      throw error
    },
    async newSession(cwd, options) { created.push({ cwd, options }) },
  }
  const router = new CommandRouter({
    controller: lockedController,
    renderer: {},
    input: { confirm: async () => true },
  })
  assert.deepEqual(await router.handle('/preset code'), { handled: true })
  assert.deepEqual(created, [{ cwd: '/workspace', options: { agentPreset: 'code' } }])
})

test('declining the new-session offer keeps the current session', async () => {
  let created = 0
  const router = new CommandRouter({
    controller: {
      agentPreset: 'standard',
      cwd: '/workspace',
      async listAgentPresets() { return { presets: [{ id: 'standard' }, { id: 'code' }], authorable: true } },
      async selectAgentPreset() {
        const error = new Error('preset locked')
        error.code = 'agent-preset-locked'
        throw error
      },
      async newSession() { created += 1 },
    },
    renderer: {},
    input: { confirm: async () => false },
  })
  assert.deepEqual(await router.handle('/preset code'), { handled: true })
  assert.equal(created, 0)
})

test('host commands route through the registry instead of the model', async () => {
  const executed = []
  const router = new CommandRouter({
    controller: {
      hostCommands: [{ name: 'plan' }],
      async executeHostCommand(line) {
        executed.push(line)
        return { kind: 'success', text: 'Plan mode on. Use /plan off to leave.' }
      },
    },
    renderer: { notice() {} },
    input: {},
  })
  assert.deepEqual(await router.handle('/plan'), { handled: true })
  assert.deepEqual(executed, ['/plan'])
})

test('slash input outside both registries still falls through to the model', async () => {
  const router = new CommandRouter({
    controller: { hostCommands: [{ name: 'plan' }] },
    renderer: {},
    input: {},
  })
  assert.deepEqual(await router.handle('/skill:code-style'), { handled: false })
})

test('search requires a keyword', async () => {
  const router = new CommandRouter({ controller: {}, renderer: {}, input: {} })
  await assert.rejects(() => router.handle('/search'), /用法/)
})

test('search lists hits and resumes the picked session', async () => {
  const resumed = []
  const router = new CommandRouter({
    controller: {
      async searchSessions(query) {
        assert.equal(query, '修复 测试')
        return { items: [{ sessionId: 'session-a', title: '修复', snippet: '…修复…' }], hasMore: false }
      },
      async switchSession(sessionId, options) { resumed.push([sessionId, options]) },
    },
    renderer: { searchList() {} },
    input: { choose: async () => 0 },
  })
  assert.deepEqual(await router.handle('/search "修复 测试"'), { handled: true })
  assert.deepEqual(resumed, [['session-a', { showHistory: true }]])
})

test('skill invocation sends the slash literal as a prompt', async () => {
  const sent = []
  const router = new CommandRouter({
    controller: {
      skills: [{ name: 'code-style', description: 'x' }],
      async send(text) { sent.push(text) },
    },
    renderer: {},
    input: {},
  })
  assert.deepEqual(await router.handle('/skill code-style 检查 src'), { handled: true })
  assert.deepEqual(sent, ['/code-style 检查 src'])
})

test('skill rejects unknown names with the available list', async () => {
  const router = new CommandRouter({
    controller: { skills: [{ name: 'code-style' }] },
    renderer: {},
    input: {},
  })
  await assert.rejects(() => router.handle('/skill nope'), /未知技能/)
})

test('new without arguments offers the workspace picker', async () => {
  const created = []
  const router = new CommandRouter({
    controller: {
      cwd: '/current',
      async listWorkspaces() { return [{ path: '/ws/one', title: 'one' }, { path: '/ws/two' }] },
      async newSession(cwd) { created.push(cwd) },
    },
    renderer: { workspaceList() {} },
    input: { choose: async () => 1 },
  })
  assert.deepEqual(await router.handle('/new'), { handled: true })
  assert.deepEqual(created, ['/ws/two'])
})

test('new with a path skips the picker', async () => {
  const created = []
  const router = new CommandRouter({
    controller: { async newSession(cwd) { created.push(cwd) } },
    renderer: {},
    input: {},
  })
  await router.handle('/new /tmp/demo')
  assert.deepEqual(created, ['/tmp/demo'])
})

test('usage command renders the projections view', async () => {
  const view = { tokenUsage: { outputTokens: 3 } }
  let rendered
  const router = new CommandRouter({
    controller: { usageView: () => view },
    renderer: { usage(value) { rendered = value } },
    input: {},
  })
  assert.deepEqual(await router.handle('/usage'), { handled: true })
  assert.equal(rendered, view)
})

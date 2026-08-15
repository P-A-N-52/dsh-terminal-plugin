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

test('preset command maps agent-preset-locked to a /new hint', async () => {
  const router = new CommandRouter({
    controller: {
      agentPreset: 'standard',
      async listAgentPresets() { return { presets: [{ id: 'standard' }, { id: 'code' }], authorable: true } },
      async selectAgentPreset() {
        const error = new Error('preset locked')
        error.code = 'agent-preset-locked'
        throw error
      },
    },
    renderer: {},
    input: {},
  })
  await assert.rejects(() => router.handle('/preset code'), /\/new/)
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

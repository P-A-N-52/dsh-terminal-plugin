import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { TerminalInput, InputInterrupted, InputClosed } from '../src/input.js'

function createInput(options = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  const terminal = new TerminalInput({ input, output, exitWindowMs: 60, ...options })
  return { input, output, terminal }
}

test('first composer Ctrl+C interrupts without requesting exit', async () => {
  const { terminal } = createInput()
  let exits = 0
  terminal.onExit(() => { exits += 1 })
  const interrupted = terminal.question('› ', { context: 'composer' }).catch(error => error)
  terminal.rl.emit('SIGINT')
  const error = await interrupted
  assert.ok(error instanceof InputInterrupted)
  assert.equal(exits, 0)
  assert.equal(terminal.exitArmed, true)
  terminal.close()
})

test('second composer Ctrl+C within the window requests exit', async () => {
  const { terminal } = createInput()
  let exits = 0
  terminal.onExit(() => { exits += 1 })
  const first = terminal.question('› ', { context: 'composer' }).catch(error => error)
  terminal.rl.emit('SIGINT')
  await first
  const second = terminal.question('› ', { context: 'composer' }).catch(error => error)
  terminal.rl.emit('SIGINT')
  assert.equal(exits, 1)
  assert.equal(terminal.exitArmed, false)
  terminal.close()
  assert.ok(await second instanceof InputClosed)
})

test('typing after the first Ctrl+C disarms the exit request', async () => {
  const { input, terminal } = createInput()
  let exits = 0
  terminal.onExit(() => { exits += 1 })
  const interrupted = terminal.question('› ', { context: 'composer' }).catch(error => error)
  terminal.rl.emit('SIGINT')
  await interrupted
  assert.equal(terminal.exitArmed, true)
  input.emit('keypress', 'a', { name: 'a', ctrl: false })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(terminal.exitArmed, false)
  terminal.rl.emit('SIGINT')
  assert.equal(exits, 0)
  terminal.close()
})

test('the exit window expires on its own', async () => {
  const { terminal } = createInput()
  const interrupted = terminal.question('› ', { context: 'composer' }).catch(error => error)
  terminal.rl.emit('SIGINT')
  await interrupted
  assert.equal(terminal.exitArmed, true)
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.equal(terminal.exitArmed, false)
  terminal.close()
})

test('Ctrl+C outside the composer never arms the exit', async () => {
  const { terminal } = createInput()
  const interrupted = terminal.question('允许？', { context: 'approval' }).catch(error => error)
  terminal.rl.emit('SIGINT')
  const error = await interrupted
  assert.ok(error instanceof InputInterrupted)
  assert.equal(terminal.exitArmed, false)
  terminal.close()
})

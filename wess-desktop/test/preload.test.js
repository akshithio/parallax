const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('renderer subscriptions remove their underlying IPC listeners', async () => {
  const listeners = new Map()
  const sent = []
  const invoked = []
  let exposed = null

  const ipcRenderer = {
    on(channel, listener) {
      const handlers = listeners.get(channel) || new Set()
      handlers.add(listener)
      listeners.set(channel, handlers)
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener)
    },
    invoke(channel, payload) {
      invoked.push({ channel, payload })
      return Promise.resolve({ ok: true })
    },
    send(channel, payload) {
      sent.push({ channel, payload })
    },
  }
  const contextBridge = {
    exposeInMainWorld(name, api) {
      exposed = { name, api }
    },
  }
  const context = vm.createContext({
    require(name) {
      assert.equal(name, 'electron')
      return { contextBridge, ipcRenderer }
    },
  })

  const file = path.join(__dirname, '..', 'preload.js')
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file })

  assert.equal(exposed.name, 'wess')
  const received = []
  const unsubscribe = exposed.api.onResponse((data) => received.push(data))
  assert.equal(listeners.get('response').size, 1)

  for (const listener of listeners.get('response')) {
    listener({}, { text: 'one response' })
  }
  assert.deepEqual(received, [{ text: 'one response' }])

  const replacement = []
  const unsubscribeReplacement = exposed.api.onResponse((data) => replacement.push(data))
  assert.equal(listeners.get('response').size, 1, 'a remount replaces the previous subscriber')

  for (const listener of listeners.get('response')) {
    listener({}, { text: 'replacement response' })
  }
  assert.deepEqual(received, [{ text: 'one response' }])
  assert.deepEqual(replacement, [{ text: 'replacement response' }])

  unsubscribe()
  assert.equal(
    listeners.get('response').size,
    1,
    'an obsolete cleanup cannot remove the current subscriber',
  )
  unsubscribeReplacement()
  assert.equal(listeners.get('response').size, 0)

  const edit = {
    convId: 'thread-a',
    msgId: 'edited-message',
    text: 'Updated text',
    userIndex: 0,
  }
  exposed.api.editMessage(edit)
  assert.deepEqual(sent.at(-1), { channel: 'edit-message', payload: edit })

  await exposed.api.getUpdateStatus()
  await exposed.api.checkForUpdates()
  exposed.api.installUpdate()
  assert.deepEqual(invoked.slice(-2), [
    { channel: 'app-update-status', payload: undefined },
    { channel: 'app-update-check', payload: undefined },
  ])
  assert.deepEqual(sent.at(-1), { channel: 'app-update-install', payload: undefined })

  const statuses = []
  const unsubscribeStatus = exposed.api.onUpdateStatus((status) => statuses.push(status))
  for (const listener of listeners.get('app-update-status')) {
    listener({}, { status: 'downloaded' })
  }
  assert.deepEqual(statuses, [{ status: 'downloaded' }])
  unsubscribeStatus()
  assert.equal(listeners.get('app-update-status').size, 0)
})

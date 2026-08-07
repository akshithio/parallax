const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function loadContent() {
  let messageListener = null
  let nextTimerId = 1
  const sent = []
  const pageMessages = []
  const timeouts = new Map()
  const intervals = new Map()
  const observers = []
  let queryElement = null

  const port = {
    onMessage: {
      addListener(listener) {
        messageListener = listener
      },
    },
    onDisconnect: { addListener() {} },
    postMessage(message) {
      sent.push(message)
    },
    disconnect() {},
  }

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback
      this.observing = false
      this.disconnected = false
      observers.push(this)
    }

    observe() {
      this.observing = true
    }

    disconnect() {
      this.disconnected = true
    }
  }

  class FakeTextArea {
    constructor(value = '') {
      this.tagName = 'TEXTAREA'
      this.value = value
      this.events = []
    }

    focus() {}

    dispatchEvent(event) {
      this.events.push(event.type)
      return true
    }
  }

  const document = {
    readyState: 'complete',
    body: {},
    addEventListener() {},
    querySelector() {
      return queryElement
    },
    querySelectorAll() {
      return []
    },
  }
  const window = {
    location: { href: 'https://chatgpt.com/c/personal-chat' },
    HTMLTextAreaElement: FakeTextArea,
    HTMLInputElement: FakeTextArea,
    addEventListener() {},
    postMessage(message) {
      pageMessages.push(message)
    },
  }
  const chrome = {
    runtime: {
      id: 'extension-id',
      lastError: null,
      connect() {
        return port
      },
    },
  }

  const context = vm.createContext({
    chrome,
    document,
    window,
    location: window.location,
    MutationObserver: FakeMutationObserver,
    Event: class {
      constructor(type) {
        this.type = type
      }
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout(callback, delay) {
      const id = nextTimerId++
      timeouts.set(id, { callback, delay, cleared: false })
      return id
    },
    clearTimeout(id) {
      const timer = timeouts.get(id)
      if (timer) timer.cleared = true
    },
    setInterval(callback, delay) {
      const id = nextTimerId++
      intervals.set(id, { callback, delay, cleared: false })
      return id
    },
    clearInterval(id) {
      const timer = intervals.get(id)
      if (timer) timer.cleared = true
    },
  })

  const file = path.join(__dirname, '..', 'src', 'content.js')
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file })

  return {
    sent,
    pageMessages,
    timeouts,
    intervals,
    observers,
    helpers: {
      submissionAccepted: context.submissionAccepted,
      clearComposerIfMatches: context.clearComposerIfMatches,
      isCompleteNixResponse: context.isCompleteNixResponse,
    },
    FakeTextArea,
    setComposer(element) {
      queryElement = element
    },
    receive(message) {
      assert.ok(messageListener, 'content port listener was registered')
      messageListener(message)
    },
  }
}

function activeDelays(timers) {
  return [...timers.values()]
    .filter((timer) => !timer.cleared)
    .map((timer) => timer.delay)
    .sort((a, b) => a - b)
}

test('ordinary ChatGPT tabs stay inert until the background confirms ownership', () => {
  const harness = loadContent()

  assert.equal(harness.sent[0].type, 'ready')
  assert.deepEqual(activeDelays(harness.timeouts), [])
  assert.deepEqual(activeDelays(harness.intervals), [])
  assert.equal(harness.observers.length, 0)
  assert.equal(harness.pageMessages.length, 0)

  harness.receive({ type: 'standby' })

  assert.deepEqual(activeDelays(harness.timeouts), [])
  assert.deepEqual(activeDelays(harness.intervals), [])
  assert.equal(harness.observers.length, 0)
  assert.equal(harness.pageMessages.length, 0)
})

test('page features start only for an owned tab and stop again on standby', () => {
  const harness = loadContent()

  harness.receive({ type: 'resume' })

  assert.deepEqual(activeDelays(harness.timeouts), [1200, 3000, 3500])
  assert.deepEqual(activeDelays(harness.intervals), [700])
  assert.equal(harness.observers.length, 1)
  assert.equal(harness.observers[0].observing, true)
  assert.equal(harness.pageMessages.length, 1)

  harness.receive({ type: 'standby' })

  assert.deepEqual(activeDelays(harness.timeouts), [])
  assert.deepEqual(activeDelays(harness.intervals), [])
  assert.equal(harness.observers[0].disconnected, true)
})

test('an owned page command recovers a lost resume message', () => {
  const harness = loadContent()

  harness.receive({ type: 'stop' })

  assert.deepEqual(activeDelays(harness.timeouts), [1200, 3000, 3500])
  assert.deepEqual(activeDelays(harness.intervals), [700])
  assert.equal(harness.observers.length, 1)
  assert.equal(harness.pageMessages.length, 1)
})

test('editing a message recovers ownership and arms the network stream before touching the page', () => {
  const harness = loadContent()

  harness.receive({
    type: 'edit_message',
    text: 'Updated prompt',
    originalText: 'Original prompt',
    userIndex: 0,
    msgId: 'edit-turn',
    expectUrl: 'https://chatgpt.com/c/personal-chat',
  })

  assert.equal(harness.observers.length, 1)
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.pageMessages.at(-1))),
    {
      __nix_arm: true,
      armed: true,
      turnId: 'edit-turn',
    },
  )
})

test('page bridge probes acknowledge even while the tab is in standby', () => {
  const harness = loadContent()

  harness.receive({ type: 'page_probe', probeId: 'probe-1' })

  assert.equal(harness.sent.at(-1).type, 'page_ready')
  assert.equal(harness.sent.at(-1).probeId, 'probe-1')
  assert.deepEqual(activeDelays(harness.timeouts), [])
  assert.deepEqual(activeDelays(harness.intervals), [])
})

test('submission is acknowledged only after its conversation request starts', () => {
  const harness = loadContent()

  assert.equal(harness.helpers.submissionAccepted(false), false)
  assert.equal(harness.helpers.submissionAccepted(true), true)
})

test('ordinary assistant responses still have no DOM fallback path', () => {
  const file = path.join(__dirname, '..', 'src', 'content.js')
  const source = fs.readFileSync(file, 'utf8')

  assert.doesNotMatch(source, /waitForResponse|response \(dom|DOM-scraping backstop/)
  assert.match(source, /source:\s*'network'/)
  assert.match(source, /waiting for network response/)
  assert.match(source, /case 'recover_turn'/)
})

test('page recovery accepts only complete Nix response envelopes', () => {
  const harness = loadContent()
  const complete = [
    '{nix:note}Inspecting data{/nix:note}',
    '{nix:run}find . -maxdepth 2 -type f -print{/nix:run}',
  ].join('\n')

  assert.equal(harness.helpers.isCompleteNixResponse(complete), true)
  assert.equal(
    harness.helpers.isCompleteNixResponse(
      '{nix:note}Inspecting data{/nix:note}\n{nix:run}find .',
    ),
    false,
  )
  assert.equal(harness.helpers.isCompleteNixResponse('ordinary rendered text'), false)
})

test('a rejected internal follow-up is removed without erasing a different draft', () => {
  const harness = loadContent()
  const internal = '{nix:result kind="run"}output{/nix:result}'
  const composer = new harness.FakeTextArea(internal)
  harness.setComposer(composer)

  harness.helpers.clearComposerIfMatches(composer, internal)
  assert.equal(composer.value, '')
  assert.deepEqual(composer.events, ['input'])

  composer.value = 'a user-authored draft'
  harness.helpers.clearComposerIfMatches(composer, internal)
  assert.equal(composer.value, 'a user-authored draft')
})

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function loadContent() {
  const protocolCore = require('../src/protocol-core')
  let messageListener = null
  let disconnectListener = null
  let runtimeValid = true
  let runtimeLastError = null
  let runtimeLastErrorReads = 0
  let nextTimerId = 1
  const sent = []
  const pageMessages = []
  const consoleWarnings = []
  const consoleErrors = []
  const timeouts = new Map()
  const intervals = new Map()
  const observers = []
  let queryElement = null
  let queryElementForSelector = null
  let queryElements = []
  let queryElementsForSelector = null

  const port = {
    onMessage: {
      addListener(listener) {
        messageListener = listener
      },
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListener = listener
      },
    },
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
    querySelector(selector) {
      return queryElementForSelector
        ? queryElementForSelector(selector)
        : queryElement
    },
    querySelectorAll(selector) {
      return queryElementsForSelector
        ? queryElementsForSelector(selector)
        : queryElements
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
      get id() {
        return runtimeValid ? 'extension-id' : undefined
      },
      get lastError() {
        runtimeLastErrorReads++
        return runtimeLastError
      },
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
    ParallaxProtocolCore: protocolCore,
    MutationObserver: FakeMutationObserver,
    Event: class {
      constructor(type) {
        this.type = type
      }
    },
    console: {
      log() {},
      warn(...args) { consoleWarnings.push(args) },
      error(...args) { consoleErrors.push(args) },
    },
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
    consoleWarnings,
    consoleErrors,
    timeouts,
    intervals,
    observers,
    helpers: {
      submissionAccepted: context.submissionAccepted,
      find: context.find,
      clearComposerIfMatches: context.clearComposerIfMatches,
      renderedUserPromptExists: context.renderedUserPromptExists,
      isCompleteParallaxResponse: context.isCompleteParallaxResponse,
      findProjectControl: context.findProjectControl,
      projectCreationRoot: context.projectCreationRoot,
      projectControlForName: context.projectControlForName,
      projectLinkForName: context.projectLinkForName,
      projectUrlFromControl: context.projectUrlFromControl,
      projectNewChatControl: context.projectNewChatControl,
      projectMemoryControl: context.projectMemoryControl,
      projectNameInput: context.projectNameInput,
      scrapeModelMenu: context.scrapeModelMenu,
    },
    FakeTextArea,
    setComposer(element) {
      queryElement = element
      queryElements = [element]
    },
    setQueryElementForSelector(handler) {
      queryElementForSelector = handler
    },
    setQueryElements(elements) {
      queryElements = elements
    },
    setQueryElementsForSelector(handler) {
      queryElementsForSelector = handler
    },
    receive(message) {
      assert.ok(messageListener, 'content port listener was registered')
      messageListener(message)
    },
    invalidateExtension() {
      runtimeValid = false
      runtimeLastError = { message: 'Extension context invalidated.' }
      assert.ok(disconnectListener, 'content port disconnect listener was registered')
      disconnectListener()
    },
    runtimeLastErrorReads() {
      return runtimeLastErrorReads
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

test('extension replacement stops the stale content script without recording a Chrome error', () => {
  const harness = loadContent()
  const timerCount = harness.timeouts.size

  harness.invalidateExtension()

  assert.equal(harness.timeouts.size, timerCount)
  assert.equal(harness.runtimeLastErrorReads(), 1)
  assert.deepEqual(harness.consoleWarnings, [])
  assert.deepEqual(harness.consoleErrors, [])
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
      __parallax_arm: true,
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

test('composer lookup skips a hidden duplicate and uses the visible editor', () => {
  const harness = loadContent()
  const hidden = {
    getAttribute() { return null },
    getBoundingClientRect() { return { width: 0, height: 0 } },
  }
  const visible = {
    getAttribute() { return null },
    getBoundingClientRect() { return { width: 500, height: 48 } },
  }
  harness.setQueryElementsForSelector((selector) => (
    selector === '#prompt-textarea' ? [hidden, visible] : []
  ))

  assert.equal(harness.helpers.find(['#prompt-textarea']), visible)
})

test('project lookup reuses an exact plx folder project route', () => {
  const harness = loadContent()
  const link = {
    href: 'https://chatgpt.com/g/g-p-67710a876dac8191bd024ba6d5725bb8/project',
    textContent: 'plx-parallax',
    getAttribute(name) {
      return name === 'aria-label' ? 'plx-parallax' : null
    },
  }
  harness.setQueryElements([link])

  assert.equal(harness.helpers.projectLinkForName('plx-parallax'), link)
  assert.equal(harness.helpers.projectLinkForName('plx-other'), null)
})

test('project lookup recognizes the current button-based project list', () => {
  const harness = loadContent()
  const button = {
    textContent: 'plx-parallax',
    disabled: false,
    getAttribute(name) {
      return name === 'aria-label' ? 'plx-parallax' : null
    },
  }
  harness.setQueryElements([button])

  assert.equal(harness.helpers.projectControlForName('plx-parallax'), button)
  assert.equal(harness.helpers.projectControlForName('plx-other'), null)
  assert.equal(harness.helpers.projectLinkForName('plx-parallax'), null)
})

test('project lookup recovers a route embedded in a button project id', () => {
  const harness = loadContent()
  const button = {
    tagName: 'BUTTON',
    textContent: 'plx-parallax',
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-label') return 'plx-parallax'
      if (name === 'data-project-id') return 'g-p-67710a876dac8191bd024ba6d5725bb8'
      return null
    },
  }
  harness.setQueryElements([button])

  assert.equal(
    harness.helpers.projectUrlFromControl(button),
    'https://chatgpt.com/g/g-p-67710a876dac8191bd024ba6d5725bb8/project',
  )
  assert.equal(harness.helpers.projectLinkForName('plx-parallax'), button)
})

test('project lookup ignores a matching project options button', () => {
  const harness = loadContent()
  const options = {
    tagName: 'BUTTON',
    textContent: '',
    disabled: false,
    getAttribute(name) {
      return name === 'aria-label' ? 'plx-parallax project options' : null
    },
  }
  harness.setQueryElements([options])

  assert.equal(harness.helpers.projectControlForName('plx-parallax'), null)
})

test('project lookup selects the pencil new-chat action beside an expanded project', () => {
  const harness = loadContent()
  const pencil = {
    tagName: 'BUTTON',
    disabled: false,
    getAttribute(name) {
      return name === 'aria-label' ? 'Start a new chat in plx-parallax' : null
    },
  }
  const more = {
    tagName: 'BUTTON',
    disabled: false,
    getAttribute(name) {
      return name === 'aria-label' ? 'Project options' : null
    },
  }
  const project = {
    tagName: 'DIV',
    textContent: 'plx-parallax',
    disabled: false,
    parentElement: null,
    getAttribute(name) {
      if (name === 'role') return 'button'
      if (name === 'aria-label') return 'plx-parallax'
      if (name === 'aria-expanded') return 'true'
      return null
    },
    querySelectorAll() { return [pencil, more] },
  }
  harness.setQueryElements([project])

  assert.equal(harness.helpers.projectNewChatControl('plx-parallax'), pencil)
})

test('project form lookup scopes an unnamed input to the visible Create project modal', () => {
  const harness = loadContent()
  const input = {
    tagName: 'INPUT',
    getAttribute(name) {
      return name === 'placeholder' ? 'Copenhagen Trip' : null
    },
  }
  const memory = {
    disabled: false,
    textContent: 'Default memory',
    getAttribute(name) {
      return name === 'role' ? 'combobox' : null
    },
  }
  const dialog = {
    tagName: 'DIV',
    textContent: 'Create project Project name Default memory Create project',
    getAttribute() { return null },
    querySelectorAll(selector) {
      if (selector.includes('input')) return [input]
      if (selector.includes('button')) return [memory]
      return []
    },
  }
  harness.setQueryElementsForSelector((selector) => (
    selector === '[role="dialog"],dialog' ? [dialog] : []
  ))

  assert.equal(harness.helpers.projectCreationRoot(), dialog)
  assert.equal(harness.helpers.projectNameInput(), input)
  assert.equal(harness.helpers.projectMemoryControl(dialog), memory)
})

test('project-only memory is recognized as an interactive menu option', () => {
  const harness = loadContent()
  const option = {
    disabled: false,
    textContent: 'Project-only memoryThis project can only access its own memory.',
    getAttribute(name) {
      return name === 'role' ? 'menuitemradio' : null
    },
  }
  harness.setQueryElements([option])

  assert.equal(harness.helpers.findProjectControl(/^project-only memory/i), option)
})

test('project memory radios never become model intelligence options', () => {
  const harness = loadContent()
  const memoryOption = {
    textContent: 'Default memoryThis project can access outside memory.',
    querySelector() { return null },
    querySelectorAll() { return [] },
    getAttribute(name) {
      return name === 'aria-checked' ? 'true' : null
    },
  }
  harness.setQueryElementForSelector(() => null)
  harness.setQueryElements([memoryOption])

  assert.equal(harness.helpers.scrapeModelMenu(true), null)
  assert.equal(harness.sent.some((message) => message.type === 'models'), false)
})

test('model scraping ignores the generic Model navigation row', () => {
  const harness = loadContent()
  const row = (textContent, checked = false) => ({
    textContent,
    querySelector() { return null },
    querySelectorAll() { return [] },
    getAttribute(name) {
      if (name === 'aria-checked') return checked ? 'true' : 'false'
      return null
    },
  })
  const intelligence = row('High', true)
  const selectedModel = row('GPT-5.6 Sol', true)
  const modelNavigation = row('Model')
  const menu = {
    querySelector() { return modelNavigation },
  }
  const picker = {
    closest() { return menu },
    querySelectorAll() { return [intelligence] },
  }
  harness.setQueryElementForSelector((selector) => (
    selector === '[data-testid="composer-intelligence-picker-content"]' ? picker : null
  ))
  harness.setQueryElementsForSelector((selector) => (
    selector === '[role="menuitemradio"]' ? [intelligence, selectedModel] : []
  ))

  const state = harness.helpers.scrapeModelMenu(true)
  assert.equal(state.currentModel, 'GPT-5.6 Sol')
  assert.equal(state.currentIntelligence, 'High')
  assert.deepEqual(
    JSON.parse(JSON.stringify(state.intelligences)),
    [{ label: 'High', hint: '', checked: true }],
  )
})

test('ordinary assistant responses still have no DOM fallback path', () => {
  const file = path.join(__dirname, '..', 'src', 'content.js')
  const source = fs.readFileSync(file, 'utf8')

  assert.doesNotMatch(source, /waitForResponse|response \(dom|DOM-scraping backstop/)
  assert.match(source, /source:\s*'network'/)
  assert.match(source, /waiting for network response/)
  assert.match(source, /case 'recover_turn'/)
})

test('page recovery accepts only complete Parallax response envelopes', () => {
  const harness = loadContent()
  const complete = [
    '{plx:note}Inspecting data{/plx:note}',
    '{plx:run}find . -maxdepth 2 -type f -print{/plx:run}',
  ].join('\n')

  assert.equal(harness.helpers.isCompleteParallaxResponse(complete), true)
  assert.equal(
    harness.helpers.isCompleteParallaxResponse(
      '{plx:note}Inspecting data{/plx:note}\n{plx:run}find .',
    ),
    false,
  )
  assert.equal(harness.helpers.isCompleteParallaxResponse('ordinary rendered text'), false)
})

test('a rejected internal follow-up is removed without erasing a different draft', () => {
  const harness = loadContent()
  const internal = '{plx:result kind="run"}output{/plx:result}'
  const composer = new harness.FakeTextArea(internal)
  harness.setComposer(composer)

  harness.helpers.clearComposerIfMatches(composer, internal)
  assert.equal(composer.value, '')
  assert.deepEqual(composer.events, ['input'])

  composer.value = 'a user-authored draft'
  harness.helpers.clearComposerIfMatches(composer, internal)
  assert.equal(composer.value, 'a user-authored draft')
})

test('pending-turn recovery recognizes an already-rendered prompt before retrying', () => {
  const harness = loadContent()
  const userTurn = {
    innerText: 'hi',
    textContent: 'hi',
    querySelector() { return null },
  }
  harness.setQueryElementsForSelector((selector) => (
    selector === '[data-message-author-role="user"]' ? [userTurn] : []
  ))

  assert.equal(harness.helpers.renderedUserPromptExists('hi'), true)
  assert.equal(harness.helpers.renderedUserPromptExists('different prompt'), false)
})

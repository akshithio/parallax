const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const protocolCore = require('../src/protocol-core')

function loadNetworkHook() {
  const messages = []
  const listeners = new Map()

  class FakeEventSource {
    addEventListener() {}
  }
  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    addEventListener() {}
  }

  const window = {
    WessProtocolCore: protocolCore,
    fetch() {
      return Promise.resolve({ headers: { get: () => '' } })
    },
    EventSource: FakeEventSource,
    WebSocket: FakeWebSocket,
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
    postMessage(message) {
      messages.push(message)
    },
  }
  const context = vm.createContext({
    window,
    globalThis: window,
    console: { log() {}, warn() {}, error() {} },
    Date,
    JSON,
    TextDecoder,
    URL,
    atob,
  })
  const file = path.join(__dirname, '..', 'src', 'inject.js')
  const source = fs.readFileSync(file, 'utf8').replace(
    /\}\)\(\);\s*$/,
    ';globalThis.__networkTest = { createSink, feedWsPayload };})();',
  )
  vm.runInContext(source, context, { filename: file })

  return { api: window.__networkTest, messages, listeners, window }
}

test('a fetch handoff continues on the socket and completes from network text', () => {
  const harness = loadNetworkHook()
  const sink = harness.api.createSink('turn-1')
  const fetchState = { handoff: false }
  const socketState = { handoff: false }

  harness.api.feedWsPayload(
    sink,
    JSON.stringify([{
      type: 'message',
      topic_id: 'conversations',
      payload: {
        type: 'conversation-turn-complete',
        payload: { conversation_id: 'conversation-1' },
      },
    }]),
    socketState,
  )
  assert.equal(sink.done, false, 'a global completion before the handoff is unrelated')

  sink.feed(
    JSON.stringify({
      type: 'stream_handoff',
      conversation_id: 'conversation-1',
      turn_exchange_id: 'exchange-1',
      options: [{ type: 'resume_sse_endpoint', topic_id: 'conversation-turn-exchange-1' }],
    }),
    'fetch',
    fetchState,
  )
  assert.equal(sink.feed('[DONE]', 'fetch', fetchState), true)
  assert.equal(sink.done, false, 'the handoff ticket must not complete the turn')

  harness.api.feedWsPayload(
    sink,
    JSON.stringify([{
      type: 'message',
      topic_id: 'conversation-turn-another-exchange',
      payload: { type: 'conversation-turn-complete' },
    }]),
    socketState,
  )
  assert.equal(sink.done, false, 'a different turn topic must not complete this turn')

  const message = {
    message: {
      author: { role: 'assistant' },
      content: { content_type: 'text', parts: ['{wess:note}Reading'] },
    },
  }
  const append = {
    o: 'append',
    p: '/message/content/parts/0',
    v: ' repository',
  }
  const continuation = {
    v: ' structure{/wess:note}\n{wess:run}ls -la{/wess:run}',
  }
  const socketFrame = {
    replacement_wrapper: [{
      type: 'message',
      topic_id: 'conversation-turn-exchange-1',
      payload: {
        catchups: [
          { type: 'message', payload: { payload: message } },
          {
            type: 'message',
            payload: {
              type: 'conversation-turn-stream',
              payload: { type: 'stream-item', replacement_item: append },
            },
          },
          {
            type: 'message',
            payload: {
              type: 'conversation-turn-stream',
              payload: {
                type: 'stream-item',
                encoded_item: `data: ${JSON.stringify(continuation)}\n\n`,
              },
            },
          },
        ],
      },
    }],
  }
  harness.api.feedWsPayload(sink, JSON.stringify(socketFrame), socketState)
  assert.equal(sink.done, false, 'answer text alone must keep waiting for completion')

  harness.api.feedWsPayload(
    sink,
    JSON.stringify([{
      type: 'message',
      topic_id: 'conversations',
      payload: {
        type: 'conversation-turn-complete',
        payload: { conversation_id: 'another-conversation' },
      },
    }]),
    socketState,
  )
  assert.equal(sink.done, false, 'a shared completion for another conversation is unrelated')

  harness.api.feedWsPayload(
    sink,
    JSON.stringify([{
      type: 'message',
      topic_id: 'conversations',
      payload: {
        type: 'conversation-turn-complete',
        payload: { conversation_id: 'conversation-1' },
      },
    }]),
    socketState,
  )

  assert.equal(sink.done, true)
  const responsePosts = harness.messages.filter((message) => message.__wess_net)
  assert.equal(responsePosts.at(-1).done, true)
  assert.equal(responsePosts.at(-1).source, 'network')
  assert.equal(
    responsePosts.at(-1).text,
    '{wess:note}Reading repository structure{/wess:note}\n{wess:run}ls -la{/wess:run}',
  )

  const metric = harness.messages.find((message) => message.__wess_net_metric).metric
  assert.equal(metric.status, 'completed')
  assert.equal(metric.handoffs, 1)
  assert.equal(metric.domFallbacks, 0)
  assert.deepEqual(Array.from(metric.transports).sort(), ['fetch', 'websocket'])
})

test('arming the page hook acknowledges the exact turn before submission', () => {
  const harness = loadNetworkHook()

  harness.listeners.get('message')({
    source: harness.window,
    data: { __wess_arm: true, armed: true, turnId: 'turn-ready' },
  })

  const ready = harness.messages.find((message) => message.__wess_net_arm_ready)
  assert.equal(ready.__wess_net_arm_ready, true)
  assert.equal(ready.armed, true)
  assert.equal(ready.turnId, 'turn-ready')
})

test('a message boundary cannot truncate a turn that continues streaming', () => {
  const harness = loadNetworkHook()
  const sink = harness.api.createSink('turn-multi-message')
  const state = { handoff: false }

  sink.feed(
    JSON.stringify({
      type: 'stream_handoff',
      conversation_id: 'conversation-1',
      turn_exchange_id: 'exchange-1',
      options: [{ type: 'resume_sse_endpoint', topic_id: 'conversation-turn-exchange-1' }],
    }),
    'fetch',
    state,
  )
  sink.feed(
    JSON.stringify({
      message: {
        author: { role: 'assistant' },
        content: {
          content_type: 'text',
          parts: ['Yes. We discussed it around July 18–'],
        },
      },
    }),
    'websocket',
    state,
  )

  const stoppedAtBoundary = sink.feed(
    JSON.stringify({ type: 'message_stream_complete' }),
    'websocket',
    state,
  )
  assert.equal(stoppedAtBoundary, false)
  assert.equal(sink.done, false, 'one completed assistant message is not a completed turn')

  sink.feed(
    JSON.stringify({ v: '21, 2026. The rest of the answer must remain visible.' }),
    'websocket',
    state,
  )
  sink.feed(
    JSON.stringify({
      type: 'turn_exchange_stream_complete',
      conversation_id: 'conversation-1',
      turn_exchange_id: 'exchange-1',
    }),
    'websocket',
    state,
  )

  assert.equal(sink.done, true)
  const response = harness.messages.filter((message) => message.__wess_net).at(-1)
  assert.equal(
    response.text,
    'Yes. We discussed it around July 18–21, 2026. The rest of the answer must remain visible.',
  )
  const metric = harness.messages.find((message) => message.__wess_net_metric).metric
  assert.equal(metric.messageBoundaries, 1)
  assert.equal(metric.completion, 'turn_exchange_stream_complete via websocket')
})

const test = require('node:test');
const assert = require('node:assert/strict');
const { conversationId, streamEvents } = require('../src/protocol-core');

test('conversationId ignores new-chat and temporary WEB routes', () => {
  assert.equal(conversationId('https://chatgpt.com/'), null);
  assert.equal(
    conversationId('https://chatgpt.com/c/WEB:75720f15-f5fc-4c8b-aec7-238113d74b3e'),
    null,
  );
});

test('conversationId returns the complete canonical route segment', () => {
  assert.equal(
    conversationId('https://chatgpt.com/c/6a62954e-9984-83ea-a025-99acc61ce4cc'),
    '6a62954e-9984-83ea-a025-99acc61ce4cc',
  );
});

test('streamEvents unwraps array and nested payload envelopes in order', () => {
  const message = {
    message: {
      author: { role: 'assistant' },
      content: { content_type: 'text', parts: ['hello'] },
    },
  };
  const append = { o: 'append', p: '/message/content/parts/0', v: ' world' };
  const frame = [
    {
      type: 'reply',
      reply: {
        type: 'subscribe',
        catchups: [{ type: 'message', payload: { payload: message } }],
      },
    },
    {
      type: 'message',
      payload: {
        type: 'conversation-turn-stream',
        payload: { type: 'stream-item', item: append },
      },
    },
  ];
  assert.deepEqual(streamEvents(frame), [message, append]);
});

test('streamEvents follows unknown handoff wrappers and recognizes turn completion', () => {
  const append = { o: 'append', p: '/message/content/parts/0', v: 'network text' };
  const complete = { type: 'conversation-turn-complete', conversation_id: 'conversation-a' };
  const frame = {
    channel: {
      replacement_envelope: {
        type: 'conversation-turn-stream',
        replacement_item: {
          type: 'stream-item',
          value_added_later: append,
        },
      },
      completion_added_later: complete,
    },
  };

  assert.deepEqual(streamEvents(frame), [append, complete]);
});

test('streamEvents unwraps SSE strings and completion events', () => {
  const complete = { type: 'message_stream_complete' };
  const input = `data: ${JSON.stringify(complete)}\ndata: [DONE]\n`;
  assert.deepEqual(streamEvents(input), [complete, '[DONE]']);
});

test('streamEvents preserves bare v1 continuation chunks from encoded items', () => {
  const encoded = [{
    type: 'message',
    topic_id: 'conversation-turn-1',
    payload: {
      type: 'conversation-turn-stream',
      payload: {
        type: 'stream-item',
        encoded_item: [
          'data: {"p":"/message/content/parts/0","o":"append","v":"{wess:note}Reading"}',
          '',
          'data: {"v":" the repository"}',
          '',
          'data: {"v":" structure{/wess:note}"}',
          '',
        ].join('\n'),
      },
    },
  }];

  assert.deepEqual(streamEvents(encoded), [
    { p: '/message/content/parts/0', o: 'append', v: '{wess:note}Reading' },
    { v: ' the repository' },
    { v: ' structure{/wess:note}' },
  ]);
});

test('streamEvents ignores unrelated transport control frames', () => {
  assert.deepEqual(
    streamEvents([{ type: 'reply', reply: { type: 'subscribe' } }]),
    [],
  );
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeliveryTracker } = require('../lib/deliveryTracker');

test('acknowledges a pending delivery exactly once', () => {
  const tracker = createDeliveryTracker();
  tracker.remember('message-1', 'Inspect the repository.', 'thread-a');

  assert.deepEqual(tracker.acknowledge('message-1', 'thread-a'), {
    text: 'Inspect the repository.',
    msgId: 'message-1',
    convId: 'thread-a',
  });
  assert.equal(tracker.acknowledge('message-1', 'thread-a'), null);
});

test('uses the acknowledged task identity and clears failed deliveries', () => {
  const tracker = createDeliveryTracker();
  tracker.remember('message-1', 'First task', 'thread-a');
  tracker.remember('message-2', 'Second task', 'thread-b');

  assert.equal(tracker.acknowledge('message-2', 'thread-b-live').convId, 'thread-b-live');
  assert.equal(tracker.has('message-1'), true);
  tracker.fail('message-1');
  assert.equal(tracker.has('message-1'), false);
});

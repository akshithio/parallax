const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execAgentActions } = require('../lib/agentExecutor');

test('command execution is asynchronous and preserves action order', async () => {
  const execution = execAgentActions(path.join(__dirname, '..'), [
    { type: 'run', command: 'printf first' },
    { type: 'run', command: 'printf second' },
  ]);

  assert.equal(typeof execution.then, 'function');
  const results = await execution;
  assert.equal(results.length, 2);
  assert.match(results[0].content, /^\$ printf first\nfirst/);
  assert.match(results[1].content, /^\$ printf second\nsecond/);
});

test('command output is published before the process exits', async () => {
  const updates = [];
  let markFirstChunk;
  const firstChunk = new Promise((resolve) => {
    markFirstChunk = resolve;
  });
  const execution = execAgentActions(
    path.join(__dirname, '..'),
    [{ type: 'run', command: 'printf alpha; sleep 0.08; printf omega' }],
    (actionIndex, progress) => {
      updates.push({ actionIndex, ...progress });
      if (progress.content.endsWith('\nalpha')) {
        markFirstChunk();
      }
    },
  );

  await Promise.race([
    firstChunk,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('partial output was not published')), 1000);
    }),
  ]);
  const results = await execution;

  assert.ok(updates.some((update) => update.actionIndex === 0 && update.status === 'running'));
  assert.ok(updates.some((update) => update.content.endsWith('\nalpha')));
  assert.match(results[0].content, /alphaomega/);
});

test('shell reads can inspect a parent directory', async () => {
  const results = await execAgentActions(path.join(__dirname, '..'), [
    { type: 'run', command: 'ls ..' },
  ]);

  assert.equal(results[0].status, 'ok');
  assert.match(results[0].content, /^\$ ls \.\./);
  assert.match(results[0].content, /parallax-desktop/);
});

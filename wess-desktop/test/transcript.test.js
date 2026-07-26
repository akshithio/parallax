const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function loadTypeScriptModule(file) {
  const source = fs.readFileSync(file, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = module.paths;
  loaded._compile(output, file);
  return loaded.exports;
}

const transcript = loadTypeScriptModule(
  path.join(__dirname, '..', 'lib', 'transcript.ts'),
);

test('hides the narrow duplicate produced by an old delivery retry', () => {
  const messages = [
    { role: 'user', text: 'inspect this repository', msgId: '1784845644410-n8zw' },
    { role: 'user', text: 'inspect this repository', msgId: '1784845664746-q4h6' },
    { role: 'assistant', text: 'Working on it.' },
  ];

  assert.deepEqual(transcript.visibleTranscriptMessages(messages), [
    messages[0],
    messages[2],
  ]);
});

test('preserves repeated messages outside the retry window', () => {
  const messages = [
    { role: 'user', text: 'try again', msgId: '1784845600000-one' },
    { role: 'user', text: 'try again', msgId: '1784845700000-two' },
  ];

  assert.deepEqual(transcript.visibleTranscriptMessages(messages), messages);
});

test('preserves repeated messages with attachments or unknown identifiers', () => {
  const attached = [
    { role: 'user', text: 'review this', msgId: '1784845600000-one', attachments: [{}] },
    { role: 'user', text: 'review this', msgId: '1784845601000-two', attachments: [{}] },
  ];
  const unknown = [
    { role: 'user', text: 'hello' },
    { role: 'user', text: 'hello' },
  ];

  assert.deepEqual(transcript.visibleTranscriptMessages(attached), attached);
  assert.deepEqual(transcript.visibleTranscriptMessages(unknown), unknown);
});

test('preserves intentional repeated messages from the current delivery flow', () => {
  const messages = [
    {
      role: 'user',
      text: 'continue',
      msgId: '1784845600000-one',
      delivery: 'sent',
    },
    {
      role: 'user',
      text: 'continue',
      msgId: '1784845601000-two',
      delivery: 'pending',
    },
  ];

  assert.deepEqual(transcript.visibleTranscriptMessages(messages), messages);
});

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

const prompt = loadTypeScriptModule(
  path.join(__dirname, '..', 'lib', 'systemPrompt.ts'),
);

test('workspace protocol stays compact', () => {
  // The wire tag is `plx`, not the product name: it repeats in every message in
  // both directions, so the three characters are worth more than the branding.
  assert.ok(prompt.SYSTEM_PROMPT.length < 3000);
  const wire = prompt.composeWireMessage('Inspect this repository.', 'example-project');
  assert.ok(wire.startsWith(`{plx:task}
Inspect this repository.
{/plx:task}`));
  assert.equal(wire.includes(String.fromCharCode(92, 110)), false);
  assert.equal(wire.codePointAt('{plx:task}'.length), 10);
  assert.match(wire, /workspace root is \*\*"example-project"\*\*/);
  assert.match(wire, /not a read boundary/);
  assert.match(wire, /ls \.\.\/repo/);
  assert.match(wire, /approval="required"/);
  assert.match(wire, /visible commentary to the user/);
  assert.match(wire, /natural first-person sentence/);
  assert.match(wire, /followed immediately by 1–4 related action tags/);
  assert.doesNotMatch(wire, /note becomes the activity label/);
  assert.doesNotMatch(wire, /Use 3–7 words, no pronoun/);
  assert.match(wire, /Other local paths explicitly named in the current task are in scope/);
  assert.doesNotMatch(wire, /Never use absolute paths or "\.\."/);
});

test('the first message carries the workspace protocol regardless of its text', () => {
  const wire = prompt.composeWireMessage('hi', 'example-project');
  assert.ok(wire.startsWith(`{plx:task}
hi
{/plx:task}`));
  assert.match(wire, /You are Parallax's planner in a desktop coding harness/);
});

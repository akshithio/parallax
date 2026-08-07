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
  assert.ok(prompt.SYSTEM_PROMPT.length < 3000);
  const wire = prompt.composeWireMessage('Inspect this repository.', 'example-project');
  assert.match(wire, /^\{nix:task\}\nInspect this repository\.\n\{\/nix:task\}/);
  assert.match(wire, /workspace root is \*\*"example-project"\*\*/);
  assert.match(wire, /not a read boundary/);
  assert.match(wire, /ls \.\.\/repo/);
  assert.match(wire, /approval="required"/);
  assert.match(wire, /Other local paths explicitly named in the current task are in scope/);
  assert.doesNotMatch(wire, /Never use absolute paths or "\.\."/);
});

test('plain greetings do not bootstrap the workspace protocol', () => {
  assert.equal(prompt.needsHarnessBootstrap('hi'), false);
  assert.equal(prompt.needsHarnessBootstrap('Hello!'), false);
  assert.equal(prompt.needsHarnessBootstrap('how are you?'), false);
  assert.equal(prompt.needsHarnessBootstrap('hi, inspect this repository'), true);
  assert.equal(prompt.needsHarnessBootstrap('hi', 'attached context'), true);
});

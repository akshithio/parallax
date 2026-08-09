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

const protocol = loadTypeScriptModule(
  path.join(__dirname, '..', 'lib', 'agentProtocol.ts'),
);

test('parser preserves narration and calls in emission order', () => {
  const result = protocol.parseAgentActions(
    '{plx:note}I will inspect the entry points next.{/plx:note}\n' +
      '{plx:run}cat package.json{/plx:run}\n' +
      '{plx:run}sed -n "1,160p" src/index.ts{/plx:run}',
  );
  assert.deepEqual(
    result.actions.map((action) => action.type),
    ['note', 'run', 'run'],
  );
  assert.equal(result.actions[0].text, 'I will inspect the entry points next.');
});

test('parser does not promote a truncated action to an executable call', () => {
  const result = protocol.parseAgentActions('{plx:run}cat package.json');
  assert.equal(result.hasDone, false);
  assert.deepEqual(result.actions, []);
  assert.equal(protocol.stripAgentTags('{plx:run}cat package.json'), '');
});

test('parser accepts the canonical completed-answer wrapper', () => {
  const result = protocol.parseAgentActions(
    '{plx:done}The project has two runtime components.{/plx:done}',
  );
  assert.equal(result.hasDone, true);
  assert.equal(result.actions[0].text, 'The project has two runtime components.');
});

test('parser preserves explicit human-review requests on actions', () => {
  const result = protocol.parseAgentActions(
    '{plx:run approval="required"}pnpm install{/plx:run}\n' +
      '{plx:write path="README.md" approval="required"}content{/plx:write}',
  );
  assert.deepEqual(result.actions, [
    { type: 'run', command: 'pnpm install', approval: 'required' },
    { type: 'write', path: 'README.md', content: 'content', approval: 'required' },
  ]);
});

test('parser tolerates spaced tags and decodes escaped attributes', () => {
  const result = protocol.parseAgentActions(
    '{ plx:search query="&quot;message&quot;" path="src" /}',
  );
  assert.deepEqual(result.actions[0], {
    type: 'search',
    query: '"message"',
    path: 'src',
  });
  assert.equal(protocol.stripAgentTags('{ plx:search query="hello" /}'), '');
});

test('git global path options preserve read-only command classification', () => {
  assert.equal(protocol.isReadOnlyCommand('git -C mnist status --short --branch'), true);
  assert.equal(protocol.isReadOnlyCommand('git --no-pager -C mnist log -n 5'), true);
  assert.equal(protocol.isReadOnlyCommand('git -C ../akshith.io log -n 5'), true);
  assert.equal(protocol.isReadOnlyCommand('ls -la ../akshith.io'), true);
  assert.equal(protocol.isReadOnlyCommand('cat ../akshith.io/package.json'), true);
  assert.equal(protocol.isReadOnlyCommand('git -C mnist checkout main'), false);
});

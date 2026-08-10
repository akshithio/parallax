const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

const SIZES = ['16', '32', '48', '128'];

test('declares an icon at every size Chrome asks for', () => {
  assert.deepEqual(Object.keys(manifest.icons), SIZES);
  assert.deepEqual(Object.keys(manifest.action.default_icon), SIZES);
});

test('every declared icon exists in the packaged tree', () => {
  const declared = [
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const relative of declared) {
    // The packager zips `manifest.json` and `src`, so icons must live under src.
    assert.ok(relative.startsWith('src/'), `${relative} would not be packaged`);
    assert.ok(fs.existsSync(path.join(root, relative)), `missing ${relative}; run \`pnpm icons\``);
  }
});

test('uses a store-sized summary that describes the extension single purpose', () => {
  assert.ok(manifest.description.length <= 132);
  assert.match(manifest.description, /Parallax desktop workspace/);
  assert.match(manifest.description, /ChatGPT tabs/);
});

test('limits host access to the two supported ChatGPT origins', () => {
  assert.deepEqual(manifest.host_permissions, [
    'https://chatgpt.com/*',
    'https://chat.openai.com/*',
  ]);
});

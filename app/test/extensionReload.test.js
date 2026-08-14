const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isExtensionRuntimeFile,
  normalizeExtensionPath,
} = require('../lib/extensionReload');

test('reloads only files Chrome executes or displays from the unpacked extension', () => {
  assert.equal(isExtensionRuntimeFile('manifest.json'), true);
  assert.equal(isExtensionRuntimeFile('src/content.js'), true);
  assert.equal(isExtensionRuntimeFile('src/popup.html'), true);
  assert.equal(isExtensionRuntimeFile('src/icons/icon-128.png'), true);

  assert.equal(isExtensionRuntimeFile('test/content.ownership.test.js'), false);
  assert.equal(isExtensionRuntimeFile('dist/Parallax-Extension-0.1.1.zip'), false);
  assert.equal(isExtensionRuntimeFile('store/listing.md'), false);
  assert.equal(isExtensionRuntimeFile('package.json'), false);
});

test('normalizes watcher paths before classifying extension files', () => {
  assert.equal(normalizeExtensionPath('src\\content.js'), 'src/content.js');
  assert.equal(isExtensionRuntimeFile('src\\content.js'), true);
});

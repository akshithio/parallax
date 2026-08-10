const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ICON_PREFERENCES,
  normalizePreference,
  resolveVariant,
  iconFileFor,
} = require('../lib/dockIcon');

test('an explicit choice wins over the system appearance', () => {
  assert.equal(resolveVariant('light', true), 'light');
  assert.equal(resolveVariant('dark', false), 'dark');
});

test('the system preference follows the OS both ways', () => {
  assert.equal(resolveVariant('system', true), 'dark');
  assert.equal(resolveVariant('system', false), 'light');
});

test('an unknown or missing preference falls back to following the OS', () => {
  for (const bad of [undefined, null, '', 'sepia', 42]) {
    assert.equal(normalizePreference(bad), 'system');
    assert.equal(resolveVariant(bad, true), 'dark');
  }
});

test('every preference resolves to a file that exists', () => {
  const build = path.join(__dirname, '..', 'build');
  for (const preference of ICON_PREFERENCES) {
    for (const systemPrefersDark of [true, false]) {
      const file = iconFileFor(resolveVariant(preference, systemPrefersDark));
      assert.ok(
        fs.existsSync(path.join(build, file)),
        `${preference} resolved to missing ${file}; run \`pnpm icons\``,
      );
    }
  }
});

test('the packaged app ships the icns and both dock tiles', () => {
  const build = path.join(__dirname, '..', 'build');
  for (const file of ['icon.icns', 'icon-dark.png', 'icon-light.png']) {
    assert.ok(fs.existsSync(path.join(build, file)), `missing build/${file}`);
  }

  const { createReleaseConfig } = require('../lib/releaseConfig');
  const config = createReleaseConfig({});
  assert.equal(config.mac.icon, 'build/icon.icns');
  // Without these the runtime swap has nothing to load inside the asar.
  assert.ok(config.files.includes('build/icon-dark.png'));
  assert.ok(config.files.includes('build/icon-light.png'));
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createReleaseConfig,
  githubReleaseProvider,
} = require('../lib/releaseConfig');

test('derives the GitHub update feed from the Actions repository slug', () => {
  assert.deepEqual(githubReleaseProvider('example/nix'), {
    provider: 'github',
    owner: 'example',
    repo: 'nix',
    releaseType: 'release',
  });
  assert.equal(githubReleaseProvider(''), null);
  assert.equal(githubReleaseProvider('missing-repo-name'), null);
});

test('packages the exported renderer and both macOS update artifacts', () => {
  const config = createReleaseConfig({ GITHUB_REPOSITORY: 'example/nix' });

  assert.ok(config.files.includes('out/**/*'));
  assert.deepEqual(config.mac.target, ['dmg', 'zip']);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.notarize, true);
  assert.deepEqual(config.publish, [{
    provider: 'github',
    owner: 'example',
    repo: 'nix',
    releaseType: 'release',
  }]);
});

test('allows local packaging without a publication target', () => {
  const config = createReleaseConfig({});
  assert.equal(config.publish, undefined);
});

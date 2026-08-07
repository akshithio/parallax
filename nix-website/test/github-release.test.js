import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseAsset,
  fetchLatestRelease,
  normalizeRelease,
} from '../lib/github-release.js';

const assets = [
  {
    name: 'Nix-0.1.0-arm64.dmg',
    size: 12,
    browser_download_url: 'https://downloads.test/arm.dmg',
  },
  {
    name: 'Nix-0.1.0-universal.dmg',
    size: 20,
    browser_download_url: 'https://downloads.test/universal.dmg',
  },
  {
    name: 'Nix-Extension-0.1.0.zip',
    size: 5,
    browser_download_url: 'https://downloads.test/extension.zip',
  },
];

test('prefers the universal macOS image and identifies the extension package', () => {
  assert.equal(chooseAsset(assets, 'macos').name, 'Nix-0.1.0-universal.dmg');
  assert.equal(chooseAsset(assets, 'extension').name, 'Nix-Extension-0.1.0.zip');
  assert.equal(chooseAsset(assets, 'unknown'), null);
});

test('normalizes release metadata for the website', () => {
  const release = normalizeRelease({
    tag_name: 'v0.1.0',
    name: 'Nix 0.1.0',
    published_at: '2026-07-25T00:00:00Z',
    html_url: 'https://github.com/akshithio/nix/releases/tag/v0.1.0',
    assets,
  });

  assert.equal(release.version, '0.1.0');
  assert.equal(release.downloads.macos.size, 20);
  assert.equal(release.downloads.extension.url, 'https://downloads.test/extension.zip');
});

test('fetches the public latest-release endpoint with explicit GitHub headers', async () => {
  let request = null;
  const release = await fetchLatestRelease(async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      async json() {
        return { tag_name: 'v0.1.0', assets };
      },
    };
  });

  assert.match(request.url, /repos\/akshithio\/nix\/releases\/latest$/);
  assert.equal(request.options.headers.Accept, 'application/vnd.github+json');
  assert.equal(release.version, '0.1.0');
});

test('rejects an unavailable release feed', async () => {
  await assert.rejects(
    () => fetchLatestRelease(async () => ({ ok: false, status: 404 })),
    /failed with 404/,
  );
});

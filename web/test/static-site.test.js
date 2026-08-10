import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const privacy = readFileSync(path.join(root, 'public', 'privacy.txt'), 'utf8');
const styles = readFileSync(path.join(root, 'public', 'assets', 'styles.css'), 'utf8');
const workspacePackage = JSON.parse(
  readFileSync(path.join(root, '..', 'package.json'), 'utf8'),
);
const vercelConfig = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));

test('publishes stable download and repository links', () => {
  assert.match(html, /href="\/download\/macos"/);
  assert.match(html, /href="\/download\/extension"/);
  assert.match(html, /https:\/\/github\.com\/akshithio\/parallax/);
});

test('publishes a complete privacy disclosure for the Chrome bridge', () => {
  assert.match(html, /href="\/privacy"/);
  assert.match(privacy, /separate inactive task tab/);
  assert.match(privacy, /local WebSocket/);
  assert.match(privacy, /does not operate developer data servers/);
  assert.match(privacy, /Chrome Web Store User Data Policy/);
  assert.deepEqual(
    vercelConfig.rewrites.find(({ source }) => source === '/privacy'),
    { source: '/privacy', destination: '/privacy.txt' },
  );
  const privacyHeaders = vercelConfig.headers
    .find(({ source }) => source === '/privacy')
    .headers;
  assert.equal(
    privacyHeaders.find(({ key }) => key === 'Content-Type').value,
    'text/plain; charset=utf-8',
  );
});

test('self-hosts both typefaces and ships one stylesheet', () => {
  assert.match(styles, /\/assets\/fonts\/plex-sans-latin\.woff2/);
  assert.match(styles, /\/assets\/fonts\/plex-mono-400-latin\.woff2/);
  assert.equal((html.match(/rel="stylesheet"/g) || []).length, 1);
});

test('supports light and dark without a theme control', () => {
  assert.match(html, /name="color-scheme" content="light dark"/);
  assert.match(styles, /@media \(prefers-color-scheme: dark\)/);
  assert.doesNotMatch(html, /theme-toggle|data-theme/i);
});

test('avoids decorative gradients, glows, and shadows', () => {
  assert.doesNotMatch(styles, /gradient|box-shadow|backdrop-filter|filter: *blur/i);
});

test('ships responsive and reduced-motion presentation rules', () => {
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test('does not depend on remote fonts or scripts', () => {
  assert.doesNotMatch(html, /fonts\.(googleapis|gstatic)\.com/);
  assert.doesNotMatch(html, /<script[^>]+https?:\/\//);
});

test('only caches immutably what has an immutable name', () => {
  const rules = vercelConfig.headers.filter((rule) => rule.source.startsWith('/assets/'));
  const valueFor = (source) => rules
    .find((rule) => rule.source === source)
    .headers.find((header) => header.key === 'Cache-Control')
    .value;

  // Font filenames encode family and subset, so their bytes never change.
  assert.match(valueFor('/assets/fonts/(.*)'), /immutable/);
  // styles.css and site.js keep stable names, so they must revalidate.
  assert.doesNotMatch(valueFor('/assets/(.*)'), /immutable/);
  assert.match(valueFor('/assets/(.*)'), /must-revalidate/);

  // Vercel applies later matching rules over earlier ones, so the narrower
  // fonts rule has to come last or the general one overwrites it.
  assert.ok(
    rules.findIndex((rule) => rule.source === '/assets/fonts/(.*)')
      > rules.findIndex((rule) => rule.source === '/assets/(.*)'),
  );
});

test('busts the cache when a stamped asset changes', () => {
  for (const relative of ['styles.css', 'site.js']) {
    const hash = createHash('sha256')
      .update(readFileSync(path.join(root, 'public', 'assets', relative)))
      .digest('hex')
      .slice(0, 10);
    assert.match(html, new RegExp(`/assets/${relative.replace('.', '\\.')}\\?v=${hash}`));
  }
});

test('uses the workspace pnpm version for Vercel dependency installation', () => {
  assert.equal(workspacePackage.packageManager, 'pnpm@10.8.1');
  assert.match(vercelConfig.installCommand, /^pnpm /);
});

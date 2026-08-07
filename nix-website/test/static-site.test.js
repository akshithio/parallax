import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const styles = readFileSync(path.join(root, 'public', 'assets', 'styles.css'), 'utf8');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const vercelConfig = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));

test('publishes stable download and repository links', () => {
  assert.match(html, /href="\/download\/macos"/);
  assert.match(html, /href="\/download\/extension"/);
  assert.match(html, /https:\/\/github\.com\/akshithio\/nix/);
});

test('builds on the self-hosted Vercel brand foundation', () => {
  assert.match(html, /<body class="vbg-report">/);
  assert.match(html, /href="\/assets\/vercel-brand\.css"/);
  assert.match(styles, /@font-face/);
  assert.match(styles, /\/assets\/fonts\/geist-latin\.woff2/);
});

test('keeps page-owned CSS inside the custom namespace', () => {
  const selectors = styles.match(/\.vbg-[a-z0-9-]+/g) || [];
  const published = selectors.filter((selector) => !selector.startsWith('.vbg-custom-'));
  assert.deepEqual(published, [], `page CSS must not target published classes: ${published}`);
});

test('ships responsive and reduced-motion presentation rules', () => {
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test('does not depend on remote fonts or scripts', () => {
  assert.doesNotMatch(html, /fonts\.(googleapis|gstatic)\.com/);
  assert.doesNotMatch(html, /<script[^>]+https?:\/\//);
});

test('uses pnpm for local and Vercel dependency installation', () => {
  assert.equal(packageJson.packageManager, 'pnpm@10.8.1');
  assert.match(vercelConfig.installCommand, /^pnpm /);
});

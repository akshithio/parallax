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

test('uses pnpm for local and Vercel dependency installation', () => {
  assert.equal(packageJson.packageManager, 'pnpm@10.8.1');
  assert.match(vercelConfig.installCommand, /^pnpm /);
});

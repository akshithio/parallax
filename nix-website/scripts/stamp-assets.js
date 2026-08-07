/*
  Stamps /assets/styles.css and /assets/site.js in index.html with a hash of
  their contents.

  The asset filenames are stable, so a returning browser would otherwise keep
  serving whatever it cached. The query string changes whenever the file does,
  which makes the URL itself the cache key.

  Run with --check to fail instead of writing, so CI catches a stale stamp.
*/

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = path.join(root, 'public', 'index.html');
const stamped = ['assets/styles.css', 'assets/site.js'];

export function hashFile(relative) {
  const contents = readFileSync(path.join(root, 'public', relative));
  return createHash('sha256').update(contents).digest('hex').slice(0, 10);
}

export function stampHtml(html) {
  return stamped.reduce((current, relative) => {
    const pattern = new RegExp(`(/${relative})(\\?v=[a-f0-9]+)?`, 'g');
    return current.replace(pattern, `$1?v=${hashFile(relative)}`);
  }, html);
}

const check = process.argv.includes('--check');
const html = readFileSync(indexPath, 'utf8');
const next = stampHtml(html);

if (html === next) {
  console.log('Asset stamps are current.');
} else if (check) {
  console.error('Asset stamps are stale. Run `pnpm run stamp` and commit the result.');
  process.exit(1);
} else {
  writeFileSync(indexPath, next);
  console.log('Updated asset stamps in public/index.html.');
}

const path = require('node:path');

const root = path.join(__dirname, '..');
const versions = new Map([
  ['workspace', require(path.join(root, 'package.json')).version],
  ['desktop', require(path.join(root, 'wess-desktop', 'package.json')).version],
  ['extension package', require(path.join(root, 'wess-extension', 'package.json')).version],
  ['extension manifest', require(path.join(root, 'wess-extension', 'manifest.json')).version],
  ['website', require(path.join(root, 'wess-website', 'package.json')).version],
]);

const expected = versions.get('workspace');
const mismatches = [...versions].filter(([, version]) => version !== expected);
if (mismatches.length > 0) {
  console.error(
    `Workspace versions must match ${expected}: ${mismatches
      .map(([name, version]) => `${name}=${version}`)
      .join(', ')}`,
  );
  process.exit(1);
}

console.log(`All workspace packages use version ${expected}.`);

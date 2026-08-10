const path = require('node:path');

const root = path.join(__dirname, '..');
const versions = new Map([
  ['workspace', require(path.join(root, 'package.json')).version],
  ['desktop', require(path.join(root, 'parallax-desktop', 'package.json')).version],
  ['extension package', require(path.join(root, 'parallax-extension', 'package.json')).version],
  ['extension manifest', require(path.join(root, 'parallax-extension', 'manifest.json')).version],
  ['website', require(path.join(root, 'parallax-website', 'package.json')).version],
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

// Every package claims the licence the repository actually ships in LICENSE.
const licenses = new Map([
  ['workspace', require(path.join(root, 'package.json')).license],
  ['desktop', require(path.join(root, 'parallax-desktop', 'package.json')).license],
  ['extension', require(path.join(root, 'parallax-extension', 'package.json')).license],
  ['website', require(path.join(root, 'parallax-website', 'package.json')).license],
]);

const wrongLicense = [...licenses].filter(([, license]) => license !== 'MIT');
if (wrongLicense.length > 0) {
  console.error(
    `Every workspace package must declare "license": "MIT": ${wrongLicense
      .map(([name, license]) => `${name}=${license || 'missing'}`)
      .join(', ')}`,
  );
  process.exit(1);
}

if (!require('node:fs').existsSync(path.join(root, 'LICENSE'))) {
  console.error('LICENSE is missing from the repository root.');
  process.exit(1);
}

console.log(`All workspace packages use version ${expected} and declare MIT.`);

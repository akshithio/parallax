const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const packageInfo = require('../package.json');

const extensionRoot = path.join(__dirname, '..');
const outputDirectory = path.join(extensionRoot, 'dist');
const outputPath = path.join(
  outputDirectory,
  `Parallax-Extension-${packageInfo.version}.zip`,
);

mkdirSync(outputDirectory, { recursive: true });
const result = spawnSync(
  'zip',
  ['-FSr', outputPath, 'manifest.json', 'src'],
  { cwd: extensionRoot, encoding: 'utf8' },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || 'Extension packaging failed.\n');
  process.exit(result.status || 1);
}

console.log(outputPath);

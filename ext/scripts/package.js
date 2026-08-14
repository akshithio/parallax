const { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
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
const stagingDirectory = mkdtempSync(path.join(tmpdir(), 'parallax-extension-release-'));
let result;
try {
  cpSync(path.join(extensionRoot, 'manifest.json'), path.join(stagingDirectory, 'manifest.json'));
  cpSync(path.join(extensionRoot, 'src'), path.join(stagingDirectory, 'src'), { recursive: true });
  writeFileSync(
    path.join(stagingDirectory, 'src', 'build-config.js'),
    [
      '// Release packages keep verbose diagnostics disabled.',
      "Object.defineProperty(globalThis, '__parallaxBuildConfig', {",
      '  value: Object.freeze({ debug: false }),',
      '  configurable: false,',
      '  enumerable: false,',
      '  writable: false,',
      '});',
      '',
    ].join('\n'),
  );
  result = spawnSync(
    'zip',
    ['-FSr', outputPath, 'manifest.json', 'src'],
    { cwd: stagingDirectory, encoding: 'utf8' },
  );
} finally {
  rmSync(stagingDirectory, { recursive: true, force: true });
}

if (!result || result.status !== 0) {
  process.stderr.write(result?.stderr || result?.stdout || 'Extension packaging failed.\n');
  process.exit(result?.status || 1);
}

console.log(outputPath);

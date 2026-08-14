const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const packageInfo = require('../package.json')

test('unpacked development is verbose and release packages are quiet', () => {
  const developmentConfig = fs.readFileSync(path.join(root, 'src', 'build-config.js'), 'utf8')
  assert.match(developmentConfig, /debug:\s*true/)

  const packaged = spawnSync(process.execPath, ['scripts/package.js'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout)

  const archive = path.join(root, 'dist', `Parallax-Extension-${packageInfo.version}.zip`)
  const extracted = spawnSync('unzip', ['-p', archive, 'src/build-config.js'], {
    encoding: 'utf8',
  })
  assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout)
  assert.match(extracted.stdout, /debug:\s*false/)
  assert.doesNotMatch(extracted.stdout, /debug:\s*true/)

  const runtimeSource = spawnSync(
    'unzip',
    ['-p', archive, 'src/content.js', 'src/background.js'],
    { encoding: 'utf8' },
  )
  assert.equal(runtimeSource.status, 0, runtimeSource.stderr || runtimeSource.stdout)
  assert.doesNotMatch(runtimeSource.stdout, /console\.(?:warn|error)/)
  assert.doesNotMatch(runtimeSource.stdout, /extension context lost|showReloadWarning|__parallax_reload_warning/)
})

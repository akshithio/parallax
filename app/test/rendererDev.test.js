const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { findAvailablePort } = require('../lib/rendererDev');

test('skips occupied renderer ports instead of reusing their processes', async () => {
  const checked = [];
  const port = await findAvailablePort(3000, 4, async (candidate) => {
    checked.push(candidate);
    return candidate === 3002;
  });

  assert.equal(port, 3002);
  assert.deepEqual(checked, [3000, 3001, 3002]);
});

test('fails clearly when no renderer port is available', async () => {
  await assert.rejects(
    findAvailablePort(3000, 2, async () => false),
    /No available renderer port from 3000 to 3001/,
  );
});

test('desktop development owns its renderer process and isolates its cache', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.doesNotMatch(source, /reusing dev server|probeNextDev/);
  assert.match(source, /const NEXT_DEV_START_PORT = 3200/);
  assert.match(source, /findAvailablePort\(NEXT_DEV_START_PORT\)/);
  assert.match(source, /PARALLAX_NEXT_DIST_DIR: `\.next-dev-\$\{nextDevPort\}`/);
});

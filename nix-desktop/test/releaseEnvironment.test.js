const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_RELEASE_ENVIRONMENT,
  missingReleaseEnvironment,
} = require('../lib/releaseEnvironment');

test('release publication fails closed when signing credentials are absent', () => {
  assert.deepEqual(missingReleaseEnvironment({}), REQUIRED_RELEASE_ENVIRONMENT);
});

test('release publication accepts a complete signing environment', () => {
  const environment = Object.fromEntries(
    REQUIRED_RELEASE_ENVIRONMENT.map((name) => [name, `${name}-value`]),
  );
  assert.deepEqual(missingReleaseEnvironment(environment), []);
});

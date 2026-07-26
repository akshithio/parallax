const { missingReleaseEnvironment } = require('../lib/releaseEnvironment');

const missing = missingReleaseEnvironment(process.env);
if (missing.length > 0) {
  console.error(`Release environment is missing: ${missing.join(', ')}`);
  process.exit(1);
}

console.log('Release signing and publication environment is configured.');

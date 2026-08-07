const packageInfo = require('../package.json');

const expectedTag = `v${packageInfo.version}`;
const actualTag = String(process.env.GITHUB_REF_NAME || '');

if (actualTag !== expectedTag) {
  console.error(`Release tag ${actualTag || '(missing)'} does not match package version ${expectedTag}.`);
  process.exit(1);
}

console.log(`Release tag ${actualTag} matches package version ${packageInfo.version}.`);

const REQUIRED_RELEASE_ENVIRONMENT = [
  'GITHUB_REPOSITORY',
  'GH_TOKEN',
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
];

function missingReleaseEnvironment(environment) {
  return REQUIRED_RELEASE_ENVIRONMENT.filter((name) => !String(environment[name] || '').trim());
}

module.exports = {
  REQUIRED_RELEASE_ENVIRONMENT,
  missingReleaseEnvironment,
};

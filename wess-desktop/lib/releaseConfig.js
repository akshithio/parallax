function githubReleaseProvider(repository) {
  if (!repository) return null;
  const parts = String(repository).split('/');
  if (parts.length !== 2 || parts.some((part) => !part.trim())) return null;
  return {
    provider: 'github',
    owner: parts[0],
    repo: parts[1],
    releaseType: 'release',
  };
}

function createReleaseConfig(environment = process.env) {
  const provider = githubReleaseProvider(environment.GITHUB_REPOSITORY);
  return {
    appId: 'com.wess.desktop',
    productName: 'Wess',
    directories: {
      output: 'dist',
    },
    files: [
      'main.js',
      'preload.js',
      'preview-preload.js',
      'lib/**/*.js',
      'out/**/*',
      'package.json',
    ],
    asar: true,
    mac: {
      category: 'public.app-category.developer-tools',
      hardenedRuntime: true,
      notarize: true,
      target: ['dmg', 'zip'],
    },
    dmg: {
      artifactName: '${productName}-${version}-${arch}.${ext}',
    },
    artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
    publish: provider ? [provider] : undefined,
  };
}

module.exports = { createReleaseConfig, githubReleaseProvider };

export const REPOSITORY = process.env.WESS_GITHUB_REPOSITORY || 'akshithio/wess';
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;

export function chooseAsset(assets, kind) {
  const candidates = Array.isArray(assets) ? assets : [];
  if (kind === 'macos') {
    return candidates
      .filter((asset) => String(asset?.name || '').toLowerCase().endsWith('.dmg'))
      .sort((left, right) => {
        const leftUniversal = /universal/i.test(left.name) ? 1 : 0;
        const rightUniversal = /universal/i.test(right.name) ? 1 : 0;
        return rightUniversal - leftUniversal;
      })[0] || null;
  }
  if (kind === 'extension') {
    return candidates.find((asset) => (
      /extension/i.test(String(asset?.name || ''))
      && String(asset?.name || '').toLowerCase().endsWith('.zip')
    )) || null;
  }
  return null;
}

export function normalizeRelease(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const macos = chooseAsset(assets, 'macos');
  const extension = chooseAsset(assets, 'extension');
  return {
    available: true,
    version: String(release?.tag_name || '').replace(/^v/, ''),
    name: release?.name || release?.tag_name || 'Latest release',
    publishedAt: release?.published_at || null,
    pageUrl: release?.html_url || `${REPOSITORY_URL}/releases/latest`,
    downloads: {
      macos: macos ? {
        name: macos.name,
        size: Number(macos.size) || 0,
        url: macos.browser_download_url,
      } : null,
      extension: extension ? {
        name: extension.name,
        size: Number(extension.size) || 0,
        url: extension.browser_download_url,
      } : null,
    },
  };
}

export async function fetchLatestRelease(fetcher = fetch) {
  const response = await fetcher(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'wess-website',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed with ${response.status}.`);
  }
  return normalizeRelease(await response.json());
}

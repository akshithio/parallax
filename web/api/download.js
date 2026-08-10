import {
  chooseAsset,
  fetchLatestRelease,
  REPOSITORY_URL,
} from '../lib/github-release.js';

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).send('Method not allowed');
  }

  const queryKind = Array.isArray(request.query?.kind)
    ? request.query.kind[0]
    : request.query?.kind;
  const kind = queryKind === 'extension' ? 'extension' : 'macos';

  try {
    const release = await fetchLatestRelease();
    const asset = chooseAsset(
      Object.values(release.downloads)
        .filter(Boolean)
        .map((download) => ({
          name: download.name,
          browser_download_url: download.url,
        })),
      kind,
    );
    if (asset?.browser_download_url) {
      response.setHeader('Cache-Control', 'public, s-maxage=300');
      return response.redirect(307, asset.browser_download_url);
    }
  } catch {}

  return response.redirect(307, `${REPOSITORY_URL}/releases`);
}

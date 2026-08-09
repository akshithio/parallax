import { fetchLatestRelease, REPOSITORY_URL } from '../lib/github-release.js';

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'Method not allowed' });
  }

  response.setHeader(
    'Cache-Control',
    'public, s-maxage=300, stale-while-revalidate=3600',
  );
  try {
    return response.status(200).json(await fetchLatestRelease());
  } catch {
    return response.status(200).json({
      available: false,
      version: '',
      pageUrl: `${REPOSITORY_URL}/releases`,
      downloads: { macos: null, extension: null },
    });
  }
}

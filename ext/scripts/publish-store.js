const { readFileSync } = require('node:fs');
const path = require('node:path');
const packageInfo = require('../package.json');

const API_ROOT = 'https://chromewebstore.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REQUIRED_ENV = [
  'CWS_CLIENT_ID',
  'CWS_CLIENT_SECRET',
  'CWS_REFRESH_TOKEN',
  'CWS_PUBLISHER_ID',
  'CWS_EXTENSION_ID',
];

function requiredEnvironment(environment = process.env) {
  const missing = REQUIRED_ENV.filter((name) => !environment[name]);
  if (missing.length > 0) {
    throw new Error(`Missing Chrome Web Store configuration: ${missing.join(', ')}`);
  }
  return Object.fromEntries(REQUIRED_ENV.map((name) => [name, environment[name]]));
}

async function jsonResponse(response, action) {
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${action} returned a non-JSON response (${response.status}).`);
  }
  if (!response.ok) {
    const detail = body.error?.message || body.error_description || text || response.statusText;
    throw new Error(`${action} failed (${response.status}): ${detail}`);
  }
  return body;
}

async function accessToken(configuration, request = fetch) {
  const form = new URLSearchParams({
    client_id: configuration.CWS_CLIENT_ID,
    client_secret: configuration.CWS_CLIENT_SECRET,
    refresh_token: configuration.CWS_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const response = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const body = await jsonResponse(response, 'OAuth token refresh');
  if (!body.access_token) throw new Error('OAuth token refresh returned no access token.');
  return body.access_token;
}

function itemName(configuration) {
  return `publishers/${configuration.CWS_PUBLISHER_ID}/items/${configuration.CWS_EXTENSION_ID}`;
}

async function waitForUpload(name, token, request = fetch) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const response = await request(`${API_ROOT}/v2/${name}:fetchStatus`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await jsonResponse(response, 'Chrome Web Store upload status');
    const state = body.lastAsyncUploadState;
    if (state === 'SUCCEEDED') return body;
    if (state === 'FAILED' || state === 'NOT_FOUND') {
      throw new Error(`Chrome Web Store upload ended in state ${state}.`);
    }
  }
  throw new Error('Chrome Web Store upload was still in progress after one minute.');
}

async function publishStoreUpdate({ environment = process.env, request = fetch } = {}) {
  const configuration = requiredEnvironment(environment);
  const name = itemName(configuration);
  const packagePath = path.join(
    __dirname,
    '..',
    'dist',
    `Parallax-Extension-${packageInfo.version}.zip`,
  );
  const archive = readFileSync(packagePath);
  const token = await accessToken(configuration, request);

  const uploadResponse = await request(`${API_ROOT}/upload/v2/${name}:upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/zip',
    },
    body: archive,
  });
  const upload = await jsonResponse(uploadResponse, 'Chrome Web Store upload');
  if (upload.uploadState === 'IN_PROGRESS' || upload.uploadState === 'UPLOAD_IN_PROGRESS') {
    await waitForUpload(name, token, request);
  } else if (upload.uploadState !== 'SUCCEEDED') {
    throw new Error(`Chrome Web Store upload ended in state ${upload.uploadState || 'unknown'}.`);
  }
  if (upload.crxVersion && upload.crxVersion !== packageInfo.version) {
    throw new Error(
      `Chrome Web Store accepted version ${upload.crxVersion}, expected ${packageInfo.version}.`,
    );
  }

  const publishResponse = await request(`${API_ROOT}/v2/${name}:publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      publishType: 'DEFAULT_PUBLISH',
      skipReview: false,
      blockOnWarnings: true,
    }),
  });
  const publication = await jsonResponse(publishResponse, 'Chrome Web Store submission');
  if (!['PENDING_REVIEW', 'PUBLISHED'].includes(publication.state)) {
    throw new Error(`Chrome Web Store submission ended in state ${publication.state || 'unknown'}.`);
  }
  console.log(
    `Submitted Parallax ${packageInfo.version} to the Chrome Web Store (${publication.state}).`,
  );
  return { upload, publication };
}

if (require.main === module) {
  publishStoreUpdate().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  accessToken,
  itemName,
  jsonResponse,
  publishStoreUpdate,
  requiredEnvironment,
};

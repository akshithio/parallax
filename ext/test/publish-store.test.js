const test = require('node:test');
const assert = require('node:assert/strict');
const {
  accessToken,
  itemName,
  jsonResponse,
  requiredEnvironment,
} = require('../scripts/publish-store.js');

const configuration = {
  CWS_CLIENT_ID: 'client-id',
  CWS_CLIENT_SECRET: 'client-secret',
  CWS_REFRESH_TOKEN: 'refresh-token',
  CWS_PUBLISHER_ID: 'publisher-id',
  CWS_EXTENSION_ID: 'extension-id',
};

function response(body, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    async text() { return JSON.stringify(body); },
  };
}

test('requires every store credential and identifier', () => {
  assert.throws(
    () => requiredEnvironment({ CWS_CLIENT_ID: 'client-id' }),
    /CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_PUBLISHER_ID, CWS_EXTENSION_ID/,
  );
  assert.deepEqual(requiredEnvironment(configuration), configuration);
});

test('builds the version-two item resource name', () => {
  assert.equal(itemName(configuration), 'publishers/publisher-id/items/extension-id');
});

test('refreshes an access token without exposing credentials in the URL', async () => {
  let request = null;
  const token = await accessToken(configuration, async (url, options) => {
    request = { url, options };
    return response({ access_token: 'access-token' });
  });

  assert.equal(token, 'access-token');
  assert.equal(request.url, 'https://oauth2.googleapis.com/token');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.body.get('client_secret'), 'client-secret');
  assert.doesNotMatch(request.url, /client-secret|refresh-token/);
});

test('surfaces the Web Store error message', async () => {
  await assert.rejects(
    () => jsonResponse(response({ error: { message: 'version already exists' } }, {
      ok: false,
      status: 400,
    }), 'Chrome Web Store upload'),
    /version already exists/,
  );
});

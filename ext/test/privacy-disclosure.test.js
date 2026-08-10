const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const popup = fs.readFileSync(path.join(root, 'src', 'popup.html'), 'utf8');
const popupScript = fs.readFileSync(path.join(root, 'src', 'popup.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'src', 'background.js'), 'utf8');

test('requires an informed user action before enabling the local bridge', () => {
  assert.match(popup, /prompts and attachments you choose/);
  assert.match(popup, /not sent to the developer/);
  assert.match(popup, /Enable local bridge/);
  assert.match(popup, /https:\/\/parallax\.akshith\.io\/privacy/);
  assert.match(popupScript, /set_bridge_enabled/);
  assert.match(background, /parallax_bridge_enabled/);
  assert.match(background, /if \(!bridgeEnabled\) return/);
  assert.match(background, /if \(bridgeEnabled\) startBridge\(\)/);
});

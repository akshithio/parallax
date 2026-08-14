const EXTENSION_RUNTIME_FILE = /(?:^|\/)(?:manifest\.json|src\/.*\.(?:js|json|html|css|png|svg))$/;

function normalizeExtensionPath(file) {
  return String(file || '').replaceAll('\\', '/');
}

function isExtensionRuntimeFile(file) {
  return EXTENSION_RUNTIME_FILE.test(normalizeExtensionPath(file));
}

module.exports = { isExtensionRuntimeFile, normalizeExtensionPath };

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function setText(selector, value) {
  const node = document.querySelector(selector);
  if (node && value) node.textContent = value;
}

function clearPlaceholder(selector) {
  const node = document.querySelector(selector);
  if (node) node.textContent = '';
}

async function hydrateRelease() {
  const status = document.querySelector('[data-release-state]');
  try {
    const response = await fetch('/api/release', {
      headers: { Accept: 'application/json' },
    });
    const release = await response.json();
    if (!release.available) {
      status.textContent = 'First signed release coming soon';
      clearPlaceholder('[data-release-macos-size]');
      clearPlaceholder('[data-release-extension-size]');
      return;
    }

    const macos = release.downloads?.macos;
    const extension = release.downloads?.extension;

    status.textContent = [
      release.version ? `Version ${release.version}` : '',
      formatDate(release.publishedAt),
    ].filter(Boolean).join(' · ') || 'Latest release';

    const macosSize = formatBytes(macos?.size);
    const extensionSize = formatBytes(extension?.size);
    if (macosSize) setText('[data-release-macos-size]', macosSize);
    else clearPlaceholder('[data-release-macos-size]');
    if (extensionSize) setText('[data-release-extension-size]', extensionSize);
    else clearPlaceholder('[data-release-extension-size]');
  } catch {
    status.textContent = 'View the latest release on GitHub';
    clearPlaceholder('[data-release-macos-size]');
    clearPlaceholder('[data-release-extension-size]');
  }
}

hydrateRelease();

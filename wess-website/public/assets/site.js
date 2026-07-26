function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  return `${Math.round(bytes / 1024 / 1024)} MB`;
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
      return;
    }

    const macos = release.downloads?.macos;
    const details = [
      release.version ? `Version ${release.version}` : '',
      macos ? formatBytes(macos.size) : '',
      'Universal',
    ].filter(Boolean);
    status.textContent = details.join(' · ');
  } catch {
    status.textContent = 'View the latest release on GitHub';
  }
}

function adaptDownloadLabel() {
  if (/Mac|iPhone|iPad/.test(navigator.platform)) return;
  const label = document.querySelector('[data-macos-download] small');
  if (label) label.textContent = 'View download for';
}

hydrateRelease();
adaptDownloadLabel();

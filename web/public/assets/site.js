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

    status.textContent = [
      release.version ? `Version ${release.version}` : '',
      formatDate(release.publishedAt),
    ].filter(Boolean).join(' · ') || 'Latest release';
  } catch {
    status.textContent = 'View the latest release on GitHub';
  }
}

hydrateRelease();

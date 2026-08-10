/*
  Which dock icon to show.

  The packaged .icns is fixed at build time, but the dock tile can be swapped at
  runtime, so Settings offers a light plate and a dark plate. "system" follows
  the OS appearance so the tile matches the rest of the dock.

  Pure functions here; main.js owns the Electron calls.
*/

const ICON_PREFERENCES = ['system', 'light', 'dark'];

const ICON_FILES = {
  light: 'icon-light.png',
  dark: 'icon-dark.png',
};

/** Anything unrecognised, including undefined, falls back to following the OS. */
function normalizePreference(preference) {
  return ICON_PREFERENCES.includes(preference) ? preference : 'system';
}

/** Resolve a stored preference plus the current OS appearance to one variant. */
function resolveVariant(preference, systemPrefersDark) {
  const normalized = normalizePreference(preference);
  if (normalized === 'system') return systemPrefersDark ? 'dark' : 'light';
  return normalized;
}

/** File name inside build/ for a resolved variant. */
function iconFileFor(variant) {
  return ICON_FILES[variant] || ICON_FILES.dark;
}

module.exports = {
  ICON_PREFERENCES,
  normalizePreference,
  resolveVariant,
  iconFileFor,
};

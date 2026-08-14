import { test, expect } from '@playwright/test';

test('presents the argument and the hydrated release on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: /Work through a repository/ }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download for macOS' }).first()).toHaveAttribute(
    'href',
    '/download/macos',
  );
  await expect(page).toHaveTitle('Parallax');
  await expect(page.getByRole('link', { name: 'Get the Chrome extension' })).toHaveAttribute(
    'href',
    'https://chromewebstore.google.com/detail/parallax/bfnlhalnojbjoipblfnhhljffajanaei?authuser=0&hl=en-GB',
  );
  await expect(page.getByText('Version 0.1.1 · 6 August 2026')).toBeVisible();
  await expect(page.getByRole('heading', { name: /What you download/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Install once/ })).toHaveCount(0);
});

test('keeps the download path usable on mobile without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  await expect(page.getByRole('link', { name: 'GitHub' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download for macOS' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /What you download|Install once/ })).toHaveCount(0);

  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
});

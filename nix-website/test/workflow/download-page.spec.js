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
  await expect(page.getByText('Version 0.1.1 · 6 August 2026')).toBeVisible();
  await expect(page.getByRole('cell', { name: '99 MB' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '64 KB' })).toBeVisible();
});

test('keeps the download path usable on mobile without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  await expect(page.getByRole('link', { name: 'GitHub' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download for macOS' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /Install once/ })).toBeVisible();

  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
});

import { test, expect } from '@playwright/test';

test('presents the product and hydrated macOS release on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Stay close to the work.' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Download for macOS/ })).toHaveAttribute(
    'href',
    '/download/macos',
  );
  await expect(page.getByText('Version 0.1.0 · 99 MB · Universal')).toBeVisible();
  await expect(page.getByLabel('Wess desktop application preview')).toBeVisible();
});

test('keeps navigation and download actions usable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  await expect(page.getByRole('link', { name: 'GitHub' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Download for macOS/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Install once/ })).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('overflow-x', 'hidden');
});

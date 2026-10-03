import { expect, test } from '@playwright/test';

test('UI-001 shell navigation, focus, and responsive layout work at target sizes', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.setViewportSize({ width: 1280, height: 812 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Foundation', exact: true })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('Kerangka aplikasi siap dikembangkan.');
  await expect(page.getByRole('progressbar', { name: 'Loading page' })).toBeHidden();

  const desktopNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(desktopNavigation).toBeVisible();
  const navigationBounds = await desktopNavigation.boundingBox();
  const mainBounds = await page.getByRole('main').boundingBox();
  if (!navigationBounds || !mainBounds) throw new Error('The desktop shell landmarks did not render.');
  expect(navigationBounds.x + navigationBounds.width).toBeLessThanOrEqual(mainBounds.x);
  const readinessLink = desktopNavigation.getByRole('link', { name: 'Kesiapan' });
  await expect(readinessLink).toHaveAttribute('href', '/');
  expect(await readinessLink.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await readinessLink.click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Foundation', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('ui-shell-desktop.png'), fullPage: true });

  await page.goto('/unknown-route');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('main')).toBeFocused();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await expect(page.getByRole('progressbar', { name: 'Loading page' })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('ui-shell-mobile.png'), fullPage: true });

  const skipLink = page.getByRole('link', { name: 'Ke konten utama' });
  const openNavigation = page.getByRole('button', { name: 'Buka navigasi' });
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Tab');
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  expect(
    await skipLink.evaluate((element) => {
      const style = getComputedStyle(element);
      return style.boxShadow !== 'none' || style.outlineStyle !== 'none';
    }),
  ).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();

  await page.reload();
  await expect(page.getByRole('progressbar', { name: 'Loading page' })).toBeHidden();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Tab');
  await expect(skipLink).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(openNavigation).toBeFocused();
  await page.keyboard.press('Enter');

  const mobileDialog = page.getByRole('dialog', { name: 'Buka navigasi' });
  await expect(mobileDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(mobileDialog).toBeHidden();
  await expect(openNavigation).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(mobileDialog).toBeVisible();
  const closeNavigation = mobileDialog.getByRole('button', { name: 'Tutup navigasi' });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await closeNavigation.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(closeNavigation).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(mobileDialog).toBeHidden();
  await expect(openNavigation).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(mobileDialog).toBeVisible();
  const mobileReadinessLink = mobileDialog.getByRole('link', { name: 'Kesiapan' });
  expect(await mobileReadinessLink.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await mobileReadinessLink.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(mobileReadinessLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(mobileDialog).toBeHidden();
  await expect(openNavigation).toBeFocused();
  await expect(page).toHaveURL('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('UI-002 the static root page does not call the backend API', async ({ page }) => {
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api')) apiRequests.push(request.url());
  });

  await page.setViewportSize({ width: 1280, height: 812 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Foundation', exact: true })).toBeVisible();

  expect(apiRequests).toEqual([]);
});

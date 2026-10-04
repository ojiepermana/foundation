import { expect, test, type Locator, type Page, type Response } from '@playwright/test';
import { expectNothingClipped as expectLayout } from './layout';
import { readinessBodyAt, recordReadinessBodies } from './response-body';

// READY-006 (spec 0006, AC-3, AC-7, and AC-8): the backend webServer of playwright.config.ts runs with an empty
// DATABASE_URL, so every check goes browser → SDK → proxy /api → backend without a pool and ends in 503. The state
// `available` at 375×812 needs a real database and belongs to READY-009.
const unavailableText = 'Database tidak tersedia. Pastikan PostgreSQL berjalan, lalu periksa ulang.';
const readinessUrl = 'http://127.0.0.1:8889/api/readiness';

// Browser context decided by spec 0006 (*Value sourcing*, Test browser row).
test.use({ locale: 'id-ID', timezoneId: 'Asia/Jakarta' });

interface Traffic {
  /** Every request whose path starts with /api, in order. */
  apiRequests: string[];
  readinessResponses: Response[];
  pageErrors: string[];
}

/** Starts recording before the first navigation; the page also records every readiness body (see response-body.ts). */
async function watch(page: Page): Promise<Traffic> {
  await recordReadinessBodies(page);
  const traffic: Traffic = { apiRequests: [], readinessResponses: [], pageErrors: [] };
  page.on('pageerror', (error) => traffic.pageErrors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api')) traffic.apiRequests.push(request.url());
  });
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/readiness') traffic.readinessResponses.push(response);
  });
  return traffic;
}

const isReadinessResponse = (response: Response) => new URL(response.url()).pathname === '/api/readiness';

/** Exactly one item of the navigation carries `aria-current`, and it is the named link. */
async function expectCurrentItem(navigation: Locator, current: 'Beranda' | 'Kesiapan'): Promise<void> {
  const other = current === 'Beranda' ? 'Kesiapan' : 'Beranda';
  await expect(navigation.getByRole('link', { name: current, exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(navigation.getByRole('link', { name: other, exact: true })).not.toHaveAttribute('aria-current');
  await expect(navigation.locator('[aria-current]')).toHaveCount(1);
}

/**
 * The 503 went through the same origin proxy with `no-store`, and the page shows it without a migration count. The
 * body is the one the page received, read inside the page, because Chromium can drop it from DevTools (response-body.ts).
 */
async function expectUnavailable(page: Page, traffic: Traffic, response: Response): Promise<void> {
  expect(response.url()).toBe(readinessUrl);
  expect(response.request().method()).toBe('GET');
  expect(response.status()).toBe(503);
  expect(response.headers()['cache-control']).toBe('no-store');
  const index = traffic.readinessResponses.indexOf(response);
  expect(index, 'watch() saw this readiness response').toBeGreaterThanOrEqual(0);
  const body = (await readinessBodyAt(page, index)) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(['checkedAt', 'status']);
  expect(body['status']).toBe('unavailable');
  const checkedAt = body['checkedAt'] as string;

  const main = page.getByRole('main');
  await expect(main.getByRole('status')).toHaveText(unavailableText);
  await expect(main.getByRole('button', { name: 'Periksa ulang' })).not.toHaveAttribute('aria-disabled');
  const time = main.locator('time');
  await expect(time).toHaveCount(1);
  await expect(time).toHaveAttribute('datetime', checkedAt);
  const expectedText = await page.evaluate(
    (value) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)),
    checkedAt,
  );
  await expect(time).toHaveText(expectedText);
  await expect(main.locator('dt')).toHaveText(['Waktu pemeriksaan']);
  await expect(main.getByText('Migration terapan')).toHaveCount(0);
}

/** No horizontal page overflow, and the `unavailable` state shows its status, dt, dd, time, and button unclipped. */
async function expectNothingClipped(page: Page): Promise<void> {
  await expectLayout(page, ['status', 'dt 0', 'dd 0', 'time', 'button']);
}

/** Tab reaches `Periksa ulang` with a visible focus indicator; Enter and Space each send one check and keep the focus. */
async function expectKeyboardRecheck(page: Page, traffic: Traffic): Promise<void> {
  const button = page.getByRole('main').getByRole('button', { name: 'Periksa ulang' });
  const indicator = () =>
    button.evaluate((element) => {
      const style = getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, boxShadow: style.boxShadow };
    });

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(button).not.toBeFocused();
  const unfocused = await indicator();
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (await button.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(button).toBeFocused();
  const focused = await indicator();
  expect(focused.outlineStyle !== 'none' || focused.boxShadow !== 'none').toBe(true);
  expect(focused).not.toEqual(unfocused);

  for (const key of ['Enter', 'Space']) {
    const requestsBefore = traffic.apiRequests.length;
    const answer = page.waitForResponse(isReadinessResponse);
    await page.keyboard.press(key);
    const response = await answer;
    await expectUnavailable(page, traffic, response);
    await expect(button).toBeFocused();
    expect(traffic.apiRequests.slice(requestsBefore), `${key} sends exactly one check`).toEqual([readinessUrl]);
  }
}

test('READY-006 desktop 1280×812: Kesiapan from the navigation, 503 through the proxy, layout, and keyboard', async ({ page }, testInfo) => {
  const traffic = await watch(page);
  await page.setViewportSize({ width: 1280, height: 812 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Foundation', exact: true })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
  expect(traffic.apiRequests).toEqual([]);

  const firstCheck = page.waitForResponse(isReadinessResponse);
  await navigation.getByRole('link', { name: 'Kesiapan', exact: true }).click();
  await expect(page).toHaveURL('/kesiapan');
  await expect(page.getByRole('heading', { level: 1, name: 'Kesiapan', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Database', exact: true })).toBeVisible();
  await expectCurrentItem(navigation, 'Kesiapan');
  await expectUnavailable(page, traffic, await firstCheck);
  expect(traffic.apiRequests).toEqual([readinessUrl]);
  expect(traffic.readinessResponses).toHaveLength(1);

  await expectNothingClipped(page);
  await page.screenshot({ path: testInfo.outputPath('readiness-unavailable-desktop.png'), fullPage: true });

  await expectKeyboardRecheck(page, traffic);
  expect(traffic.apiRequests).toEqual([readinessUrl, readinessUrl, readinessUrl]);
  await expectNothingClipped(page);

  await navigation.getByRole('link', { name: 'Beranda', exact: true }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Foundation', exact: true })).toBeVisible();
  await expectCurrentItem(navigation, 'Beranda');
  expect(traffic.apiRequests).toEqual([readinessUrl, readinessUrl, readinessUrl]);
  expect(traffic.pageErrors).toEqual([]);
});

test('READY-006 mobile 375×812: Kesiapan through the navigation drawer, 503 through the proxy, layout, and keyboard', async ({ page }, testInfo) => {
  const traffic = await watch(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Foundation', exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Loading page' })).toBeHidden();
  expect(traffic.apiRequests).toEqual([]);

  const openNavigation = page.getByRole('button', { name: 'Buka navigasi' });
  const drawer = page.getByRole('dialog', { name: 'Buka navigasi' });
  await openNavigation.click();
  await expect(drawer).toBeVisible();

  const firstCheck = page.waitForResponse(isReadinessResponse);
  await drawer.getByRole('link', { name: 'Kesiapan', exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(page).toHaveURL('/kesiapan');
  await expect(page.getByRole('heading', { level: 1, name: 'Kesiapan', exact: true })).toBeVisible();
  await expectUnavailable(page, traffic, await firstCheck);
  expect(traffic.apiRequests).toEqual([readinessUrl]);

  await openNavigation.click();
  await expect(drawer).toBeVisible();
  await expectCurrentItem(drawer, 'Kesiapan');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  await expectNothingClipped(page);
  await page.screenshot({ path: testInfo.outputPath('readiness-unavailable-mobile.png'), fullPage: true });

  await expectKeyboardRecheck(page, traffic);
  expect(traffic.apiRequests).toEqual([readinessUrl, readinessUrl, readinessUrl]);
  await expectNothingClipped(page);

  await openNavigation.click();
  await expect(drawer).toBeVisible();
  await drawer.getByRole('link', { name: 'Beranda', exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Foundation', exact: true })).toBeVisible();
  await openNavigation.click();
  await expect(drawer).toBeVisible();
  await expectCurrentItem(drawer, 'Beranda');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  expect(traffic.apiRequests).toEqual([readinessUrl, readinessUrl, readinessUrl]);
  expect(traffic.pageErrors).toEqual([]);
});

// AC-7 on the first load of /kesiapan: the page sends exactly one check, and the item that does not match (Beranda)
// never carries aria-current. Kesiapan itself may look active without aria-current on this first load (the known
// library defect described below), so these tests assert nothing about Kesiapan's attribute beyond "at most one item
// is current, and never Beranda".
for (const viewport of [{ width: 1280, height: 812 }, { width: 375, height: 812 }]) {
  test(`READY-006 opening /kesiapan directly at ${viewport.width}×${viewport.height}: one check through the proxy, and Beranda never carries aria-current`, async ({ page }) => {
    const traffic = await watch(page);
    await page.setViewportSize(viewport);
    const firstCheck = page.waitForResponse(isReadinessResponse);
    await page.goto('/kesiapan');
    await expect(page.getByRole('heading', { level: 1, name: 'Kesiapan', exact: true })).toBeVisible();
    await expectUnavailable(page, traffic, await firstCheck);
    await expect(page.getByRole('progressbar', { name: 'Loading page' })).toBeHidden();

    let navigation = page.getByRole('navigation', { name: 'Primary navigation' });
    if (viewport.width < 768) {
      await page.getByRole('button', { name: 'Buka navigasi' }).click();
      navigation = page.getByRole('dialog', { name: 'Buka navigasi' });
      await expect(navigation).toBeVisible();
    }
    const home = navigation.getByRole('link', { name: 'Beranda', exact: true });
    await expect(home).toHaveAttribute('href', '/');
    await expect(navigation.getByRole('link', { name: 'Kesiapan', exact: true })).toHaveAttribute('href', '/kesiapan');
    await expect(home).not.toHaveAttribute('aria-current');
    const current = navigation.locator('[aria-current]');
    expect(await current.count()).toBeLessThanOrEqual(1);
    if ((await current.count()) === 1) await expect(current).toHaveAccessibleName('Kesiapan');

    // Opening the navigation sends nothing: the single check stays the only API request (no polling is proven with
    // fake time in READY-005, so no fixed wait is needed here).
    expect(traffic.apiRequests).toEqual([readinessUrl]);
    expect(traffic.pageErrors).toEqual([]);
  });
}

// Known library defect, kept visible by a canary (spec 0006, AC-7, rationale decisions 47 to 50). On the first load
// of a URL the matching navigation item can look active without aria-current: the NavigationItem anchor of
// @ojiepermana/angular 22.1.14 binds [attr.aria-current] and also carries RouterLinkActive without
// ariaCurrentWhenActive, so RouterLinkActive.update() of @angular/router 22.2.0 removes the attribute after the first
// render, and the binding never writes it back while its value stays the same. Picking an item from the navigation
// (checked in the two tests above) sets the attribute correctly. The application never writes, removes, or fixes
// aria-current; the fix belongs to a library release (spec 0006, Follow-up).
//
// What these tests prove as criteria: the intro page renders, no /api request and no page error happen, and the
// item that does not match (Kesiapan) never carries aria-current. The last assertion is the canary: it states that
// the defect is still there, so verify, test, review, and release reports record it as a known library defect, never
// as evidence of aria-current on first load.
//
// Reversal, once a library or router version with the fix is installed and the canary fails: change the Beranda
// assertion to toHaveAttribute('aria-current', 'page') and add exactly one [aria-current] in the navigation, rename
// each test back to `READY-006 opening / directly at <width>×<height> marks only Beranda with aria-current`, and
// restore the first load sentence of AC-7 as spec 0006 Follow-up describes.
for (const viewport of [{ width: 1280, height: 812 }, { width: 375, height: 812 }]) {
  test(`READY-006 opening / directly at ${viewport.width}×${viewport.height}: no other item is current, and Beranda lacks aria-current (known library defect)`, async ({ page }) => {
    const traffic = await watch(page);
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Foundation', exact: true })).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Loading page' })).toBeHidden();
    let navigation = page.getByRole('navigation', { name: 'Primary navigation' });
    if (viewport.width < 768) {
      await page.getByRole('button', { name: 'Buka navigasi' }).click();
      navigation = page.getByRole('dialog', { name: 'Buka navigasi' });
      await expect(navigation).toBeVisible();
    }
    const home = navigation.getByRole('link', { name: 'Beranda', exact: true });
    const readiness = navigation.getByRole('link', { name: 'Kesiapan', exact: true });
    await expect(home).toHaveAttribute('href', '/');
    await expect(readiness).toHaveAttribute('href', '/kesiapan');
    await expect(readiness).not.toHaveAttribute('aria-current');
    expect(traffic.apiRequests).toEqual([]);
    expect(traffic.pageErrors).toEqual([]);

    // Canary for the known library defect: waits until RouterLinkActive has removed the attribute from Beranda.
    await expect(home).not.toHaveAttribute('aria-current');
  });
}

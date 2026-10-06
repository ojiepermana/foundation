import { expect, test, type Page } from '@playwright/test';
import { TEST_ACCOUNT_NAMES } from '../../orchestration/auth-accounts';
import { recordSessionTokens } from '../auth/session-tokens';

// AUTH-013 (spec 0014, AC-12 and AC-13): the production build served by the edge of the deployment topology that
// `test:deployment:real` starts, in the same Playwright invocation as DEP-006. The first test account (made by the
// `migrate` job, check auth_account_job) signs in through /masuk; the session cookie must be the `__Host-` cookie of the
// production composition; /akun shows the account under the final CSP and Trusted Types; the navigation holds Beranda
// and Akun; Keluar ends the session. As in DEP-006, a `securitypolicyviolation` listener runs before every document,
// every origin outside the edge goes through page.route (the two Google Fonts origins answered empty, any other origin
// aborted and failing), and console errors and page errors are collected. The only console error allowed is the one
// Chromium writes for the expected 401 after the sign out. The account comes only through
// FOUNDATION_DEPLOY_AUTH_ACCOUNT_EMAIL and FOUNDATION_DEPLOY_AUTH_ACCOUNT_PASSWORD; the token and its CSRF token are only
// fingerprinted (*Sidik token uji*). This file runs on Node, so it imports no Bun module.

const missingEdge = 'AUTH-013 needs FOUNDATION_DEPLOY_EDGE_URL, the HTTPS edge URL that bun run test:deployment:real starts';
const fontsCss = 'https://fonts.googleapis.com';
const fontsFiles = 'https://fonts.gstatic.com';
const expected401 = /^Failed to load resource: the server responded with a status of 401\b/;

/** The edge origin, or a failure with a fixed message, never a skip. */
function edgeOrigin(): string {
  const value = process.env['FOUNDATION_DEPLOY_EDGE_URL'];
  if (value === undefined || value === '') throw new Error(missingEdge);
  return new URL(value).origin;
}

/** A required variable of the orchestration; a missing one fails with a fixed message and never prints a value. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is missing; run this spec through test:deployment:real`);
  return value;
}

interface Traffic {
  requestedOrigins: string[];
  refusedOrigins: string[];
  /** Every request of the edge whose path starts with /api/, as `METHOD /path`. */
  api: string[];
  consoleErrors: string[];
  pageErrors: string[];
}

async function watch(page: Page, edge: string): Promise<Traffic> {
  const traffic: Traffic = { requestedOrigins: [], refusedOrigins: [], api: [], consoleErrors: [], pageErrors: [] };
  await page.addInitScript(() => {
    const target = window as unknown as { __foundationViolations: string[] };
    target.__foundationViolations = [];
    document.addEventListener(
      'securitypolicyviolation',
      (event) => target.__foundationViolations.push(`${event.effectiveDirective} ${event.blockedURI}`.trim()),
      true,
    );
  });
  page.on('console', (message) => {
    if (message.type() === 'error') traffic.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => traffic.pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === edge && url.pathname.startsWith('/api/')) traffic.api.push(`${request.method()} ${url.pathname}`);
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === edge) {
      await route.continue();
      return;
    }
    traffic.requestedOrigins.push(url.origin);
    if (url.origin === fontsCss) await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    else if (url.origin === fontsFiles) await route.fulfill({ status: 200, contentType: 'font/woff2', body: Buffer.alloc(0) });
    else {
      traffic.refusedOrigins.push(url.origin);
      await route.abort();
    }
  });
  return traffic;
}

async function violations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __foundationViolations?: string[] }).__foundationViolations ?? ['listener missing']);
}

test('AUTH-013 production through the edge: sign in sets the __Host- session cookie, /akun shows the account under the final CSP, the navigation holds Beranda and Akun, and Keluar ends the session', async ({ page, context }) => {
  const edge = edgeOrigin();
  const email = required('FOUNDATION_DEPLOY_AUTH_ACCOUNT_EMAIL');
  const password = required('FOUNDATION_DEPLOY_AUTH_ACCOUNT_PASSWORD');
  const traffic = await watch(page, edge);
  await page.setViewportSize({ width: 1280, height: 812 });
  const main = page.getByRole('main');
  const navigation = page.getByRole('navigation', { name: 'Primary navigation' });

  await page.goto(`${edge}/masuk`, { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(`${edge}/masuk`);
  await expect(main.getByRole('heading', { level: 1, name: 'Masuk', exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Loading page' })).toBeHidden();
  // The production navigation: Beranda and Akun only, and /masuk calls no API when it opens.
  const links = navigation.getByRole('link');
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAccessibleName('Beranda');
  await expect(links.nth(1)).toHaveAccessibleName('Akun');
  await expect(links.nth(1)).toHaveAttribute('href', '/akun');
  expect(traffic.api).toEqual([]);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  const signedIn = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/session' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  const answer = await signedIn;
  expect(answer.status()).toBe(200);
  expect(answer.headers()['cache-control']).toBe('no-store');
  await expect(page).toHaveURL(`${edge}/akun`);
  await expect(main.getByRole('heading', { level: 2, name: 'Profil', exact: true })).toBeVisible();
  await expect(main.locator('dd').first()).toHaveText(TEST_ACCOUNT_NAMES[0]);
  await expect(main.locator('dd').nth(1)).toHaveText(email);
  await expect(main.getByRole('heading', { level: 2, name: 'Sesi aktif', exact: true })).toBeVisible();
  await expect(main.getByRole('listitem').filter({ hasText: 'Sesi ini' })).toHaveCount(1);

  // *Cookie sesi* production: the __Host- name, Secure, HttpOnly, SameSite Strict, Path /, a host only cookie without
  // an expiry (a browser session cookie). Its token and CSRF token are fingerprinted, never kept.
  const session = (await context.cookies()).filter((cookie) => cookie.name.endsWith('foundation_session'));
  expect(session.map(({ name, domain, path, secure, httpOnly, sameSite, expires }) => ({ name, domain, path, secure, httpOnly, sameSite, expires }))).toEqual([
    { name: '__Host-foundation_session', domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Strict', expires: -1 },
  ]);
  expect(await recordSessionTokens(context)).toBe(1);
  // No auth value in script readable storage or document.cookie; key names are reported, never values.
  const storage = await page.evaluate(async ([accountEmail, accountPassword]) => {
    const authLike = (text: string) => text.includes(accountEmail!) || text.includes(accountPassword!)
      || /csrf|token|session|password|auth/i.test(text) || /(^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{43}([^A-Za-z0-9_-]|$)/.test(text);
    const flagged = (store: Storage) => Object.keys(store).filter((key) => authLike(`${key}=${store.getItem(key) ?? ''}`));
    return {
      local: flagged(localStorage),
      session: flagged(sessionStorage),
      indexedDb: (await indexedDB.databases()).map((database) => database.name ?? ''),
      cookie: document.cookie.includes('foundation_session'),
    };
  }, [email, password]);
  expect(storage).toEqual({ local: [], session: [], indexedDb: [], cookie: false });

  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 812 });
    await expect(main.getByRole('heading', { level: 2, name: 'Sesi aktif', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${width}×812`).toBe(true);
  }

  // Keluar ends the session through the edge and removes the cookie; /akun then moves to /masuk with the expired notice.
  const signedOut = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/session' && response.request().method() === 'DELETE');
  await main.getByRole('button', { name: 'Keluar', exact: true }).click();
  expect((await signedOut).status()).toBe(204);
  await expect(page).toHaveURL(`${edge}/masuk`);
  await expect(main.getByRole('status')).toHaveText('Anda sudah keluar.');
  expect((await context.cookies()).filter((cookie) => cookie.name.endsWith('foundation_session'))).toEqual([]);
  await navigation.getByRole('link', { name: 'Akun', exact: true }).click();
  await expect(page).toHaveURL(`${edge}/masuk`);
  await expect(main.getByRole('status')).toHaveText('Sesi Anda berakhir. Masuk lagi untuk melanjutkan.');

  expect(traffic.api).toEqual([
    'POST /api/auth/session', 'GET /api/auth/session', 'GET /api/auth/sessions',
    'DELETE /api/auth/session',
    'GET /api/auth/session',
  ]);
  expect(await violations(page)).toEqual([]);
  expect(traffic.consoleErrors.filter((text) => !expected401.test(text))).toEqual([]);
  expect(traffic.pageErrors).toEqual([]);
  expect(traffic.refusedOrigins).toEqual([]);
  for (const origin of traffic.requestedOrigins) expect([fontsCss, fontsFiles]).toContain(origin);
});

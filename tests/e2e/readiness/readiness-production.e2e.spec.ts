import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile, stat } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// READY-007 (spec 0006, AC-9): the production build of `bun run build:frontend` does not register the readiness page
// and never sends a diagnostic request. Playwright serves apps/frontend/dist/frontend/browser/ itself through
// page.route on a fixed origin, so neither the dev server nor the backend of the webServer entries takes part. A path
// without an extension receives index.html, like a deployed single page application. Requests to every other origin
// are aborted and recorded; only the Google Fonts origins that provideMaterialSymbols() loads may appear. The proof is
// behavior, not the absence of a file: the lazy readiness chunk may stay in dist because isDevMode() is a runtime
// check. This suite depends on a dist built from the same checkout; `test:ci` runs build:frontend before test:e2e.
const productionOrigin = 'http://foundation-production.test';
const allowedExternalOrigins = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
const browserDirectory = fileURLToPath(new URL('../../../apps/frontend/dist/frontend/browser/', import.meta.url));
const indexFile = resolve(browserDirectory, 'index.html');
const missingBuild = 'READY-007 needs the production build at apps/frontend/dist/frontend/browser/index.html; run bun run build:frontend first';

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

interface Traffic {
  /** Origin of every request that was not for the production origin, in order; each one was aborted. */
  externalOrigins: string[];
  /** Every request, from any origin, whose path contains /api/. */
  apiRequests: string[];
  pageErrors: string[];
}

/** Fails with a fixed message, never a skip, when the production build is missing. */
async function requireProductionBuild(): Promise<void> {
  try {
    if (!(await stat(indexFile)).isFile()) throw new Error(missingBuild);
  } catch {
    throw new Error(missingBuild);
  }
}

/** The file a production request path maps to, or undefined when it would leave the build directory. */
function buildFile(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (extname(decoded) === '') return indexFile;
  const file = resolve(browserDirectory, `.${decoded}`);
  const inside = relative(browserDirectory, file);
  return inside === '' || inside.startsWith('..') ? undefined : file;
}

async function serveProductionBuild(page: Page): Promise<Traffic> {
  const traffic: Traffic = { externalOrigins: [], apiRequests: [], pageErrors: [] };
  page.on('pageerror', (error) => traffic.pageErrors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.includes('/api/')) traffic.apiRequests.push(request.url());
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== productionOrigin) {
      traffic.externalOrigins.push(url.origin);
      await route.abort();
      return;
    }
    const file = buildFile(url.pathname);
    const body = file === undefined ? undefined : await readFile(file).catch(() => undefined);
    if (file === undefined || body === undefined) {
      await route.fulfill({ status: 404, contentType: 'text/plain; charset=utf-8', body: 'Not found' });
      return;
    }
    await route.fulfill({ status: 200, contentType: contentTypes[extname(file)] ?? 'application/octet-stream', body });
  });
  return traffic;
}

/** Opens a production URL and waits until the page and every request it started are settled. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(`${productionOrigin}${path}`, { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(`${productionOrigin}/`);
  await expect(page.getByRole('heading', { level: 1, name: 'Foundation', exact: true })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('Kerangka aplikasi siap dikembangkan.');
  await expect(page.getByRole('progressbar', { name: 'Loading page' })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Kesiapan' })).toHaveCount(0);
}

/** The production navigation holds exactly two items in this order: Beranda to / and Akun to /akun (spec 0014). */
async function expectBerandaAndAkun(navigation: Locator): Promise<void> {
  const links = navigation.getByRole('link');
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAccessibleName('Beranda');
  await expect(links.nth(0)).toHaveAttribute('href', '/');
  await expect(links.nth(1)).toHaveAccessibleName('Akun');
  await expect(links.nth(1)).toHaveAttribute('href', '/akun');
  await expect(navigation.getByText('Kesiapan')).toHaveCount(0);
}

function expectNoDiagnosticTraffic(traffic: Traffic): void {
  expect(traffic.apiRequests).toEqual([]);
  for (const origin of traffic.externalOrigins) expect(allowedExternalOrigins).toContain(origin);
  expect(traffic.pageErrors).toEqual([]);
}

test('READY-007 production build at 1280×812: the navigation holds Beranda and Akun, /kesiapan ends at /, and no request path contains /api/', async ({ page }) => {
  await requireProductionBuild();
  const traffic = await serveProductionBuild(page);
  await page.setViewportSize({ width: 1280, height: 812 });

  await open(page, '/');
  await expectBerandaAndAkun(page.getByRole('navigation', { name: 'Primary navigation' }));
  expectNoDiagnosticTraffic(traffic);

  await open(page, '/kesiapan');
  await expectBerandaAndAkun(page.getByRole('navigation', { name: 'Primary navigation' }));
  expectNoDiagnosticTraffic(traffic);
});

test('READY-007 production build at 375×812: the navigation drawer holds Beranda and Akun, /kesiapan ends at /, and no request path contains /api/', async ({ page }) => {
  await requireProductionBuild();
  const traffic = await serveProductionBuild(page);
  await page.setViewportSize({ width: 375, height: 812 });
  const openNavigation = page.getByRole('button', { name: 'Buka navigasi' });
  const drawer = page.getByRole('dialog', { name: 'Buka navigasi' });

  for (const path of ['/', '/kesiapan']) {
    await open(page, path);
    await openNavigation.click();
    await expect(drawer).toBeVisible();
    await expectBerandaAndAkun(drawer);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    expectNoDiagnosticTraffic(traffic);
  }
});

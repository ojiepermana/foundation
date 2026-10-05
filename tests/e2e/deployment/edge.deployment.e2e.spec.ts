import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

// DEP-006 (spec 0012, AC-6): the production build served by the edge of the deployment topology, with the final CSP and
// Trusted Types, at 1280×812 and 375×812. A `securitypolicyviolation` listener is installed through page.addInitScript
// before every navigation, console errors and page errors are collected, and every request outside the edge goes
// through page.route: the two Google Fonts origins are answered here with an empty body (CSS and font, status 200), so
// the test never depends on an outside network, and every other origin is aborted and fails the test. The browser
// applies CSP before the network layer, so a violation is still seen. The requested origins are attached as evidence.
// `test:deployment:real` starts the topology and passes the edge URL; without it the test fails with a fixed message.

const missingEdge = 'DEP-006 needs FOUNDATION_DEPLOY_EDGE_URL, the HTTPS edge URL that bun run test:deployment:real starts';
const fontsCss = 'https://fonts.googleapis.com';
const fontsFiles = 'https://fonts.gstatic.com';
const hashedStylesheet = /\/styles-[A-Za-z0-9_-]{8}\.css$/;

interface Traffic {
  /** Origin of every request outside the edge, in order. */
  requestedOrigins: string[];
  /** Origins outside the edge and Google Fonts; each request was aborted. */
  refusedOrigins: string[];
  /** Every request, from any origin, whose path contains /api/. */
  apiRequests: string[];
  consoleErrors: string[];
  pageErrors: string[];
}

/** The edge origin, or a failure with a fixed message, never a skip. */
function edgeOrigin(): string {
  const value = process.env['FOUNDATION_DEPLOY_EDGE_URL'];
  if (value === undefined || value === '') throw new Error(missingEdge);
  return new URL(value).origin;
}

async function watch(page: Page, edge: string): Promise<Traffic> {
  const traffic: Traffic = { requestedOrigins: [], refusedOrigins: [], apiRequests: [], consoleErrors: [], pageErrors: [] };
  // Runs before any script of every document, so a violation during startup is recorded too.
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
    if (new URL(request.url()).pathname.includes('/api/')) traffic.apiRequests.push(request.url());
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

/** Violations recorded by the init script in the current document. */
async function violations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __foundationViolations?: string[] }).__foundationViolations ?? ['listener missing']);
}

/** Opens an edge path, waits until it settles at /, and checks the page and its stylesheet. */
async function open(page: Page, edge: string, path: string): Promise<void> {
  await page.goto(`${edge}${path}`, { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(`${edge}/`);
  await expect(page.getByRole('heading', { level: 1, name: 'Foundation', exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Loading page' })).toBeHidden();
  const style = await page.evaluate(() => ({
    sheets: [...document.styleSheets].map((sheet) => sheet.href ?? ''),
    radius: getComputedStyle(document.documentElement).getPropertyValue('--radius-base').trim(),
  }));
  expect(style.sheets.filter((href) => href.startsWith(edge) && hashedStylesheet.test(new URL(href).pathname))).toHaveLength(1);
  expect(style.radius).toBe('.375rem');
  expect(await violations(page)).toEqual([]);
}

/** The navigation holds exactly one item, Beranda to /. */
async function expectOnlyBeranda(navigation: Locator): Promise<void> {
  const links = navigation.getByRole('link');
  await expect(links).toHaveCount(1);
  await expect(links).toHaveAccessibleName('Beranda');
  await expect(links).toHaveAttribute('href', '/');
  await expect(navigation.getByText('Kesiapan')).toHaveCount(0);
}

/**
 * The requested origins as durable evidence (AC-6). The JUnit reporter drops attachments that only have a body, so the
 * list goes to a file in outputDir, attached by path (the JUnit lists it and the evidence bundle copies test-results/),
 * and to stdout as one `requested-origins <JSON>` line, which the JUnit reporter keeps in <system-out>.
 */
async function recordRequestedOrigins(traffic: Traffic, testInfo: TestInfo): Promise<void> {
  const origins = JSON.stringify([...new Set(traffic.requestedOrigins)]);
  const file = testInfo.outputPath('requested-origins.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${origins}\n`);
  await testInfo.attach('requested-origins', { path: file, contentType: 'application/json' });
  console.log(`requested-origins ${origins}`);
}

async function expectCleanTraffic(page: Page, traffic: Traffic, testInfo: TestInfo): Promise<void> {
  await recordRequestedOrigins(traffic, testInfo);
  expect(await violations(page)).toEqual([]);
  expect(traffic.consoleErrors).toEqual([]);
  expect(traffic.pageErrors).toEqual([]);
  expect(traffic.apiRequests).toEqual([]);
  expect(traffic.refusedOrigins).toEqual([]);
  for (const origin of traffic.requestedOrigins) expect([fontsCss, fontsFiles]).toContain(origin);
}

test('DEP-006 edge at 1280×812: the production build runs under the final CSP, the navigation holds only Beranda, and /kesiapan ends at /', async ({ page }, testInfo) => {
  const edge = edgeOrigin();
  const traffic = await watch(page, edge);
  await page.setViewportSize({ width: 1280, height: 812 });

  for (const path of ['/', '/kesiapan']) {
    await open(page, edge, path);
    await expectOnlyBeranda(page.getByRole('navigation', { name: 'Primary navigation' }));
  }
  await expectCleanTraffic(page, traffic, testInfo);
});

test('DEP-006 edge at 375×812: the production build runs under the final CSP, the navigation drawer holds only Beranda, and /kesiapan ends at /', async ({ page }, testInfo) => {
  const edge = edgeOrigin();
  const traffic = await watch(page, edge);
  await page.setViewportSize({ width: 375, height: 812 });
  const openNavigation = page.getByRole('button', { name: 'Buka navigasi' });
  const drawer = page.getByRole('dialog', { name: 'Buka navigasi' });

  for (const path of ['/', '/kesiapan']) {
    await open(page, edge, path);
    await openNavigation.click();
    await expect(drawer).toBeVisible();
    await expectOnlyBeranda(drawer);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    expect(await violations(page)).toEqual([]);
  }
  await expectCleanTraffic(page, traffic, testInfo);
});

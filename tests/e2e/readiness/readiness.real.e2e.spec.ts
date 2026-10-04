import { expect, test, type Page, type Response } from '@playwright/test';
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readinessContainerLabelsAccepted, readinessNameAccepted } from '../../orchestration/readiness-container';
import { expectNothingClipped } from './layout';
import { readinessBodyAt, recordReadinessBodies } from './response-body';

// READY-009 (spec 0006, AC-2, AC-7, AC-8, and AC-10): the real browser flow browser → SDK → proxy /api → backend →
// isolated PostgreSQL 18, with no database mock. Run by `bun run test:readiness:real` with playwright.real.config.ts,
// which starts the database, backend, and frontend first and passes FOUNDATION_READINESS_CONTAINER. Feature 2 may run
// this spec against `serve` the same way (spec 0006, Follow-up). This file runs on Node, so it imports no Bun module.
//
// Container guard of spec 0006 (*Nama dan penjaga container*): before the flow starts and again before every
// `docker stop` and `docker start`, (1) the name passes readinessNameAccepted('browser', ...), before Docker is
// called, (2) `docker container inspect` succeeds, and (3) its labels pass readinessContainerLabelsAccepted. The first
// failure stops the test with a fixed message and no Docker action. Docker is called through execFile with an
// argument array, never a shell. The rule itself lives only in tests/orchestration/readiness-container.ts.
const readinessUrl = 'http://127.0.0.1:8889/api/readiness';
const availableText = 'Database dapat dibaca.';
const unavailableText = 'Database tidak tersedia. Pastikan PostgreSQL berjalan, lalu periksa ulang.';
const migrationsDirectory = fileURLToPath(new URL('../../../database/migrations/', import.meta.url));
/** Recovery after `docker start` (spec 0006, *Batas tunggu*): press every 1,000 ms for at most 30 seconds. */
const recoveryLimitMs = 30_000;
const recheckIntervalMs = 1_000;

// Browser context decided by spec 0006 (*Value sourcing*, Test browser row).
test.use({ locale: 'id-ID', timezoneId: 'Asia/Jakarta' });

// Docker environment of spec 0006 (*Environment proses anak*): the base allow list plus the Docker variables.
const BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SHELL', 'SystemRoot', 'CI'];
const dockerEnv = Object.fromEntries(
  [...BASE_ENV_KEYS, 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
);

function docker(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile('docker', args, { env: dockerEnv, timeout: 30_000, encoding: 'utf8' }, (error, stdout) => resolve({ ok: !error, stdout }));
  });
}

/** JSON.parse of a `{{json .Config.Labels}}` inspect output; text that is not JSON counts as refused labels. */
function parsedLabels(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
}

/** The three guard steps, in order; resolves to the accepted container name. */
async function guardedContainer(): Promise<string> {
  const name = process.env['FOUNDATION_READINESS_CONTAINER'];
  if (!readinessNameAccepted('browser', name)) {
    throw new Error('FOUNDATION_READINESS_CONTAINER is empty or not a readiness harness container name');
  }
  const accepted = name as string;
  const inspected = await docker(['container', 'inspect', '--format', '{{json .Config.Labels}}', accepted]);
  if (!inspected.ok) throw new Error('Readiness container guard could not inspect the container');
  if (!readinessContainerLabelsAccepted(parsedLabels(inspected.stdout))) throw new Error('Readiness container guard rejected the container labels');
  return accepted;
}

async function guardedDocker(action: 'stop' | 'start'): Promise<void> {
  const name = await guardedContainer();
  if (!(await docker([action, name])).ok) throw new Error(`Readiness container ${action} failed`);
}

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

/**
 * The answer came through the same origin proxy as a GET with `no-store`; returns its parsed body. The body is the one
 * the page received, read inside the page, because Chromium can drop it from DevTools (response-body.ts).
 */
async function readinessBody(page: Page, traffic: Traffic, response: Response, status: number, keys: string[]): Promise<Record<string, unknown>> {
  expect(response.url()).toBe(readinessUrl);
  expect(response.request().method()).toBe('GET');
  expect(response.status()).toBe(status);
  expect(response.headers()['cache-control']).toBe('no-store');
  const index = traffic.readinessResponses.indexOf(response);
  expect(index, 'watch() saw this readiness response').toBeGreaterThanOrEqual(0);
  const body = (await readinessBodyAt(page, index)) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(keys);
  return body;
}

/** `checkedAt` is an ISO string from the server, shown in <time> with the browser locale and time zone. */
async function expectCheckedAt(page: Page, checkedAt: unknown): Promise<void> {
  expect(typeof checkedAt).toBe('string');
  expect(Number.isNaN(Date.parse(checkedAt as string))).toBe(false);
  expect((checkedAt as string).endsWith('Z')).toBe(true);
  const time = page.getByRole('main').locator('time');
  await expect(time).toHaveCount(1);
  await expect(time).toHaveAttribute('datetime', checkedAt as string);
  const expectedText = await page.evaluate(
    (value) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)),
    checkedAt as string,
  );
  await expect(time).toHaveText(expectedText);
}

/** A 200 with exactly the expected count, and the page shows it as the `available` state. */
async function expectAvailable(page: Page, traffic: Traffic, response: Response, migrationCount: number): Promise<void> {
  const body = await readinessBody(page, traffic, response, 200, ['appliedMigrations', 'checkedAt', 'status']);
  expect(body['status']).toBe('available');
  expect(body['appliedMigrations']).toBe(migrationCount);
  const main = page.getByRole('main');
  await expect(main.getByRole('status')).toHaveText(availableText);
  await expect(main.getByRole('button', { name: 'Periksa ulang' })).not.toHaveAttribute('aria-disabled');
  await expect(main.locator('dt')).toHaveText(['Waktu pemeriksaan', 'Migration terapan']);
  await expect(main.locator('dd')).toHaveCount(2);
  await expect(main.locator('dd').nth(1)).toHaveText(String(migrationCount));
  await expectCheckedAt(page, body['checkedAt']);
}

/** A 503 from the stopped database, and the page shows `unavailable` with its time and without the old count. */
async function expectUnavailable(page: Page, traffic: Traffic, response: Response): Promise<void> {
  const body = await readinessBody(page, traffic, response, 503, ['checkedAt', 'status']);
  expect(body['status']).toBe('unavailable');
  const main = page.getByRole('main');
  await expect(main.getByRole('status')).toHaveText(unavailableText);
  await expect(main.getByRole('button', { name: 'Periksa ulang' })).not.toHaveAttribute('aria-disabled');
  await expect(main.locator('dt')).toHaveText(['Waktu pemeriksaan']);
  await expect(main.locator('dd')).toHaveCount(1);
  await expect(main.getByText('Migration terapan')).toHaveCount(0);
  await expectCheckedAt(page, body['checkedAt']);
}

/** Activates `Periksa ulang` once, after the previous result arrived, and resolves to the answer it caused. */
async function recheck(page: Page): Promise<Response> {
  const button = page.getByRole('main').getByRole('button', { name: 'Periksa ulang' });
  await expect(button).not.toHaveAttribute('aria-disabled');
  const answer = page.waitForResponse(isReadinessResponse);
  await button.click();
  return answer;
}

test('READY-009 real database: available with the exact count at 1280×812 and 375×812, recheck, a stopped database without the old count, and recovery after docker start without a restart', async ({ page }, testInfo) => {
  await guardedContainer();
  const migrationCount = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).length;
  expect(migrationCount).toBeGreaterThan(0);
  const traffic = await watch(page);
  let checks = 0;

  // Opening /kesiapan sends exactly one check, answered from the real database with the number of migration files.
  await page.setViewportSize({ width: 1280, height: 812 });
  const firstCheck = page.waitForResponse(isReadinessResponse);
  await page.goto('/kesiapan');
  checks += 1;
  await expect(page.getByRole('heading', { level: 1, name: 'Kesiapan', exact: true })).toBeVisible();
  await expectAvailable(page, traffic, await firstCheck, migrationCount);
  await expectNothingClipped(page, ['status', 'dt 0', 'dt 1', 'dd 0', 'dd 1', 'time', 'button']);
  await page.screenshot({ path: testInfo.outputPath('readiness-available-desktop.png'), fullPage: true });

  // The `available` state at 375×812 (AC-8): no page overflow and nothing clipped.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole('main').getByRole('status')).toHaveText(availableText);
  await expectNothingClipped(page, ['status', 'dt 0', 'dt 1', 'dd 0', 'dd 1', 'time', 'button']);
  await page.screenshot({ path: testInfo.outputPath('readiness-available-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 812 });

  // Periksa ulang reads the count again.
  await expectAvailable(page, traffic, await recheck(page), migrationCount);
  checks += 1;

  await guardedDocker('stop');
  let stopped = true;
  try {
    // The stopped database gives the safe unavailable result, and the old count is gone.
    await expectUnavailable(page, traffic, await recheck(page));
    checks += 1;
    await page.screenshot({ path: testInfo.outputPath('readiness-unavailable-stopped.png'), fullPage: true });

    await guardedDocker('start');
    stopped = false;
    // Periksa ulang every 1,000 ms, only while the button is not aria-disabled, until the same frontend and backend
    // read the started database again, within 30 seconds.
    const deadline = Date.now() + recoveryLimitMs;
    let recovered: Response | undefined;
    for (;;) {
      const pressedAt = Date.now();
      const answer = await recheck(page);
      checks += 1;
      if (answer.status() === 200) {
        recovered = answer;
        break;
      }
      // Every answer on the way is a well formed busy or unavailable result.
      if (answer.status() === 429) expect(await readinessBody(page, traffic, answer, 429, ['status'])).toEqual({ status: 'busy' });
      else await expectUnavailable(page, traffic, answer);
      if (Date.now() >= deadline) throw new Error('Readiness did not recover within 30 seconds after docker start');
      await page.waitForTimeout(Math.max(0, pressedAt + recheckIntervalMs - Date.now()));
    }
    await expectAvailable(page, traffic, recovered, migrationCount);
    await page.screenshot({ path: testInfo.outputPath('readiness-recovered.png'), fullPage: true });
  } finally {
    if (stopped) await guardedDocker('start').catch(() => undefined);
  }

  // One request per check, all same origin through the proxy, no polling, and no page error.
  expect(traffic.apiRequests).toEqual(Array.from({ length: checks }, () => readinessUrl));
  expect(traffic.pageErrors).toEqual([]);
});

import { expect, test, type Page, type Request, type Route } from '@playwright/test';

// AUTH-012 (spec 0014, AC-12), the states that need no database: the backend webServer of playwright.config.ts runs
// with an empty DATABASE_URL, so every request goes browser → SDK → proxy /api → backend without a pool. The backend
// answers 503 after its guard and schema, so `unavailable` is a real answer. Three other states come from the same real
// backend with one request header or the request target changed through page.route: a query string on a GET (400 from
// the guard, `failed`) leaves the browser with the new target; a foreign `Origin` (403 `forbidden` from the guard) and
// a `text/plain` media type (415, `failed`) are sent by route.fetch through the same proxy, because Chromium does not
// let route.continue replace `Origin`, and the real answer is handed to the page. Only `network` has no real answer:
// page.route aborts the request with `connectionrefused` (status 0), the one boundary this file declares. The states
// that need an account (invalid, limited, the notices, the sessions list, and every action of /akun) are in
// auth.real.e2e.spec.ts. No test here ever holds a session, so none obtains a token.

test.use({ locale: 'id-ID', timezoneId: 'Asia/Jakarta' });

/** Fixed texts of spec 0014, tables *Teks halaman* and *State halaman*. */
const TEXT = {
  empty: 'Isi email dan password.',
  forbidden: 'Permintaan ditolak. Muat ulang halaman, lalu coba lagi.',
  unavailable: 'Layanan belum tersedia. Coba lagi beberapa saat lagi.',
  network: 'Backend tidak dapat dihubungi. Periksa koneksi, lalu coba lagi.',
  failed: 'Permintaan gagal. Coba lagi beberapa saat lagi.',
  loading: 'Memuat akun.',
} as const;

/** Every request whose path starts with /api/, as `METHOD /path`, and every page error, from the first navigation on. */
function watch(page: Page): { api: string[]; pageErrors: string[] } {
  const traffic = { api: [] as string[], pageErrors: [] as string[] };
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) traffic.api.push(`${request.method()} ${url.pathname}`);
  });
  page.on('pageerror', (error) => traffic.pageErrors.push(error.message));
  return traffic;
}

const isSignIn = (request: Request) => new URL(request.url()).pathname === '/api/auth/session' && request.method() === 'POST';
const isIdentity = (request: Request) => new URL(request.url()).pathname === '/api/auth/session' && request.method() === 'GET';

/**
 * The status of the next answer to a request that `matches`, or 0 when that request failed without an answer. Start it
 * before the action that sends the request. The branch that loses the race settles quietly.
 */
function settled(page: Page, matches: (request: Request) => boolean): Promise<number> {
  return Promise.race([
    page.waitForResponse((response) => matches(response.request())).then((response) => response.status(), () => -1),
    page.waitForEvent('requestfailed', { predicate: matches }).then(() => 0, () => -1),
  ]);
}

/** A route handler that holds each matching request until `release` is called, then lets it reach the backend. */
function held(): { handler: (route: Route) => Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  return { handler: async (route) => { await gate; await route.continue(); }, release };
}

/**
 * A route handler that sends the request with `headers` replaced through route.fetch (to the same proxy and backend),
 * then gives the page that real answer unchanged.
 */
function changed(headers: Readonly<Record<string, string>>): (route: Route) => Promise<void> {
  return async (route) => {
    const response = await route.fetch({ headers: { ...route.request().headers(), ...headers } });
    await route.fulfill({ response });
  };
}

async function expectNoOverflow(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${width}×812`).toBe(true);
}

/**
 * Fills the form, submits it with the button, waits for the answer (or the failed connection), and checks the alert
 * text: the email stays, the password empties, and the button is active again. Resolves to the status (0 for none).
 */
async function submitAndExpect(page: Page, email: string, text: string): Promise<number> {
  const main = page.getByRole('main');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password-uji-yang-panjang');
  const answer = settled(page, isSignIn);
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  const status = await answer;
  await expect(main.getByRole('alert')).toHaveText(text);
  await expect(main.getByRole('status')).toHaveText('');
  await expect(page.getByLabel('Email')).toHaveValue(email);
  await expect(page.getByLabel('Password')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Masuk', exact: true })).not.toHaveAttribute('aria-disabled');
  await expect(page).toHaveURL('/masuk');
  return status;
}

test('AUTH-012 /masuk without a database: the form, the empty input state, the 503 state of the backend, keyboard submit, one request for a double submit, and both viewports', async ({ page }) => {
  const traffic = watch(page);
  await page.setViewportSize({ width: 1280, height: 812 });
  await page.goto('/masuk');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Masuk', exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Loading page' })).toBeHidden();
  // The page calls no API when it opens.
  expect(traffic.api).toEqual([]);

  // *Halaman*: a novalidate form with labelled email and password fields, and one alert and one status region that are
  // always in the DOM and empty at first.
  await expect(main.locator('form')).toHaveAttribute('novalidate', '');
  await expect(page.getByLabel('Email')).toHaveAttribute('type', 'email');
  await expect(page.getByLabel('Email')).toHaveAttribute('autocomplete', 'username');
  await expect(page.getByLabel('Password')).toHaveAttribute('type', 'password');
  await expect(page.getByLabel('Password')).toHaveAttribute('autocomplete', 'current-password');
  await expect(main.getByRole('alert')).toHaveCount(1);
  await expect(main.getByRole('status')).toHaveCount(1);
  await expect(main.getByRole('alert')).toHaveText('');
  await expect(main.getByRole('status')).toHaveText('');

  // Isian kosong: nothing, only an email, or an email of spaces only never sends a request.
  const button = page.getByRole('button', { name: 'Masuk', exact: true });
  await button.click();
  await expect(main.getByRole('alert')).toHaveText(TEXT.empty);
  await page.getByLabel('Email').fill('ana@example.test');
  await button.click();
  await expect(main.getByRole('alert')).toHaveText(TEXT.empty);
  await page.getByLabel('Email').fill('   ');
  await page.getByLabel('Password').fill('password-uji-yang-panjang');
  await button.click();
  await expect(main.getByRole('alert')).toHaveText(TEXT.empty);
  expect(traffic.api).toEqual([]);

  // Keyboard: type the email, Tab to the password, Tab to the button and back, then Enter in the password field
  // submits. The request is held, so a second Enter and a click on the button while it runs must not send another one.
  const hold = held();
  await page.route('**/api/auth/session', hold.handler);
  await page.getByLabel('Email').fill('');
  await page.getByLabel('Password').fill('');
  await page.getByLabel('Email').focus();
  // Outer spaces, then two frames so change detection runs before the rest is typed: the field must keep the caret where
  // the user types. Chromium moves the caret of a focused type="email" field to the start when its value is written, so
  // a page that wrote the trimmed value back while the user typed would put the rest in front of the first letter.
  await page.keyboard.type('  a');
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.keyboard.type('na@example.test  ');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password')).toBeFocused();
  await page.keyboard.type('password-uji-yang-panjang');
  await page.keyboard.press('Tab');
  await expect(button).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByLabel('Password')).toBeFocused();
  const answered = page.waitForResponse((response) => isSignIn(response.request()));
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(main.getByRole('alert')).toHaveText('');
  await page.keyboard.press('Enter');
  // `force`, because the button is aria-disabled while the request runs and a normal click would wait for it.
  await button.click({ force: true });
  hold.release();
  const response = await answered;
  expect(response.status()).toBe(503);
  expect(response.headers()['cache-control']).toBe('no-store');
  await expect(main.getByRole('alert')).toHaveText(TEXT.unavailable);
  await expect(main.getByRole('status')).toHaveText('');
  // The email keeps what was typed (Chromium strips the outer spaces of a type="email" value itself); the password is
  // emptied and the button is active again.
  await expect(page.getByLabel('Email')).toHaveValue('ana@example.test');
  await expect(page.getByLabel('Password')).toHaveValue('');
  await expect(button).not.toHaveAttribute('aria-disabled');
  await page.unroute('**/api/auth/session', hold.handler);
  expect(traffic.api).toEqual(['POST /api/auth/session']);

  // A new submit replaces the old text: the same 503 again, still one text in the alert region.
  expect(await submitAndExpect(page, 'ana@example.test', TEXT.unavailable)).toBe(503);
  expect(traffic.api).toEqual(['POST /api/auth/session', 'POST /api/auth/session']);

  for (const width of [375, 1280]) {
    await expectNoOverflow(page, width);
    await expect(button).toBeVisible();
  }
  expect(traffic.pageErrors).toEqual([]);
});

test('AUTH-012 /masuk shows forbidden and failed from the real backend (a foreign Origin, a text/plain body) and network for a closed connection', async ({ page }) => {
  const traffic = watch(page);
  await page.setViewportSize({ width: 1280, height: 812 });
  await page.goto('/masuk');
  await expect(page.getByRole('heading', { level: 1, name: 'Masuk', exact: true })).toBeVisible();

  // 403 from the guard of the backend: the same request with a foreign Origin.
  const foreign = changed({ origin: 'http://evil.test' });
  await page.route('**/api/auth/session', foreign);
  expect(await submitAndExpect(page, 'ana@example.test', TEXT.forbidden)).toBe(403);
  await page.unroute('**/api/auth/session', foreign);

  // 415 from the guard of the backend: the same body as text/plain; the adapter maps any other status to failed.
  const plainText = changed({ 'content-type': 'text/plain' });
  await page.route('**/api/auth/session', plainText);
  expect(await submitAndExpect(page, 'ana@example.test', TEXT.failed)).toBe(415);
  await page.unroute('**/api/auth/session', plainText);

  // A connection that never reaches the backend: status 0 is network.
  const refused = async (route: Route) => route.abort('connectionrefused');
  await page.route('**/api/auth/session', refused);
  expect(await submitAndExpect(page, 'ana@example.test', TEXT.network)).toBe(0);
  await page.unroute('**/api/auth/session', refused);

  // Without any change the same form reaches the backend again and gets its real 503.
  expect(await submitAndExpect(page, 'ana@example.test', TEXT.unavailable)).toBe(503);
  expect(traffic.api).toEqual(['POST /api/auth/session', 'POST /api/auth/session', 'POST /api/auth/session', 'POST /api/auth/session']);
  expect(traffic.pageErrors).toEqual([]);
});

test('AUTH-012 /akun without a database: loading, the 503 state with Coba lagi that repeats the call, failed, network, keyboard, and both viewports', async ({ page }) => {
  const traffic = watch(page);
  await page.setViewportSize({ width: 1280, height: 812 });
  const main = page.getByRole('main');
  const retry = main.getByRole('button', { name: 'Coba lagi', exact: true });

  // Memuat: while the identity read is held, the status region says so and neither section shows.
  const hold = held();
  await page.route('**/api/auth/session', hold.handler);
  const first = page.waitForResponse((response) => isIdentity(response.request()));
  await page.goto('/akun');
  await expect(main.getByRole('heading', { level: 1, name: 'Akun', exact: true })).toBeVisible();
  await expect(main.getByRole('status')).toHaveText(TEXT.loading);
  await expect(main.getByRole('alert')).toHaveText('');
  await expect(main.getByRole('heading', { level: 2, name: 'Profil' })).toHaveCount(0);
  await expect(main.getByRole('heading', { level: 2, name: 'Sesi aktif' })).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  hold.release();
  expect((await first).status()).toBe(503);
  await page.unroute('**/api/auth/session', hold.handler);

  // unavailable: the text in the alert region, Coba lagi, no section, and /akun stays (only 401 moves to /masuk).
  await expect(main.getByRole('alert')).toHaveText(TEXT.unavailable);
  await expect(main.getByRole('status')).toHaveText('');
  await expect(retry).toBeVisible();
  await expect(main.getByRole('heading', { level: 2, name: 'Profil' })).toHaveCount(0);
  await expect(page).toHaveURL('/akun');
  // The list is only read after the identity, so a failed identity read sends nothing else.
  expect(traffic.api).toEqual(['GET /api/auth/session']);

  // Coba lagi with the keyboard repeats the call and shows the same state again.
  const again = settled(page, isIdentity);
  await retry.focus();
  await page.keyboard.press('Enter');
  expect(await again).toBe(503);
  await expect(main.getByRole('alert')).toHaveText(TEXT.unavailable);
  await expect(retry).toBeVisible();

  // failed: the guard answers 400 for a query string on a GET.
  const withQuery = async (route: Route) => {
    const url = new URL(route.request().url());
    url.search = '?x=1';
    await route.continue({ url: url.toString() });
  };
  await page.route('**/api/auth/session', withQuery);
  const queried = settled(page, isIdentity);
  await retry.click();
  expect(await queried).toBe(400);
  await expect(main.getByRole('alert')).toHaveText(TEXT.failed);
  await expect(retry).toBeVisible();
  await page.unroute('**/api/auth/session', withQuery);

  // network: the connection is refused before it reaches the backend.
  const refused = async (route: Route) => route.abort('connectionrefused');
  await page.route('**/api/auth/session', refused);
  const closed = settled(page, isIdentity);
  await retry.click();
  expect(await closed).toBe(0);
  await expect(main.getByRole('alert')).toHaveText(TEXT.network);
  await expect(retry).toBeVisible();
  await page.unroute('**/api/auth/session', refused);

  for (const width of [375, 1280]) {
    await expectNoOverflow(page, width);
    await expect(retry).toBeVisible();
  }
  expect(traffic.api).toEqual(Array.from({ length: 4 }, () => 'GET /api/auth/session'));
  expect(traffic.pageErrors).toEqual([]);
});

import { randomBytes } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page, type Request, type Route } from '@playwright/test';
import { TEST_ACCOUNT_NAMES } from '../../orchestration/auth-accounts';
import { csrfTokenOf } from '../../orchestration/token-fingerprints';
import { recordSessionTokens } from './session-tokens';

// AUTH-012 (spec 0014, AC-10, AC-12) and AUTH-010 (AC-10, the browser part): the real browser flow browser → SDK →
// proxy /api → backend → isolated PostgreSQL
// 18, with two accounts that the orchestration created through `database/accounts.ts create`. Run by
// `bun run test:readiness:real` and `bun run test:tooling:real` with playwright.real.config.ts, which pass the accounts
// only through FOUNDATION_E2E_ACCOUNT_EMAIL, FOUNDATION_E2E_ACCOUNT_PASSWORD, FOUNDATION_E2E_OTHER_EMAIL, and
// FOUNDATION_E2E_OTHER_PASSWORD. A password is typed into the form and never written anywhere: no log line, no assertion
// message, and trace stays off in that config. After every sign in the session cookie of the browser context is read
// and its token and CSRF token are added to the fingerprint file of the orchestration (*Sidik token uji*); a token is
// never printed, asserted on, or written. With session-tokens.ts, every row of *State halaman* that needs an account is
// here; the rows without a database are in sign-in.e2e.spec.ts.
//
// Every answer comes from the real backend except two declared boundaries: `network` (page.route aborts the request,
// status 0) and `unavailable` of an action (page.route answers 503 `{"error":"Service unavailable"}`), because the
// shared database of this run cannot be stopped in the middle of the flow. `forbidden` and `failed` of an action are
// real answers to the same request with a changed `x-csrf-token`, sent through route.fetch to the same proxy.
// This file runs on Node, so it imports no Bun module.

/** A required variable of the orchestration; a missing one fails with a fixed message and never prints a value. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is missing; run this spec through test:readiness:real or test:tooling:real`);
  return value;
}

test.use({ locale: 'id-ID', timezoneId: 'Asia/Jakarta' });

/** Fixed texts of spec 0014, tables *Teks halaman* and *State halaman*. */
const TEXT = {
  invalid: 'Email atau password salah.',
  limited: 'Terlalu banyak percobaan masuk. Tunggu beberapa menit, lalu coba lagi.',
  forbidden: 'Permintaan ditolak. Muat ulang halaman, lalu coba lagi.',
  unavailable: 'Layanan belum tersedia. Coba lagi beberapa saat lagi.',
  network: 'Backend tidak dapat dihubungi. Periksa koneksi, lalu coba lagi.',
  failed: 'Permintaan gagal. Coba lagi beberapa saat lagi.',
  expired: 'Sesi Anda berakhir. Masuk lagi untuk melanjutkan.',
  signedOut: 'Anda sudah keluar.',
  revoked: 'Sesi diakhiri.',
  revokeNotFound: 'Sesi sudah berakhir.',
  revokeFailed: 'Sesi tidak dapat diakhiri. Coba lagi.',
} as const;

const UUID_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isSignIn = (request: Request) => new URL(request.url()).pathname === '/api/auth/session' && request.method() === 'POST';
const isRevoke = (request: Request) => request.method() === 'DELETE' && /^\/api\/auth\/sessions\//.test(new URL(request.url()).pathname);
const isSignOut = (request: Request) => request.method() === 'DELETE' && new URL(request.url()).pathname === '/api/auth/session';
const isList = (request: Request) => request.method() === 'GET' && new URL(request.url()).pathname === '/api/auth/sessions';

/**
 * The status of the next answer to a request that `matches`, or 0 when it failed without an answer. Start it before
 * the action that sends the request; the branch that loses the race settles quietly.
 */
function settled(page: Page, matches: (request: Request) => boolean): Promise<number> {
  return Promise.race([
    page.waitForResponse((response) => matches(response.request())).then((response) => response.status(), () => -1),
    page.waitForEvent('requestfailed', { predicate: matches }).then(() => 0, () => -1),
  ]);
}

/** A route handler for DELETE only: other methods on the same pattern reach the backend unchanged. */
function onDelete(handler: (route: Route) => Promise<void>): (route: Route) => Promise<void> {
  return async (route) => (route.request().method() === 'DELETE' ? handler(route) : route.continue());
}

/** Sends the request with `headers` replaced through route.fetch (same proxy, same backend) and gives the page that answer. */
function changed(headers: Readonly<Record<string, string>>): (route: Route) => Promise<void> {
  return async (route) => {
    const response = await route.fetch({ headers: { ...route.request().headers(), ...headers } });
    await route.fulfill({ response });
  };
}

const refused = async (route: Route) => route.abort('connectionrefused');
const unavailable = async (route: Route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Service unavailable"}' });

/**
 * The session lives only in the HttpOnly cookie: no auth value in script readable storage or document.cookie. The theme
 * library keeps its layout and theme preferences in localStorage, so the check looks at what each entry holds (the
 * email, the password, a 43 character token shape, or an auth word) and reports key names only, never values.
 */
async function expectNoAuthStorage(page: Page, email: string, password: string): Promise<void> {
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
}

/**
 * Signs in through `/masuk` and waits for `/akun` with its list, then records the fingerprints of the new session token
 * and its CSRF token; the password is only typed, never kept or printed.
 */
async function signInThrough(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/masuk');
  await expect(page.getByRole('heading', { level: 1, name: 'Masuk', exact: true })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await expect(page).toHaveURL('/akun');
  await expect(page.getByRole('heading', { level: 2, name: 'Sesi aktif', exact: true })).toBeVisible();
  expect(await recordSessionTokens(page.context())).toBe(1);
}

/** A second browser with the same locale and time zone. */
async function newBrowser(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({ baseURL, locale: 'id-ID', timezoneId: 'Asia/Jakarta' });
}

/** The `datetime` of each `<time>` matches the API shape and its text is not empty, whatever the locale gives. */
async function expectSessionTimes(page: Page): Promise<void> {
  const times = page.getByRole('main').locator('li time');
  expect(await times.count()).toBeGreaterThan(0);
  for (const time of await times.all()) {
    expect(await time.getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect((await time.textContent())?.trim()).not.toBe('');
  }
}

/** Back to /akun through the navigation without a reload, so the page reads the identity and the list again. */
async function reopenAccount(page: Page): Promise<void> {
  const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await navigation.getByRole('link', { name: 'Beranda', exact: true }).click();
  await expect(page).toHaveURL('/');
  const listed = settled(page, isList);
  await navigation.getByRole('link', { name: 'Akun', exact: true }).click();
  await expect(page).toHaveURL('/akun');
  expect(await listed).toBe(200);
  await expect(page.getByRole('heading', { level: 2, name: 'Sesi aktif', exact: true })).toBeVisible();
}

test('AUTH-012 sign in through /masuk opens /akun with the name and email of the account, without auth values in script readable storage', async ({ page }) => {
  const email = required('FOUNDATION_E2E_ACCOUNT_EMAIL');
  const password = required('FOUNDATION_E2E_ACCOUNT_PASSWORD');
  const apiRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) apiRequests.push(`${request.method()} ${url.pathname}`);
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.setViewportSize({ width: 1280, height: 812 });
  await page.goto('/masuk');
  await expect(page.getByRole('heading', { level: 1, name: 'Masuk', exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Loading page' })).toBeHidden();
  // The page calls no API when it opens.
  expect(apiRequests).toEqual([]);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  const signedIn = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/session' && response.request().method() === 'POST');
  const identity = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/session' && response.request().method() === 'GET');
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  const signInResponse = await signedIn;
  expect(signInResponse.status()).toBe(200);
  expect(signInResponse.headers()['cache-control']).toBe('no-store');

  // /akun reads the identity once and shows the profile from the same account.
  await expect(page).toHaveURL('/akun');
  expect((await identity).status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Akun', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Profil', exact: true })).toBeVisible();
  const main = page.getByRole('main');
  await expect(main.locator('dd').first()).toHaveText(TEST_ACCOUNT_NAMES[0]);
  await expect(main.locator('dd').nth(1)).toHaveText(email);
  await expect(page.getByRole('heading', { level: 2, name: 'Sesi aktif', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('');
  await expect(page.getByRole('alert')).toHaveText('');
  // The identity, then the list of active sessions (spec 0014, *Halaman*).
  expect(apiRequests).toEqual(['POST /api/auth/session', 'GET /api/auth/session', 'GET /api/auth/sessions']);
  expect(await recordSessionTokens(page.context())).toBe(1);

  await expectNoAuthStorage(page, email, password);
  expect(pageErrors).toEqual([]);
});

test('AUTH-012 the account page lists the active sessions, ends another session of the account, and signs out, all without a reload', async ({ page, browser, baseURL }) => {
  const email = required('FOUNDATION_E2E_ACCOUNT_EMAIL');
  const password = required('FOUNDATION_E2E_ACCOUNT_PASSWORD');
  const apiRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) apiRequests.push(`${request.method()} ${url.pathname.replace(UUID_PATH, '<id>')}`);
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 812 });
  await signInThrough(page, email, password);
  const items = page.getByRole('main').getByRole('listitem');
  const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
  // The session of this page carries `Sesi ini` and no `Akhiri sesi`.
  const current = items.filter({ hasText: 'Sesi ini' });
  await expect(current).toHaveCount(1);
  await expect(current.getByRole('button', { name: 'Akhiri sesi' })).toHaveCount(0);
  await expectSessionTimes(page);

  // A second browser signs in to the same account, so this page gets one more session to end.
  const second = await newBrowser(browser, baseURL);
  try {
    const other = await second.newPage();
    await signInThrough(other, email, password);
    // Back to /akun through the navigation, without a reload: the list is read again.
    await navigation.getByRole('link', { name: 'Beranda', exact: true }).click();
    await expect(page).toHaveURL('/');
    await navigation.getByRole('link', { name: 'Akun', exact: true }).click();
    await expect(page).toHaveURL('/akun');
    // The list was read again: this session and the one of the second browser are both in it.
    await expect(items.filter({ hasText: 'Sesi ini' })).toHaveCount(1);
    await expect(items).not.toHaveCount(1);
    const others = items.filter({ has: page.getByRole('button', { name: 'Akhiri sesi', exact: true }) });
    expect(await others.count()).toBeGreaterThan(0);
    // The list of several sessions fits 375×812 and 1280×812 without horizontal overflow.
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 812 });
      await expect(items.first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${width}`).toBe(true);
    }
    const before = await items.count();
    const revoked = page.waitForResponse((response) => /^\/api\/auth\/sessions\/[0-9a-f-]{36}$/.test(new URL(response.url()).pathname) && response.request().method() === 'DELETE');
    await others.first().getByRole('button', { name: 'Akhiri sesi', exact: true }).click();
    expect((await revoked).status()).toBe(204);
    await expect(page.getByRole('status')).toHaveText(TEXT.revoked);
    await expect(page.getByRole('alert')).toHaveText('');
    await expect(items).toHaveCount(before - 1);
    await expect(items.filter({ hasText: 'Sesi ini' })).toHaveCount(1);
    await expectNoAuthStorage(page, email, password);

    // The newest other session is the one of the second browser (ordered by last_seen_at), so that browser is refused
    // now: /akun moves it to /masuk with the expired notice.
    await other.goto('/akun');
    await expect(other).toHaveURL('/masuk');
    await expect(other.getByRole('status')).toHaveText(TEXT.expired);
  } finally {
    await second.close();
  }

  // Keluar ends this session and moves to /masuk with its notice, without a reload.
  const signedOut = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/session' && response.request().method() === 'DELETE');
  await page.getByRole('button', { name: 'Keluar', exact: true }).click();
  expect((await signedOut).status()).toBe(204);
  await expect(page).toHaveURL('/masuk');
  await expect(page.getByRole('status')).toHaveText(TEXT.signedOut);
  // The cookie is gone and the session ended: /akun now moves to /masuk with the expired notice.
  await navigation.getByRole('link', { name: 'Akun', exact: true }).click();
  await expect(page).toHaveURL('/masuk');
  await expect(page.getByRole('status')).toHaveText(TEXT.expired);
  expect(apiRequests).toEqual([
    'POST /api/auth/session', 'GET /api/auth/session', 'GET /api/auth/sessions',
    'GET /api/auth/session', 'GET /api/auth/sessions',
    'DELETE /api/auth/sessions/<id>', 'GET /api/auth/sessions',
    'DELETE /api/auth/session',
    'GET /api/auth/session',
  ]);
  await expectNoAuthStorage(page, email, password);
  // The removal cookie of the sign out left no session cookie in the browser.
  expect((await page.context().cookies()).filter((cookie) => cookie.name.endsWith('foundation_session'))).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('AUTH-012 /masuk with a real database: a wrong password is invalid, the eleventh attempt for one email is limited, and a keyboard sign in opens /akun', async ({ page }) => {
  const email = required('FOUNDATION_E2E_ACCOUNT_EMAIL');
  const password = required('FOUNDATION_E2E_ACCOUNT_PASSWORD');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/masuk');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Masuk', exact: true })).toBeVisible();
  const button = page.getByRole('button', { name: 'Masuk', exact: true });

  /** One submit with the button, its status, and the alert text; the email stays and the password empties. */
  const attempt = async (address: string, text: string, status: number) => {
    await page.getByLabel('Email').fill(address);
    await page.getByLabel('Password').fill(`salah-${randomBytes(6).toString('hex')}`);
    const answer = settled(page, isSignIn);
    await button.click();
    expect(await answer).toBe(status);
    await expect(main.getByRole('alert')).toHaveText(text);
    await expect(main.getByRole('status')).toHaveText('');
    await expect(page.getByLabel('Email')).toHaveValue(address);
    await expect(page.getByLabel('Password')).toHaveValue('');
    await expect(button).not.toHaveAttribute('aria-disabled');
  };

  // invalid: the account with a wrong password (a later sign in of that account removes its attempt row).
  await attempt(email, TEXT.invalid, 401);
  // limited: an email of no account. Ten attempts in the window answer 401, the eleventh 429 (spec 0014, AC-6).
  const stranger = `batas-${randomBytes(6).toString('hex')}@example.test`;
  for (let count = 1; count <= 10; count += 1) await attempt(stranger, TEXT.invalid, 401);
  await attempt(stranger, TEXT.limited, 429);

  // A keyboard sign in: type the email, Tab to the password, Enter.
  await page.getByLabel('Email').fill('');
  await page.getByLabel('Email').focus();
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password')).toBeFocused();
  await page.keyboard.type(password);
  const signedIn = settled(page, isSignIn);
  await page.keyboard.press('Enter');
  expect(await signedIn).toBe(200);
  await expect(page).toHaveURL('/akun');
  await expect(main.getByRole('heading', { level: 2, name: 'Profil', exact: true })).toBeVisible();
  await expect(main.locator('dd').nth(1)).toHaveText(email);
  expect(await recordSessionTokens(page.context())).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expectNoAuthStorage(page, email, password);
  expect(pageErrors).toEqual([]);
});

/** The id of the session of `page` itself, from the `account-session-<id>` element of its `Sesi ini` item on /akun. */
async function ownSessionId(page: Page): Promise<string> {
  const id = await page.getByRole('main').getByRole('listitem').filter({ hasText: 'Sesi ini' }).locator('dl').getAttribute('id');
  expect(id).toMatch(/^account-session-[0-9a-f-]{36}$/);
  return id!.slice('account-session-'.length);
}

/** The list item of session `id` on the /akun page of `page`. */
function sessionItem(page: Page, id: string) {
  return page.getByRole('main').getByRole('listitem').filter({ has: page.locator(`[id="account-session-${id}"]`) });
}

test('AUTH-012 /akun actions: forbidden, failed, network, and unavailable keep the state, not-found reloads the list, unauthenticated moves to /masuk, and the session of another user stays out of reach through the API', async ({ page, browser, baseURL }) => {
  const email = required('FOUNDATION_E2E_ACCOUNT_EMAIL');
  const password = required('FOUNDATION_E2E_ACCOUNT_PASSWORD');
  const otherEmail = required('FOUNDATION_E2E_OTHER_EMAIL');
  const otherPassword = required('FOUNDATION_E2E_OTHER_PASSWORD');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 812 });
  const main = page.getByRole('main');
  const items = main.getByRole('listitem');
  const signOutButton = main.getByRole('button', { name: 'Keluar', exact: true });

  // Browser A and browser B hold sessions of the first account; browser C holds a session of the second account. The
  // account may hold sessions of earlier tests too, so every step names its session by id.
  await signInThrough(page, email, password);
  const sessionOfA = await ownSessionId(page);
  const contextB = await newBrowser(browser, baseURL);
  const contextC = await newBrowser(browser, baseURL);
  try {
    const pageB = await contextB.newPage();
    const pageC = await contextC.newPage();
    await signInThrough(pageB, email, password);
    const sessionOfB = await ownSessionId(pageB);
    await signInThrough(pageC, otherEmail, otherPassword);
    await expect(pageC.getByRole('main').locator('dd').first()).toHaveText(TEST_ACCOUNT_NAMES[1]);
    const sessionOfC = await ownSessionId(pageC);

    // Cross user access through the API from the page of A, with A's own CSRF token, which never leaves the page: the
    // session of C answers 404 like an id that does not exist, and stays out of A's list. A session id is no credential.
    const crossUser = await page.evaluate(async (id) => {
      const identity = (await (await fetch('/api/auth/session')).json()) as { csrfToken: string };
      const revoke = await fetch(`/api/auth/sessions/${id}`, { method: 'DELETE', headers: { 'x-csrf-token': identity.csrfToken } });
      const list = (await (await fetch('/api/auth/sessions')).json()) as { sessions: { id: string }[] };
      return { status: revoke.status, body: await revoke.text(), listed: list.sessions.some((session) => session.id === id) };
    }, sessionOfC);
    expect(crossUser).toEqual({ status: 404, body: '{"error":"Not found"}', listed: false });
    // The session of C is untouched: a reload of its /akun still shows the profile and the same session.
    await pageC.reload();
    await expect(pageC).toHaveURL('/akun');
    await expect(pageC.getByRole('heading', { level: 2, name: 'Profil', exact: true })).toBeVisible();
    expect(await ownSessionId(pageC)).toBe(sessionOfC);

    // A reads its list again and sees the session of B.
    await reopenAccount(page);
    const endB = sessionItem(page, sessionOfB).getByRole('button', { name: 'Akhiri sesi', exact: true });
    await expect(endB).toHaveCount(1);
    const listed = await items.count();

    // Akhiri sesi with an answer that leaves the list as it was. While one request runs, only that button is disabled
    // and a second press sends nothing.
    let revokeRequests = 0;
    page.on('request', (request) => {
      if (isRevoke(request)) revokeRequests += 1;
    });
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const heldUnavailable = onDelete(async (route) => {
      await gate;
      await unavailable(route);
    });
    const revokeCases: [string, (route: Route) => Promise<void>, string, number][] = [
      ['forbidden', onDelete(changed({ 'x-csrf-token': 'A'.repeat(43) })), TEXT.forbidden, 403],
      ['failed', onDelete(changed({ 'x-csrf-token': '!'.repeat(43) })), TEXT.revokeFailed, 400],
      ['network', onDelete(refused), TEXT.network, 0],
      ['unavailable', heldUnavailable, TEXT.unavailable, 503],
    ];
    for (const [label, handler, text, status] of revokeCases) {
      await page.route('**/api/auth/sessions/*', handler);
      const answer = settled(page, isRevoke);
      const counted = revokeRequests;
      if (label === 'forbidden') {
        // Keyboard: the button is reached with focus and pressed with Enter.
        await endB.focus();
        await page.keyboard.press('Enter');
      } else await endB.click();
      if (label === 'unavailable') {
        await expect(endB).toHaveAttribute('aria-disabled', 'true');
        await expect(signOutButton).not.toHaveAttribute('aria-disabled');
        // `force`, because the button is aria-disabled while its request runs and a normal click would wait for it.
        await endB.click({ force: true });
        release();
      }
      expect(await answer, label).toBe(status);
      await expect(main.getByRole('alert'), label).toHaveText(text);
      await expect(main.getByRole('status'), label).toHaveText('');
      await expect(items, label).toHaveCount(listed);
      await expect(endB, label).not.toHaveAttribute('aria-disabled');
      expect(revokeRequests - counted, label).toBe(1);
      await page.unroute('**/api/auth/sessions/*', handler);
    }

    // Keluar with an answer that keeps the state: still /akun, the list stays, and Keluar is active again.
    const signOutCases: [string, (route: Route) => Promise<void>, string, number][] = [
      ['forbidden', onDelete(changed({ 'x-csrf-token': 'A'.repeat(43) })), TEXT.forbidden, 403],
      ['failed', onDelete(changed({ 'x-csrf-token': '!'.repeat(43) })), TEXT.failed, 400],
      ['network', onDelete(refused), TEXT.network, 0],
      ['unavailable', onDelete(unavailable), TEXT.unavailable, 503],
    ];
    for (const [label, handler, text, status] of signOutCases) {
      await page.route('**/api/auth/session', handler);
      const answer = settled(page, isSignOut);
      await signOutButton.click();
      expect(await answer, label).toBe(status);
      await expect(main.getByRole('alert'), label).toHaveText(text);
      await expect(main.getByRole('status'), label).toHaveText('');
      await expect(page, label).toHaveURL('/akun');
      await expect(items, label).toHaveCount(listed);
      await expect(signOutButton, label).not.toHaveAttribute('aria-disabled');
      await page.unroute('**/api/auth/session', handler);
    }

    // not-found: B signs out, and A ends B's session from its list, which still shows it. The alert says the session
    // already ended, and the list is read again without it.
    const signedOutB = settled(pageB, isSignOut);
    await pageB.getByRole('main').getByRole('button', { name: 'Keluar', exact: true }).click();
    expect(await signedOutB).toBe(204);
    await expect(pageB).toHaveURL('/masuk');
    await expect(pageB.getByRole('status')).toHaveText(TEXT.signedOut);
    const notFound = settled(page, isRevoke);
    const reloaded = settled(page, isList);
    await endB.click();
    expect(await notFound).toBe(404);
    expect(await reloaded).toBe(200);
    await expect(main.getByRole('alert')).toHaveText(TEXT.revokeNotFound);
    await expect(main.getByRole('status')).toHaveText('');
    await expect(items).toHaveCount(listed - 1);
    await expect(sessionItem(page, sessionOfB)).toHaveCount(0);

    // unauthenticated: B signs in again and ends A's session from its own list; A then presses Akhiri sesi on B's new
    // session. The backend refuses A (401), so A empties its state and moves to /masuk with the expired notice, and B's
    // new session is unchanged.
    await signInThrough(pageB, email, password);
    const newSessionOfB = await ownSessionId(pageB);
    await reopenAccount(page);
    const endNewB = sessionItem(page, newSessionOfB).getByRole('button', { name: 'Akhiri sesi', exact: true });
    await expect(endNewB).toHaveCount(1);
    const endedA = settled(pageB, isRevoke);
    await sessionItem(pageB, sessionOfA).getByRole('button', { name: 'Akhiri sesi', exact: true }).click();
    expect(await endedA).toBe(204);
    await expect(pageB.getByRole('status')).toHaveText(TEXT.revoked);
    const refusedA = settled(page, isRevoke);
    await endNewB.click();
    expect(await refusedA).toBe(401);
    await expect(page).toHaveURL('/masuk');
    await expect(page.getByRole('status')).toHaveText(TEXT.expired);
    await pageB.reload();
    await expect(pageB).toHaveURL('/akun');
    expect(await ownSessionId(pageB)).toBe(newSessionOfB);

    for (const [checked, address, secret] of [[page, email, password], [pageB, email, password], [pageC, otherEmail, otherPassword]] as const) {
      await expectNoAuthStorage(checked, address, secret);
    }
  } finally {
    await contextB.close();
    await contextC.close();
  }
  expect(pageErrors).toEqual([]);
});

test('AUTH-010 through a sign in, a reload, and a sign out the session lives only in an HttpOnly SameSite=Strict cookie: no auth value in storage or document.cookie, no token or password in an API body, and the CSRF token only in AuthSession bodies', async ({ page }) => {
  const email = required('FOUNDATION_E2E_OTHER_EMAIL');
  const password = required('FOUNDATION_E2E_OTHER_PASSWORD');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  // Every API answer of this page, kept in memory only: its route and status, and its body to search, never printed.
  const answers: Array<Promise<{ route: string; body: string }>> = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/')) return;
    const route = `${response.request().method()} ${url.pathname.replace(UUID_PATH, '<id>')} ${response.status()}`;
    answers.push(response.text().then((body) => ({ route, body }), () => ({ route, body: '' })));
  });
  await page.setViewportSize({ width: 1280, height: 812 });
  await signInThrough(page, email, password);
  await expectNoAuthStorage(page, email, password);
  // The development cookie of *Cookie sesi*: only its attributes are compared; its value stays in memory.
  const cookies = (await page.context().cookies()).filter((cookie) => cookie.name === 'foundation_session');
  expect(cookies.map(({ httpOnly, sameSite, path, secure, expires }) => ({ httpOnly, sameSite, path, secure, browserSession: expires === -1 })))
    .toEqual([{ httpOnly: true, sameSite: 'Strict', path: '/', secure: false, browserSession: true }]);
  const token = cookies[0]!.value;
  const csrf = csrfTokenOf(token);

  // A reload reads the identity and the list again from the cookie alone.
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: 'Sesi aktif', exact: true })).toBeVisible();
  await expectNoAuthStorage(page, email, password);

  // Keluar ends the session; the removal cookie leaves no session cookie behind.
  const signedOut = settled(page, isSignOut);
  await page.getByRole('button', { name: 'Keluar', exact: true }).click();
  expect(await signedOut).toBe(204);
  await expect(page).toHaveURL('/masuk');
  await expect(page.getByRole('status')).toHaveText(TEXT.signedOut);
  await expectNoAuthStorage(page, email, password);
  expect((await page.context().cookies()).filter((cookie) => cookie.name.endsWith('foundation_session'))).toEqual([]);

  // Only routes are compared, so a failure names the answer and never prints a token or the password.
  const bodies = await Promise.all(answers);
  expect(bodies.map(({ route }) => route)).toEqual([
    'POST /api/auth/session 200', 'GET /api/auth/session 200', 'GET /api/auth/sessions 200',
    'GET /api/auth/session 200', 'GET /api/auth/sessions 200', 'DELETE /api/auth/session 204',
  ]);
  expect(bodies.filter(({ body }) => body.includes(token)).map(({ route }) => route)).toEqual([]);
  expect(bodies.filter(({ body }) => body.includes(password)).map(({ route }) => route)).toEqual([]);
  expect(bodies.filter(({ body }) => body.includes(csrf)).map(({ route }) => route)).toEqual([
    'POST /api/auth/session 200', 'GET /api/auth/session 200', 'GET /api/auth/session 200',
  ]);
  expect(pageErrors).toEqual([]);
});

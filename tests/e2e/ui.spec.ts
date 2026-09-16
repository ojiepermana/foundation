import { test, expect } from '@playwright/test';

// UI isolation tests. Live service/authenticator integration is a separate suite.
const account = { id: 'ui-test-user', name: 'Ayu Pratama', email: 'ayu@example.test', role: 'admin', status: 'active', createdAt: '2026-09-16T00:00:00Z' };
const base = process.env['E2E_BASE_URL'] || 'http://localhost:8088';

test('[UI isolation] login has real labels, centered fluid layout and validates fields', async ({ page }) => {
  await page.goto(base + '/login');
  await expect(page.getByRole('heading', { name: 'Selamat datang kembali' })).toBeVisible();
  await expect(page.locator('LayoutFluid')).toBeVisible();
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await expect(page.getByText('Isi alamat email Anda.')).toBeVisible();
  await expect(page.getByText('Isi kata sandi Anda.')).toBeVisible();
  await expect(page.getByLabel('Alamat email')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Masuk dengan passkey' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.locator('Icon').first().evaluate(icon => icon.getBoundingClientRect().width)).toBeLessThanOrEqual(24);
});

test('[UI isolation] session guard redirects an unauthenticated visitor', async ({ page }) => {
  await page.route('**/api/v1/auth/session', route => route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED', message: 'Masuk terlebih dahulu.' } } }));
  await page.goto(base + '/dashboard');
  await expect(page).toHaveURL(/\/login$/);
});

test('[UI isolation] keyboard-only visitor can validate login and open password recovery', async ({ page }) => {
  let loginRequests = 0;
  await page.route('**/api/v1/auth/login', route => {
    loginRequests++;
    return route.fulfill({ status: 400, json: { error: { code: 'INVALID_INPUT', message: 'Kata sandi diperlukan.' } } });
  });
  await page.goto(base + '/login');
  await expect(page.getByRole('heading', { name: 'Selamat datang kembali' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Foundation, halaman masuk' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Alamat email')).toBeFocused();
  await page.keyboard.type('ayu@example.test');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Lupa kata sandi?' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Kata sandi', { exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Isi kata sandi Anda.')).toBeVisible();
  expect(loginRequests).toBe(0);
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('link', { name: 'Lupa kata sandi?' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/forgot-password$/);
  await expect(page.getByRole('heading', { name: 'Lupa kata sandi?' })).toBeVisible();
});

test('[UI isolation] dashboard uses library shell and placeholder content without invented metrics', async ({ page }) => {
  await page.route('**/api/v1/auth/session', route => route.fulfill({ json: { data: { user: account, csrfToken: 'ui-csrf' } } }));
  await page.goto(base + '/dashboard');
  await expect(page.locator('LayoutWrapperDefault')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Halo, Ayu Pratama.' })).toBeVisible();
  await expect(page.getByText('Belum tersedia', { exact: true })).toHaveCount(3);
  await expect(page.getByRole('link', { name: 'Pengguna', exact: true })).toBeVisible();
});

test('[UI isolation] regular users do not see admin navigation and cannot enter its route', async ({ page }) => {
  await page.route('**/api/v1/auth/session', route => route.fulfill({ json: { data: { user: { ...account, role: 'user' }, csrfToken: 'ui-csrf' } } }));
  await page.goto(base + '/users');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('link', { name: 'Pengguna', exact: true })).toHaveCount(0);
});

test('[UI isolation] mobile dashboard fits viewport and opens accessible navigation', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await page.route('**/api/v1/auth/session', route => route.fulfill({ json: { data: { user: account, csrfToken: 'ui-csrf' } } }));
  await page.goto(base + '/dashboard');
  await expect(page.getByRole('heading', { name: 'Halo, Ayu Pratama.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Buka navigasi' }).click();
  await expect(page.getByRole('button', { name: 'Tutup navigasi' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Profil', exact: true })).toBeVisible();
});

test('[UI isolation] activation link token is removed from location and confirmation remains required', async ({ page }) => {
  await page.goto(base + '/activate#token=example-secret');
  await expect(page).toHaveURL(base + '/activate');
  await page.getByLabel('Kata sandi baru', { exact: true }).fill('A long test password 123');
  await page.getByLabel('Ulangi kata sandi', { exact: true }).fill('Different password 123');
  await page.getByRole('button', { name: 'Aktifkan akun', exact: true }).click();
  await expect(page.getByText('Kata sandi belum sama.')).toBeVisible();
});

test('[UI isolation] profile renders empty passkeys and preserves actionable load failure', async ({ page }) => {
  await page.route('**/api/v1/auth/session', route => route.fulfill({ json: { data: { user: account, csrfToken: 'ui-csrf' } } }));
  let reads = 0;
  await page.route('**/api/v1/me/passkeys', route => route.fulfill(++reads === 1
    ? { status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Layanan belum tersedia. Coba kembali.' } } }
    : { json: { data: [] } }));
  await page.goto(base + '/profile');
  await expect(page.getByRole('heading', { name: 'Profil & keamanan' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Layanan belum tersedia');
  await page.getByRole('button', { name: 'Coba kembali' }).click();
  await expect(page.getByRole('heading', { name: 'Belum ada passkey' })).toBeVisible();
  await expect(page.getByLabel('Nama lengkap')).toHaveValue(account.name);
});

test('[UI isolation] admin edits role through native library select and sends CSRF', async ({ page }) => {
  const member = { ...account, id: 'member-id', name: 'Budi Santoso', role: 'user' };
  await page.route('**/api/v1/auth/session', route => route.fulfill({ json: { data: { user: account, csrfToken: 'ui-csrf' } } }));
  await page.route('**/api/v1/users?**', route => route.fulfill({ json: { data: [member], meta: { total: 1, page: 1, limit: 20 } } }));
  let payload: unknown;
  let csrf: string | undefined;
  await page.route('**/api/v1/users/member-id', route => {
    payload = route.request().postDataJSON(); csrf = route.request().headers()['x-csrf-token'];
    return route.fulfill({ json: { data: { ...member, role: 'admin' } } });
  });
  await page.goto(base + '/users');
  await page.getByRole('button', { name: 'Edit Budi Santoso' }).click();
  await expect(page.getByLabel('Nama lengkap')).toBeFocused();
  await page.getByLabel('Peran', { exact: true }).selectOption('admin');
  await page.getByRole('button', { name: 'Simpan perubahan' }).click();
  await expect(page.getByRole('status')).toContainText('telah disimpan');
  expect(payload).toEqual({ name: 'Budi Santoso', role: 'admin' });
  expect(csrf).toBe('ui-csrf');
});

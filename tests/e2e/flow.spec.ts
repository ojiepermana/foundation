import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const password = 'Foundation-e2e-password-2026';
async function fixture() { return JSON.parse(await readFile('.local/e2e/context.json', 'utf8')) as { env: Record<string, string>; databaseName: string }; }
async function register(name: string, email: string, role: 'admin' | 'user') {
  const context = await fixture();
  await run('bun', ['scripts/user-register.ts', '--name', name, '--email', email, '--role', role], { env: { ...process.env, ...context.env }, timeout: 15_000 });
}
async function mailLink(email: string, purpose: 'activate' | 'reset-password') {
  let result = '';
  await expect.poll(async () => {
    const messages = JSON.parse(await readFile('.local/e2e/mail.json', 'utf8')) as { to: string; raw: string }[];
    for (const message of messages.toReversed()) {
      if (message.to !== email) continue;
      const decoded = message.raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
      const match = decoded.match(new RegExp(`https?://[^\\s<>\"]+/${purpose}#token=[A-Za-z0-9_-]+`));
      if (match) { result = match[0]; return true; }
    }
    return false;
  }, { timeout: 20_000, message: 'Local SMTP sink receives action email from the real worker' }).toBe(true);
  return result;
}
async function activate(page: Page, email: string) {
  await page.goto(await mailLink(email, 'activate'));
  await page.getByLabel('Kata sandi baru', { exact: true }).fill(password);
  await page.getByLabel('Ulangi kata sandi', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Aktifkan akun', exact: true }).click();
  await expect(page.getByRole('status')).toBeVisible();
}
async function login(page: Page, email: string, value = password) {
  await page.goto('/login');
  await page.getByLabel('Alamat email').fill(email);
  await page.getByLabel('Kata sandi', { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}
async function session(page: Page) { return (await (await page.request.get('/api/v1/auth/session')).json()).data; }
async function logout(page: Page) {
  const data = await session(page);
  const response = await page.request.post('/api/v1/auth/logout', { headers: { origin: 'http://localhost:8090', 'x-csrf-token': data.csrfToken } });
  expect(response.status()).toBe(200); await page.goto('/login');
}

test('[Live services] CLI → SMTP → activation → password/passkey → admin → recovery', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const suffix = Date.now(); const adminEmail = `e2e-admin-${suffix}@example.test`; const memberEmail = `e2e-member-${suffix}@example.test`;
  await register('Admin Uji', adminEmail, 'admin');
  await activate(page, adminEmail);
  await login(page, adminEmail);
  await expect(page.getByRole('heading', { name: 'Halo, Admin Uji.' })).toBeVisible();
  const cookie = (await page.context().cookies()).find(item => item.name === 'foundation_session');
  expect(cookie?.httpOnly).toBe(true); expect(cookie?.sameSite).toBe('Lax');
  await page.reload(); await expect(page.getByRole('heading', { name: 'Halo, Admin Uji.' })).toBeVisible();
  await page.screenshot({ path: '.local/e2e/dashboard.png', fullPage: true });

  await page.getByRole('link', { name: 'Profil', exact: true }).click();
  await page.getByLabel('Nama lengkap', { exact: true }).fill('Admin Foundation');
  await page.getByRole('button', { name: 'Simpan perubahan', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('diperbarui');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.getByLabel('Nama passkey', { exact: true }).fill('Perangkat uji virtual');
  await page.getByLabel('Konfirmasi kata sandi', { exact: true }).fill(password);
  const registrationRequest = page.waitForRequest(request => request.url().endsWith('/me/passkeys/verify'));
  await page.getByRole('button', { name: 'Tambahkan passkey', exact: true }).click();
  const registration = (await registrationRequest).postDataJSON();
  await expect(page.getByRole('button', { name: 'Hapus passkey Perangkat uji virtual' })).toBeVisible();
  let current = await session(page);
  const replay = await page.request.post('/api/v1/me/passkeys/verify', { data: registration, headers: { origin: 'http://localhost:8090', 'x-csrf-token': current.csrfToken } });
  expect(replay.status()).toBe(400);

  await logout(page);
  await page.getByRole('button', { name: 'Masuk dengan passkey', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  current = await session(page);
  const reauthRequired = await page.request.post('/api/v1/me/passkeys/options', { headers: { origin: 'http://localhost:8090', 'x-csrf-token': current.csrfToken } });
  expect(reauthRequired.status()).toBe(403); expect((await reauthRequired.json()).error.code).toBe('REAUTH_REQUIRED');
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Hapus passkey Perangkat uji virtual' }).click();
  await page.getByLabel('Konfirmasi kata sandi', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Hapus passkey', exact: true }).click();
  await expect(page.getByText('Belum ada passkey', { exact: true })).toBeVisible();
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });

  await register('Anggota Uji', memberEmail, 'user');
  const memberContext = await browser.newContext({ baseURL: 'http://localhost:8090' }); const memberPage = await memberContext.newPage();
  await activate(memberPage, memberEmail); await login(memberPage, memberEmail);
  expect((await memberPage.request.get('/api/v1/users')).status()).toBe(403);
  await page.goto('/users');
  await page.getByLabel('Cari nama atau email').fill(memberEmail);
  await page.getByRole('button', { name: 'Cari', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Anggota Uji', exact: true }).click();
  await page.getByLabel('Status', { exact: true }).selectOption('disabled');
  await page.getByRole('button', { name: 'Simpan perubahan', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('disimpan');
  expect((await memberPage.request.get('/api/v1/auth/session')).status()).toBe(401);
  await memberContext.close();
  current = await session(page);
  const lastAdmin = await page.request.patch(`/api/v1/users/${current.user.id}`, { data: { role: 'user' }, headers: { origin: 'http://localhost:8090', 'x-csrf-token': current.csrfToken } });
  expect(lastAdmin.status()).toBe(409);

  await logout(page);
  await page.getByRole('link', { name: 'Lupa kata sandi?' }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await expect(page.getByRole('heading', { name: 'Lupa kata sandi?', exact: true })).toBeVisible();
  await page.getByLabel('Alamat email').fill(adminEmail);
  await page.getByRole('button', { name: 'Kirim tautan pemulihan', exact: true }).click();
  await expect(page.getByRole('status')).toBeVisible();
  await page.goto(await mailLink(adminEmail, 'reset-password'));
  const replacement = `${password}-reset`;
  await page.getByLabel('Kata sandi baru', { exact: true }).fill(replacement);
  await page.getByLabel('Ulangi kata sandi', { exact: true }).fill(replacement);
  await page.getByRole('button', { name: 'Simpan kata sandi', exact: true }).click();
  await expect(page.getByRole('status')).toBeVisible();
  await login(page, adminEmail, replacement);
  await expect(page.getByRole('heading', { name: 'Halo, Admin Foundation.' })).toBeVisible();
});

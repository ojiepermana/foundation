import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Observable, Subject } from 'rxjs';
import { vi, type MockInstance } from 'vitest';
import { routes } from '../../app.routes';
import { SessionState } from '../../core/session/session-state';
import {
  AuthApi,
  type CheckedAuthSession,
  type ListedSession,
  type RevokeResult,
  type SessionResult,
  type SessionsResult,
  type SignInResult,
  type SignOutResult,
} from './auth-api';
import { AccountPage } from './account-page';
import { SignInPage } from './sign-in-page';

// AUTH-012 (spec 0014, AC-12): `/akun` with an AuthApi double built on Subject, so the test decides when each call
// answers. Covers every row of `/akun` in table *State halaman*: loading, the identity read before the list, the profile
// and the active sessions, `unauthenticated` from either read, load failures with `Coba lagi`, every result of `Akhiri
// sesi` and `Keluar`, one request per button while it runs, and one text per region. The last group runs both pages
// through the application routes, so the moves between `/masuk` and `/akun` and the notice are real router navigations.
// Texts are copied from the spec tables, not imported from the page. The real browser flows are in tests/e2e/auth/.
const TEXT = {
  loading: 'Memuat akun.',
  forbidden: 'Permintaan ditolak. Muat ulang halaman, lalu coba lagi.',
  unavailable: 'Layanan belum tersedia. Coba lagi beberapa saat lagi.',
  network: 'Backend tidak dapat dihubungi. Periksa koneksi, lalu coba lagi.',
  failed: 'Permintaan gagal. Coba lagi beberapa saat lagi.',
  revoked: 'Sesi diakhiri.',
  revokeNotFound: 'Sesi sudah berakhir.',
  revokeFailed: 'Sesi tidak dapat diakhiri. Coba lagi.',
} as const;

const CSRF = 'Abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';
const CURRENT_ID = '0b6f8f9c-3c1d-4c5e-9a7b-2d4e6f8a0b1c';
const OTHER_ID = '1c7a9e0d-4d2e-4f6a-8b9c-3e5f7a9b1c2d';
const THIRD_ID = '2d8b0f1e-5e3f-4a7b-9c0d-4f6a8b0c2d3e';
const identity: CheckedAuthSession = {
  user: { id: '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a', email: 'ana@foundation.test', displayName: 'Ana Uji' },
  session: {
    id: CURRENT_ID,
    createdAt: '2026-10-06T08:00:00.000Z',
    lastSeenAt: '2026-10-06T08:05:00.000Z',
    idleExpiresAt: '2026-10-06T08:35:00.000Z',
    expiresAt: '2026-10-06T20:00:00.000Z',
  },
  csrfToken: CSRF,
};
const current: ListedSession = { id: CURRENT_ID, createdAt: '2026-10-06T08:00:00.000Z', lastSeenAt: '2026-10-06T08:05:00.000Z', current: true };
const other: ListedSession = { id: OTHER_ID, createdAt: '2026-10-05T21:10:00.000Z', lastSeenAt: '2026-10-06T07:45:30.000Z', current: false };
const third: ListedSession = { id: THIRD_ID, createdAt: '2026-10-04T23:59:59.000Z', lastSeenAt: '2026-10-05T00:01:02.000Z', current: false };

/** One pending call of the double: what it was given and the Subject the test answers. */
interface Pending<T, A = undefined> {
  readonly args: A;
  readonly results: Subject<T>;
}

function pendingCall<T, A>(calls: Pending<T, A>[], args: A): Observable<T> {
  return new Observable<T>((subscriber) => {
    const pending: Pending<T, A> = { args, results: new Subject<T>() };
    calls.push(pending);
    const subscription = pending.results.subscribe(subscriber);
    return () => subscription.unsubscribe();
  });
}

/** Answers the latest pending call once and completes it, like the real adapter. */
function reply<T, A>(calls: Pending<T, A>[], result: NoInfer<T>): void {
  const pending = calls.at(-1);
  if (!pending || pending.results.closed || !pending.results.observed) throw new Error('No pending call to answer.');
  pending.results.next(result);
  pending.results.complete();
}

/** Stand in for AuthApi: every subscription is one pending call that the test answers. */
class AuthApiDouble {
  readonly identities: Pending<SessionResult>[] = [];
  readonly lists: Pending<SessionsResult>[] = [];
  readonly revokes: Pending<RevokeResult, { sessionId: string; csrfToken: string }>[] = [];
  readonly signOuts: Pending<SignOutResult, { csrfToken: string }>[] = [];

  session(): Observable<SessionResult> {
    return pendingCall(this.identities, undefined);
  }

  sessions(): Observable<SessionsResult> {
    return pendingCall(this.lists, undefined);
  }

  revoke(sessionId: string, csrfToken: string): Observable<RevokeResult> {
    return pendingCall(this.revokes, { sessionId, csrfToken });
  }

  signOut(csrfToken: string): Observable<SignOutResult> {
    return pendingCall(this.signOuts, { csrfToken });
  }

  readonly signIns: Pending<SignInResult, { email: string; password: string }>[] = [];

  signIn(email: string, password: string): Observable<SignInResult> {
    return pendingCall(this.signIns, { email, password });
  }
}

interface Rendered {
  fixture: ComponentFixture<AccountPage>;
  api: AuthApiDouble;
  element: HTMLElement;
  state: SessionState;
  navigate: MockInstance<Router['navigateByUrl']>;
}

async function render(before?: (state: SessionState) => void): Promise<Rendered> {
  const api = new AuthApiDouble();
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthApi, useValue: api }] });
  const state = TestBed.inject(SessionState);
  before?.(state);
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  const fixture = TestBed.createComponent(AccountPage);
  await fixture.whenStable();
  return { fixture, api, element: fixture.nativeElement as HTMLElement, state, navigate };
}

async function settle(rendered: Rendered): Promise<void> {
  await rendered.fixture.whenStable();
}

/** `/akun` with the identity read and the list of three sessions: the caller's, then two others. */
async function ready(): Promise<Rendered> {
  const rendered = await render();
  reply(rendered.api.identities, { status: 'signed-in', session: identity });
  reply(rendered.api.lists, { status: 'listed', sessions: [current, other, third] });
  await settle(rendered);
  return rendered;
}

const text = (node: Element | null | undefined) => node?.textContent?.trim() ?? '';
const alertText = (element: HTMLElement) => text(element.querySelector('[role="alert"]'));
const statusText = (element: HTMLElement) => text(element.querySelector('[role="status"]'));
const headings = (element: HTMLElement) => [...element.querySelectorAll('h1, h2')].map(text);
const buttons = (element: HTMLElement, name: string) => [...element.querySelectorAll('button')].filter((button) => text(button) === name);
const items = (element: HTMLElement) => [...element.querySelectorAll('li')];

/** The `Akhiri sesi` button of the session with this id, found through its aria-describedby. */
function endButton(element: HTMLElement, sessionId: string): HTMLButtonElement {
  const found = buttons(element, 'Akhiri sesi').find((button) => button.getAttribute('aria-describedby') === `account-session-${sessionId}`);
  if (!found) throw new Error(`No Akhiri sesi button for ${sessionId}`);
  return found;
}

async function click(rendered: Rendered, button: HTMLButtonElement): Promise<void> {
  button.click();
  await settle(rendered);
}

function expectLoading(element: HTMLElement): void {
  expect(statusText(element)).toBe(TEXT.loading);
  expect(alertText(element)).toBe('');
  expect(element.querySelector('spinner')).not.toBeNull();
  expect(headings(element)).toEqual(['Akun']);
  expect(buttons(element, 'Keluar')).toHaveLength(0);
  expect(buttons(element, 'Coba lagi')).toHaveLength(0);
}

function expectSignedOutState(state: SessionState, notice: 'expired' | 'signed-out'): void {
  expect(state.status()).toBe('signed-out');
  expect(state.user()).toBeNull();
  expect(state.csrfToken()).toBeNull();
  expect(state.notice()).toBe(notice);
}

describe('AUTH-012 account page /akun loading', () => {
  it('reads the identity first and shows the loading text without the profile or session sections', async () => {
    const rendered = await render();
    expect(rendered.api.identities).toHaveLength(1);
    expect(rendered.api.lists).toHaveLength(0);
    expectLoading(rendered.element);
    expect(rendered.element.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(rendered.element.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it('reads the list only after the identity, fills the session state from it, and stays loading until the list answers', async () => {
    const rendered = await render();
    reply(rendered.api.identities, { status: 'signed-in', session: identity });
    await settle(rendered);
    expect(rendered.api.lists).toHaveLength(1);
    expect(rendered.state.status()).toBe('signed-in');
    expect(rendered.state.user()).toEqual(identity.user);
    expect(rendered.state.csrfToken()).toBe(CSRF);
    expectLoading(rendered.element);
  });

  it('shows Profil with the name and email, then Sesi aktif with the times of the API, Sesi ini on the caller, Akhiri sesi on the others, and Keluar', async () => {
    const { element, api } = await ready();
    expect(statusText(element)).toBe('');
    expect(alertText(element)).toBe('');
    expect(element.querySelector('spinner')).toBeNull();
    expect(headings(element)).toEqual(['Akun', 'Profil', 'Sesi aktif']);
    expect([...element.querySelectorAll('dt')].slice(0, 2).map(text)).toEqual(['Nama', 'Email']);
    expect([...element.querySelectorAll('dd')].slice(0, 2).map(text)).toEqual(['Ana Uji', 'ana@foundation.test']);

    const list = element.querySelector('ul')!;
    const sessionsHeading = [...element.querySelectorAll('h2')].find((heading) => text(heading) === 'Sesi aktif')!;
    expect(list.getAttribute('aria-labelledby')).toBe(sessionsHeading.id);
    const rows = items(element);
    expect(rows).toHaveLength(3);
    for (const [index, session] of [current, other, third].entries()) {
      const row = rows[index]!;
      const times = [...row.querySelectorAll('time')];
      expect(times.map((time) => time.getAttribute('datetime'))).toEqual([session.createdAt, session.lastSeenAt]);
      for (const time of times) expect(text(time)).not.toBe('');
      expect([...row.querySelectorAll('dt')].map(text)).toEqual(['Dibuat', 'Terakhir aktif']);
      if (session.current) {
        expect(text(row.querySelector('badge'))).toBe('Sesi ini');
        expect(row.querySelector('button')).toBeNull();
      } else {
        expect(row.querySelector('badge')).toBeNull();
        const button = row.querySelector('button')!;
        expect(text(button)).toBe('Akhiri sesi');
        expect(button.type).toBe('button');
        // The button is described by the times of its own session.
        const described = element.querySelector(`[id="${button.getAttribute('aria-describedby')}"]`);
        expect(described).not.toBeNull();
        expect(row.contains(described)).toBe(true);
      }
    }
    expect(buttons(element, 'Keluar')).toHaveLength(1);
    expect(buttons(element, 'Coba lagi')).toHaveLength(0);
    expect(api.identities).toHaveLength(1);
    expect(api.lists).toHaveLength(1);
  });

  it('when the identity read is unauthenticated, empties the state, sets the notice expired, and replaces /akun with /masuk', async () => {
    const rendered = await render((state) => state.signedIn(identity.user, CSRF));
    reply(rendered.api.identities, { status: 'unauthenticated' });
    await settle(rendered);
    expectSignedOutState(rendered.state, 'expired');
    expect(rendered.navigate.mock.calls).toEqual([['/masuk', { replaceUrl: true }]]);
    expect(rendered.api.lists).toHaveLength(0);
  });

  it('when the list read is unauthenticated, empties the state it just filled and replaces /akun with /masuk', async () => {
    const rendered = await render();
    reply(rendered.api.identities, { status: 'signed-in', session: identity });
    reply(rendered.api.lists, { status: 'unauthenticated' });
    await settle(rendered);
    expectSignedOutState(rendered.state, 'expired');
    expect(rendered.navigate.mock.calls).toEqual([['/masuk', { replaceUrl: true }]]);
  });

  const loadFailures: ['unavailable' | 'network' | 'failed', string][] = [
    ['unavailable', TEXT.unavailable],
    ['network', TEXT.network],
    ['failed', TEXT.failed],
  ];
  for (const [status, message] of loadFailures) {
    it(`when the identity read is ${status}, shows its text with Coba lagi, which repeats both calls`, async () => {
      const rendered = await render();
      const { api, element } = rendered;
      reply(api.identities, { status });
      await settle(rendered);
      expect(alertText(element)).toBe(message);
      expect(statusText(element)).toBe('');
      expect(headings(element)).toEqual(['Akun']);
      expect(api.lists).toHaveLength(0);
      expect(rendered.navigate).not.toHaveBeenCalled();

      await click(rendered, buttons(element, 'Coba lagi')[0]!);
      expect(api.identities).toHaveLength(2);
      expectLoading(element);
      reply(api.identities, { status: 'signed-in', session: identity });
      reply(api.lists, { status: 'listed', sessions: [current] });
      await settle(rendered);
      expect(headings(element)).toEqual(['Akun', 'Profil', 'Sesi aktif']);
      expect(alertText(element)).toBe('');
    });

    it(`when the list read is ${status}, shows its text with Coba lagi and no profile, and Coba lagi reads the identity again`, async () => {
      const rendered = await render();
      const { api, element } = rendered;
      reply(api.identities, { status: 'signed-in', session: identity });
      reply(api.lists, { status });
      await settle(rendered);
      expect(alertText(element)).toBe(message);
      expect(headings(element)).toEqual(['Akun']);
      expect(buttons(element, 'Keluar')).toHaveLength(0);

      await click(rendered, buttons(element, 'Coba lagi')[0]!);
      expect(api.identities).toHaveLength(2);
      expect(api.lists).toHaveLength(1);
      expectLoading(element);
    });
  }

  it('stops listening to the running load when the page is destroyed', async () => {
    const rendered = await render();
    const pending = rendered.api.identities[0]!;
    expect(pending.results.observed).toBe(true);
    rendered.fixture.destroy();
    expect(pending.results.observed).toBe(false);
  });
});

describe('AUTH-012 account page /akun Akhiri sesi', () => {
  it('revoked: sends one DELETE with the CSRF token of the state, disables only that button while it runs, then says Sesi diakhiri. and reads the list again', async () => {
    const rendered = await ready();
    const { api, element } = rendered;
    await click(rendered, endButton(element, OTHER_ID));
    expect(api.revokes.map((call) => call.args)).toEqual([{ sessionId: OTHER_ID, csrfToken: CSRF }]);
    expect(endButton(element, OTHER_ID).getAttribute('aria-disabled')).toBe('true');
    expect(endButton(element, THIRD_ID).getAttribute('aria-disabled')).toBeNull();
    expect(buttons(element, 'Keluar')[0]!.getAttribute('aria-disabled')).toBeNull();

    // A second press of the same button while it runs sends nothing.
    await click(rendered, endButton(element, OTHER_ID));
    expect(api.revokes).toHaveLength(1);

    reply(api.revokes, { status: 'revoked' });
    await settle(rendered);
    expect(statusText(element)).toBe(TEXT.revoked);
    expect(alertText(element)).toBe('');
    // Only the list is read again; the profile stays.
    expect(api.lists).toHaveLength(2);
    expect(api.identities).toHaveLength(1);
    expect(headings(element)).toEqual(['Akun', 'Profil', 'Sesi aktif']);

    reply(api.lists, { status: 'listed', sessions: [current, third] });
    await settle(rendered);
    expect(items(element)).toHaveLength(2);
    expect(buttons(element, 'Akhiri sesi').map((button) => button.getAttribute('aria-describedby'))).toEqual([`account-session-${THIRD_ID}`]);
    expect(statusText(element)).toBe(TEXT.revoked);
  });

  it('not-found: says Sesi sudah berakhir. in the alert region and reads the list again', async () => {
    const rendered = await ready();
    const { api, element } = rendered;
    await click(rendered, endButton(element, OTHER_ID));
    reply(api.revokes, { status: 'not-found' });
    await settle(rendered);
    expect(alertText(element)).toBe(TEXT.revokeNotFound);
    expect(statusText(element)).toBe('');
    expect(api.lists).toHaveLength(2);
    reply(api.lists, { status: 'listed', sessions: [current, third] });
    await settle(rendered);
    expect(items(element)).toHaveLength(2);
    expect(alertText(element)).toBe(TEXT.revokeNotFound);
  });

  const kept: [RevokeResult['status'], string][] = [
    ['failed', TEXT.revokeFailed],
    ['forbidden', TEXT.forbidden],
    ['unavailable', TEXT.unavailable],
    ['network', TEXT.network],
  ];
  for (const [status, message] of kept) {
    it(`${status}: shows its text in the alert region, keeps the list without reading it again, and makes the button active again`, async () => {
      const rendered = await ready();
      const { api, element } = rendered;
      await click(rendered, endButton(element, OTHER_ID));
      reply(api.revokes, { status } as RevokeResult);
      await settle(rendered);
      expect(alertText(element)).toBe(message);
      expect(statusText(element)).toBe('');
      expect(api.lists).toHaveLength(1);
      expect(items(element)).toHaveLength(3);
      expect(endButton(element, OTHER_ID).getAttribute('aria-disabled')).toBeNull();
      expect(rendered.navigate).not.toHaveBeenCalled();
      expect(rendered.state.status()).toBe('signed-in');
    });
  }

  it('unauthenticated: empties the state, sets the notice expired, and replaces /akun with /masuk', async () => {
    const rendered = await ready();
    await click(rendered, endButton(rendered.element, OTHER_ID));
    reply(rendered.api.revokes, { status: 'unauthenticated' });
    await settle(rendered);
    expectSignedOutState(rendered.state, 'expired');
    expect(rendered.navigate.mock.calls).toEqual([['/masuk', { replaceUrl: true }]]);
  });

  it('keeps one text per region: a newer alert empties an older status text', async () => {
    const rendered = await ready();
    const { api, element } = rendered;
    await click(rendered, endButton(element, OTHER_ID));
    reply(api.revokes, { status: 'revoked' });
    reply(api.lists, { status: 'listed', sessions: [current, third] });
    await settle(rendered);
    expect(statusText(element)).toBe(TEXT.revoked);

    await click(rendered, endButton(element, THIRD_ID));
    reply(api.revokes, { status: 'failed' });
    await settle(rendered);
    expect(alertText(element)).toBe(TEXT.revokeFailed);
    expect(statusText(element)).toBe('');
  });

  it('when the list read after a revocation fails, shows its text with Coba lagi, which repeats both calls', async () => {
    const rendered = await ready();
    const { api, element } = rendered;
    await click(rendered, endButton(element, OTHER_ID));
    reply(api.revokes, { status: 'revoked' });
    reply(api.lists, { status: 'network' });
    await settle(rendered);
    expect(alertText(element)).toBe(TEXT.network);
    expect(statusText(element)).toBe('');
    await click(rendered, buttons(element, 'Coba lagi')[0]!);
    expect(api.identities).toHaveLength(2);
    expectLoading(element);
  });

  it('when the list read after a revocation is unauthenticated, replaces /akun with /masuk', async () => {
    const rendered = await ready();
    await click(rendered, endButton(rendered.element, OTHER_ID));
    reply(rendered.api.revokes, { status: 'revoked' });
    reply(rendered.api.lists, { status: 'unauthenticated' });
    await settle(rendered);
    expectSignedOutState(rendered.state, 'expired');
    expect(rendered.navigate.mock.calls).toEqual([['/masuk', { replaceUrl: true }]]);
  });
});

describe('AUTH-012 account page /akun Keluar', () => {
  it('signed-out: sends one DELETE with the CSRF token, disables Keluar while it runs, then empties the state, sets the notice signed-out, and moves to /masuk', async () => {
    const rendered = await ready();
    const { api, element } = rendered;
    const signOut = buttons(element, 'Keluar')[0]!;
    await click(rendered, signOut);
    expect(api.signOuts.map((call) => call.args)).toEqual([{ csrfToken: CSRF }]);
    expect(signOut.getAttribute('aria-disabled')).toBe('true');
    expect(endButton(element, OTHER_ID).getAttribute('aria-disabled')).toBeNull();
    await click(rendered, signOut);
    expect(api.signOuts).toHaveLength(1);

    reply(api.signOuts, { status: 'signed-out' });
    await settle(rendered);
    expectSignedOutState(rendered.state, 'signed-out');
    // A plain move, not a replacement: only `unauthenticated` replaces /akun.
    expect(rendered.navigate.mock.calls).toEqual([['/masuk']]);
  });

  const failures: [Exclude<SignOutResult['status'], 'signed-out'>, string][] = [
    ['forbidden', TEXT.forbidden],
    ['unavailable', TEXT.unavailable],
    ['network', TEXT.network],
    ['failed', TEXT.failed],
  ];
  for (const [status, message] of failures) {
    it(`${status}: shows its text in the alert region, keeps the session state and the list, and makes Keluar active again`, async () => {
      const rendered = await ready();
      const { api, element } = rendered;
      await click(rendered, buttons(element, 'Keluar')[0]!);
      reply(api.signOuts, { status });
      await settle(rendered);
      expect(alertText(element)).toBe(message);
      expect(statusText(element)).toBe('');
      expect(buttons(element, 'Keluar')[0]!.getAttribute('aria-disabled')).toBeNull();
      expect(rendered.state.status()).toBe('signed-in');
      expect(rendered.state.csrfToken()).toBe(CSRF);
      expect(items(element)).toHaveLength(3);
      expect(rendered.navigate).not.toHaveBeenCalled();

      // Keluar works again after the failure.
      await click(rendered, buttons(element, 'Keluar')[0]!);
      expect(api.signOuts).toHaveLength(2);
    });
  }
});

describe('AUTH-012 /masuk and /akun through the application routes', () => {
  async function harness(): Promise<{ api: AuthApiDouble; harness: RouterTestingHarness; router: Router }> {
    const api = new AuthApiDouble();
    TestBed.configureTestingModule({ providers: [provideRouter(routes), { provide: AuthApi, useValue: api }] });
    return { api, harness: await RouterTestingHarness.create(), router: TestBed.inject(Router) };
  }

  const page = (testing: RouterTestingHarness) => testing.routeNativeElement as HTMLElement;

  it('the routes masuk and akun load the two pages lazily, and opening /masuk calls no API', async () => {
    const masuk = routes.find((route) => route.path === 'masuk')!;
    const akun = routes.find((route) => route.path === 'akun')!;
    expect(masuk.component).toBeUndefined();
    expect(akun.component).toBeUndefined();
    expect(await masuk.loadComponent!()).toBe(SignInPage);
    expect(await akun.loadComponent!()).toBe(AccountPage);

    const { api, harness: testing } = await harness();
    await testing.navigateByUrl('/masuk', SignInPage);
    expect(text(page(testing).querySelector('h1'))).toBe('Masuk');
    expect([api.signIns, api.identities, api.lists, api.revokes, api.signOuts].every((calls) => calls.length === 0)).toBe(true);
  });

  it('a sign in on /masuk moves to /akun, which reads the identity and then the list', async () => {
    const { api, harness: testing, router } = await harness();
    await testing.navigateByUrl('/masuk', SignInPage);
    const element = page(testing);
    const email = element.querySelector<HTMLInputElement>('#sign-in-email')!;
    const password = element.querySelector<HTMLInputElement>('#sign-in-password')!;
    email.value = 'ana@foundation.test';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    password.value = 'Pw-correct-horse-battery';
    password.dispatchEvent(new Event('input', { bubbles: true }));
    element.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await testing.fixture.whenStable();
    reply(api.signIns, { status: 'signed-in', session: identity });
    await testing.fixture.whenStable();

    expect(router.url).toBe('/akun');
    expect(text(page(testing).querySelector('h1'))).toBe('Akun');
    expect(api.identities).toHaveLength(1);
    reply(api.identities, { status: 'signed-in', session: identity });
    reply(api.lists, { status: 'listed', sessions: [current, other] });
    await testing.fixture.whenStable();
    expect(headings(page(testing))).toEqual(['Akun', 'Profil', 'Sesi aktif']);
  });

  it('/akun without a session moves to /masuk, which shows the session ended text once', async () => {
    const { api, harness: testing, router } = await harness();
    await testing.navigateByUrl('/akun', AccountPage);
    reply(api.identities, { status: 'unauthenticated' });
    await testing.fixture.whenStable();
    expect(router.url).toBe('/masuk');
    expect(text(page(testing).querySelector('h1'))).toBe('Masuk');
    expect(statusText(page(testing))).toBe('Sesi Anda berakhir. Masuk lagi untuk melanjutkan.');
    expect(TestBed.inject(SessionState).notice()).toBeNull();
  });

  it('Keluar on /akun moves to /masuk without a reload, which shows the signed out text', async () => {
    const { api, harness: testing, router } = await harness();
    await testing.navigateByUrl('/akun', AccountPage);
    reply(api.identities, { status: 'signed-in', session: identity });
    reply(api.lists, { status: 'listed', sessions: [current] });
    await testing.fixture.whenStable();
    buttons(page(testing), 'Keluar')[0]!.click();
    await testing.fixture.whenStable();
    reply(api.signOuts, { status: 'signed-out' });
    await testing.fixture.whenStable();
    expect(router.url).toBe('/masuk');
    expect(statusText(page(testing))).toBe('Anda sudah keluar.');
    expect(TestBed.inject(SessionState).status()).toBe('signed-out');
  });
});

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Observable, Subject } from 'rxjs';
import { vi, type MockInstance } from 'vitest';
import { SessionState } from '../../core/session/session-state';
import { AuthApi, type CheckedAuthSession, type SignInResult } from './auth-api';
import { SignInPage } from './sign-in-page';

// AUTH-012 (spec 0014, AC-12): `/masuk` with an AuthApi double built on Subject, so the test decides when each sign in
// answers. Covers the rows of `/masuk` in tables *Halaman*, *State halaman*, and *Teks halaman*: no API call when it
// opens, the notice read once, empty fields without a request, the trimmed email, one request while one runs, the
// session state and the move to `/akun` after a sign in, and every failure text with the email kept and the password
// emptied. Texts are copied from the spec tables, not imported from the page. The real browser flows are in
// tests/e2e/auth/.
const TEXT = {
  empty: 'Isi email dan password.',
  invalid: 'Email atau password salah.',
  limited: 'Terlalu banyak percobaan masuk. Tunggu beberapa menit, lalu coba lagi.',
  forbidden: 'Permintaan ditolak. Muat ulang halaman, lalu coba lagi.',
  unavailable: 'Layanan belum tersedia. Coba lagi beberapa saat lagi.',
  network: 'Backend tidak dapat dihubungi. Periksa koneksi, lalu coba lagi.',
  failed: 'Permintaan gagal. Coba lagi beberapa saat lagi.',
  expired: 'Sesi Anda berakhir. Masuk lagi untuk melanjutkan.',
  signedOut: 'Anda sudah keluar.',
} as const;

const CSRF = 'Abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';
const session: CheckedAuthSession = {
  user: { id: '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a', email: 'ana@foundation.test', displayName: 'Ana Uji' },
  session: {
    id: '0b6f8f9c-3c1d-4c5e-9a7b-2d4e6f8a0b1c',
    createdAt: '2026-10-06T08:00:00.000Z',
    lastSeenAt: '2026-10-06T08:00:00.000Z',
    idleExpiresAt: '2026-10-06T08:30:00.000Z',
    expiresAt: '2026-10-06T20:00:00.000Z',
  },
  csrfToken: CSRF,
};

interface PendingSignIn {
  readonly email: string;
  readonly password: string;
  readonly results: Subject<SignInResult>;
}

/** Stand in for AuthApi: every subscription of `signIn` is one pending sign in that the test answers. */
class AuthApiDouble {
  readonly signIns: PendingSignIn[] = [];

  signIn(email: string, password: string): Observable<SignInResult> {
    return new Observable<SignInResult>((subscriber) => {
      const pending: PendingSignIn = { email, password, results: new Subject<SignInResult>() };
      this.signIns.push(pending);
      const subscription = pending.results.subscribe(subscriber);
      return () => subscription.unsubscribe();
    });
  }

  /** Answers the latest sign in once and completes it, like the real adapter. */
  answer(result: SignInResult): void {
    const pending = this.signIns.at(-1);
    if (!pending) throw new Error('No pending sign in to answer.');
    pending.results.next(result);
    pending.results.complete();
  }
}

interface Rendered {
  fixture: ComponentFixture<SignInPage>;
  api: AuthApiDouble;
  element: HTMLElement;
  state: SessionState;
  navigate: MockInstance<Router['navigateByUrl']>;
}

/** Renders `/masuk`; `before` runs on the session state before the page is created (for example to set a notice). */
async function render(before?: (state: SessionState) => void): Promise<Rendered> {
  const api = new AuthApiDouble();
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthApi, useValue: api }] });
  const state = TestBed.inject(SessionState);
  before?.(state);
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  const fixture = TestBed.createComponent(SignInPage);
  await fixture.whenStable();
  return { fixture, api, element: fixture.nativeElement as HTMLElement, state, navigate };
}

const text = (node: Element | null | undefined) => node?.textContent?.trim() ?? '';
const alertText = (element: HTMLElement) => text(element.querySelector('[role="alert"]'));
const statusText = (element: HTMLElement) => text(element.querySelector('[role="status"]'));
const emailInput = (element: HTMLElement) => element.querySelector<HTMLInputElement>('#sign-in-email')!;
const passwordInput = (element: HTMLElement) => element.querySelector<HTMLInputElement>('#sign-in-password')!;
const submitButton = (element: HTMLElement) => element.querySelector<HTMLButtonElement>('button[type="submit"]')!;

/** Types into a field the way a user does: the value changes and an input event follows. */
function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Presses the submit button and renders whatever follows. */
async function press({ fixture, element }: Rendered): Promise<void> {
  submitButton(element).click();
  await fixture.whenStable();
}

async function fill(rendered: Rendered, email: string, password: string): Promise<void> {
  type(emailInput(rendered.element), email);
  type(passwordInput(rendered.element), password);
  await rendered.fixture.whenStable();
}

describe('AUTH-012 sign in page /masuk', () => {
  it('opens without an API call and shows the form of table Halaman with empty alert and status regions', async () => {
    const { api, element } = await render();
    expect(api.signIns).toHaveLength(0);
    expect(text(element.querySelector('h1'))).toBe('Masuk');
    expect(element.querySelector('section')?.getAttribute('aria-labelledby')).toBe(element.querySelector('h1')?.id);

    const form = element.querySelector('form')!;
    expect(form.hasAttribute('novalidate')).toBe(true);
    const email = emailInput(element);
    expect(email.type).toBe('email');
    expect(email.getAttribute('autocomplete')).toBe('username');
    expect(text(element.querySelector(`label[for="${email.id}"]`))).toBe('Email');
    const password = passwordInput(element);
    expect(password.type).toBe('password');
    expect(password.getAttribute('autocomplete')).toBe('current-password');
    expect(text(element.querySelector(`label[for="${password.id}"]`))).toBe('Password');
    expect(email.form).toBe(form);
    expect(password.form).toBe(form);

    const buttons = element.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(text(submitButton(element))).toBe('Masuk');
    expect(submitButton(element).getAttribute('aria-disabled')).toBeNull();

    // One alert region and one status region, both in the DOM and empty, before the form.
    expect(element.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(element.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(element.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
    expect(alertText(element)).toBe('');
    expect(statusText(element)).toBe('');
    const alert = element.querySelector('[role="alert"]')!;
    expect(alert.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  const notices: ['expired' | 'signed-out', string][] = [
    ['expired', TEXT.expired],
    ['signed-out', TEXT.signedOut],
  ];
  for (const [notice, message] of notices) {
    it(`shows the notice ${notice} once in the status region and empties it, so the next visit shows nothing`, async () => {
      const { element, state } = await render((session) => session.clear(notice));
      expect(statusText(element)).toBe(message);
      expect(alertText(element)).toBe('');
      expect(state.notice()).toBeNull();

      const again = TestBed.createComponent(SignInPage);
      await again.whenStable();
      expect(statusText(again.nativeElement as HTMLElement)).toBe('');
    });
  }

  const empties: [string, string, string][] = [
    ['both fields empty', '', ''],
    ['only the email', 'ana@foundation.test', ''],
    ['only the password', '', 'Pw-correct-horse-battery'],
    ['an email of spaces only', '   ', 'Pw-correct-horse-battery'],
  ];
  for (const [name, email, password] of empties) {
    it(`with ${name} shows the empty fields text in the alert region without a request`, async () => {
      const rendered = await render();
      await fill(rendered, email, password);
      await press(rendered);
      expect(rendered.api.signIns).toHaveLength(0);
      expect(alertText(rendered.element)).toBe(TEXT.empty);
      expect(statusText(rendered.element)).toBe('');
      expect(submitButton(rendered.element).getAttribute('aria-disabled')).toBeNull();
    });
  }

  it('sends the trimmed email and the password as typed, sends one request while it runs, then fills the session state and moves to /akun', async () => {
    const rendered = await render();
    const { api, element, fixture, state, navigate } = rendered;
    await fill(rendered, '  ana@foundation.test ', ' Pw with spaces ');
    await press(rendered);
    expect(api.signIns).toHaveLength(1);
    expect(api.signIns[0]!.email).toBe('ana@foundation.test');
    expect(api.signIns[0]!.password === ' Pw with spaces ').toBe(true);

    // While the request runs the button is aria-disabled; a second press and a second submit (Enter) send nothing.
    expect(submitButton(element).getAttribute('aria-disabled')).toBe('true');
    expect(element.querySelector('spinner')).not.toBeNull();
    await press(rendered);
    element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(api.signIns).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();

    api.answer({ status: 'signed-in', session });
    await fixture.whenStable();
    expect(state.status()).toBe('signed-in');
    expect(state.user()).toEqual(session.user);
    expect(state.csrfToken()).toBe(CSRF);
    expect(navigate.mock.calls).toEqual([['/akun']]);
    expect(submitButton(element).getAttribute('aria-disabled')).toBeNull();
    expect(alertText(element)).toBe('');
  });

  it('empties the notice text from the status region when the form is sent', async () => {
    const rendered = await render((session) => session.clear('signed-out'));
    expect(statusText(rendered.element)).toBe(TEXT.signedOut);
    await fill(rendered, 'ana@foundation.test', 'Pw-correct-horse-battery');
    await press(rendered);
    expect(statusText(rendered.element)).toBe('');
    expect(rendered.api.signIns).toHaveLength(1);
  });

  const failures: [Exclude<SignInResult['status'], 'signed-in'>, string][] = [
    ['invalid', TEXT.invalid],
    ['limited', TEXT.limited],
    ['forbidden', TEXT.forbidden],
    ['unavailable', TEXT.unavailable],
    ['network', TEXT.network],
    ['failed', TEXT.failed],
  ];
  for (const [status, message] of failures) {
    it(`after ${status} shows its text in the alert region, keeps the email, empties the password, and makes the button active again`, async () => {
      const rendered = await render();
      const { api, element, fixture, state, navigate } = rendered;
      await fill(rendered, 'ana@foundation.test', 'Pw-wrong-horse-battery');
      await press(rendered);
      api.answer({ status } as SignInResult);
      await fixture.whenStable();

      expect(alertText(element)).toBe(message);
      expect(statusText(element)).toBe('');
      expect(emailInput(element).value).toBe('ana@foundation.test');
      expect(passwordInput(element).value).toBe('');
      expect(submitButton(element).getAttribute('aria-disabled')).toBeNull();
      expect(element.querySelector('spinner')).toBeNull();
      expect(navigate).not.toHaveBeenCalled();
      expect(state.status()).toBe('unknown');
      expect(state.csrfToken()).toBeNull();

      // Sending again without a new password is the empty fields case, with no request.
      await press(rendered);
      expect(api.signIns).toHaveLength(1);
      expect(alertText(element)).toBe(TEXT.empty);

      // A new password sends a second request and the old text goes while it runs.
      type(passwordInput(element), 'Pw-correct-horse-battery');
      await press(rendered);
      expect(api.signIns).toHaveLength(2);
      expect(api.signIns[1]!.password === 'Pw-correct-horse-battery').toBe(true);
      expect(alertText(element)).toBe('');
    });
  }

  it('stops listening to the running sign in when the page is destroyed', async () => {
    const rendered = await render();
    await fill(rendered, 'ana@foundation.test', 'Pw-correct-horse-battery');
    await press(rendered);
    const pending = rendered.api.signIns[0]!;
    expect(pending.results.observed).toBe(true);
    rendered.fixture.destroy();
    expect(pending.results.observed).toBe(false);
    expect(rendered.navigate).not.toHaveBeenCalled();
  });
});

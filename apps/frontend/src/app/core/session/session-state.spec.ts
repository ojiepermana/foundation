import { TestBed } from '@angular/core/testing';
import { SessionState, type SessionUser } from './session-state';

// AUTH-012 (spec 0014, AC-10 and AC-12, *Halaman* and Value sourcing *Pesan sesudah pindah ke /masuk*): the session state
// lives only in signals, in memory. It starts unknown, `signedIn` fills it from a checked AuthSession, `clear` empties
// it and sets the notice `/masuk` shows next, and `takeNotice` reads that notice once. Nothing reaches browser storage.
const user: SessionUser = { id: '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a', email: 'ana@foundation.test', displayName: 'Ana Uji' };
const CSRF = 'Abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';

/** Every key and value of localStorage and sessionStorage, to prove the state never writes there. */
function storage(): string[] {
  const entries: string[] = [];
  for (const store of [localStorage, sessionStorage]) {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index)!;
      entries.push(key, store.getItem(key) ?? '');
    }
  }
  return entries;
}

describe('AUTH-012 session state in memory', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('starts unknown, without a user, a CSRF token, or a notice', () => {
    const state = TestBed.inject(SessionState);
    expect(state.status()).toBe('unknown');
    expect(state.user()).toBeNull();
    expect(state.csrfToken()).toBeNull();
    expect(state.notice()).toBeNull();
  });

  it('signedIn fills the user and the CSRF token only in memory, never in localStorage or sessionStorage', () => {
    const state = TestBed.inject(SessionState);
    state.signedIn(user, CSRF);
    expect(state.status()).toBe('signed-in');
    expect(state.user()).toEqual(user);
    expect(state.csrfToken()).toBe(CSRF);
    expect(storage()).toEqual([]);
  });

  it('clear empties the user and the CSRF token and keeps the notice for /masuk', () => {
    const state = TestBed.inject(SessionState);
    state.signedIn(user, CSRF);
    state.clear('expired');
    expect(state.status()).toBe('signed-out');
    expect(state.user()).toBeNull();
    expect(state.csrfToken()).toBeNull();
    expect(state.notice()).toBe('expired');
  });

  it('clear without a notice leaves none', () => {
    const state = TestBed.inject(SessionState);
    state.clear();
    expect(state.status()).toBe('signed-out');
    expect(state.notice()).toBeNull();
  });

  for (const notice of ['expired', 'signed-out'] as const) {
    it(`takeNotice reads the notice ${notice} once and empties it, so it never shows twice`, () => {
      const state = TestBed.inject(SessionState);
      state.clear(notice);
      expect(state.takeNotice()).toBe(notice);
      expect(state.notice()).toBeNull();
      expect(state.takeNotice()).toBeNull();
    });
  }

  it('a later sign in replaces the user and the CSRF token, and does not bring back a notice that was taken', () => {
    const state = TestBed.inject(SessionState);
    state.clear('signed-out');
    state.takeNotice();
    const other: SessionUser = { id: '1c7a9e0d-4d2e-4f6a-8b9c-3e5f7a9b1c2d', email: 'budi@foundation.test', displayName: 'Budi' };
    state.signedIn(other, 'Zyxwvutsrqponmlkjihgfedcba9876543210_-ZYXWV');
    expect(state.user()).toEqual(other);
    expect(state.csrfToken()).toBe('Zyxwvutsrqponmlkjihgfedcba9876543210_-ZYXWV');
    expect(state.notice()).toBeNull();
  });
});

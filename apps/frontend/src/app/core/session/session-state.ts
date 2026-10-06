import { Service, computed, signal } from '@angular/core';

// Session state of the application (spec 0014, *Halaman*): only signals, in memory, never in browser storage, and with
// no SDK import. The auth feature adapter and its pages fill it; the shell reads it for the user of the layout wrapper.

/** The identity the shell and the auth pages show. */
export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

/** `unknown` until a page asked the backend; `signed-in` after a sign in or identity read; `signed-out` after clear. */
export type SessionStatus = 'unknown' | 'signed-in' | 'signed-out';

/** Message for `/masuk` after a move there: the session ended, or the user signed out. `null` means none. */
export type SessionNotice = 'expired' | 'signed-out' | null;

interface Current {
  status: SessionStatus;
  user: SessionUser | null;
  csrfToken: string | null;
}

@Service()
export class SessionState {
  private readonly current = signal<Current>({ status: 'unknown', user: null, csrfToken: null });
  private readonly pendingNotice = signal<SessionNotice>(null);

  readonly status = computed(() => this.current().status);
  readonly user = computed(() => this.current().user);
  /** CSRF token of the current session, from the AuthSession body; sent by the DELETE routes of a later milestone. */
  readonly csrfToken = computed(() => this.current().csrfToken);
  readonly notice = this.pendingNotice.asReadonly();

  /** Fills the state from an AuthSession body that the adapter already checked. */
  signedIn(user: SessionUser, csrfToken: string): void {
    this.current.set({ status: 'signed-in', user, csrfToken });
  }

  /** Empties the state and sets the notice that `/masuk` shows next; set before navigating there. */
  clear(notice: SessionNotice = null): void {
    this.current.set({ status: 'signed-out', user: null, csrfToken: null });
    this.pendingNotice.set(notice);
  }

  /** Reads the notice once and empties it, so it never shows twice. */
  takeNotice(): SessionNotice {
    const notice = this.pendingNotice();
    this.pendingNotice.set(null);
    return notice;
  }
}

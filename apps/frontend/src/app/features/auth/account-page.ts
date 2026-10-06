import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { BadgeComponent } from '@ojiepermana/angular/component/badge';
import { ButtonComponent } from '@ojiepermana/angular/component/button';
import {
  CardComponent,
  CardContentComponent,
  CardHeaderComponent,
  CardTitleComponent,
} from '@ojiepermana/angular/component/card';
import { ItemActionsComponent, ItemComponent, ItemContentComponent } from '@ojiepermana/angular/component/item';
import { SpinnerComponent } from '@ojiepermana/angular/component/spinner';
import { type Observable, type Subscription, map, of, switchMap } from 'rxjs';
import { SessionState, type SessionUser } from '../../core/session/session-state';
import { AuthApi, type ListedSession, type RevokeResult, type SessionsResult, type SignOutResult } from './auth-api';

type LoadFailure = 'unavailable' | 'network' | 'failed';
type ActionFailure = 'forbidden' | 'unavailable' | 'network' | 'failed';

/** Fixed texts of spec 0014, tables *Teks halaman* and *State halaman*. */
const LOADING_TEXT = 'Memuat akun.';
const FAILURE_TEXT: Readonly<Record<ActionFailure, string>> = {
  forbidden: 'Permintaan ditolak. Muat ulang halaman, lalu coba lagi.',
  unavailable: 'Layanan belum tersedia. Coba lagi beberapa saat lagi.',
  network: 'Backend tidak dapat dihubungi. Periksa koneksi, lalu coba lagi.',
  failed: 'Permintaan gagal. Coba lagi beberapa saat lagi.',
};
const REVOKED_TEXT = 'Sesi diakhiri.';
const REVOKE_NOT_FOUND_TEXT = 'Sesi sudah berakhir.';
const REVOKE_FAILED_TEXT = 'Sesi tidak dapat diakhiri. Coba lagi.';

/** Value sourcing *Waktu sesi*: medium date and short time of `id-ID` in the time zone of the browser. */
const TIME_FORMAT = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' });

type View =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; user: SessionUser; sessions: readonly ListedSession[] };

/** What the two reads of a load give together: the identity and the list, or the first failure. */
type Loaded =
  | { status: 'ready'; user: SessionUser; sessions: readonly ListedSession[] }
  | { status: 'unauthenticated' | LoadFailure };

/**
 * `/akun` (spec 0014, *Halaman* and *State halaman*): reads the identity with `getAuthSession`, then the active sessions
 * with `listAuthSessions`, when it opens. While it loads, the status region says so and no section shows;
 * `unauthenticated` from any call empties the session state, sets the notice `expired`, and moves to `/masuk` with
 * `replaceUrl`; any other failure shows its text in the alert region with `Coba lagi`, which repeats both calls. Each
 * other session has `Akhiri sesi`, and `Keluar` ends the session of the caller; no confirmation dialog, and only the
 * button whose request runs is disabled. Each region shows at most one text, and a new text replaces the old one.
 */
@Component({
  selector: 'app-account-page',
  imports: [
    BadgeComponent,
    ButtonComponent,
    CardComponent,
    CardContentComponent,
    CardHeaderComponent,
    CardTitleComponent,
    ItemActionsComponent,
    ItemComponent,
    ItemContentComponent,
    SpinnerComponent,
  ],
  templateUrl: './account-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountPage {
  private readonly api = inject(AuthApi);
  private readonly session = inject(SessionState);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private loading: Subscription | undefined;

  protected readonly view = signal<View>({ state: 'loading' });
  /** The identity of the `Profil` section, only once it was read. */
  protected readonly user = computed(() => {
    const view = this.view();
    return view.state === 'ready' ? view.user : null;
  });
  /** The active sessions of the `Sesi aktif` section, only once they were read. */
  protected readonly sessions = computed(() => {
    const view = this.view();
    return view.state === 'ready' ? view.sessions : null;
  });
  protected readonly alertText = signal('');
  protected readonly statusText = signal(LOADING_TEXT);
  /** `Coba lagi` shows after `session()` or `sessions()` failed with `unavailable`, `network`, or `failed`. */
  protected readonly retryable = signal(false);
  /** Ids of the sessions whose `Akhiri sesi` request runs. */
  protected readonly revoking = signal<ReadonlySet<string>>(new Set());
  protected readonly signingOut = signal(false);

  constructor() {
    this.load();
  }

  /** `<time>` text of an API time; the `datetime` attribute keeps the API value. */
  protected timeText(value: string): string {
    return TIME_FORMAT.format(new Date(value));
  }

  /** Loads the identity and then the list; `Coba lagi` repeats both. A load that still runs is never started twice. */
  protected load(): void {
    if (this.loading !== undefined && !this.loading.closed) return;
    this.view.set({ state: 'loading' });
    this.alertText.set('');
    this.statusText.set(LOADING_TEXT);
    this.retryable.set(false);
    const loaded: Observable<Loaded> = this.api.session().pipe(
      switchMap((identity) => {
        if (identity.status !== 'signed-in') return of(identity);
        this.session.signedIn(identity.session.user, identity.session.csrfToken);
        return this.listed(identity.session.user);
      }),
    );
    this.loading = loaded.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((result) => {
      if (result.status === 'ready') {
        this.statusText.set('');
        this.view.set({ state: 'ready', user: result.user, sessions: result.sessions });
        return;
      }
      if (result.status === 'unauthenticated') return this.expired();
      this.statusText.set('');
      this.alertText.set(FAILURE_TEXT[result.status]);
      this.retryable.set(true);
      this.view.set({ state: 'failed' });
    });
  }

  /** `Akhiri sesi` on one other session of the caller. */
  protected revoke(sessionId: string): void {
    const csrfToken = this.session.csrfToken();
    if (this.revoking().has(sessionId) || csrfToken === null) return;
    this.revoking.update((ids) => new Set(ids).add(sessionId));
    this.api.revoke(sessionId, csrfToken).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((result) => {
      this.revoking.update((ids) => {
        const next = new Set(ids);
        next.delete(sessionId);
        return next;
      });
      this.revoked(result);
    });
  }

  /** `Keluar`: ends the session of the caller and moves to `/masuk` with the notice `signed-out`. */
  protected signOut(): void {
    const csrfToken = this.session.csrfToken();
    if (this.signingOut() || csrfToken === null) return;
    this.signingOut.set(true);
    this.api.signOut(csrfToken).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((result: SignOutResult) => {
      this.signingOut.set(false);
      if (result.status === 'signed-out') {
        this.session.clear('signed-out');
        void this.router.navigateByUrl('/masuk');
        return;
      }
      // The state stays and `Keluar` is active again.
      this.announce('alert', FAILURE_TEXT[result.status]);
    });
  }

  /** The list read after the identity, as one `Loaded`. */
  private listed(user: SessionUser): Observable<Loaded> {
    return this.api.sessions().pipe(
      map((list: SessionsResult): Loaded => (list.status === 'listed' ? { status: 'ready', user, sessions: list.sessions } : list)),
    );
  }

  /** Rows *Pencabutan* of *State halaman*. */
  private revoked(result: RevokeResult): void {
    switch (result.status) {
      case 'revoked':
        this.announce('status', REVOKED_TEXT);
        return this.reloadList();
      case 'not-found':
        this.announce('alert', REVOKE_NOT_FOUND_TEXT);
        return this.reloadList();
      case 'unauthenticated':
        return this.expired();
      case 'failed':
        return this.announce('alert', REVOKE_FAILED_TEXT);
      default:
        // forbidden, unavailable, network: the list stays.
        this.announce('alert', FAILURE_TEXT[result.status]);
    }
  }

  /** After a revocation the list is read again through `sessions()`; the profile stays. */
  private reloadList(): void {
    const user = this.user();
    if (user === null) return;
    this.listed(user).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((result) => {
      if (result.status === 'ready') {
        this.view.set({ state: 'ready', user: result.user, sessions: result.sessions });
        return;
      }
      if (result.status === 'unauthenticated') return this.expired();
      // Like a failed load: the text of the state and `Coba lagi`, which repeats both calls.
      this.announce('alert', FAILURE_TEXT[result.status]);
      this.retryable.set(true);
    });
  }

  /**
   * Shows the newest result of an action: its text goes to its region and the other region is emptied, so an older text
   * never stays next to a newer one (each region holds at most one text).
   */
  private announce(region: 'alert' | 'status', text: string): void {
    this.alertText.set(region === 'alert' ? text : '');
    this.statusText.set(region === 'status' ? text : '');
  }

  /** `unauthenticated`: the state is emptied, the notice is `expired`, and `/masuk` replaces this page. */
  private expired(): void {
    this.session.clear('expired');
    void this.router.navigateByUrl('/masuk', { replaceUrl: true });
  }
}

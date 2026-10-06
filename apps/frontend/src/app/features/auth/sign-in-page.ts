import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { ButtonComponent } from '@ojiepermana/angular/component/button';
import {
  CardComponent,
  CardContentComponent,
  CardDescriptionComponent,
  CardFooterComponent,
  CardHeaderComponent,
  CardTitleComponent,
} from '@ojiepermana/angular/component/card';
import { InputComponent } from '@ojiepermana/angular/component/input';
import { LabelComponent } from '@ojiepermana/angular/component/label';
import { SpinnerComponent } from '@ojiepermana/angular/component/spinner';
import { SessionState } from '../../core/session/session-state';
import { AuthApi, type SignInResult } from './auth-api';

type Failure = Exclude<SignInResult['status'], 'signed-in'>;

/** Fixed texts of spec 0014, tables *Teks halaman* and *State halaman*. */
const FAILURE_TEXT: Readonly<Record<Failure, string>> = {
  invalid: 'Email atau password salah.',
  limited: 'Terlalu banyak percobaan masuk. Tunggu beberapa menit, lalu coba lagi.',
  forbidden: 'Permintaan ditolak. Muat ulang halaman, lalu coba lagi.',
  unavailable: 'Layanan belum tersedia. Coba lagi beberapa saat lagi.',
  network: 'Backend tidak dapat dihubungi. Periksa koneksi, lalu coba lagi.',
  failed: 'Permintaan gagal. Coba lagi beberapa saat lagi.',
};
const EMPTY_TEXT = 'Isi email dan password.';
const NOTICE_TEXT = { expired: 'Sesi Anda berakhir. Masuk lagi untuk melanjutkan.', 'signed-out': 'Anda sudah keluar.' } as const;

/**
 * `/masuk` (spec 0014, *Halaman*): no API call when it opens. One `role="alert"` region for errors and one
 * `role="status"` region for other messages, both always in the DOM, each with at most one text.
 */
@Component({
  selector: 'app-sign-in-page',
  imports: [
    ButtonComponent,
    CardComponent,
    CardContentComponent,
    CardDescriptionComponent,
    CardFooterComponent,
    CardHeaderComponent,
    CardTitleComponent,
    InputComponent,
    LabelComponent,
    SpinnerComponent,
  ],
  templateUrl: './sign-in-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SignInPage {
  private readonly api = inject(AuthApi);
  private readonly session = inject(SessionState);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly pending = signal(false);
  protected readonly alertText = signal('');
  protected readonly statusText = signal('');

  constructor() {
    // The notice is read once and emptied when the page is created, so a later visit never repeats it.
    const notice = this.session.takeNotice();
    if (notice !== null) this.statusText.set(NOTICE_TEXT[notice]);
  }

  protected typed(field: 'email' | 'password', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (field === 'email') this.email.set(value);
    else this.password.set(value);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    // A submit while the request runs (Enter key or a second press) never sends a second request.
    if (this.pending()) return;
    const email = this.email().trim();
    const password = this.password();
    this.statusText.set('');
    if (email === '' || password === '') {
      this.alertText.set(EMPTY_TEXT);
      return;
    }
    this.alertText.set('');
    this.pending.set(true);
    this.api.signIn(email, password).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((result) => {
      this.pending.set(false);
      if (result.status === 'signed-in') {
        this.session.signedIn(result.session.user, result.session.csrfToken);
        void this.router.navigateByUrl('/akun');
        return;
      }
      // The email stays; the password is emptied.
      this.password.set('');
      this.alertText.set(FAILURE_TEXT[result.status]);
    });
  }
}

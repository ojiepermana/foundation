import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { form, FormField, required, email, minLength, maxLength, submit, applyWhen, validate } from '@angular/forms/signals';
import { browserSupportsWebAuthn, startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { LayoutComponent, LayoutFluidComponent } from '@ojiepermana/angular/theme/layout';
import { Api, errorMessage } from './api';
import { UI } from './ui';
import type { SessionData } from '../../../../shared/contracts';

@Component({
  selector: 'app-auth-page', imports: [...UI, FormField, RouterLink, LayoutComponent, LayoutFluidComponent],
  templateUrl: './auth-page.html', changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(Api);
  readonly mode = this.route.snapshot.data['mode'] as string;
  readonly isLogin = this.mode === 'login';
  readonly isForgot = this.mode === 'forgot-password';
  readonly needsEmail = this.isLogin || this.isForgot;
  readonly needsPassword = !this.isForgot;
  readonly title = this.isLogin ? 'Selamat datang kembali' : this.isForgot ? 'Lupa kata sandi?' : this.mode === 'activate' ? 'Aktifkan akun Anda' : 'Buat kata sandi baru';
  readonly subtitle = this.isLogin ? 'Masuk untuk melanjutkan ke ruang kerja Anda.' : this.isForgot ? 'Kami akan mengirimkan tautan pemulihan ke email Anda.' : this.mode === 'activate' ? 'Satu langkah lagi. Buat kata sandi untuk memulai.' : 'Gunakan kata sandi yang belum pernah Anda pakai.';
  readonly action = this.isLogin ? 'Masuk' : this.isForgot ? 'Kirim tautan pemulihan' : this.mode === 'activate' ? 'Aktifkan akun' : 'Simpan kata sandi';
  readonly supportsPasskey = browserSupportsWebAuthn();
  readonly error = signal(this.route.snapshot.queryParamMap.has('connection') ? 'Layanan belum dapat dihubungi. Silakan coba masuk kembali.' : '');
  readonly success = signal('');
  readonly busy = signal(false);
  readonly model = signal({ email: '', password: '', confirmation: '' });
  private readonly token = new URLSearchParams(this.route.snapshot.fragment ?? '').get('token') ?? '';
  readonly fields = form(this.model, s => {
    applyWhen(s.email, () => this.needsEmail, path => { required(path, { message: 'Isi alamat email Anda.' }); email(path, { message: 'Gunakan alamat email yang valid.' }); maxLength(path, 254); });
    applyWhen(s.password, () => this.needsPassword, path => { required(path, { message: 'Isi kata sandi Anda.' }); maxLength(path, 128); });
    applyWhen(s.password, () => !this.isLogin && this.needsPassword, path => minLength(path, 12, { message: 'Gunakan setidaknya 12 karakter.' }));
    applyWhen(s.confirmation, () => !this.isLogin && this.needsPassword, path => {
      required(path, { message: 'Ulangi kata sandi Anda.' });
      validate(path, ({ value, valueOf }) => value() === valueOf(s.password) ? undefined : { kind: 'mismatch', message: 'Kata sandi belum sama.' });
    });
  });
  constructor() {
    if (this.route.snapshot.fragment) history.replaceState(history.state, '', location.pathname + location.search);
    if (!this.needsEmail && !this.token) this.error.set('Tautan tidak lengkap. Buka kembali tautan dari email Anda.');
  }
  onSubmit(event: Event): void {
    event.preventDefault();
    if (this.busy() || (!this.needsEmail && !this.token)) return;
    void submit(this.fields, async () => {
      this.busy.set(true); this.error.set('');
      try {
        const { email: address, password } = this.model();
        if (this.isLogin) {
          const { data } = await this.api.request<SessionData>('POST', '/auth/login', { email: address, password });
          this.api.establish(data); await this.router.navigateByUrl('/dashboard');
        } else if (this.isForgot) {
          await this.api.request('POST', '/auth/forgot-password', { email: address });
          this.success.set('Jika akun Anda memenuhi syarat, tautan pemulihan akan dikirim. Periksa kotak masuk dan folder spam.');
        } else {
          await this.api.request('POST', this.mode === 'activate' ? '/auth/activate' : '/auth/reset-password', { token: this.token, password });
          this.api.clear();
          this.success.set(this.mode === 'activate' ? 'Akun Anda telah aktif. Silakan masuk dengan kata sandi baru.' : 'Kata sandi telah diperbarui. Silakan masuk kembali.');
        }
        this.model.update(m => ({ ...m, password: '', confirmation: '' }));
      } catch (error) { this.error.set(errorMessage(error)); }
      finally { this.busy.set(false); }
    });
  }
  async passkey(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.error.set('');
    try {
      const { data } = await this.api.request<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>('POST', '/auth/passkey/options');
      const response = await startAuthentication({ optionsJSON: data.options });
      const session = await this.api.request<SessionData>('POST', '/auth/passkey/verify', { challengeId: data.challengeId, response });
      this.api.establish(session.data); await this.router.navigateByUrl('/dashboard');
    } catch (error) { this.error.set(errorMessage(error)); }
    finally { this.busy.set(false); }
  }
}

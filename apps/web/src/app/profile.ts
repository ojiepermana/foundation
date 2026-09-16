import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormField, form, required, minLength, maxLength, submit, applyWhen, validate } from '@angular/forms/signals';
import { browserSupportsWebAuthn, startRegistration, type PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { Api, errorMessage } from './api';
import { UI } from './ui';
import type { Passkey, SessionData, User } from '../../../../shared/contracts';
@Component({ selector: 'app-profile', imports: [...UI, FormField, DatePipe], templateUrl: './profile.html', changeDetection: ChangeDetectionStrategy.OnPush })
export class Profile {
  readonly api = inject(Api);
  readonly busy = signal('');
  readonly error = signal('');
  readonly success = signal('');
  readonly passkeys = signal<Passkey[]>([]);
  readonly loading = signal(true);
  readonly keysError = signal('');
  readonly pendingDelete = signal<Passkey | null>(null);
  readonly supportsPasskey = browserSupportsWebAuthn();
  readonly profileModel = signal({ name: this.api.user()?.name ?? '' });
  readonly profileForm = form(this.profileModel, s => { required(s.name, { message: 'Isi nama Anda.' }); maxLength(s.name, 100); });
  readonly passwordModel = signal({ currentPassword: '', password: '', confirmation: '' });
  readonly passwordForm = form(this.passwordModel, s => {
    required(s.currentPassword, { message: 'Isi kata sandi saat ini.' });
    required(s.password); minLength(s.password, 12, { message: 'Gunakan setidaknya 12 karakter.' }); maxLength(s.password, 128);
    required(s.confirmation, { message: 'Ulangi kata sandi baru.' });
    validate(s.confirmation, ({ value, valueOf }) => value() === valueOf(s.password) ? undefined : { kind: 'mismatch', message: 'Kata sandi belum sama.' });
  });
  readonly keyModel = signal({ name: '', password: '' });
  readonly keyForm = form(this.keyModel, s => {
    applyWhen(s.name, () => !this.pendingDelete(), path => { required(path, { message: 'Beri nama passkey Anda.' }); maxLength(path, 100); });
    required(s.password, { message: 'Isi kata sandi untuk mengonfirmasi identitas Anda.' });
  });
  constructor() { void this.loadPasskeys(); }
  async loadPasskeys(): Promise<void> {
    this.loading.set(true); this.keysError.set('');
    try { this.passkeys.set((await this.api.request<Passkey[]>('GET', '/me/passkeys')).data); }
    catch (error) { this.keysError.set(errorMessage(error)); }
    finally { this.loading.set(false); }
  }
  private async run(action: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(action); this.error.set(''); this.success.set('');
    try { await fn(); }
    catch (error) { this.error.set(errorMessage(error)); }
    finally { this.busy.set(''); }
  }
  saveProfile(event: Event): void {
    event.preventDefault();
    void submit(this.profileForm, async () => this.run('profile', async () => {
      const { data } = await this.api.request<User>('PATCH', '/me', this.profileModel());
      this.api.user.set(data); this.success.set('Nama Anda telah diperbarui.');
    }));
  }
  savePassword(event: Event): void {
    event.preventDefault();
    void submit(this.passwordForm, async () => this.run('password', async () => {
      const { currentPassword, password } = this.passwordModel();
      const { data } = await this.api.request<SessionData>('POST', '/me/password', { currentPassword, password });
      this.api.establish(data);
      this.passwordModel.set({ currentPassword: '', password: '', confirmation: '' });
      this.success.set('Kata sandi telah diperbarui. Sesi lain telah diakhiri.');
    }));
  }
  savePasskey(event: Event): void {
    event.preventDefault();
    void submit(this.keyForm, async () => this.run('passkey', async () => {
      const { name, password } = this.keyModel();
      await this.api.request('POST', '/auth/reauthenticate', { password });
      const selected = this.pendingDelete();
      if (selected) {
        await this.api.request('DELETE', '/me/passkeys/' + selected.id);
        this.success.set('Passkey telah dihapus.');
      } else {
        const { data } = await this.api.request<PublicKeyCredentialCreationOptionsJSON>('POST', '/me/passkeys/options');
        const response = await startRegistration({ optionsJSON: data });
        await this.api.request('POST', '/me/passkeys/verify', { response, name });
        this.success.set('Passkey baru telah ditambahkan.');
      }
      this.pendingDelete.set(null); this.keyModel.set({ name: '', password: '' });
      await this.loadPasskeys();
    }));
  }
  selectDelete(key: Passkey): void {
    this.pendingDelete.set(key); this.keyModel.set({ name: '', password: '' });
    document.getElementById('passkey-password')?.focus();
  }
  cancelDelete(): void { this.pendingDelete.set(null); this.keyModel.set({ name: '', password: '' }); }
}

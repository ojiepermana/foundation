import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormField, form, required, maxLength, submit } from '@angular/forms/signals';
import { NativeSelectComponent } from '@ojiepermana/angular/component/native-select';
import { Api, errorMessage } from './api';
import { UI } from './ui';
import type { User, Role, UserStatus } from '../../../../shared/contracts';
@Component({ selector: 'app-users', imports: [...UI, FormField, NativeSelectComponent, DatePipe], templateUrl: './users.html', changeDetection: ChangeDetectionStrategy.OnPush })
export class Users {
  readonly api = inject(Api);
  readonly rows = signal<User[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly success = signal('');
  readonly selected = signal<User | null>(null);
  readonly searchModel = signal({ search: '' });
  readonly searchForm = form(this.searchModel, s => maxLength(s.search, 254));
  readonly editModel = signal({ name: '', role: 'user' as Role, status: 'active' as UserStatus });
  readonly editForm = form(this.editModel, s => { required(s.name, { message: 'Isi nama pengguna.' }); maxLength(s.name, 100); });
  private revision = 0;
  constructor() { void this.load(); }
  async load(): Promise<void> {
    const revision = ++this.revision;
    this.loading.set(true); this.error.set('');
    try {
      const response = await this.api.request<User[]>('GET', `/users?page=${this.page()}&limit=20&search=${encodeURIComponent(this.searchModel().search)}`);
      if (revision !== this.revision) return;
      this.rows.set(response.data); this.total.set(response.meta?.total ?? 0);
    } catch (error) { if (revision === this.revision) this.error.set(errorMessage(error)); }
    finally { if (revision === this.revision) this.loading.set(false); }
  }
  search(event: Event): void { event.preventDefault(); this.page.set(1); void this.load(); }
  changePage(delta: number): void { this.page.update(p => p + delta); void this.load(); }
  edit(user: User): void {
    this.selected.set(user); this.editModel.set({ name: user.name, role: user.role, status: user.status });
    this.error.set(''); this.success.set('');
    setTimeout(() => document.getElementById('edit-name')?.focus());
  }
  save(event: Event): void {
    event.preventDefault();
    void submit(this.editForm, async () => {
      const selected = this.selected(); if (!selected || this.busy()) return;
      this.busy.set(true); this.error.set(''); this.success.set('');
      try {
        const { name, role, status } = this.editModel();
        const { data } = await this.api.request<User>('PATCH', '/users/' + selected.id, { name, role, ...(status !== selected.status ? { status } : {}) });
        this.selected.set(null);
        this.success.set('Perubahan pengguna telah disimpan.');
        if (data.id === this.api.user()?.id) {
          this.api.user.set(data);
          // Re-enter through the guards when the current account loses admin access.
          if (data.role !== 'admin' || data.status !== 'active') location.assign('/dashboard');
        }
        await this.load();
      } catch (error) { this.error.set(errorMessage(error)); }
      finally { this.busy.set(false); }
    });
  }
  statusLabel(status: UserStatus): string { return { active: 'Aktif', pending: 'Menunggu aktivasi', disabled: 'Dinonaktifkan' }[status]; }
}

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LayoutWrapperDefault } from '@ojiepermana/angular/theme/layout/wrapper';
import type { NavigationItem } from '@ojiepermana/angular/navigation/types';
import { Api, errorMessage } from './api';
@Component({
  selector: 'app-shell', imports: [RouterOutlet, LayoutWrapperDefault],
  templateUrl: './shell.html', changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Shell {
  readonly api = inject(Api);
  readonly error = signal('');
  readonly brand = { name: 'Foundation', icon: null, title: 'Foundation', subtitle: 'Ruang kerja' };
  readonly user = computed(() => ({ name: this.api.user()?.name ?? '', email: this.api.user()?.email ?? '' }));
  readonly navigation = computed<NavigationItem[]>(() => [
    { id: 'main', title: 'RUANG KERJA', type: 'group', children: [
      { id: 'dashboard', title: 'Dashboard', icon: 'space_dashboard', link: '/dashboard', exactMatch: true },
      { id: 'profile', title: 'Profil', icon: 'person', link: '/profile' },
      ...(this.api.user()?.role === 'admin' ? [{ id: 'users', title: 'Pengguna', icon: 'group', link: '/users' }] : []),
    ] },
  ]);
  private busy = false;
  async logout(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.error.set('');
    try { await this.api.logout(); }
    catch (error) { this.error.set(errorMessage(error)); }
    finally { this.busy = false; }
  }
}

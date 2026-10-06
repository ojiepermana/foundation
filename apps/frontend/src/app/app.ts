import { ChangeDetectionStrategy, Component, computed, inject, isDevMode } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import type { NavigationItem } from '@ojiepermana/angular/navigation/types';
import { LayoutWrapperDefault } from '@ojiepermana/angular/theme/layout/wrapper';
import { SessionState } from './core/session/session-state';

@Component({
  selector: 'app-root',
  imports: [LayoutWrapperDefault, RouterOutlet],
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly session = inject(SessionState);

  // Static items; neither the navigation nor the shell calls the API (spec 0014, *Halaman*).
  readonly navItems: readonly NavigationItem[] = [
    { id: 'home', title: 'Beranda', link: '/', exactMatch: true },
    { id: 'account', title: 'Akun', link: '/akun', exactMatch: true },
    // The readiness page is development only (spec 0006, AC-7 and AC-9).
    ...(isDevMode() ? [{ id: 'readiness', title: 'Kesiapan', link: '/kesiapan', exactMatch: true }] : []),
  ];
  readonly brand = { name: 'Foundation', icon: null, title: 'Foundation', subtitle: '' };
  /** The user of the wrapper comes from the session state once a page read it, and stays empty before. */
  readonly user = computed(() => {
    const user = this.session.user();
    return user === null ? { name: '', email: '' } : { name: user.displayName, email: user.email };
  });
}

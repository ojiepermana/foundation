import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import type { NavigationItem } from '@ojiepermana/angular/navigation/types';
import { LayoutWrapperDefault } from '@ojiepermana/angular/theme/layout/wrapper';

@Component({
  selector: 'app-root',
  imports: [LayoutWrapperDefault, RouterOutlet],
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  readonly navItems: readonly NavigationItem[] = [
    { id: 'readiness', title: 'Kesiapan', link: '/', exactMatch: true },
  ];
  readonly brand = { name: 'Foundation', icon: null, title: 'Foundation', subtitle: '' };
  readonly user = { name: '', email: '' };
}

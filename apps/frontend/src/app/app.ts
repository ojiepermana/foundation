import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LayoutWrapperDefault } from '@ojiepermana/angular/theme/layout/wrapper';

@Component({
  selector: 'app-root',
  imports: [LayoutWrapperDefault],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  readonly brand = { name: 'Foundation', icon: null, title: 'Foundation', subtitle: '' };
  readonly user = { name: '', email: '' };
}

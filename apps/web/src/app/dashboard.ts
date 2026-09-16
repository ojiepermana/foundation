import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from './api';
import { UI } from './ui';
@Component({ selector: 'app-dashboard', imports: [...UI, RouterLink], templateUrl: './dashboard.html', changeDetection: ChangeDetectionStrategy.OnPush })
export class Dashboard { readonly api = inject(Api); }

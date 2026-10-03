import { Routes } from '@angular/router';
import { FoundationHome } from './features/foundation-home/foundation-home';

export const routes: Routes = [
  { path: '', pathMatch: 'full', component: FoundationHome },
  { path: '**', redirectTo: '' },
];

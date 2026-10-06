import { isDevMode } from '@angular/core';
import { Routes } from '@angular/router';
import { FoundationHome } from './features/foundation-home/foundation-home';

/** The readiness page exists only in development builds (spec 0006, AC-7 and AC-9). */
const developmentRoutes: Routes = isDevMode()
  ? [{ path: 'kesiapan', loadComponent: () => import('./features/readiness/readiness-page').then((m) => m.ReadinessPage) }]
  : [];

export const routes: Routes = [
  { path: '', pathMatch: 'full', component: FoundationHome },
  // The auth pages exist in every build (spec 0014, *Halaman*); each loads on first use.
  { path: 'masuk', loadComponent: () => import('./features/auth/sign-in-page').then((m) => m.SignInPage) },
  { path: 'akun', loadComponent: () => import('./features/auth/account-page').then((m) => m.AccountPage) },
  ...developmentRoutes,
  { path: '**', redirectTo: '' },
];

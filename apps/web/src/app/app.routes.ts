import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { Api } from './api';
export const authenticated: CanActivateFn = async () => {
  const api = inject(Api);
  const router = inject(Router);
  try { return await api.loadSession() || router.createUrlTree(['/login']); }
  catch { return router.createUrlTree(['/login'], { queryParams: { connection: 'unavailable' } }); }
};
export const administrator: CanActivateFn = () =>
  inject(Api).user()?.role === 'admin' || inject(Router).createUrlTree(['/dashboard']);
export const routes: Routes = [
  ...['login', 'activate', 'forgot-password', 'reset-password'].map(path => ({
    path, loadComponent: () => import('./auth-page').then(m => m.AuthPage),
    data: { mode: path }, title: 'Akun | Foundation',
  })),
  {
    path: '', canActivate: [authenticated],
    loadComponent: () => import('./shell').then(m => m.Shell),
    children: [
      { path: 'dashboard', title: 'Dashboard | Foundation', loadComponent: () => import('./dashboard').then(m => m.Dashboard) },
      { path: 'profile', title: 'Profil | Foundation', loadComponent: () => import('./profile').then(m => m.Profile) },
      { path: 'users', title: 'Pengguna | Foundation', canActivate: [administrator], loadComponent: () => import('./users').then(m => m.Users) },
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
    ],
  },
  { path: '**', redirectTo: 'dashboard' },
];

import { inject, Service, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { ApiResponse, SessionData, User } from '../../../../shared/contracts';

export function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    return error.error?.error?.message || (error.status === 0
      ? 'Tidak dapat terhubung. Periksa koneksi Anda lalu coba kembali.'
      : 'Permintaan belum berhasil. Silakan coba kembali.');
  }
  if (error instanceof Error && ['NotAllowedError', 'AbortError'].includes(error.name)) {
    return 'Permintaan passkey dibatalkan atau waktunya habis. Silakan coba kembali.';
  }
  return 'Permintaan belum berhasil. Silakan coba kembali.';
}

@Service()
export class Api {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  readonly user = signal<User | null>(null);
  private csrfToken = '';
  private sessionLoaded = false;
  private sessionRequest?: Promise<boolean>;

  async request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    try {
      return await firstValueFrom(this.http.request<ApiResponse<T>>(method, '/api/v1' + path, {
        body,
        timeout: 15_000,
        headers: this.csrfToken && method !== 'GET' ? { 'X-CSRF-Token': this.csrfToken } : {},
      }));
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401 && !path.startsWith('/auth/')) {
        this.clear();
        void this.router.navigateByUrl('/login');
      }
      throw error;
    }
  }
  establish(session: SessionData): void {
    this.user.set(session.user);
    this.csrfToken = session.csrfToken;
    this.sessionLoaded = true;
  }
  clear(): void {
    this.user.set(null);
    this.csrfToken = '';
    this.sessionLoaded = false;
  }
  async loadSession(): Promise<boolean> {
    if (this.sessionLoaded) return !!this.user();
    this.sessionRequest ??= this.request<SessionData>('GET', '/auth/session')
      .then(({ data }) => { this.establish(data); return true; })
      .catch((error) => {
        this.clear();
        if (error instanceof HttpErrorResponse && error.status === 401) return false;
        throw error;
      }).finally(() => { this.sessionRequest = undefined; });
    return this.sessionRequest;
  }
  async logout(): Promise<void> {
    await this.request('POST', '/auth/logout');
    this.clear();
    await this.router.navigateByUrl('/login');
  }
}

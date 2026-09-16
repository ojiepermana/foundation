import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { Api } from './api';
import type { SessionData } from '../../../../shared/contracts';

const session: SessionData = { user: { id: 'test-user', name: 'Test User', email: 'test@example.com', role: 'user', status: 'active', createdAt: '2026-09-16T00:00:00Z' }, csrfToken: 'csrf-test' };

describe('session and API boundary', () => {
  let api: Api;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    api = TestBed.inject(Api); http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());
  it('shares session restoration between concurrent guards', async () => {
    const first = api.loadSession(); const second = api.loadSession();
    http.expectOne('/api/v1/auth/session').flush({ data: session });
    expect(await first).toBe(true); expect(await second).toBe(true);
    expect(api.user()?.name).toBe('Test User');
  });
  it('attaches CSRF to authenticated mutations and omits it on reads', async () => {
    api.establish(session);
    const mutation = api.request('PATCH', '/me', { name: 'Updated' });
    const req = http.expectOne('/api/v1/me');
    expect(req.request.headers.get('X-CSRF-Token')).toBe('csrf-test');
    req.flush({ data: session.user }); await mutation;
    const read = api.request('GET', '/me/passkeys');
    const readReq = http.expectOne('/api/v1/me/passkeys');
    expect(readReq.request.headers.has('X-CSRF-Token')).toBe(false);
    readReq.flush({ data: [] }); await read;
  });
  it('distinguishes an expired session from an unavailable server', async () => {
    const expired = api.loadSession();
    http.expectOne('/api/v1/auth/session').flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(await expired).toBe(false);
    const unavailable = api.loadSession();
    http.expectOne('/api/v1/auth/session').flush({}, { status: 503, statusText: 'Unavailable' });
    await expect(unavailable).rejects.toMatchObject({ status: 503 });
  });
  it('clears the in-memory identity when a protected request expires', async () => {
    api.establish(session);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const request = api.request('GET', '/me/passkeys');
    http.expectOne('/api/v1/me/passkeys').flush({}, { status: 401, statusText: 'Unauthorized' });
    await expect(request).rejects.toMatchObject({ status: 401 });
    expect(api.user()).toBeNull(); expect(navigate).toHaveBeenCalledWith('/login');
  });
});

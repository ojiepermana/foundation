import { TestBed } from '@angular/core/testing';
import { provideRouter, ActivatedRoute, convertToParamMap } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { AuthPage } from './auth-page';

describe('account forms', () => {
  function setup(mode: string, fragment: string | null = null) {
    TestBed.configureTestingModule({ imports: [AuthPage], providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: ActivatedRoute, useValue: { snapshot: { data: { mode }, fragment, queryParamMap: convertToParamMap({}) } } }] });
    return TestBed.createComponent(AuthPage);
  }
  it('blocks short activation passwords and mismatched confirmation', () => {
    const fixture = setup('activate', 'token=test-secret');
    fixture.componentInstance.model.set({ email: '', password: 'short', confirmation: 'short' });
    expect(fixture.componentInstance.fields().invalid()).toBe(true);
    fixture.componentInstance.model.set({ email: '', password: 'A secure password 123', confirmation: 'different' });
    expect(fixture.componentInstance.fields.confirmation().invalid()).toBe(true);
    fixture.componentInstance.model.set({ email: '', password: 'A secure password 123', confirmation: 'A secure password 123' });
    expect(fixture.componentInstance.fields().valid()).toBe(true);
  });
  it('renders an actionable error when an email link has no token', async () => {
    const fixture = setup('reset-password'); fixture.detectChanges(); await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('Tautan tidak lengkap');
    expect(fixture.nativeElement.querySelector('input[type="password"]')).not.toBeNull();
  });
  it('sends the activation token in the request body and clears password on success', async () => {
    const fixture = setup('activate', 'token=test-secret');
    fixture.componentInstance.model.set({ email: '', password: 'A secure password 123', confirmation: 'A secure password 123' });
    fixture.componentInstance.onSubmit(new Event('submit'));
    await Promise.resolve();
    const http = TestBed.inject(HttpTestingController);
    const req = http.expectOne('/api/v1/auth/activate');
    expect(req.request.body).toEqual({ token: 'test-secret', password: 'A secure password 123' });
    req.flush({ data: { ok: true } }); await fixture.whenStable();
    expect(fixture.componentInstance.model().password).toBe('');
    expect(fixture.componentInstance.success()).toContain('telah aktif');
    http.verify();
  });
});

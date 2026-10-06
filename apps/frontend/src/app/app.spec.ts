import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { App } from './app';
import { routes } from './app.routes';
import { SessionState } from './core/session/session-state';
import { FoundationHome } from './features/foundation-home/foundation-home';

describe('APP-002 framework page', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ providers: [provideRouter(routes)] }).compileComponents();
  });
  it('renders the static home page through the root route', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/', FoundationHome);
    await harness.fixture.whenStable();

    const page = harness.routeNativeElement;
    expect(page?.querySelector('h1')?.textContent).toBe('Foundation');
    expect(page?.querySelector('p')?.textContent).toBe('Kerangka aplikasi siap dikembangkan.');
    expect(page?.querySelector('section')?.getAttribute('aria-labelledby')).toBe(page?.querySelector('h1')?.id);
  });

  // Spec 0014 (*Halaman*): the static navigation of a development build is Beranda, Akun, Kesiapan, in that order, and
  // the wrapper user stays empty until a page filled the session state.
  it('lists Beranda, Akun, and Kesiapan in order and takes the wrapper user from the session state', () => {
    const app = TestBed.runInInjectionContext(() => new App());
    expect(app.navItems.map((item) => [item.title, item.link])).toEqual([['Beranda', '/'], ['Akun', '/akun'], ['Kesiapan', '/kesiapan']]);
    expect(app.user()).toEqual({ name: '', email: '' });
    TestBed.inject(SessionState).signedIn({ id: '00000000-0000-4000-8000-000000000000', email: 'ana@example.test', displayName: 'Ana' }, 'a'.repeat(43));
    expect(app.user()).toEqual({ name: 'Ana', email: 'ana@example.test' });
    expect(routes.map((route) => route.path)).toEqual(['', 'masuk', 'akun', 'kesiapan', '**']);
  });
});

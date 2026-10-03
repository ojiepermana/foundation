import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';
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
});

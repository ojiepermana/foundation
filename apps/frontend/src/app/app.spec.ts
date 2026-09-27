import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { App } from './app';

describe('APP-002 framework page', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({imports:[App],providers:[provideRouter([]),provideHttpClient(),provideHttpClientTesting()]}).compileComponents();
  });
  it('renders the static heading and content inside an accessible main landmark', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const page: HTMLElement = fixture.nativeElement;
    expect(page.querySelector('[role=main] h1')?.textContent).toBe('Foundation');
    expect(page.querySelector('[role=main] p')?.textContent).toBe('Kerangka aplikasi siap dikembangkan.');
    expect(page.querySelector('section')?.getAttribute('aria-labelledby')).toBe(page.querySelector('h1')?.id);
    TestBed.inject(HttpTestingController).expectNone(() => true);
  });
});

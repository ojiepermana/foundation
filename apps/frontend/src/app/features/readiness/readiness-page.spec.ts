import { isDevMode } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Observable, Subject } from 'rxjs';
import { vi } from 'vitest';
import { App } from '../../app';
import { routes } from '../../app.routes';
import { ReadinessApi, type ReadinessResult } from './readiness-api';
import { ReadinessPage } from './readiness-page';

// READY-005 (spec 0006, AC-7 and AC-8): ReadinessPage with a ReadinessApi double built on Subject, so the test decides
// when each check answers. Texts are copied from the spec table *Teks dan state halaman*, not imported from the page.
const TEXT = {
  loading: 'Memeriksa database.',
  available: 'Database dapat dibaca.',
  unavailable: 'Database tidak tersedia. Pastikan PostgreSQL berjalan, lalu periksa ulang.',
  busy: 'Pemeriksaan lain masih berjalan. Tunggu sebentar, lalu periksa ulang.',
  network: 'Backend tidak dapat dihubungi. Pastikan layanan development berjalan, lalu periksa ulang.',
  failed: 'Pemeriksaan gagal. Periksa ulang beberapa saat lagi.',
} as const;
const DESCRIPTION = 'Backend development membaca riwayat migration dengan role runtime. Kelengkapan migration diperiksa oleh doctor.';

const checkedAt = '2026-10-04T08:15:30.123Z';
const laterCheckedAt = '2026-10-04T08:16:45.987Z';

interface PendingCheck {
  readonly results: Subject<ReadinessResult>;
  settled: boolean;
  /** True when the page unsubscribed before the check answered. */
  cancelled: boolean;
}

/** Stand in for ReadinessApi: every `check()` call is counted, and every subscription is one pending check. */
class ReadinessApiDouble {
  calls = 0;
  readonly checks: PendingCheck[] = [];

  constructor(private readonly immediate?: ReadinessResult) {}

  check(): Observable<ReadinessResult> {
    this.calls += 1;
    return new Observable<ReadinessResult>((subscriber) => {
      const pending: PendingCheck = { results: new Subject<ReadinessResult>(), settled: false, cancelled: false };
      this.checks.push(pending);
      const subscription = pending.results.subscribe(subscriber);
      if (this.immediate) this.answer(this.immediate);
      return () => {
        if (!pending.settled) pending.cancelled = true;
        subscription.unsubscribe();
      };
    });
  }

  /** Answers the latest pending check with one result, then completes it like the real adapter. */
  answer(result: ReadinessResult): void {
    const pending = this.checks.at(-1);
    if (!pending || pending.settled) throw new Error('No pending readiness check to answer.');
    pending.settled = true;
    pending.results.next(result);
    pending.results.complete();
  }

  /** Ends the latest pending check with an error, which the real adapter never does; the page must still cope. */
  fail(error: unknown): void {
    const pending = this.checks.at(-1);
    if (!pending || pending.settled) throw new Error('No pending readiness check to fail.');
    pending.settled = true;
    pending.results.error(error);
  }
}

interface Rendered {
  fixture: ComponentFixture<ReadinessPage>;
  api: ReadinessApiDouble;
  element: HTMLElement;
}

function render(): Rendered {
  const api = new ReadinessApiDouble();
  TestBed.configureTestingModule({ providers: [{ provide: ReadinessApi, useValue: api }] });
  const fixture = TestBed.createComponent(ReadinessPage);
  // A loading resource holds a pending task, so whenStable() would wait for the answer; render the loading state now.
  fixture.detectChanges();
  return { fixture, api, element: fixture.nativeElement as HTMLElement };
}

async function answer({ fixture, api }: Rendered, result: ReadinessResult): Promise<void> {
  api.answer(result);
  await fixture.whenStable();
}

/** Activates the button the way a click does, then renders whatever state follows. */
function activate({ fixture, element }: Rendered): void {
  button(element).click();
  fixture.detectChanges();
}

const status = (element: HTMLElement) => element.querySelector<HTMLElement>('[role="status"]')!;
const button = (element: HTMLElement) => element.querySelector<HTMLButtonElement>('button')!;
const text = (node: Element | null | undefined) => node?.textContent?.trim();
const terms = (element: HTMLElement) => [...element.querySelectorAll('dt')].map(text);
const details = (element: HTMLElement) => [...element.querySelectorAll('dd')].map(text);
const formatted = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));

function expectLoading(element: HTMLElement): void {
  expect(text(status(element))).toBe(TEXT.loading);
  const spinner = element.querySelector('spinner');
  expect(spinner).not.toBeNull();
  expect(spinner?.getAttribute('aria-hidden')).toBe('true');
  expect(spinner?.getAttribute('role')).toBeNull();
  expect(element.querySelector('dl')).toBeNull();
  expect(element.querySelector('time')).toBeNull();
  expect(button(element).getAttribute('aria-disabled')).toBe('true');
}

function expectSettled(element: HTMLElement, message: string): void {
  expect(text(status(element))).toBe(message);
  expect(element.querySelector('spinner')).toBeNull();
  expect(button(element).getAttribute('aria-disabled')).toBeNull();
}

function expectTime(element: HTMLElement, value: string): void {
  const times = element.querySelectorAll('time');
  expect(times).toHaveLength(1);
  expect(times[0]!.getAttribute('datetime')).toBe(value);
  expect(text(times[0])).toBe(formatted(value));
}

describe('READY-005 readiness page states', () => {
  it('sends exactly one check when created and shows the loading state inside the AC-8 composition', () => {
    const { api, element } = render();
    expect(api.calls).toBe(1);
    expect(api.checks).toHaveLength(1);

    const headings = [...element.querySelectorAll('h1, h2')].map((heading) => [heading.tagName, text(heading)]);
    expect(headings).toEqual([['H1', 'Kesiapan'], ['H2', 'Database']]);
    expect(element.querySelector('h2')?.hasAttribute('cardtitle')).toBe(true);
    const description = element.querySelector('p[carddescription]');
    expect(text(description)).toBe(DESCRIPTION);
    for (const host of ['card', 'cardheader', 'cardcontent', 'cardfooter']) expect(element.querySelectorAll(host)).toHaveLength(1);
    expect(element.querySelectorAll('button')).toHaveLength(1);
    expect(button(element).hasAttribute('button')).toBe(true);
    expect(button(element).closest('cardfooter')).not.toBeNull();
    expect(text(button(element))).toBe('Periksa ulang');
    expect(button(element).type).toBe('button');

    const statuses = element.querySelectorAll('[role="status"]');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.getAttribute('aria-live')).toBe('polite');
    expectLoading(element);
  });

  it('keeps the same status node through loading, available, then loading again, and hides the old result', async () => {
    const rendered = render();
    const { api, element } = rendered;
    const statusNode = status(element);

    await answer(rendered, { status: 'available', checkedAt, appliedMigrations: 0 });
    expect(status(element)).toBe(statusNode);
    expectSettled(element, TEXT.available);
    expect(terms(element)).toEqual(['Waktu pemeriksaan', 'Migration terapan']);
    expect(details(element)).toEqual([formatted(checkedAt), '0']);
    expectTime(element, checkedAt);

    activate(rendered);
    expect(api.calls).toBe(2);
    expect(status(element)).toBe(statusNode);
    expectLoading(element);
    expect(element.textContent).not.toContain(formatted(checkedAt));

    await answer(rendered, { status: 'available', checkedAt: laterCheckedAt, appliedMigrations: 1234567 });
    expect(status(element)).toBe(statusNode);
    expectSettled(element, TEXT.available);
    expect(details(element)).toEqual([formatted(laterCheckedAt), '1234567']);
    expectTime(element, laterCheckedAt);
  });

  it('ignores activation while loading: the button is aria-disabled and no second request starts', async () => {
    const rendered = render();
    const { api, element } = rendered;
    activate(rendered);
    activate(rendered);
    expect(api.calls).toBe(1);
    expect(api.checks).toHaveLength(1);
    expectLoading(element);

    await answer(rendered, { status: 'busy' });
    expectSettled(element, TEXT.busy);
    activate(rendered);
    expect(api.calls).toBe(2);
    activate(rendered);
    expect(api.calls).toBe(2);
    expect(api.checks).toHaveLength(2);
  });

  const failures: [keyof typeof TEXT, ReadinessResult, boolean][] = [
    ['unavailable', { status: 'unavailable', checkedAt: laterCheckedAt }, true],
    ['busy', { status: 'busy' }, false],
    ['network', { status: 'network' }, false],
    ['failed', { status: 'failed' }, false],
  ];

  for (const [state, result, showsTime] of failures) {
    it(`shows the ${state} text after a successful check without the old migration count`, async () => {
      const rendered = render();
      const { element } = rendered;
      await answer(rendered, { status: 'available', checkedAt, appliedMigrations: 4242 });
      expect(details(element)).toContain('4242');

      activate(rendered);
      await answer(rendered, result);
      expectSettled(element, TEXT[state]);
      expect(element.textContent).not.toContain('4242');
      expect(element.textContent).not.toContain('Migration terapan');
      expect(element.textContent).not.toContain(formatted(checkedAt));
      if (showsTime) {
        expect(terms(element)).toEqual(['Waktu pemeriksaan']);
        expect(details(element)).toEqual([formatted(laterCheckedAt)]);
        expectTime(element, laterCheckedAt);
      } else {
        expect(element.querySelector('dl')).toBeNull();
        expect(element.querySelector('time')).toBeNull();
      }
    });
  }

  const results: ReadinessResult[] = [
    { status: 'available', checkedAt, appliedMigrations: 3 },
    { status: 'unavailable', checkedAt },
    { status: 'busy' },
    { status: 'network' },
    { status: 'failed' },
  ];

  for (const result of results) {
    it(`does not check again on its own after a ${result.status} result while fake time advances 60 seconds`, async () => {
      vi.useFakeTimers();
      try {
        const rendered = render();
        const { api, element, fixture } = rendered;
        api.answer(result);
        await vi.advanceTimersByTimeAsync(0);
        fixture.detectChanges();
        expectSettled(element, TEXT[result.status]);

        await vi.advanceTimersByTimeAsync(60_000);
        fixture.detectChanges();
        expect(api.calls).toBe(1);
        expect(api.checks).toHaveLength(1);
        expectSettled(element, TEXT[result.status]);
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it('does not check again on its own while a check stays pending for 60 seconds of fake time', async () => {
    vi.useFakeTimers();
    try {
      const { api, element, fixture } = render();
      await vi.advanceTimersByTimeAsync(60_000);
      fixture.detectChanges();
      expect(api.calls).toBe(1);
      expectLoading(element);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the running check when the page is destroyed', () => {
    const { api, fixture } = render();
    const pending = api.checks[0]!;
    expect(pending.cancelled).toBe(false);
    fixture.destroy();
    expect(pending.cancelled).toBe(true);
    expect(pending.results.observed).toBe(false);
    expect(api.calls).toBe(1);
  });

  it('shows the failed text without the old count or time when a check errors instead of answering', async () => {
    const rendered = render();
    const { api, element, fixture } = rendered;
    await answer(rendered, { status: 'available', checkedAt, appliedMigrations: 4242 });
    expect(details(element)).toContain('4242');

    activate(rendered);
    api.fail(new Error('unexpected'));
    await fixture.whenStable();
    fixture.detectChanges();
    expectSettled(element, TEXT.failed);
    expect(element.textContent).not.toContain('4242');
    expect(element.querySelector('dl')).toBeNull();
    expect(element.querySelector('time')).toBeNull();

    // The page recovers through the same button, with one new check.
    activate(rendered);
    expect(api.calls).toBe(3);
    expectLoading(element);
    await answer(rendered, { status: 'available', checkedAt: laterCheckedAt, appliedMigrations: 1 });
    expectSettled(element, TEXT.available);
    expect(details(element)).toEqual([formatted(laterCheckedAt), '1']);
  });

  it('shows the count exactly as String() gives it, with no thousands separator, for a large count', async () => {
    const rendered = render();
    await answer(rendered, { status: 'available', checkedAt, appliedMigrations: 9007199254740991 });
    expect(details(rendered.element)[1]).toBe('9007199254740991');
  });

  it('keeps the button focused and its accessible name while the state changes', async () => {
    const rendered = render();
    const { element } = rendered;
    // Focus needs a connected element; attach the host only when TestBed did not already.
    const attached = !element.isConnected;
    if (attached) document.body.appendChild(element);
    try {
      await answer(rendered, { status: 'unavailable', checkedAt });
      const before = button(element);
      before.focus();
      expect(document.activeElement).toBe(before);
      activate(rendered);
      expect(document.activeElement).toBe(before);
      expect(text(before)).toBe('Periksa ulang');
      await answer(rendered, { status: 'busy' });
      expect(button(element)).toBe(before);
      expect(document.activeElement).toBe(before);
    } finally {
      if (attached) element.remove();
    }
  });

  it('does not report a finished check as cancelled when the page is destroyed later', async () => {
    const rendered = render();
    await answer(rendered, { status: 'network' });
    rendered.fixture.destroy();
    expect(rendered.api.checks[0]!.cancelled).toBe(false);
  });
});

describe('READY-005 development route and navigation', () => {
  it('runs in development mode, where the page and its navigation item exist', () => {
    expect(isDevMode()).toBe(true);
  });

  it('registers kesiapan as a lazy route between the auth routes and the fallback', async () => {
    // Spec 0014 puts masuk and akun between the home route and kesiapan.
    expect(routes.map((route) => route.path)).toEqual(['', 'masuk', 'akun', 'kesiapan', '**']);
    const readiness = routes[3]!;
    expect(readiness.component).toBeUndefined();
    expect(typeof readiness.loadComponent).toBe('function');
    expect(await readiness.loadComponent!()).toBe(ReadinessPage);
  });

  it('App.navItems holds exactly Beranda, Akun, then Kesiapan in the AC-7 shape', () => {
    // Spec 0014 adds the static item Akun between Beranda and Kesiapan; App injects the session state, so it is built
    // in an injection context.
    expect(TestBed.runInInjectionContext(() => new App()).navItems).toStrictEqual([
      { id: 'home', title: 'Beranda', link: '/', exactMatch: true },
      { id: 'account', title: 'Akun', link: '/akun', exactMatch: true },
      { id: 'readiness', title: 'Kesiapan', link: '/kesiapan', exactMatch: true },
    ]);
  });

  it('leaving /kesiapan through the router cancels the running check, and coming back sends exactly one new check', async () => {
    const api = new ReadinessApiDouble();
    TestBed.configureTestingModule({ providers: [provideRouter(routes), { provide: ReadinessApi, useValue: api }] });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/kesiapan', ReadinessPage);
    expect(api.calls).toBe(1);
    const pending = api.checks[0]!;
    expect(pending.cancelled).toBe(false);

    await harness.navigateByUrl('/');
    expect(pending.cancelled).toBe(true);
    expect(pending.results.observed).toBe(false);
    expect(text(harness.routeNativeElement!.querySelector('h1'))).toBe('Foundation');
    expect(api.calls).toBe(1);

    await harness.navigateByUrl('/kesiapan', ReadinessPage);
    expect(api.calls).toBe(2);
    expectLoading(harness.routeNativeElement!);
  });

  it('opening /kesiapan loads the page through the router with the h1 Kesiapan and one check', async () => {
    const api = new ReadinessApiDouble({ status: 'unavailable', checkedAt });
    TestBed.configureTestingModule({ providers: [provideRouter(routes), { provide: ReadinessApi, useValue: api }] });
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/kesiapan', ReadinessPage);
    expect(page).toBeInstanceOf(ReadinessPage);
    const element = harness.routeNativeElement!;
    expect(text(element.querySelector('h1'))).toBe('Kesiapan');
    expect(element.querySelector('section')?.getAttribute('aria-labelledby')).toBe(element.querySelector('h1')?.id);
    expect(api.calls).toBe(1);
    expectSettled(element, TEXT.unavailable);
    expectTime(element, checkedAt);
  });
});

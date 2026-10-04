import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { DevelopmentService, provideApiConfiguration } from '@sdk';
import { firstValueFrom, throwError, toArray } from 'rxjs';
import { inject } from 'vitest';
import { appConfig } from '../../app.config';
import { ReadinessApi, type ReadinessResult } from './readiness-api';

// READY-004 (spec 0006, AC-6): ReadinessApi over the generated SDK, wired through appConfig. Request shape and every
// row of *Pemetaan adapter* use HttpTestingController; the real results use the backend that vitest-backend.setup.ts
// starts once per run without DATABASE_URL (spec 0009 harness).
const backendUrl = inject('sdkContractBackendUrl');
const closedUrl = inject('sdkContractClosedUrl');

const checkedAt = '2026-10-04T08:15:30.123Z';

describe('READY-004 request shape with the application config', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [...appConfig.providers, provideHttpClientTesting()] });
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('is cold, then sends exactly one GET /api/readiness without query, body, Authorization, or credentials', () => {
    const httpTesting = TestBed.inject(HttpTestingController);
    const check = TestBed.inject(ReadinessApi).check();
    expect(httpTesting.match(() => true)).toHaveLength(0);

    const results: ReadinessResult[] = [];
    check.subscribe((result) => results.push(result));
    const requests = httpTesting.match(() => true);
    expect(requests).toHaveLength(1);
    const request = requests[0]!.request;
    expect(request.method).toBe('GET');
    expect(request.url).toBe('/api/readiness');
    expect(request.urlWithParams).toBe('/api/readiness');
    expect(request.params.keys()).toEqual([]);
    expect(request.body).toBeNull();
    expect(request.headers.has('Authorization')).toBe(false);
    expect(request.withCredentials).toBe(false);
    requests[0]!.flush({ status: 'available', checkedAt, appliedMigrations: 2 });
    expect(results).toEqual([{ status: 'available', checkedAt, appliedMigrations: 2 }]);
  });
});

interface Row {
  name: string;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  expected: ReadinessResult;
}

const failed: ReadinessResult = { status: 'failed' };
const network: ReadinessResult = { status: 'network' };
const available = { status: 'available', checkedAt, appliedMigrations: 7 };

const rows: Row[] = [
  { name: '200 with a valid body', status: 200, body: available, expected: available as ReadinessResult },
  { name: '200 with zero migrations', status: 200, body: { ...available, appliedMigrations: 0 }, expected: { ...available, appliedMigrations: 0 } as ReadinessResult },
  { name: '200 with another status', status: 200, body: { status: 'ok' }, expected: failed },
  { name: '200 with appliedMigrations -1', status: 200, body: { ...available, appliedMigrations: -1 }, expected: failed },
  { name: '200 with appliedMigrations 1.5', status: 200, body: { ...available, appliedMigrations: 1.5 }, expected: failed },
  { name: '200 with appliedMigrations "3"', status: 200, body: { ...available, appliedMigrations: '3' }, expected: failed },
  { name: '200 without appliedMigrations', status: 200, body: { status: 'available', checkedAt }, expected: failed },
  { name: '200 with checkedAt not-a-date', status: 200, body: { ...available, checkedAt: 'not-a-date' }, expected: failed },
  { name: '200 with a body that is not an object', status: 200, body: 'available', expected: failed },
  { name: '503 with a valid body', status: 503, body: { status: 'unavailable', checkedAt }, expected: { status: 'unavailable', checkedAt } },
  { name: '503 with another body', status: 503, body: { error: 'Service unavailable' }, expected: failed },
  { name: '503 with checkedAt not-a-date', status: 503, body: { status: 'unavailable', checkedAt: 'not-a-date' }, expected: failed },
  { name: '429 with a valid body', status: 429, body: { status: 'busy' }, expected: { status: 'busy' } },
  { name: '429 with another body', status: 429, body: { status: 'unavailable', checkedAt }, expected: failed },
  { name: '400', status: 400, body: { error: 'Invalid request' }, expected: failed },
  { name: '404', status: 404, body: { error: 'Not found' }, expected: failed },
  { name: '500', status: 500, body: { error: 'Internal server error' }, expected: failed },
  { name: '502 with an empty text/plain body', status: 502, body: '', headers: { 'Content-Type': 'text/plain' }, expected: network },
  { name: '504', status: 504, body: null, expected: network },
];

describe('READY-004 adapter mapping table', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [...appConfig.providers, provideHttpClientTesting()] });
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  for (const row of rows) {
    it(`maps ${row.name} to ${row.expected.status} and completes without error`, () => {
      const emitted: ReadinessResult[] = [];
      let completed = false;
      let errored = false;
      TestBed.inject(ReadinessApi).check().subscribe({
        next: (result) => emitted.push(result),
        error: () => (errored = true),
        complete: () => (completed = true),
      });
      TestBed.inject(HttpTestingController)
        .expectOne('/api/readiness')
        .flush(row.body as never, { status: row.status, statusText: 'Fixture', headers: row.headers });
      expect(errored).toBe(false);
      expect(completed).toBe(true);
      expect(emitted).toStrictEqual([row.expected]);
      // A result is always a new object, never the body that arrived.
      if (typeof row.body === 'object' && row.body !== null) expect(emitted[0]).not.toBe(row.body);
    });
  }

  it('drops fields outside the model from a 200 body', () => {
    let result: ReadinessResult | undefined;
    TestBed.inject(ReadinessApi).check().subscribe((value) => (result = value));
    TestBed.inject(HttpTestingController).expectOne('/api/readiness').flush({ ...available, extra: '<script>' });
    expect(result).toStrictEqual(available);
    expect(Object.keys(result!).sort()).toEqual(['appliedMigrations', 'checkedAt', 'status']);
  });

  it('maps a network error with status 0 to network and completes without error', () => {
    const emitted: ReadinessResult[] = [];
    let completed = false;
    TestBed.inject(ReadinessApi).check().subscribe({ next: (result) => emitted.push(result), complete: () => (completed = true) });
    TestBed.inject(HttpTestingController).expectOne('/api/readiness').error(new ProgressEvent('error'));
    expect(completed).toBe(true);
    expect(emitted).toStrictEqual([network]);
  });
});

const edgeRows: Row[] = [
  { name: '200 with a null body', status: 200, body: null, expected: failed },
  { name: '200 with an array body', status: 200, body: [available], expected: failed },
  { name: '200 with appliedMigrations above the safe integer range', status: 200, body: { ...available, appliedMigrations: 2 ** 53 }, expected: failed },
  { name: '200 with appliedMigrations null', status: 200, body: { ...available, appliedMigrations: null }, expected: failed },
  { name: '200 with checkedAt as a number', status: 200, body: { ...available, checkedAt: Date.parse(checkedAt) }, expected: failed },
  { name: '200 with an empty checkedAt', status: 200, body: { ...available, checkedAt: '' }, expected: failed },
  { name: '200 without checkedAt', status: 200, body: { status: 'available', appliedMigrations: 7 }, expected: failed },
  { name: '200 with the unavailable body', status: 200, body: { status: 'unavailable', checkedAt }, expected: failed },
  { name: '503 with a null body', status: 503, body: null, expected: failed },
  { name: '503 with checkedAt as a number', status: 503, body: { status: 'unavailable', checkedAt: Date.parse(checkedAt) }, expected: failed },
  { name: '503 without checkedAt', status: 503, body: { status: 'unavailable' }, expected: failed },
  { name: '503 with the busy body', status: 503, body: { status: 'busy' }, expected: failed },
  { name: '429 with a text body', status: 429, body: 'busy', headers: { 'Content-Type': 'text/plain' }, expected: failed },
  { name: '429 with a null body', status: 429, body: null, expected: failed },
  { name: '401', status: 401, body: { error: 'Unauthorized' }, expected: failed },
  { name: '403', status: 403, body: { error: 'Forbidden' }, expected: failed },
  { name: '502 with a body that looks like unavailable', status: 502, body: { status: 'unavailable', checkedAt }, expected: network },
  { name: '504 with a body that looks like busy', status: 504, body: { status: 'busy' }, expected: network },
];

describe('READY-004 adapter mapping edge cases', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [...appConfig.providers, provideHttpClientTesting()] });
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  for (const row of edgeRows) {
    it(`maps ${row.name} to ${row.expected.status} and completes without error`, () => {
      const emitted: ReadinessResult[] = [];
      let completed = false;
      let errored = false;
      TestBed.inject(ReadinessApi).check().subscribe({
        next: (result) => emitted.push(result),
        error: () => (errored = true),
        complete: () => (completed = true),
      });
      TestBed.inject(HttpTestingController)
        .expectOne('/api/readiness')
        .flush(row.body as never, { status: row.status, statusText: 'Fixture', headers: row.headers });
      expect(errored).toBe(false);
      expect(completed).toBe(true);
      expect(emitted).toStrictEqual([row.expected]);
    });
  }

  it('builds a new unavailable result with only status and checkedAt from a 503 body with extra fields', () => {
    let result: ReadinessResult | undefined;
    const body = { status: 'unavailable', checkedAt, detail: 'password authentication failed', appliedMigrations: 4 };
    TestBed.inject(ReadinessApi).check().subscribe((value) => (result = value));
    TestBed.inject(HttpTestingController).expectOne('/api/readiness').flush(body, { status: 503, statusText: 'Fixture' });
    expect(result).toStrictEqual({ status: 'unavailable', checkedAt });
    expect(result).not.toBe(body);
  });

  it('builds a new busy result with only status from a 429 body with extra fields', () => {
    let result: ReadinessResult | undefined;
    TestBed.inject(ReadinessApi).check().subscribe((value) => (result = value));
    TestBed.inject(HttpTestingController).expectOne('/api/readiness').flush({ status: 'busy', checkedAt }, { status: 429, statusText: 'Fixture' });
    expect(result).toStrictEqual({ status: 'busy' });
  });

  it('keeps checkedAt as the exact server string, without converting it', () => {
    const serverTime = '2026-10-04T08:15:30Z';
    let result: ReadinessResult | undefined;
    TestBed.inject(ReadinessApi).check().subscribe((value) => (result = value));
    TestBed.inject(HttpTestingController).expectOne('/api/readiness').flush({ ...available, checkedAt: serverTime });
    expect(result).toStrictEqual({ status: 'available', checkedAt: serverTime, appliedMigrations: 7 });
  });
});

describe('READY-004 the check observable is cold and cancellable', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [...appConfig.providers, provideHttpClientTesting()] });
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('sends one new GET for every subscription to the same observable', () => {
    const httpTesting = TestBed.inject(HttpTestingController);
    const check = TestBed.inject(ReadinessApi).check();
    const results: ReadinessResult[] = [];
    check.subscribe((result) => results.push(result));
    check.subscribe((result) => results.push(result));
    const requests = httpTesting.match('/api/readiness');
    expect(requests).toHaveLength(2);
    requests[0]!.flush({ status: 'busy' }, { status: 429, statusText: 'Fixture' });
    requests[1]!.flush(available);
    expect(results).toStrictEqual([{ status: 'busy' }, available]);
  });

  it('cancels the running request when the subscriber unsubscribes, and emits nothing', () => {
    const results: ReadinessResult[] = [];
    const subscription = TestBed.inject(ReadinessApi).check().subscribe((result) => results.push(result));
    const request = TestBed.inject(HttpTestingController).expectOne('/api/readiness');
    expect(request.cancelled).toBe(false);
    subscription.unsubscribe();
    expect(request.cancelled).toBe(true);
    expect(results).toEqual([]);
  });

  it('holds no state between checks: a failure does not change the next result', () => {
    const httpTesting = TestBed.inject(HttpTestingController);
    const api = TestBed.inject(ReadinessApi);
    const results: ReadinessResult[] = [];
    api.check().subscribe((result) => results.push(result));
    httpTesting.expectOne('/api/readiness').flush({ error: 'Internal server error' }, { status: 500, statusText: 'Fixture' });
    api.check().subscribe((result) => results.push(result));
    httpTesting.expectOne('/api/readiness').flush(available);
    expect(results).toStrictEqual([failed, available]);
  });
});

describe('READY-004 adapter mapping for an error that is not HttpErrorResponse', () => {
  it('maps it to failed and completes without error', async () => {
    TestBed.configureTestingModule({
      providers: [
        ...appConfig.providers,
        { provide: DevelopmentService, useValue: { getDevelopmentReadiness: () => throwError(() => new TypeError('not http')) } },
      ],
    });
    expect(await firstValueFrom(TestBed.inject(ReadinessApi).check().pipe(toArray()))).toStrictEqual([failed]);
  });
});

describe('READY-004 results from the real backend', () => {
  function useBackend(rootUrl: string): void {
    TestBed.configureTestingModule({ providers: [...appConfig.providers, provideApiConfiguration(rootUrl)] });
  }

  it('returns unavailable with an ISO checkedAt from the backend that runs without a database', async () => {
    useBackend(backendUrl);
    const results = await firstValueFrom(TestBed.inject(ReadinessApi).check().pipe(toArray()));
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(Object.keys(result).sort()).toEqual(['checkedAt', 'status']);
    expect(Number.isNaN(Date.parse(result.checkedAt))).toBe(false);
    expect(result.checkedAt).toBe(new Date(result.checkedAt).toISOString());
  });

  it('returns network when nothing listens on the port', async () => {
    useBackend(closedUrl);
    expect(await firstValueFrom(TestBed.inject(ReadinessApi).check().pipe(toArray()))).toStrictEqual([{ status: 'network' }]);
  });
});

import { HttpErrorResponse } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  ApiConfiguration,
  DevelopmentService,
  FoundationApi,
  getDevelopmentStatus,
  provideApiConfiguration,
  type DevelopmentStatus,
  type StrictHttpResponse,
} from '@sdk';
import { firstValueFrom } from 'rxjs';
import { inject } from 'vitest';
import { appConfig } from './app.config';

// SDK-004 (spec 0009, AC-4): the generated SDK, wired through appConfig, against the real backend that
// vitest-backend.setup.ts starts once per run without DATABASE_URL.
const backendUrl = inject('sdkContractBackendUrl');
const closedUrl = inject('sdkContractClosedUrl');

function useRealBackend(rootUrl: string): void {
  TestBed.configureTestingModule({ providers: [...appConfig.providers, provideApiConfiguration(rootUrl)] });
}

function expectDevelopmentStatus(response: StrictHttpResponse<DevelopmentStatus>): void {
  expect(response.status).toBe(200);
  expect(response.url).toBe(`${backendUrl}/api/status`);
  expect(response.headers.get('Content-Type')?.startsWith('application/json')).toBe(true);
  const body: DevelopmentStatus = response.body;
  expect(body).toStrictEqual({ status: 'ok' });
}

async function failure(rootUrl: string): Promise<HttpErrorResponse> {
  useRealBackend(rootUrl);
  const error: unknown = await firstValueFrom(TestBed.inject(DevelopmentService).getDevelopmentStatus$Response()).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(HttpErrorResponse);
  return error as HttpErrorResponse;
}

describe('SDK-004 request shape with the application config', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [...appConfig.providers, provideHttpClientTesting()] });
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('uses the same origin root URL and sends one GET /api/status without credentials', () => {
    expect(TestBed.inject(ApiConfiguration).rootUrl).toBe('');
    const httpTesting = TestBed.inject(HttpTestingController);

    TestBed.inject(DevelopmentService).getDevelopmentStatus().subscribe();

    const requests = httpTesting.match(() => true);
    expect(requests).toHaveLength(1);
    const [captured] = requests;
    const request = captured!.request;
    expect(request.method).toBe('GET');
    expect(request.url).toBe('/api/status');
    expect(request.urlWithParams).toBe('/api/status');
    expect(request.headers.get('Accept')).toBe('application/json');
    expect(request.body).toBeNull();
    expect(request.headers.has('Authorization')).toBe(false);
    expect(request.withCredentials).toBe(false);
    captured!.flush({ status: 'ok' });
  });
});

describe('SDK-004 responses from the real backend', () => {
  it('returns the development status through DevelopmentService', async () => {
    useRealBackend(backendUrl);
    expectDevelopmentStatus(await firstValueFrom(TestBed.inject(DevelopmentService).getDevelopmentStatus$Response()));
  });

  it('returns the development status through FoundationApi.invoke$Response', async () => {
    useRealBackend(backendUrl);
    expectDevelopmentStatus(
      await firstValueFrom(TestBed.inject(FoundationApi).invoke$Response(getDevelopmentStatus, {})),
    );
  });

  // covers: AC-4, the body only operations an adapter calls (Kontrak adapter fitur, butir 2 and 3).
  it('returns only the DevelopmentStatus body through getDevelopmentStatus and FoundationApi.invoke', async () => {
    useRealBackend(backendUrl);
    const fromService: DevelopmentStatus = await firstValueFrom(TestBed.inject(DevelopmentService).getDevelopmentStatus());
    const fromClient: DevelopmentStatus = await firstValueFrom(TestBed.inject(FoundationApi).invoke(getDevelopmentStatus, {}));
    expect(fromService).toStrictEqual({ status: 'ok' });
    expect(fromClient).toStrictEqual({ status: 'ok' });
  });

  it('fails with HttpErrorResponse 404 and the backend error body for an unknown path', async () => {
    const error = await failure(`${backendUrl}/missing`);
    expect(error.status).toBe(404);
    expect(error.error).toStrictEqual({ error: 'Not found' });
  });

  it('fails with HttpErrorResponse status 0 when nothing listens on the port', async () => {
    const error = await failure(closedUrl);
    expect(error.status).toBe(0);
  });
});

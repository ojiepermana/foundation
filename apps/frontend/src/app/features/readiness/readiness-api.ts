import { HttpErrorResponse } from '@angular/common/http';
import { Service, inject } from '@angular/core';
import { DevelopmentService, type ReadinessAvailable, type ReadinessBusy, type ReadinessUnavailable } from '@sdk';
import { type Observable, catchError, map, of } from 'rxjs';

export type { ReadinessAvailable, ReadinessBusy, ReadinessUnavailable } from '@sdk';

/** Result of one readiness check, as the page shows it (spec 0006, *Pemetaan adapter*). */
export type ReadinessResult =
  | ReadinessAvailable
  | ReadinessUnavailable
  | ReadinessBusy
  | { status: 'network' }
  | { status: 'failed' };

type Body = Record<string, unknown>;

const isBody = (value: unknown): value is Body => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** A 200 body is never passed through: each field is checked and a new object is built. */
function fromSuccess(body: unknown): ReadinessResult {
  if (!isBody(body) || body['status'] !== 'available') return { status: 'failed' };
  const checkedAt = body['checkedAt'];
  const appliedMigrations = body['appliedMigrations'];
  if (!isTime(checkedAt) || !isCount(appliedMigrations)) return { status: 'failed' };
  return { status: 'available', checkedAt, appliedMigrations };
}

function fromError(error: unknown): ReadinessResult {
  if (!(error instanceof HttpErrorResponse)) return { status: 'failed' };
  // The backend never answers 502 or 504; those come from the development proxy when the backend is not reachable.
  if (error.status === 0 || error.status === 502 || error.status === 504) return { status: 'network' };
  const body: unknown = error.error;
  if (error.status === 503 && isBody(body) && body['status'] === 'unavailable') {
    const checkedAt = body['checkedAt'];
    if (isTime(checkedAt)) return { status: 'unavailable', checkedAt };
  }
  if (error.status === 429 && isBody(body) && body['status'] === 'busy') return { status: 'busy' };
  return { status: 'failed' };
}

/** Feature adapter over the generated SDK (spec 0009, *Kontrak adapter fitur*); it holds no state. */
@Service()
export class ReadinessApi {
  private readonly development = inject(DevelopmentService);

  /** Cold: one GET /api/readiness per subscription. Never errors; every outcome becomes a `ReadinessResult`. */
  check(): Observable<ReadinessResult> {
    return this.development.getDevelopmentReadiness().pipe(
      map(fromSuccess),
      catchError((error: unknown) => of(fromError(error))),
    );
  }
}

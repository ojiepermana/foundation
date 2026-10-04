/** Counts applied migrations; absent when the backend runs without a database pool. */
export type CountAppliedMigrations = () => Promise<number>;

export type ReadinessOutcome =
  | { status: 'available'; checkedAt: string; appliedMigrations: number }
  | { status: 'unavailable'; checkedAt: string }
  | { status: 'busy' };

export interface ReadinessCheckOptions {
  /** Answer deadline from the moment the check starts. Tests pass a small value; the backend keeps 5,000 ms. */
  deadlineMs?: number;
}

/** Spec 0006, Value sourcing *Batas respons*: above the 3 s pool connection limit, below the 10 s listener idleTimeout. */
export const READINESS_DEADLINE_MS = 5000;

const checkedAt = () => new Date().toISOString();
const available = (appliedMigrations: number): ReadinessOutcome => ({ status: 'available', checkedAt: checkedAt(), appliedMigrations });
// Every failure maps to the same body and is never logged, so no PostgreSQL detail reaches a response or the output.
const unavailable = (): ReadinessOutcome => ({ status: 'unavailable', checkedAt: checkedAt() });
const busy = (): ReadinessOutcome => ({ status: 'busy' });

/** Starts the count once; a synchronous throw becomes a rejected promise so it maps like any other failure. */
function start(count: CountAppliedMigrations): Promise<number> {
  try {
    return count();
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Readiness check owned by one route instance, so its state never lives at module level (spec 0006, invariant 2).
 * Without a count function every call answers `unavailable` and never touches the marker. Otherwise the active marker
 * is checked and set with no `await` in between, before the count starts: a call that finds it set answers `busy`
 * without a new query or a queue. The count runs at most once per call, without retry. The marker is released only
 * when the count promise settles, through the final handlers attached the moment that promise is created, so a late
 * result after the deadline is consumed and dropped without a log or an unhandled rejection. The caller gets the race
 * between the mapped count and the deadline timer, and the timer is cleared on every path. The returned promise
 * never rejects.
 */
export function createReadinessCheck(count?: CountAppliedMigrations, { deadlineMs = READINESS_DEADLINE_MS }: ReadinessCheckOptions = {}): () => Promise<ReadinessOutcome> {
  let active = false;
  const release = () => { active = false; };
  return () => {
    if (!count) return Promise.resolve(unavailable());
    if (active) return Promise.resolve(busy());
    active = true;
    const query = start(count);
    query.then(release, release);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<ReadinessOutcome>((resolve) => { timer = setTimeout(() => resolve(unavailable()), deadlineMs); });
    return Promise.race([query.then(available, unavailable), deadline]).then((outcome) => {
      clearTimeout(timer);
      return outcome;
    });
  };
}

import { READINESS_DEADLINE_MS } from '../development/readiness.service';

/** Tells whether the required migration is applied; absent when the backend runs without a database pool. */
export type ReadinessProbe = () => Promise<boolean>;

export type HealthReadiness = 'ready' | 'unavailable';

export interface HealthReadinessOptions {
  /** Answer deadline from the moment a check starts. Tests pass a small value; the backend keeps 5,000 ms. */
  deadlineMs?: number;
}

/** Starts the probe once; a synchronous throw becomes a rejected promise so it maps like any other failure. */
function start(probe: ReadinessProbe): Promise<boolean> {
  try {
    return probe();
  } catch (error) {
    return Promise.reject(error);
  }
}

type ActiveCheck = { shared: Promise<HealthReadiness>; expired: boolean };

/**
 * Production readiness of spec 0012 (AC-4), owned by one route instance so its state never lives at module level.
 * Without a probe every call answers `unavailable` and never touches the marker. Otherwise at most one probe runs per
 * instance: the active check marker is set with no `await` in between, before the probe starts, and is released only
 * when the probe promise itself settles (success or failure), never at the deadline. A caller that finds an active
 * check never starts a new probe: before that check reached its deadline it gets the shared result of that check, and
 * after the deadline, while the probe is still pending (a stalled connection or a frozen database), it gets
 * `unavailable` at once. The shared result is the race between the probe and the deadline timer; only `true` maps to
 * `ready`. A late probe result is consumed and dropped without a log or an unhandled rejection, the timer is cleared
 * on every path, and the returned promise never rejects.
 */
export function createHealthReadiness(probe?: ReadinessProbe, { deadlineMs = READINESS_DEADLINE_MS }: HealthReadinessOptions = {}): () => Promise<HealthReadiness> {
  let active: ActiveCheck | undefined;
  return () => {
    if (!probe) return Promise.resolve('unavailable');
    if (active) return active.expired ? Promise.resolve('unavailable') : active.shared;
    const query = start(probe);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check: ActiveCheck = { shared: Promise.resolve('unavailable'), expired: false };
    const deadline = new Promise<HealthReadiness>((resolve) => {
      timer = setTimeout(() => {
        check.expired = true;
        resolve('unavailable');
      }, deadlineMs);
    });
    const mapped = query.then((applied): HealthReadiness => (applied === true ? 'ready' : 'unavailable'), (): HealthReadiness => 'unavailable');
    check.shared = Promise.race([mapped, deadline]).then((outcome) => {
      clearTimeout(timer);
      return outcome;
    });
    active = check;
    const release = () => {
      if (active === check) active = undefined;
    };
    query.then(release, release);
    return check.shared;
  };
}

// Verification slots of spec 0014 (AC-6, table *Kebijakan*): per auth plugin instance, and so per backend process, at
// most `running` sign ins hold a slot at once, at most `queue` more wait for one in arrival order, and each waits at most
// `waitMs`. A sign in that finds the queue full, or whose wait runs out, gets no slot and answers 503. The limits are the
// constants of auth.policy.ts unless a test gives the `auth.slots` option of createApp.

export interface SlotLimits {
  readonly running: number;
  readonly queue: number;
  readonly waitMs: number;
}

/** Gives the slot back; calling it again does nothing, so a slot is never returned twice. */
export type ReleaseSlot = () => void;

/**
 * The slot gate of one plugin instance. The returned function resolves with the release of a slot, or with `null` when
 * the queue is full or the wait ran out. A released slot goes straight to the oldest waiting sign in, so the number of
 * running slots never passes `running`.
 */
export function createVerifySlots(limits: SlotLimits): () => Promise<ReleaseSlot | null> {
  let running = 0;
  const waiting: ((release: ReleaseSlot) => void)[] = [];

  const handOver = (): void => {
    const next = waiting.shift();
    if (next === undefined) running -= 1;
    else next(slot());
  };

  const slot = (): ReleaseSlot => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      handOver();
    };
  };

  return () => {
    if (running < limits.running) {
      running += 1;
      return Promise.resolve(slot());
    }
    if (waiting.length >= limits.queue) return Promise.resolve(null);
    return new Promise<ReleaseSlot | null>((resolve) => {
      const grant = (release: ReleaseSlot) => {
        clearTimeout(timer);
        resolve(release);
      };
      const timer = setTimeout(() => {
        const index = waiting.indexOf(grant);
        if (index !== -1) waiting.splice(index, 1);
        resolve(null);
      }, limits.waitMs);
      waiting.push(grant);
    });
  };
}

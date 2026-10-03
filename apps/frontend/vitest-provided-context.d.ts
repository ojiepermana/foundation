import type {} from 'vitest';

// Values that `vitest-backend.setup.ts` gives every Vitest project through `project.provide`, read in tests with
// `inject` from `vitest` (spec 0009, AC-4). Kept outside `src/` so the application program never includes it.
declare module 'vitest' {
  export interface ProvidedContext {
    /** `http://127.0.0.1:<port>` of the real backend started once for the whole run. */
    sdkContractBackendUrl: string;
    /** `http://127.0.0.1:<port>` of a loopback port the harness opened and closed, for network failures. */
    sdkContractClosedUrl: string;
  }
}

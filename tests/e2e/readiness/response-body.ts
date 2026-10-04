import { expect, type Page } from '@playwright/test';

// Shared body reader of /api/readiness responses for READY-006 and READY-009. Not a test file: the Playwright
// configurations only discover *.e2e.spec.ts.
//
// Why the body is read inside the page and not with Playwright's response.json(): response.json() asks Chromium
// DevTools for the body (Network.getResponseBody). Chromium sometimes reports a fetch as failed with net::ERR_ABORTED
// right after the page has read the whole body, and DevTools then keeps no body, so response.json() fails with
// "No data found for resource with given identifier". Probes on 2026-10-04 (Playwright 1.63.0, Chromium 153) showed
// the page never aborts that request: its AbortSignal stays untouched, the SDK reads all 63 bytes to the end, and the
// page shows exactly that checkedAt. So the race is in the browser, not in the application. A clone read inside the
// page proves the exact bytes the SDK received, through the same browser request, proxy, and backend.

const recordName = '__foundationReadinessBodies';

type BodyRecord = { text: string } | { error: string };

/**
 * Before the application starts, wraps `window.fetch` so every /api/readiness response the page receives is cloned
 * and its text recorded in order. The request itself is unchanged and the application still reads its own body. Call
 * it before the first `page.goto`; the record starts empty on every document load.
 */
export async function recordReadinessBodies(page: Page): Promise<void> {
  await page.addInitScript((name) => {
    const records: BodyRecord[] = [];
    Object.defineProperty(window, name, { value: records });
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      if (new URL(response.url).pathname === '/api/readiness') {
        response.clone().text().then(
          (text) => records.push({ text }),
          (error: unknown) => records.push({ error: String(error) }),
        );
      }
      return response;
    };
  }, recordName);
}

/**
 * The parsed JSON body of the readiness response number `index` (0 based, in arrival order since the document
 * loaded), exactly as the page received it. Waits until the page has read it; a body the page could not read fails.
 */
export async function readinessBodyAt(page: Page, index: number): Promise<unknown> {
  const read = () =>
    page.evaluate(
      ([name, position]) => (window as unknown as Record<string, BodyRecord[] | undefined>)[name]?.[position],
      [recordName, index] as const,
    );
  await expect.poll(async () => (await read()) !== undefined, { message: `the page read readiness response ${index}` }).toBe(true);
  const record = await read();
  if (record === undefined) throw new Error(`The page has no readiness response ${index}`);
  if ('error' in record) throw new Error(`The page could not read readiness response ${index}: ${record.error}`);
  return JSON.parse(record.text) as unknown;
}

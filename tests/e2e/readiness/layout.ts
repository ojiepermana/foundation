import { expect, type Page } from '@playwright/test';

// Shared layout check of the readiness page for READY-006 and READY-009 (spec 0006, AC-8). Not a test file: the
// Playwright configurations only discover *.e2e.spec.ts.

/**
 * No horizontal page overflow, and the status, every dt and dd, the time, and the button are neither clipped nor
 * outside the viewport (`scrollWidth <= clientWidth` and a box inside the viewport). `expectedTargets` names the
 * elements the current state must show, in order, so a missing or extra element fails too.
 */
export async function expectNothingClipped(page: Page, expectedTargets: string[]): Promise<void> {
  // Measure the settled page, after the wrapper's route progress bar of a lazy navigation is gone (as UI-001 does).
  await expect(page.getByRole('progressbar', { name: 'Loading page' })).toBeHidden();
  const report = await page.evaluate(() => {
    const pageOverflow = document.documentElement.scrollWidth > window.innerWidth;
    // The library wrapper marks its content region with role="main" on a custom host, not a <main> element.
    const mains = document.querySelectorAll('[role="main"], main');
    if (mains.length !== 1) return { pageOverflow, checked: [], problems: [`${mains.length} main regions`] };
    const main = mains[0]!;
    const targets: [string, Element | null][] = [
      ['status', main.querySelector('[role="status"]')],
      ...[...main.querySelectorAll('dt')].map((element, index): [string, Element] => [`dt ${index}`, element]),
      ...[...main.querySelectorAll('dd')].map((element, index): [string, Element] => [`dd ${index}`, element]),
      ['time', main.querySelector('time')],
      ['button', main.querySelector('button')],
    ];
    const width = document.documentElement.clientWidth;
    const height = window.innerHeight;
    const problems: string[] = [];
    for (const [name, element] of targets) {
      if (!element) {
        problems.push(`${name} is missing`);
        continue;
      }
      const box = element.getBoundingClientRect();
      if (element.scrollWidth > element.clientWidth) problems.push(`${name} is clipped`);
      if (box.width === 0 || box.height === 0) problems.push(`${name} has no box`);
      if (box.left < 0 || box.top < 0 || box.right > width || box.bottom > height) problems.push(`${name} is outside the viewport`);
    }
    return { pageOverflow, checked: targets.map(([name]) => name), problems };
  });
  expect(report.problems).toEqual([]);
  expect(report.checked).toEqual(expectedTargets);
  expect(report.pageOverflow).toBe(false);
}

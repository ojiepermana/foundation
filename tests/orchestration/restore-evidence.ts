// The decision of `bun run test:database:real` on .local/feature-14/restore.json (spec 0013, *Perubahan
// database-real.ts*), apart from tests/orchestration/database-real.ts so a test can import it: that script runs at once
// when imported. GATE-008 in tests/integration/gate/tier.test.ts checks every branch.

/**
 * The restore evidence passed only when it is a JSON object whose `status` is `passed` and whose `secretScan.findings`
 * is an empty array; unreadable JSON or another shape never passes.
 */
export function restorePassed(data: Uint8Array): boolean {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return false;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  const scan = object['secretScan'];
  if (typeof scan !== 'object' || scan === null) return false;
  const findings = (scan as Record<string, unknown>)['findings'];
  return object['status'] === 'passed' && Array.isArray(findings) && findings.length === 0;
}

/**
 * The failure message for the restore evidence `data` read after bun test (`undefined` when the file is missing or not
 * a regular file): `Restore evidence missing`, `Restore evidence not passed`, or `undefined` when it passed.
 */
export function restoreEvidenceFailure(data: Uint8Array | undefined): string | undefined {
  if (data === undefined) return 'Restore evidence missing';
  return restorePassed(data) ? undefined : 'Restore evidence not passed';
}

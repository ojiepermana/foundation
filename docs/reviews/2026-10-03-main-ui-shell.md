# Review, main, 2026-10-03

**Reviewed by**: GPT-6 Astra (author on GPT-6 Codex; exact author variant unavailable)
**Scope**: 23 files, uncommitted
**Verdict**: Changes requested

## Summary

Scope 7 integrates the public default layout wrapper with a small routed page and meaningful browser coverage for responsive navigation and keyboard focus. The changed application code follows spec 0007 and contains no observed API calls, server imports, or credentials. The new security gate has an import-detection gap and no negative fixtures proving its rejection behavior; fix that before relying on it as the AC-5 guard in CI.

## Major

### 🟠 Cover valid import forms and prove security-gate rejection, `scripts/check-frontend-bundle.ts:34`

**Problem**: The import regex only captures `from`, `import(...)`, and `require(...)`; it does not capture valid side-effect imports such as `import '../../../../../libs/server/runtime';`. The specifier predicate at lines 6–12 also accepts bare Node/Bun imports such as `fs/promises` and `bun`. I evaluated the actual regex from this file against those strings: the side-effect import produced no capture, while the bare runtime names were captured but do not match any forbidden condition. The registry only runs this scanner against the currently clean application; no test exercises any of the new rejection/error branches, including the production credential scan.

**Why it matters**: `test:ci` now presents this command as the browser/server boundary check, and the evidence report uses its success to support AC-5. A side-effect import of browser-compilable code under `libs/server` can pass both the frontend build and this gate even though the stated boundary is violated. This is a guard correctness and security-test gap, not evidence that the current shell already leaks data.

**Suggested fix**: Extract import specifiers with the installed TypeScript parser, or otherwise handle static side-effect imports as well as the existing forms, and reject the supported bare runtime-module names alongside their prefixed forms. Add isolated fixture tests that execute the actual checker and assert nonzero exit for forbidden imports, database URLs, private-key text, and configured secret values, plus a clean fixture that passes. Keep fixture credentials synthetic and assert that failure output does not print them. Wire those tests into the applicable test gate and registry, and describe the scanner's actual coverage limits in the evidence report.

## Strengths

- Shell composition stays small and uses public library entry points instead of copying header/sidebar/drawer implementation; the root route remains an ordinary feature component.
- UI-001 checks meaningful user behavior: skip-link focus, wildcard redirect focus, mobile keyboard opening, Escape and close-button dismissal, link selection, focus restoration, and the two specified viewport sizes.
- The report distinguishes database-independent browser proof from the unsuccessful local doctor prerequisite and does not claim a production release.

## Test coverage

Reviewed the changed assertions, scenario registry, stored JUnit XML, and both stored screenshots. Frontend evidence contains one passing routed-page test; Playwright evidence contains four passing tests with no failures or skips. These cover the scoped shell and the retained application regression, while the new scanner's negative paths have no tests. I did not rerun the full suite or mutate application fixtures during this read-only review. The one inline Bun probe used the scanner's actual regex and reproduced the missed side-effect-import form; it made no filesystem changes. The 654.09 kB initial-bundle warning is already documented and is not a new blocking finding here.

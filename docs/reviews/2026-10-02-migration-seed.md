# Review, main, 2026-10-02

**Reviewed by**: GPT-6 Sol (author on GPT-6 Astra)
**Scope**: 13 files, uncommitted
**Verdict**: Changes requested

## Summary

The change adds explicit migration and seed commands with ordered SQL discovery, checksum history, one transaction, role switching, and shared advisory locks. The database integration tests exercise the principal success, rollback, contention, and credential paths. The SQL scanner leaves a PostgreSQL session authorization form outside its forbidden statement check, so the one statement policy is incomplete.

## Major

### 🟠 Reject the `SET LOCAL SESSION AUTHORIZATION` form, `database/runner.ts:91`

**Problem**: The scanner rejects `SET SESSION AUTHORIZATION` and `SET LOCAL ROLE`, but it does not reject `SET LOCAL SESSION AUTHORIZATION ...`. PostgreSQL accepts the optional `LOCAL` token before `SESSION AUTHORIZATION`, so this statement passes discovery and reaches `tx.unsafe` as a migration or seed. The current tests exercise only `COMMIT` among forbidden statements.

**Why it matters**: Spec 0005 explicitly requires session authorization changes to be rejected before execution. Allowing one form weakens the runner's statement boundary and can change the active identity during the owner transaction, leading to behavior determined by PostgreSQL permissions instead of the runner's policy.

**Suggested fix**: Parse the complete leading `SET`/`RESET` control forms, including optional `LOCAL` and `SESSION`, and reject every role or session authorization variant before opening the transaction. Add focused cases for accepted quoted semicolons and rejected control variants so the scanner's branches have behavioral coverage.

## Strengths

- SQL bytes are read from a no-follow file handle once, then used for both the checksum and the executed statement.
- Migration history is checked after both advisory locks, and SQL plus its history row are committed in one transaction.

## Test coverage

The five PostgreSQL integration scenarios cover baseline and rerun, drift and malformed files, rollback, concurrent invocation and lock timeout, and repeatable seed behavior. The reported isolated PostgreSQL 18 result is 5 tests and 51 assertions passing; this review did not rerun the suite. Control-statement coverage should include the optional PostgreSQL syntax noted above.

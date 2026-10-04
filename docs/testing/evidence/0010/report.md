# Laporan gate CI

Laporan ini dihitung ulang oleh `bun run test:report` dari bundle bukti setiap tier. Hanya status `passed` dihitung lulus.

## Kandidat

| Aspek | Nilai |
| --- | --- |
| Status gate | passed |
| Commit | 7f7d7c499ac6b8ce1c717b0e77c667adf08873ba |
| Pohon sumber | 8380f7c5cdf48877b66b15bec32668fb3e553d1f4080b61fdc23c09be0e496af |
| Run CI job laporan | run lokal tanpa identitas CI |
| Dibuat | 2026-10-04T13:14:03.032Z |

Kandidat release: bukan (`not_clean` fast, `not_clean` real, `not_clean` security, `not_ci` fast, `not_ci` real, `not_ci` security, `not_ci`)

## Pengikatan

Pengikatan sah.

## Tier

| Tier | Status | Langkah passed | Run attempt | Environment |
| --- | --- | --- | --- | --- |
| fast | passed | 17 dari 17 | - | darwin arm64, Bun 1.4.2, Node 24.21.0 |
| real | passed | 5 dari 5 | - | darwin arm64, Bun 1.4.2, Node 24.21.0 |
| security | passed | 1 dari 1 | - | darwin arm64, Bun 1.4.2, Node 24.21.0 |

### Langkah tier fast

| Langkah | Status | Durasi | Alasan |
| --- | --- | --- | --- |
| check:dependencies | passed | 0.1 detik | - |
| test:scenarios | passed | 0.2 detik | - |
| check:test-discovery | passed | 1.2 detik | - |
| check:workflow | passed | 0.0 detik | - |
| api:check | passed | 1.2 detik | - |
| build:frontend | passed | 1.7 detik | - |
| check:frontend:bundle | passed | 0.1 detik | - |
| typecheck:backend | passed | 0.7 detik | - |
| typecheck:contract | passed | 1.3 detik | - |
| typecheck:e2e | passed | 0.7 detik | - |
| typecheck:tooling | passed | 1.1 detik | - |
| build:backend | passed | 0.0 detik | - |
| test:frontend | passed | 2.7 detik | - |
| test:integration | passed | 77.1 detik | - |
| test:tooling | passed | 33.3 detik | - |
| test:gate | passed | 43.1 detik | - |
| test:e2e | passed | 10.6 detik | - |

### Langkah tier real

| Langkah | Status | Durasi | Alasan |
| --- | --- | --- | --- |
| test:infrastructure | passed | 51.1 detik | - |
| test:database:real | passed | 41.7 detik | - |
| test:database:migration | passed | 16.8 detik | - |
| test:tooling:real | passed | 24.0 detik | - |
| test:readiness:real | passed | 5.7 detik | - |

### Langkah tier security

| Langkah | Status | Durasi | Alasan |
| --- | --- | --- | --- |
| check:security | passed | 9.3 detik | - |

### Checksum input per tier

| Path | fast | real | security |
| --- | --- | --- | --- |
| .github/workflows/application.yml | edda79e565b79b9a5d204e9aaf57df86d3eae11adb723f0bb31796e3eb0fe164 | edda79e565b79b9a5d204e9aaf57df86d3eae11adb723f0bb31796e3eb0fe164 | edda79e565b79b9a5d204e9aaf57df86d3eae11adb723f0bb31796e3eb0fe164 |
| apps/frontend/sdk/ | b7fde5e16f8c7b653b6b76cdb9d6e508017b02b44e237839bfdab38615b0a96e | b7fde5e16f8c7b653b6b76cdb9d6e508017b02b44e237839bfdab38615b0a96e | b7fde5e16f8c7b653b6b76cdb9d6e508017b02b44e237839bfdab38615b0a96e |
| bun.lock | e74e16b34cde3c1a76d17328f5da63da16614409318218231e320d0a2e1fcc3f | e74e16b34cde3c1a76d17328f5da63da16614409318218231e320d0a2e1fcc3f | e74e16b34cde3c1a76d17328f5da63da16614409318218231e320d0a2e1fcc3f |
| infrastructure/postgres/pins.json | 63fe647f7df56c5e94a0e5cb6483d845eeea548dcfdbe991c50e95c234f438c4 | 63fe647f7df56c5e94a0e5cb6483d845eeea548dcfdbe991c50e95c234f438c4 | 63fe647f7df56c5e94a0e5cb6483d845eeea548dcfdbe991c50e95c234f438c4 |
| openapi.json | e583aa33ea689908d8188f5b1338a441475c9a434e97589e0b47366da95f0c00 | e583aa33ea689908d8188f5b1338a441475c9a434e97589e0b47366da95f0c00 | e583aa33ea689908d8188f5b1338a441475c9a434e97589e0b47366da95f0c00 |
| package.json | ed2191944ee9e978161a60ff65d9560aaea931ae42c67dba331e1455c4a04bd1 | ed2191944ee9e978161a60ff65d9560aaea931ae42c67dba331e1455c4a04bd1 | ed2191944ee9e978161a60ff65d9560aaea931ae42c67dba331e1455c4a04bd1 |
| tests/scenarios/ | a3546e775232a4cf91f9f3077a6417d95edefa9944928121ed3335d37242f0d3 | a3546e775232a4cf91f9f3077a6417d95edefa9944928121ed3335d37242f0d3 | a3546e775232a4cf91f9f3077a6417d95edefa9944928121ed3335d37242f0d3 |
| tests/security/actionlint.yaml | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| tests/security/exceptions.json | 0c1de1a21eb6b25b59576015d5fa5c9fbb2fd081a192ac0c221c37f5e562271f | 0c1de1a21eb6b25b59576015d5fa5c9fbb2fd081a192ac0c221c37f5e562271f | 0c1de1a21eb6b25b59576015d5fa5c9fbb2fd081a192ac0c221c37f5e562271f |
| tests/security/gitleaks.toml | b2218eefd2c12a1a2f23d36735ac4aaae6965d917965a8ed5881d0a4e8669376 | b2218eefd2c12a1a2f23d36735ac4aaae6965d917965a8ed5881d0a4e8669376 | b2218eefd2c12a1a2f23d36735ac4aaae6965d917965a8ed5881d0a4e8669376 |
| tests/security/scanners.json | 311f56a9f4cfc6e801069ac407fec4c37b55c2988f5ed7dc92248c17db243581 | 311f56a9f4cfc6e801069ac407fec4c37b55c2988f5ed7dc92248c17db243581 | 311f56a9f4cfc6e801069ac407fec4c37b55c2988f5ed7dc92248c17db243581 |

### Checksum output per tier

| Path | fast | real | security |
| --- | --- | --- | --- |
| apps/frontend/dist/frontend/ | 747ea3fc972f80b102cefab6fd0184c279add2edd2764e4c5f8b301c395b0683 | 747ea3fc972f80b102cefab6fd0184c279add2edd2764e4c5f8b301c395b0683 | 747ea3fc972f80b102cefab6fd0184c279add2edd2764e4c5f8b301c395b0683 |
| dist/backend/index.js | 7f0d92c719ae41ec6ba4b8f928626d84ed65731384c022fba224cfbdf1b7ec40 | 7f0d92c719ae41ec6ba4b8f928626d84ed65731384c022fba224cfbdf1b7ec40 | 7f0d92c719ae41ec6ba4b8f928626d84ed65731384c022fba224cfbdf1b7ec40 |

## Identitas PostgreSQL

Ini image yang diuji tier nyata, bukan image deployment (fitur 13).

| Field | Nilai |
| --- | --- |
| image | foundation-postgres:18-pinned |
| imageId | sha256:b0b3e353be9a411b11442142438e1e12491b824d6b6407a3fcf3f353d1e3cc29 |
| os | linux |
| architecture | arm64 |
| baseImage | oraclelinux:10-slim@sha256:0660af1f1bb56559b299d99d3b71d0ff51f9d593cecbd3154a46914704ec34d6 |
| baseIndexDigest | sha256:0660af1f1bb56559b299d99d3b71d0ff51f9d593cecbd3154a46914704ec34d6 |
| serverVersion | 18.6 |
| packageVersion | 18.6-4PGDG.rhel10.2 |
| Bukti | .local/feature-11/evidence/real/.local/feature-3/image.json |

## Pemindai

Status passed, dipindai 2026-10-04T13:13:46.308Z.

Working tree tidak bersih saat pemindaian: perubahan yang belum masuk commit tidak dipindai gitleaks.

| Pemindai | Versi | Image | Status | Alasan | Cakupan | Gagal | Dikecualikan | Dilaporkan |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gitleaks | v8.30.1 | ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f | passed | - | head 7f7d7c499ac6b8ce1c717b0e77c667adf08873ba, commit terjangkau 37, dangkal false | 0 | 0 | 0 |
| bun audit | 1.4.2 | - | passed | - | paket bun.lock: 487 | 0 | 0 | 0 |
| actionlint | 1.7.12 | rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 | passed | - | file: .github/workflows/application.yml | 0 | 0 | 0 |

Hasil pemindai hanya membuktikan cakupan pemindai itu; tidak ditemukannya masalah bukan bukti aplikasi aman.

## Discovery

Status discovery: passed.

## Alur kritis

| ID | Status |
| --- | --- |
| APP-002 | passed |
| READY-006 | passed |
| READY-009 | passed |
| UI-001 | passed |

## Hasil per skenario

67 skenario: 0 failed, 0 missing_test, 0 not_run, 0 skipped, 67 passed.

| ID | Kriteria dan rujukan specs | Test dan profil | Wajib untuk release | Status | Hasil aktual dan tautan bukti |
| --- | --- | --- | --- | --- | --- |
| APP-001 | AC-1, AC-2, AC-3; docs/specs/0001-struktur-aplikasi-dependency/index.md | command check:dependencies package.json; command build:frontend package.json; command typecheck:backend package.json; command build:backend package.json; profil k6 tidak ada | ya | passed | exit code 0, passed; exit code 0, passed; exit code 0, passed; exit code 0, passed |
| APP-002 | AC-2, AC-4; docs/specs/0001-struktur-aplikasi-dependency/index.md | vitest test:frontend apps/frontend/src/app/app.spec.ts APP-002; bun:test test:integration tests/integration/backend/application.test.ts APP-002; playwright test:e2e tests/e2e/application/framework.e2e.spec.ts APP-002; profil k6 tidak ada | ya, alur kritis | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/frontend.xml; 5 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/playwright.xml |
| APP-003 | AC-3, AC-5; docs/specs/0001-struktur-aplikasi-dependency/index.md | bun:test test:integration tests/integration/backend/application.test.ts APP-003; bun:test test:integration tests/integration/contract/openapi.test.ts APP-003; command api:check package.json; profil k6 tidak ada | ya | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; 48 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; exit code 0, passed |
| APP-004 | AC-4, AC-6; docs/specs/0001-struktur-aplikasi-dependency/index.md | bun:test test:integration tests/integration/backend/application.test.ts APP-004; profil k6 tidak ada | ya | passed | 14 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| GATE-001 | AC-1; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/discovery.test.ts GATE-001; command check:test-discovery scripts/check-test-discovery.ts; profil k6 tidak ada | ya | passed | 15 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml; exit code 0, passed |
| GATE-002 | AC-2; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/registry.test.ts GATE-002; command test:scenarios scripts/validate-scenarios.ts; profil k6 tidak ada | ya | passed | 8 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml; exit code 0, passed |
| GATE-003 | AC-3, AC-8, AC-9; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/workflow.test.ts GATE-003; command check:workflow scripts/check-workflow.ts; profil k6 tidak ada | ya | passed | 81 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml; exit code 0, passed |
| GATE-004 | AC-4, AC-8; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/tier.test.ts GATE-004; profil k6 tidak ada | ya | passed | 26 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml |
| GATE-005 | AC-6; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/report.test.ts GATE-005; profil k6 tidak ada | ya | passed | 17 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml |
| GATE-006 | AC-7; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/report.test.ts GATE-006; profil k6 tidak ada | ya | passed | 14 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml |
| GATE-007 | AC-5, AC-8; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/security-policy.test.ts GATE-007; command check:security tests/orchestration/security-scan.ts; profil k6 tidak ada | ya | passed | 21 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml; exit code 0, passed |
| GATE-008 | AC-4; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/tier.test.ts GATE-008; command test:ci:real scripts/gate.ts; profil k6 tidak ada | ya | passed | 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml; passed |
| GATE-009 | AC-4, AC-8; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/signal-cleanup.test.ts GATE-009; profil k6 tidak ada | ya | passed | 10 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml |
| DATA-001 | AC-1, AC-2, AC-3, AC-4, AC-5; docs/specs/0004-model-data-akses-database/index.md | bun:test test:database:real tests/integration/database/provision.test.ts DATA-001; profil k6 tidak ada | ya | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| DATA-002 | AC-1, AC-2, AC-5; docs/specs/0004-model-data-akses-database/index.md | bun:test test:database:real tests/integration/database/provision.test.ts DATA-002; profil k6 tidak ada | ya | passed | 5 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| DATA-003 | AC-3, AC-4, AC-7; docs/specs/0004-model-data-akses-database/index.md | bun:test test:database:real tests/integration/database/provision.test.ts DATA-003; profil k6 tidak ada | ya | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| DATA-004 | AC-5; docs/specs/0004-model-data-akses-database/index.md | bun:test test:database:real tests/integration/database/provision.test.ts DATA-004; profil k6 tidak ada | ya | passed | 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| DATA-005 | AC-6, AC-7; docs/specs/0004-model-data-akses-database/index.md | bun:test test:database:real tests/integration/database/provision.test.ts DATA-005; profil k6 tidak ada | ya | passed | 3 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| TOOL-001 | AC-1, AC-2, AC-3; docs/specs/0003-doctor-serve-aplikasi-nyata/index.md | bun:test test:tooling tests/integration/tooling/development.test.ts TOOL-001; command test:tooling:real tests/integration/tooling-real/doctor-smoke.ts TOOL-001; profil k6 tidak ada | ya | passed | 4 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/tooling.xml; exit code 0, passed |
| TOOL-002 | AC-6; docs/specs/0003-doctor-serve-aplikasi-nyata/index.md | bun:test test:tooling tests/integration/tooling/development.test.ts TOOL-002; command test:tooling:real tests/integration/tooling-real/doctor-smoke.ts TOOL-002; profil k6 tidak ada | ya | passed | 7 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/tooling.xml; exit code 0, passed |
| TOOL-003 | AC-5; docs/specs/0003-doctor-serve-aplikasi-nyata/index.md | bun:test test:tooling tests/integration/tooling/development.test.ts TOOL-003; profil k6 tidak ada | ya | passed | 10 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/tooling.xml |
| TOOL-004 | AC-8; docs/specs/0003-doctor-serve-aplikasi-nyata/index.md | bun:test test:tooling tests/integration/tooling/development.test.ts TOOL-004; command test:tooling:real tests/integration/tooling-real/doctor-smoke.ts TOOL-004; profil k6 tidak ada | ya | passed | 4 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/tooling.xml; exit code 0, passed |
| TOOL-005 | AC-6, AC-7; docs/specs/0003-doctor-serve-aplikasi-nyata/index.md | bun:test test:tooling tests/integration/tooling/development.test.ts TOOL-005; command test:tooling:real tests/integration/tooling-real/doctor-smoke.ts TOOL-005; profil k6 tidak ada | ya | passed | 16 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/tooling.xml; exit code 0, passed |
| TOOL-006 | AC-4, AC-8; docs/specs/0003-doctor-serve-aplikasi-nyata/index.md | bun:test test:tooling tests/integration/tooling/development.test.ts TOOL-006; profil k6 tidak ada | ya | passed | 10 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/tooling.xml |
| TOOL-007 | AC-1, AC-2, AC-3, AC-4, AC-9; docs/specs/0003-doctor-serve-aplikasi-nyata/index.md | command test:tooling:real tests/integration/tooling-real/doctor-smoke.ts; playwright test:tooling:real tests/e2e/readiness/readiness.real.e2e.spec.ts READY-009; profil k6 tidak ada | ya | passed | exit code 0, passed; 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-2/playwright-real.xml |
| TOOL-008 | AC-3, AC-5; docs/specs/0003-doctor-serve-aplikasi-nyata/index.md | bun:test test:tooling tests/integration/tooling/development.test.ts TOOL-008; profil k6 tidak ada | ya | passed | 3 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/tooling.xml |
| INFRA-001 | AC-4, AC-6, AC-7, AC-9; docs/specs/0002-infrastruktur-postgresql-development/index.md | bun:test test:infrastructure tests/integration/infrastructure/postgres.test.ts INFRA-001; profil k6 tidak ada | ya | passed | 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-3/infrastructure.xml |
| INFRA-002 | AC-1, AC-2; docs/specs/0002-infrastruktur-postgresql-development/index.md | bun:test test:infrastructure tests/integration/infrastructure/postgres.test.ts INFRA-002; profil k6 tidak ada | ya | passed | 4 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-3/infrastructure.xml |
| INFRA-003 | AC-3, AC-4, AC-7; docs/specs/0002-infrastruktur-postgresql-development/index.md | bun:test test:infrastructure tests/integration/infrastructure/postgres.test.ts INFRA-003; profil k6 tidak ada | ya | passed | 4 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-3/infrastructure.xml |
| INFRA-004 | AC-5; docs/specs/0002-infrastruktur-postgresql-development/index.md | bun:test test:infrastructure tests/integration/infrastructure/postgres.test.ts INFRA-004; profil k6 tidak ada | ya | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-3/infrastructure.xml |
| INFRA-005 | AC-8; docs/specs/0002-infrastruktur-postgresql-development/index.md | bun:test test:infrastructure tests/integration/infrastructure/postgres.test.ts INFRA-005; profil k6 tidak ada | ya | passed | 3 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-3/infrastructure.xml |
| INFRA-006 | AC-3; docs/specs/0002-infrastruktur-postgresql-development/index.md | bun:test test:infrastructure tests/integration/infrastructure/postgres.test.ts INFRA-006; profil k6 tidak ada | ya | passed | 4 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-3/infrastructure.xml |
| MIG-001 | AC-1, AC-2, AC-3, AC-4, AC-7; docs/specs/0005-migration-seed-terpisah/index.md | bun:test test:database:migration tests/integration/database/migration.test.ts MIG-001; profil k6 tidak ada | ya | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-6/migration.xml |
| MIG-002 | AC-2, AC-3, AC-6, AC-7; docs/specs/0005-migration-seed-terpisah/index.md | bun:test test:database:migration tests/integration/database/migration.test.ts MIG-002; profil k6 tidak ada | ya | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-6/migration.xml |
| MIG-003 | AC-4, AC-7; docs/specs/0005-migration-seed-terpisah/index.md | bun:test test:database:migration tests/integration/database/migration.test.ts MIG-003; profil k6 tidak ada | ya | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-6/migration.xml |
| MIG-004 | AC-1, AC-4, AC-6, AC-7; docs/specs/0005-migration-seed-terpisah/index.md | bun:test test:database:migration tests/integration/database/migration.test.ts MIG-004; profil k6 tidak ada | ya | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-6/migration.xml |
| MIG-005 | AC-5, AC-6, AC-7; docs/specs/0005-migration-seed-terpisah/index.md | bun:test test:database:migration tests/integration/database/migration.test.ts MIG-005; profil k6 tidak ada | ya | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-6/migration.xml |
| OPENAPI-001 | AC-1, AC-2; docs/specs/0008-ekspor-pemeriksaan-kontrak-openapi/index.md | bun:test test:integration tests/integration/contract/openapi-contract.test.ts OPENAPI-001; command api:check package.json; profil k6 tidak ada | ya | passed | 12 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; exit code 0, passed |
| OPENAPI-002 | AC-3; docs/specs/0008-ekspor-pemeriksaan-kontrak-openapi/index.md | bun:test test:integration tests/integration/contract/openapi-contract.test.ts OPENAPI-002; profil k6 tidak ada | ya | passed | 155 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| OPENAPI-003 | AC-4; docs/specs/0008-ekspor-pemeriksaan-kontrak-openapi/index.md | bun:test test:integration tests/integration/contract/openapi-contract.test.ts OPENAPI-003; profil k6 tidak ada | ya | passed | 143 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| OPENAPI-004 | AC-5; docs/specs/0008-ekspor-pemeriksaan-kontrak-openapi/index.md | bun:test test:integration tests/integration/contract/openapi-contract.test.ts OPENAPI-004; profil k6 tidak ada | ya | passed | 51 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| OPENAPI-005 | AC-6; docs/specs/0008-ekspor-pemeriksaan-kontrak-openapi/index.md | bun:test test:integration tests/integration/contract/openapi-contract.test.ts OPENAPI-005; profil k6 tidak ada | ya | passed | 26 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| OPENAPI-006 | AC-7; docs/specs/0008-ekspor-pemeriksaan-kontrak-openapi/index.md | bun:test test:integration tests/integration/contract/openapi-contract.test.ts OPENAPI-006; profil k6 tidak ada | ya | passed | 11 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| OPENAPI-007 | AC-8; docs/specs/0008-ekspor-pemeriksaan-kontrak-openapi/index.md | bun:test test:integration tests/integration/contract/openapi-contract.test.ts OPENAPI-007; command check:dependencies package.json; profil k6 tidak ada | ya | passed | 6 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; exit code 0, passed |
| READY-001 | AC-1, AC-3, AC-4; docs/specs/0006-alur-pemeriksaan-kesiapan/index.md | bun:test test:integration tests/integration/backend/readiness.test.ts READY-001; profil k6 tidak ada | ya | passed | 12 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| READY-002 | AC-3, AC-4; docs/specs/0006-alur-pemeriksaan-kesiapan/index.md | bun:test test:integration tests/integration/backend/readiness.test.ts READY-002; profil k6 tidak ada | ya | passed | 14 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| READY-003 | AC-5; docs/specs/0006-alur-pemeriksaan-kesiapan/index.md | bun:test test:integration tests/integration/contract/readiness-contract.test.ts READY-003; command api:check scripts/check-api.ts; profil k6 tidak ada | ya | passed | 6 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; exit code 0, passed |
| READY-004 | AC-6; docs/specs/0006-alur-pemeriksaan-kesiapan/index.md | vitest test:frontend apps/frontend/src/app/features/readiness/readiness-api.integration.spec.ts READY-004; profil k6 tidak ada | ya | passed | 49 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/frontend.xml |
| READY-005 | AC-7, AC-8; docs/specs/0006-alur-pemeriksaan-kesiapan/index.md | vitest test:frontend apps/frontend/src/app/features/readiness/readiness-page.spec.ts READY-005; bun:test test:integration tests/integration/contract/readiness-contract.test.ts READY-005; profil k6 tidak ada | ya | passed | 23 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/frontend.xml; 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| READY-006 | AC-3, AC-7, AC-8; docs/specs/0006-alur-pemeriksaan-kesiapan/index.md | playwright test:e2e tests/e2e/readiness/readiness.e2e.spec.ts READY-006; profil k6 tidak ada | ya, alur kritis | passed | 6 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/playwright.xml |
| READY-007 | AC-9; docs/specs/0006-alur-pemeriksaan-kesiapan/index.md | playwright test:e2e tests/e2e/readiness/readiness-production.e2e.spec.ts READY-007; command check:frontend:bundle scripts/check-frontend-bundle.ts; profil k6 tidak ada | ya | passed | 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/playwright.xml; exit code 0, passed |
| READY-008 | AC-1, AC-2, AC-3, AC-4, AC-10; docs/specs/0006-alur-pemeriksaan-kesiapan/index.md | bun:test test:database:real tests/integration/database/readiness.test.ts READY-008; profil k6 tidak ada | ya | passed | 12 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| READY-009 | AC-2, AC-7, AC-8, AC-10; docs/specs/0006-alur-pemeriksaan-kesiapan/index.md | playwright test:readiness:real tests/e2e/readiness/readiness.real.e2e.spec.ts READY-009; profil k6 tidak ada | ya, alur kritis | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-10/playwright-real.xml |
| READY-010 | AC-10; docs/specs/0006-alur-pemeriksaan-kesiapan/index.md | bun:test test:integration tests/integration/contract/readiness-container.test.ts READY-010; profil k6 tidak ada | ya | passed | 9 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| SDK-001 | AC-1; docs/specs/0009-sdk-sesuai-kontrak-backend/index.md | bun:test test:integration tests/integration/contract/sdk.test.ts SDK-001; bun:test test:integration tests/integration/contract/openapi.test.ts APP-003; profil k6 tidak ada | ya | passed | 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; 48 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| SDK-002 | AC-2; docs/specs/0009-sdk-sesuai-kontrak-backend/index.md | bun:test test:integration tests/integration/contract/sdk.test.ts SDK-002; command build:frontend package.json; profil k6 tidak ada | ya | passed | 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; exit code 0, passed |
| SDK-003 | AC-3; docs/specs/0009-sdk-sesuai-kontrak-backend/index.md | bun:test test:integration tests/integration/contract/frontend-bundle.test.ts SDK-003; command check:frontend:bundle scripts/check-frontend-bundle.ts; profil k6 tidak ada | ya | passed | 49 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; exit code 0, passed |
| SDK-004 | AC-4; docs/specs/0009-sdk-sesuai-kontrak-backend/index.md | vitest test:frontend apps/frontend/src/app/sdk-contract.integration.spec.ts SDK-004; bun:test test:integration tests/integration/contract/sdk.test.ts SDK-004; profil k6 tidak ada | ya | passed | 6 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/frontend.xml; 11 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| SDK-005 | AC-5; docs/specs/0009-sdk-sesuai-kontrak-backend/index.md | bun:test test:integration tests/integration/contract/sdk.test.ts SDK-005; profil k6 tidak ada | ya | passed | 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| SDK-006 | AC-6; docs/specs/0009-sdk-sesuai-kontrak-backend/index.md | bun:test test:integration tests/integration/contract/sdk.test.ts SDK-006; bun:test test:integration tests/integration/contract/openapi.test.ts APP-003; command api:check scripts/check-api.ts; profil k6 tidak ada | ya | passed | 14 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; 48 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; exit code 0, passed |
| SDK-007 | AC-7; docs/specs/0009-sdk-sesuai-kontrak-backend/index.md | bun:test test:integration tests/integration/contract/sdk.test.ts SDK-007; command api:check scripts/check-api.ts; profil k6 tidak ada | ya | passed | 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; exit code 0, passed |
| SDK-008 | AC-8; docs/specs/0009-sdk-sesuai-kontrak-backend/index.md | bun:test test:integration tests/integration/contract/sdk.test.ts SDK-008; command test:ci .github/workflows/application.yml; profil k6 tidak ada | ya | passed | 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; passed |
| SDK-009 | AC-9; docs/specs/0009-sdk-sesuai-kontrak-backend/index.md | bun:test test:integration tests/integration/contract/sdk.test.ts SDK-009; command check:dependencies package.json; profil k6 tidak ada | ya | passed | 7 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; exit code 0, passed |
| SDK-010 | AC-10; docs/specs/0009-sdk-sesuai-kontrak-backend/index.md | bun:test test:integration tests/integration/contract/sdk.test.ts SDK-010; profil k6 tidak ada | ya | passed | 12 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| UI-001 | AC-1, AC-2, AC-3, AC-4, AC-6; docs/specs/0007-kerangka-ui-navigasi/index.md | playwright test:e2e tests/e2e/ui-shell/foundation-shell.e2e.spec.ts UI-001; profil k6 tidak ada | ya, alur kritis | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/playwright.xml |
| UI-002 | AC-5; docs/specs/0007-kerangka-ui-navigasi/index.md | playwright test:e2e tests/e2e/ui-shell/foundation-shell.e2e.spec.ts UI-002; command check:frontend:bundle scripts/check-frontend-bundle.ts; profil k6 tidak ada | ya | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/playwright.xml; exit code 0, passed |
| UI-003 | AC-5; docs/specs/0007-kerangka-ui-navigasi/index.md | bun:test test:integration tests/integration/contract/frontend-bundle.test.ts UI-003; profil k6 tidak ada | ya | passed | 13 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |

## Kandidat release

Kandidat release: bukan (`not_clean` fast, `not_clean` real, `not_clean` security, `not_ci` fast, `not_ci` real, `not_ci` security, `not_ci`)

- `not_clean` tier fast: working tree tier tidak bersih di awal atau di akhir tier.
- `not_clean` tier real: working tree tier tidak bersih di awal atau di akhir tier.
- `not_clean` tier security: working tree tier tidak bersih di awal atau di akhir tier.
- `not_ci` tier fast: tidak berasal dari run CI.
- `not_ci` tier real: tidak berasal dari run CI.
- `not_ci` tier security: tidak berasal dari run CI.
- `not_ci`: tidak berasal dari run CI.

Tanda ini tidak mengubah status gate maupun exit code `test:report`.

## Di luar cakupan

- Performance k6 belum masuk gate (fitur 12).
- Identitas image deployment belum diikat pada laporan (fitur 13).

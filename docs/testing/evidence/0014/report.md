# Laporan gate CI

Laporan ini dihitung ulang oleh `bun run test:report` dari bundle bukti setiap tier. Hanya status `passed` dihitung lulus.

## Kandidat

| Aspek | Nilai |
| --- | --- |
| Status gate | passed |
| Commit | 4aa511abb738b43b06276091f18937aca10eedbd |
| Pohon sumber | 4cfa7461363c455bb3a2e2f67c2a6a18be5f8347e3cb9ffb662dda392027b480 |
| Run CI job laporan | run lokal tanpa identitas CI |
| Dibuat | 2026-10-06T12:30:24.965Z |

Kandidat release: bukan (`not_clean` fast, `not_clean` real, `not_clean` security, `not_ci` fast, `not_ci` real, `not_ci` security, `not_ci`)

## Pengikatan

Pengikatan sah.

## Tier

| Tier | Status | Langkah passed | Run attempt | Environment |
| --- | --- | --- | --- | --- |
| fast | passed | 19 dari 19 | - | darwin arm64, Bun 1.4.2, Node 24.21.0 |
| real | passed | 7 dari 7 | - | darwin arm64, Bun 1.4.2, Node 24.21.0 |
| security | passed | 1 dari 1 | - | darwin arm64, Bun 1.4.2, Node 24.21.0 |

### Langkah tier fast

| Langkah | Status | Durasi | Alasan |
| --- | --- | --- | --- |
| check:dependencies | passed | 0.1 detik | - |
| test:scenarios | passed | 0.3 detik | - |
| check:test-discovery | passed | 1.6 detik | - |
| check:workflow | passed | 0.0 detik | - |
| api:check | passed | 1.4 detik | - |
| build:frontend | passed | 1.9 detik | - |
| check:frontend:bundle | passed | 0.2 detik | - |
| typecheck:backend | passed | 0.8 detik | - |
| typecheck:contract | passed | 1.7 detik | - |
| typecheck:e2e | passed | 0.8 detik | - |
| typecheck:tooling | passed | 1.8 detik | - |
| build:backend | passed | 0.0 detik | - |
| test:frontend | passed | 3.5 detik | - |
| test:integration | passed | 90.5 detik | - |
| test:tooling | passed | 37.7 detik | - |
| test:gate | passed | 63.5 detik | - |
| test:performance:plan | passed | 22.9 detik | - |
| test:deployment:plan | passed | 32.0 detik | - |
| test:e2e | passed | 11.2 detik | - |

### Langkah tier real

| Langkah | Status | Durasi | Alasan |
| --- | --- | --- | --- |
| test:infrastructure | passed | 52.0 detik | - |
| test:database:real | passed | 169.8 detik | - |
| test:database:migration | passed | 16.9 detik | - |
| test:tooling:real | passed | 38.0 detik | - |
| test:readiness:real | passed | 13.4 detik | - |
| test:deployment:real | passed | 91.5 detik | - |
| test:performance:smoke | passed | 106.3 detik | - |

### Langkah tier security

| Langkah | Status | Durasi | Alasan |
| --- | --- | --- | --- |
| check:security | passed | 12.7 detik | - |

### Checksum input per tier

| Path | fast | real | security |
| --- | --- | --- | --- |
| .github/workflows/application.yml | edda79e565b79b9a5d204e9aaf57df86d3eae11adb723f0bb31796e3eb0fe164 | edda79e565b79b9a5d204e9aaf57df86d3eae11adb723f0bb31796e3eb0fe164 | edda79e565b79b9a5d204e9aaf57df86d3eae11adb723f0bb31796e3eb0fe164 |
| apps/frontend/sdk/ | bfebafca5383722977ce6358f579aa352800ba19e8a666b6611fc8c9a58a04ac | bfebafca5383722977ce6358f579aa352800ba19e8a666b6611fc8c9a58a04ac | bfebafca5383722977ce6358f579aa352800ba19e8a666b6611fc8c9a58a04ac |
| bun.lock | 709aa822bcd149ec2967ed79fffefe1248ddd47e8cfeee2146d68384c32de656 | 709aa822bcd149ec2967ed79fffefe1248ddd47e8cfeee2146d68384c32de656 | 709aa822bcd149ec2967ed79fffefe1248ddd47e8cfeee2146d68384c32de656 |
| infrastructure/postgres/pins.json | 63fe647f7df56c5e94a0e5cb6483d845eeea548dcfdbe991c50e95c234f438c4 | 63fe647f7df56c5e94a0e5cb6483d845eeea548dcfdbe991c50e95c234f438c4 | 63fe647f7df56c5e94a0e5cb6483d845eeea548dcfdbe991c50e95c234f438c4 |
| openapi.json | 07536c3802337c07e7206e8554bb1a8cb991195c098f1bf875096fb4d1028f37 | 07536c3802337c07e7206e8554bb1a8cb991195c098f1bf875096fb4d1028f37 | 07536c3802337c07e7206e8554bb1a8cb991195c098f1bf875096fb4d1028f37 |
| package.json | 771df0a2fc1e86ea95601cd7f9b3829ac6b21c42a8d073a81b9a6ccdc2e64a13 | 771df0a2fc1e86ea95601cd7f9b3829ac6b21c42a8d073a81b9a6ccdc2e64a13 | 771df0a2fc1e86ea95601cd7f9b3829ac6b21c42a8d073a81b9a6ccdc2e64a13 |
| tests/scenarios/ | fb0d20873f914e99e1c795b91c5d4f65a377bf3fb327beccb956e1e70aed093d | fb0d20873f914e99e1c795b91c5d4f65a377bf3fb327beccb956e1e70aed093d | fb0d20873f914e99e1c795b91c5d4f65a377bf3fb327beccb956e1e70aed093d |
| tests/security/actionlint.yaml | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| tests/security/exceptions.json | 0c1de1a21eb6b25b59576015d5fa5c9fbb2fd081a192ac0c221c37f5e562271f | 0c1de1a21eb6b25b59576015d5fa5c9fbb2fd081a192ac0c221c37f5e562271f | 0c1de1a21eb6b25b59576015d5fa5c9fbb2fd081a192ac0c221c37f5e562271f |
| tests/security/gitleaks.toml | b2218eefd2c12a1a2f23d36735ac4aaae6965d917965a8ed5881d0a4e8669376 | b2218eefd2c12a1a2f23d36735ac4aaae6965d917965a8ed5881d0a4e8669376 | b2218eefd2c12a1a2f23d36735ac4aaae6965d917965a8ed5881d0a4e8669376 |
| tests/security/scanners.json | 311f56a9f4cfc6e801069ac407fec4c37b55c2988f5ed7dc92248c17db243581 | 311f56a9f4cfc6e801069ac407fec4c37b55c2988f5ed7dc92248c17db243581 | 311f56a9f4cfc6e801069ac407fec4c37b55c2988f5ed7dc92248c17db243581 |

### Checksum output per tier

| Path | fast | real | security |
| --- | --- | --- | --- |
| apps/frontend/dist/frontend/ | c9964376d0d59bede2667bf5d1609ef53a8b8efdd81cff56f60afb822a7aec01 | c9964376d0d59bede2667bf5d1609ef53a8b8efdd81cff56f60afb822a7aec01 | c9964376d0d59bede2667bf5d1609ef53a8b8efdd81cff56f60afb822a7aec01 |
| dist/backend/index.js | dd928a72763b42d1afef82917e0182d596850b45079ec1aeeaf8922112e8e799 | dd928a72763b42d1afef82917e0182d596850b45079ec1aeeaf8922112e8e799 | dd928a72763b42d1afef82917e0182d596850b45079ec1aeeaf8922112e8e799 |

## Identitas PostgreSQL

Ini image yang diuji tier nyata, bukan image deployment (fitur 13).

| Field | Nilai |
| --- | --- |
| image | foundation-postgres:18-pinned |
| imageId | sha256:9f5becc780eb7c629845f46b0f1a8cac904e1e616d5defb49fe7f5fbdb639a14 |
| os | linux |
| architecture | arm64 |
| baseImage | oraclelinux:10-slim@sha256:0660af1f1bb56559b299d99d3b71d0ff51f9d593cecbd3154a46914704ec34d6 |
| baseIndexDigest | sha256:0660af1f1bb56559b299d99d3b71d0ff51f9d593cecbd3154a46914704ec34d6 |
| serverVersion | 18.6 |
| packageVersion | 18.6-4PGDG.rhel10.2 |
| Bukti | .local/feature-11/evidence/real/.local/feature-3/image.json |

## Pemindai

Status passed, dipindai 2026-10-06T12:30:08.675Z.

Working tree tidak bersih saat pemindaian: perubahan yang belum masuk commit tidak dipindai gitleaks.

| Pemindai | Versi | Image | Status | Alasan | Cakupan | Gagal | Dikecualikan | Dilaporkan |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gitleaks | v8.30.1 | ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f | passed | - | head 4aa511abb738b43b06276091f18937aca10eedbd, commit terjangkau 57, dangkal false | 0 | 0 | 0 |
| bun audit | 1.4.2 | - | passed | - | paket bun.lock: 487 | 0 | 0 | 0 |
| actionlint | 1.7.12 | rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 | passed | - | file: .github/workflows/application.yml, .github/workflows/capacity.yml | 0 | 0 | 0 |

Hasil pemindai hanya membuktikan cakupan pemindai itu; tidak ditemukannya masalah bukan bukti aplikasi aman.

## Discovery

Status discovery: passed.

## Alur kritis

| ID | Status |
| --- | --- |
| APP-002 | passed |
| AUTH-012 | passed |
| AUTH-013 | passed |
| DEP-006 | passed |
| READY-006 | passed |
| READY-009 | passed |
| UI-001 | passed |

## Hasil per skenario

103 skenario: 0 failed, 0 missing_test, 0 not_run, 0 skipped, 103 passed.

| ID | Kriteria dan rujukan specs | Test dan profil | Wajib untuk release | Status | Hasil aktual dan tautan bukti |
| --- | --- | --- | --- | --- | --- |
| APP-001 | AC-1, AC-2, AC-3; docs/specs/0001-struktur-aplikasi-dependency/index.md | command check:dependencies package.json; command build:frontend package.json; command typecheck:backend package.json; command build:backend package.json; profil k6 tidak ada | ya | passed | exit code 0, passed; exit code 0, passed; exit code 0, passed; exit code 0, passed |
| APP-002 | AC-2, AC-4; docs/specs/0001-struktur-aplikasi-dependency/index.md | vitest test:frontend apps/frontend/src/app/app.spec.ts APP-002; bun:test test:integration tests/integration/backend/application.test.ts APP-002; playwright test:e2e tests/e2e/application/framework.e2e.spec.ts APP-002; profil k6 tidak ada | ya, alur kritis | passed | 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/frontend.xml; 5 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/playwright.xml |
| APP-003 | AC-3, AC-5; docs/specs/0001-struktur-aplikasi-dependency/index.md | bun:test test:integration tests/integration/backend/application.test.ts APP-003; bun:test test:integration tests/integration/contract/openapi.test.ts APP-003; command api:check package.json; profil k6 tidak ada | ya | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; 48 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; exit code 0, passed |
| APP-004 | AC-4, AC-6; docs/specs/0001-struktur-aplikasi-dependency/index.md | bun:test test:integration tests/integration/backend/application.test.ts APP-004; profil k6 tidak ada | ya | passed | 14 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| AUTH-001 | AC-1; docs/specs/0014-akses-pengguna-lifecycle-sesi/index.md | bun:test test:database:real tests/integration/database/auth.test.ts AUTH-001; profil k6 tidak ada | ya | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| AUTH-002 | AC-2; docs/specs/0014-akses-pengguna-lifecycle-sesi/index.md | bun:test test:database:real tests/integration/database/auth.test.ts AUTH-002; profil k6 tidak ada | ya | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| AUTH-003 | AC-3; docs/specs/0014-akses-pengguna-lifecycle-sesi/index.md | bun:test test:database:real tests/integration/database/auth.test.ts AUTH-003; bun:test test:integration tests/integration/backend/auth.test.ts AUTH-003; command test:deployment:real tests/orchestration/deployment-real.ts; profil k6 tidak ada | ya | passed | 6 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml; 4 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; exit code 0, passed |
| AUTH-004 | AC-4; docs/specs/0014-akses-pengguna-lifecycle-sesi/index.md | bun:test test:database:real tests/integration/database/auth.test.ts AUTH-004; bun:test test:integration tests/integration/backend/auth.test.ts AUTH-004; profil k6 tidak ada | ya | passed | 6 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml; 3 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| AUTH-005 | AC-5; docs/specs/0014-akses-pengguna-lifecycle-sesi/index.md | bun:test test:database:real tests/integration/database/auth.test.ts AUTH-005; bun:test test:integration tests/integration/backend/auth.test.ts AUTH-005; profil k6 tidak ada | ya | passed | 5 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml; 6 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| AUTH-006 | AC-6; docs/specs/0014-akses-pengguna-lifecycle-sesi/index.md | bun:test test:database:real tests/integration/database/auth.test.ts AUTH-006; bun:test test:integration tests/integration/backend/auth.test.ts AUTH-006; command test:deployment:real tests/orchestration/deployment-real.ts; profil k6 tidak ada | ya | passed | 5 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml; 3 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; exit code 0, passed |
| AUTH-007 | AC-7; docs/specs/0014-akses-pengguna-lifecycle-sesi/index.md | bun:test test:database:real tests/integration/database/auth.test.ts AUTH-007; bun:test test:integration tests/integration/backend/auth.test.ts AUTH-007; profil k6 tidak ada | ya | passed | 3 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml; 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| AUTH-008 | AC-8; docs/specs/0014-akses-pengguna-lifecycle-sesi/index.md | bun:test test:database:real tests/integration/database/auth.test.ts AUTH-008; profil k6 tidak ada | ya | passed | 5 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| AUTH-009 | AC-9; docs/specs/0014-akses-pengguna-lifecycle-sesi/index.md | bun:test test:integration tests/integration/backend/auth.test.ts AUTH-009; bun:test test:integration tests/integration/backend/application.test.ts AUTH-009; bun:test test:database:real tests/integration/database/auth.test.ts AUTH-009; command test:deployment:real tests/orchestration/deployment-real.ts; profil k6 tidak ada | ya | passed | 9 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml; exit code 0, passed |
| AUTH-010 | AC-10; docs/specs/0014-akses-pengguna-lifecycle-sesi/index.md | bun:test test:database:real tests/integration/database/auth.test.ts AUTH-010; bun:test test:integration tests/integration/backend/auth.test.ts AUTH-010; playwright test:readiness:real tests/e2e/auth/auth.real.e2e.spec.ts AUTH-010; playwright test:tooling:real tests/e2e/auth/auth.real.e2e.spec.ts AUTH-010; command test:deployment:real tests/orchestration/deployment-real.ts; profil k6 tidak ada | ya | passed | 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml; 5 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-10/playwright-real.xml; 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-2/playwright-real.xml; exit code 0, passed |
| AUTH-011 | AC-11; docs/specs/0014-akses-pengguna-lifecycle-sesi/index.md | bun:test test:integration tests/integration/contract/openapi-contract.test.ts AUTH-011; vitest test:frontend apps/frontend/src/app/features/auth/auth-api.integration.spec.ts AUTH-011; profil k6 tidak ada | ya | passed | 3 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; 78 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/frontend.xml |
| AUTH-012 | AC-10, AC-12; docs/specs/0014-akses-pengguna-lifecycle-sesi/index.md | playwright test:readiness:real tests/e2e/auth/auth.real.e2e.spec.ts AUTH-012; playwright test:tooling:real tests/e2e/auth/auth.real.e2e.spec.ts AUTH-012; playwright test:e2e tests/e2e/auth/sign-in.e2e.spec.ts AUTH-012; vitest test:frontend apps/frontend/src/app/features/auth/sign-in-page.spec.ts AUTH-012; vitest test:frontend apps/frontend/src/app/features/auth/account-page.spec.ts AUTH-012; vitest test:frontend apps/frontend/src/app/core/session/session-state.spec.ts AUTH-012; profil k6 tidak ada | ya, alur kritis | passed | 4 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-10/playwright-real.xml; 4 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-2/playwright-real.xml; 3 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/playwright.xml; 16 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/frontend.xml; 31 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/frontend.xml; 7 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/frontend.xml |
| AUTH-013 | AC-12, AC-13; docs/specs/0014-akses-pengguna-lifecycle-sesi/index.md | playwright test:deployment:real tests/e2e/deployment/auth.deployment.e2e.spec.ts AUTH-013; command test:deployment:real tests/orchestration/deployment-real.ts; profil k6 tidak ada | ya, alur kritis | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-13/playwright-deployment.xml; exit code 0, passed |
| AUTH-014 | AC-15; docs/specs/0014-akses-pengguna-lifecycle-sesi/index.md | bun:test test:deployment:plan tests/integration/deployment/auth-static.test.ts AUTH-014; profil k6 tidak ada | ya | passed | 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-13/plan.xml |
| BKP-001 | AC-1, AC-3, AC-4, AC-9; docs/specs/0013-backup-pemulihan-data/index.md | bun:test test:deployment:plan tests/integration/deployment/backup-static.test.ts BKP-001; profil k6 tidak ada | ya | passed | 16 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-13/plan.xml |
| BKP-002 | AC-2; docs/specs/0013-backup-pemulihan-data/index.md | bun:test test:database:real tests/integration/database/provision.test.ts BKP-002; profil k6 tidak ada | ya | passed | 15 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| BKP-003 | AC-3, AC-4, AC-8; docs/specs/0013-backup-pemulihan-data/index.md | bun:test test:database:real tests/integration/database/backup.test.ts BKP-003; profil k6 tidak ada | ya | passed | 4 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| BKP-004 | AC-5, AC-8; docs/specs/0013-backup-pemulihan-data/index.md | bun:test test:database:real tests/integration/database/backup.test.ts BKP-004; profil k6 tidak ada | ya | passed | 3 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| BKP-005 | AC-6, AC-8; docs/specs/0013-backup-pemulihan-data/index.md | bun:test test:database:real tests/integration/database/backup.test.ts BKP-005; profil k6 tidak ada | ya | passed | 15 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| BKP-006 | AC-3, AC-4, AC-5, AC-6, AC-8; docs/specs/0013-backup-pemulihan-data/index.md | bun:test test:database:real tests/integration/database/backup.test.ts BKP-006; profil k6 tidak ada | ya | passed | 10 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| BKP-007 | AC-7, AC-8; docs/specs/0013-backup-pemulihan-data/index.md | bun:test test:database:real tests/integration/database/backup.test.ts BKP-007; profil k6 tidak ada | ya | passed | 5 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| BKP-008 | AC-4; docs/specs/0013-backup-pemulihan-data/index.md | bun:test test:tooling tests/integration/tooling/development.test.ts BKP-008; profil k6 tidak ada | ya | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/tooling.xml |
| BKP-009 | AC-8; docs/specs/0013-backup-pemulihan-data/index.md | bun:test test:database:real tests/integration/database/backup.test.ts BKP-009; profil k6 tidak ada | ya | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| GATE-001 | AC-1; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/discovery.test.ts GATE-001; command check:test-discovery scripts/check-test-discovery.ts; profil k6 tidak ada | ya | passed | 15 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml; exit code 0, passed |
| GATE-002 | AC-2; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/registry.test.ts GATE-002; command test:scenarios scripts/validate-scenarios.ts; profil k6 tidak ada | ya | passed | 8 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml; exit code 0, passed |
| GATE-003 | AC-3, AC-8, AC-9; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/workflow.test.ts GATE-003; command check:workflow scripts/check-workflow.ts; profil k6 tidak ada | ya | passed | 82 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml; exit code 0, passed |
| GATE-004 | AC-4, AC-8; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/tier.test.ts GATE-004; profil k6 tidak ada | ya | passed | 26 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml |
| GATE-005 | AC-6; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/report.test.ts GATE-005; profil k6 tidak ada | ya | passed | 17 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml |
| GATE-006 | AC-7; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/report.test.ts GATE-006; profil k6 tidak ada | ya | passed | 14 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml |
| GATE-007 | AC-5, AC-8; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/security-policy.test.ts GATE-007; command check:security tests/orchestration/security-scan.ts; profil k6 tidak ada | ya | passed | 21 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml; exit code 0, passed |
| GATE-008 | AC-4; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/tier.test.ts GATE-008; command test:ci:real scripts/gate.ts; profil k6 tidak ada | ya | passed | 3 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml; passed |
| GATE-009 | AC-4, AC-8; docs/specs/0010-pengujian-skenario-gate-ci/index.md | bun:test test:gate tests/integration/gate/signal-cleanup.test.ts GATE-009; profil k6 tidak ada | ya | passed | 11 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml |
| DATA-001 | AC-1, AC-2, AC-3, AC-4, AC-5; docs/specs/0004-model-data-akses-database/index.md | bun:test test:database:real tests/integration/database/provision.test.ts DATA-001; profil k6 tidak ada | ya | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| DATA-002 | AC-1, AC-2, AC-5; docs/specs/0004-model-data-akses-database/index.md | bun:test test:database:real tests/integration/database/provision.test.ts DATA-002; profil k6 tidak ada | ya | passed | 5 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| DATA-003 | AC-3, AC-4, AC-7; docs/specs/0004-model-data-akses-database/index.md | bun:test test:database:real tests/integration/database/provision.test.ts DATA-003; profil k6 tidak ada | ya | passed | 1 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| DATA-004 | AC-5; docs/specs/0004-model-data-akses-database/index.md | bun:test test:database:real tests/integration/database/provision.test.ts DATA-004; profil k6 tidak ada | ya | passed | 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| DATA-005 | AC-6, AC-7; docs/specs/0004-model-data-akses-database/index.md | bun:test test:database:real tests/integration/database/provision.test.ts DATA-005; profil k6 tidak ada | ya | passed | 3 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
| DEP-001 | AC-1, AC-2, AC-6, AC-7, AC-8, AC-10, AC-11, AC-12; docs/specs/0012-build-container-deployment-terpisah/index.md | bun:test test:deployment:plan tests/integration/deployment/static.test.ts DEP-001; profil k6 tidak ada | ya | passed | 34 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-13/plan.xml |
| DEP-002 | AC-4; docs/specs/0012-build-container-deployment-terpisah/index.md | bun:test test:integration tests/integration/backend/health.test.ts DEP-002; profil k6 tidak ada | ya | passed | 16 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| DEP-003 | AC-4; docs/specs/0012-build-container-deployment-terpisah/index.md | bun:test test:integration tests/integration/contract/openapi-contract.test.ts DEP-003; bun:test test:integration tests/integration/contract/readiness-contract.test.ts DEP-003; vitest test:frontend apps/frontend/src/app/sdk-contract.integration.spec.ts DEP-003; command api:check scripts/check-api.ts; profil k6 tidak ada | ya | passed | 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml; 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/frontend.xml; exit code 0, passed |
| DEP-004 | AC-11, AC-12; docs/specs/0012-build-container-deployment-terpisah/index.md | bun:test test:gate tests/integration/gate/release.test.ts DEP-004; profil k6 tidak ada | ya | passed | 15 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml |
| DEP-005 | AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11; docs/specs/0012-build-container-deployment-terpisah/index.md | command test:deployment:real tests/orchestration/deployment-real.ts; profil k6 tidak ada | ya | passed | exit code 0, passed |
| DEP-006 | AC-6; docs/specs/0012-build-container-deployment-terpisah/index.md | playwright test:deployment:real tests/e2e/deployment/edge.deployment.e2e.spec.ts DEP-006; profil k6 tidak ada | ya, alur kritis | passed | 2 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-13/playwright-deployment.xml |
| DEP-007 | AC-9, AC-10; docs/specs/0012-build-container-deployment-terpisah/index.md | bun:test test:integration tests/integration/backend/logging.test.ts DEP-007; profil k6 tidak ada | ya | passed | 18 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
| DEP-008 | AC-8, AC-11; docs/specs/0012-build-container-deployment-terpisah/index.md | bun:test test:deployment:plan tests/integration/deployment/signal.test.ts DEP-008; profil k6 tidak ada | ya | passed | 22 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-13/plan.xml |
| DEP-009 | AC-4; docs/specs/0012-build-container-deployment-terpisah/index.md | bun:test test:database:real tests/integration/database/health.test.ts DEP-009; profil k6 tidak ada | ya | passed | 8 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/real/.local/feature-5/database.xml |
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
| PERF-001 | AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-10; docs/specs/0011-kapasitas-pemulihan-beban-meningkat/index.md | bun:test test:performance:plan tests/integration/performance/plan.test.ts PERF-001; profil k6 tidak ada | ya | passed | 58 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-12/plan.xml |
| PERF-002 | AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-10; docs/specs/0011-kapasitas-pemulihan-beban-meningkat/index.md | command test:performance:smoke tests/performance/profiles/smoke.ts; profil k6 smoke | ya | passed | exit code 0, passed |
| PERF-008 | AC-9, AC-10; docs/specs/0011-kapasitas-pemulihan-beban-meningkat/index.md | bun:test test:gate tests/integration/gate/capacity.test.ts PERF-008; command check:workflow scripts/check-workflow.ts; profil k6 tidak ada | ya | passed | 58 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-11/gate.xml; exit code 0, passed |
| PERF-009 | AC-2, AC-4, AC-5, AC-6, AC-10; docs/specs/0011-kapasitas-pemulihan-beban-meningkat/index.md | bun:test test:performance:plan tests/integration/performance/signal.test.ts PERF-009; profil k6 tidak ada | ya | passed | 20 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-12/plan.xml |
| READY-001 | AC-1, AC-3, AC-4; docs/specs/0006-alur-pemeriksaan-kesiapan/index.md | bun:test test:integration tests/integration/backend/readiness.test.ts READY-001; profil k6 tidak ada | ya | passed | 13 lulus, 0 gagal, 0 dilewati, passed, .local/feature-11/evidence/fast/.local/feature-4/server.xml |
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

## Performance k6

Disalin dari `result.json` setiap profil k6 di bundle tier per push yang SHA 256 nya cocok dengan manifest. Angka ini berlaku untuk environment dan batas bukti yang tercatat, bukan perkiraan kapasitas produk. Latency dalam milidetik.

### Profil smoke

| Aspek | Nilai |
| --- | --- |
| Status | passed |
| Tier dan langkah | real, test:performance:smoke |
| Bukti | .local/feature-11/evidence/real/.local/feature-12/smoke/result.json |
| Model beban | warmup constant 10 detik S0, steady constant 30 detik S0; satu iterasi satu request |

#### Beban target dan aktual

| Scenario | Endpoint | Fase | Laju rencana per detik | Detik | Iterasi rencana | Iterasi aktual | Laju aktual per detik | Ambang iterasi | Status ambang |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| status\_warmup | status | warmup | 100 | 10 | 1000 | 1001 | 100.10 | count\>=990 | lulus |
| readiness\_warmup | readiness | warmup | 10 | 10 | 100 | 101 | 10.10 | count\>=90 | lulus |
| status\_steady | status | steady | 100 | 30 | 3000 | 3001 | 100.03 | count\>=2990 | lulus |
| readiness\_steady | readiness | steady | 10 | 30 | 300 | 301 | 10.03 | count\>=290 | lulus |

| Total | Nilai |
| --- | --- |
| Iterasi | 4404 |
| Request HTTP | 4404 |
| Dropped iterations | 0 |
| VU maksimum | 40 |
| Scenario mulai sesudah T0 (ms) | 8 |

#### Latency terhadap target

| Endpoint | Fase | Hasil | Jumlah | p50 | p95 | p99 | max | Target | Status target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| status | warmup | all | 1001 | 0.74 | 2.32 | 3.83 | 9.87 | tanpa target | - |
| readiness | warmup | available | 101 | 3.68 | 6.65 | 7.61 | 9.89 | tanpa target | - |
| readiness | warmup | busy | 0 | - | - | - | - | tanpa target | - |
| readiness | warmup | unavailable | 0 | - | - | - | - | tanpa target | - |
| status | steady | all | 3001 | 0.67 | 2.09 | 3.60 | 10.29 | p(95)\<10, p(99)\<25 | lulus |
| readiness | steady | available | 300 | 3.21 | 5.72 | 6.63 | 8.79 | p(95)\<25, p(99)\<50 | lulus |
| readiness | steady | busy | 1 | 2.74 | 2.74 | 2.74 | 2.74 | tanpa target | - |
| readiness | steady | unavailable | 0 | - | - | - | - | tanpa target | - |

#### Rasio readiness

| Fase | 200 tersedia | 429 sibuk | 503 tidak tersedia | Rasio tersedia | Target rasio | Status target |
| --- | --- | --- | --- | --- | --- | --- |
| warmup | 101 | 0 | 0 | 1 | tanpa target | - |
| steady | 300 | 1 | 0 | 0.997 | rate\>=0.98 | lulus |

#### Thresholds

18 dari 18 threshold lulus.

#### Resource, pool, dan check pengamatan

| Container | CPU rata rata (persen satu CPU) | CPU maksimum | Memory rata rata (MiB) | Memory maksimum (MiB) | Pertumbuhan memory (MiB) | Restart | OOM | Byte stderr |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| postgres | 1.19 | 6.21 | 43.36 | 44.81 | - | - | - | - |
| backend | 5.62 | 7.71 | 23.11 | 24.54 | - | 0 | tidak | 0 |
| k6 | 16.43 | 21.91 | 38.49 | 41.30 | - | - | - | - |

| Pool | Nilai |
| --- | --- |
| Sesi foundation\_backend maksimum | 5 |
| Sesi foundation\_backend aktif maksimum | 1 |
| Sesi client maksimum | 6 |
| Sampel berhasil | 55 |
| Sampel gagal | 0 |

| Check | Aturan | Aktual | Lulus |
| --- | --- | --- | --- |
| backend\_running | sesudah k6 keluar, backend berjalan, RestartCount 0, dan tidak OOMKilled | {"running":true,"restarts":0,"oomKilled":false} | ya |
| backend\_output | stderr 0 byte; stdout tepat baris listening lalu Backend stopped | {"stderrBytes":0,"stdoutExpected":true} | ya |
| backend\_memory\_peak | memory backend maksimum \<= 128 MiB | 24.54 | ya |
| pool\_sessions | setiap sampel mencatat paling banyak 5 sesi foundation\_backend | 5 | ya |
| pool\_non\_idle | setiap sampel mencatat paling banyak 1 sesi foundation\_backend yang tidak idle | 1 | ya |
| generator\_cpu | rata rata CPU k6 pada setiap fase terukur \<= 240 persen satu CPU | 16.80 | ya |
| generator\_memory | memory k6 maksimum \<= 1638 MiB | 41.30 | ya |
| observation\_coverage | sampel cukup dan celah dalam batas pada setiap container dan fase terukur, serta pada pg\_stat\_activity | \[\] | ya |
| clock\_offset | selisih jam container dengan host \<= 1000 ms sebelum T0 dan sesudah k6 keluar | {"before":18,"after":6} | ya |

#### Environment

| Aspek | Nilai |
| --- | --- |
| Host | Darwin 27.0.0 arm64 |
| CPU host | Apple M1 Max, 10 CPU |
| Memory host (byte) | 34359738368 |
| Mesin container | versi server 29.8.0, Docker Desktop, 10 CPU, memory 8319504384 byte |
| Container lain yang berjalan | 8 |
| CI | tidak |
| Image k6 | grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34 |
| Image Bun | oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 |
| PostgreSQL | foundation-postgres:18-pinned, image id sha256:9f5becc780eb7c629845f46b0f1a8cac904e1e616d5defb49fe7f5fbdb639a14, base oraclelinux:10-slim@sha256:0660af1f1bb56559b299d99d3b71d0ff51f9d593cecbd3154a46914704ec34d6, versi 18.6 |
| Batas resource postgres | cpus 2, memory 1g, shmSize 128m, pids 256 |
| Batas resource backend | cpus 1, memory 512m, pids 256 |
| Batas resource k6 | cpus 3, memory 2g, pids 512 |
| Batas resource inspect | cpus 1, memory 512m, pids 512 |
| Pool | max 5, connectionTimeout 3 detik |
| Data | 10 migration |
| Selisih jam (ms) | sebelum T0 18, sesudah k6 6 |

#### Batas bukti

| No | Batas bukti |
| --- | --- |
| 1 | Alur yang diukur adalah diagnostik komposisi development, \`GET /api/status\` dan \`GET /api/readiness\`; komposisi production tidak memasang route apa pun dan belum ada endpoint bisnis. |
| 2 | Backend berjalan sebagai satu container dengan 1 CPU dan 512 MiB dari image Bun slim dengan source yang di mount, bukan image deployment fitur 13. |
| 3 | k6 dan backend berbagi network namespace loopback; tidak ada reverse proxy, TLS, atau latency jaringan nyata. |
| 4 | Data hanya riwayat migration (10 baris); tidak ada tabel bisnis. |
| 5 | Mesin dipakai bersama (Docker Desktop di macOS bersama container lain, atau runner GitHub hosted); hasil hanya sebanding dengan run pada kelas environment yang sama. |
| 6 | Batas kapasitas (breakpoint) tidak dicari; hasil membuktikan beban yang disepakati, bukan titik jenuh. |

## Deployment

| Aspek | Nilai |
| --- | --- |
| Status | passed |
| Check passed | 41 dari 41 |
| Bukti | .local/feature-11/evidence/real/.local/feature-13/result.json |

Image dibangun lokal dari root monorepo oleh `test:deployment:real`, tidak didorong ke registry, dan bukti ini bukan izin deploy.

### Image deployment

| Image | Tag | Image ID | Ukuran (byte) | User | Image dasar | Revision | Pohon sumber |
| --- | --- | --- | --- | --- | --- | --- | --- |
| frontend | foundation-frontend:deploy-473534d66af6 | sha256:035a9474d81a5c1498c7f413d6bce999e063b45f05bd8802d9d612a5919399e7 | 93186771 | 101:101 | node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe, oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61, nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94 | 4aa511abb738b43b06276091f18937aca10eedbd | 4cfa7461363c455bb3a2e2f67c2a6a18be5f8347e3cb9ffb662dda392027b480 |
| backend | foundation-backend:deploy-473534d66af6 | sha256:b90e3e3d117e27c86f113d3eb32191322060ef373177a1638ac16cc3fe4c2556 | 275385011 | 1000:1000 | oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 | 4aa511abb738b43b06276091f18937aca10eedbd | 4cfa7461363c455bb3a2e2f67c2a6a18be5f8347e3cb9ffb662dda392027b480 |
| migrate | foundation-migrate:deploy-473534d66af6 | sha256:5cdee0ab065082a19b1698de86ef9978ce102a00cd9ed39bf81ba8c258d8bcf5 | 274710807 | 1000:1000 | oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 | 4aa511abb738b43b06276091f18937aca10eedbd | 4cfa7461363c455bb3a2e2f67c2a6a18be5f8347e3cb9ffb662dda392027b480 |

### Check deployment

| Check | Kriteria | Status |
| --- | --- | --- |
| image\_pins | AC-1 | passed |
| image\_context\_sentinels | AC-1, AC-2 | passed |
| image\_filesystem | AC-2 | passed |
| image\_config | AC-1, AC-2 | passed |
| provisioning\_step | AC-3 | passed |
| readiness\_before\_migration | AC-3, AC-4 | passed |
| migration\_step | AC-3 | passed |
| readiness\_after\_migration | AC-3, AC-4 | passed |
| auth\_account\_job | 0014/AC-3, 0014/AC-13 | passed |
| tls\_versions | AC-5 | passed |
| http\_redirect | AC-5 | passed |
| document\_headers | AC-5, AC-6 | passed |
| static\_cache\_fallback | AC-6 | passed |
| api\_forwarding | AC-7 | passed |
| api\_headers | AC-7 | passed |
| api\_stub\_forwarding | AC-7 | passed |
| cors\_absent | AC-7 | passed |
| edge\_errors | AC-7, AC-10 | passed |
| health\_not\_public | AC-4, AC-7 | passed |
| published\_ports | AC-8 | passed |
| network\_isolation | AC-8 | passed |
| egress\_blocked | AC-8 | passed |
| compose\_declaration | AC-8, AC-10 | passed |
| container\_hardening | AC-8 | passed |
| container\_environment | AC-8 | passed |
| browser\_flow | AC-6, 0014/AC-12 | passed |
| auth\_session\_cookie | 0014/AC-4, 0014/AC-13 | passed |
| auth\_origin\_csrf | 0014/AC-9, 0014/AC-13 | passed |
| auth\_capacity | 0014/AC-6, 0014/AC-13 | passed |
| auth\_edge\_rate\_limit | 0014/AC-6, 0014/AC-13 | passed |
| backend\_shutdown\_restart | AC-9 | passed |
| backend\_recreate | AC-9 | passed |
| database\_outage | AC-4, AC-9 | passed |
| edge\_shutdown | AC-9 | passed |
| log\_structure | AC-10, 0014/AC-10 | passed |
| log\_correlation | AC-10, 0014/AC-10 | passed |
| log\_no\_data | AC-10, 0014/AC-10 | passed |
| postgres\_log\_policy | AC-10 | passed |
| topology\_shutdown | AC-9 | passed |
| artifact\_scan | AC-2, AC-11 | passed |
| cleanup | AC-11 | passed |

### Batas bukti deployment

Topologi rujukan satu host Docker dengan sertifikat dari CA sementara; bukan bukti platform deployment, kapasitas, image di registry, atau ketiadaan kerentanan paket OS di image (paket OS ketiga image tidak dipindai pemindai kerentanan).

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

- Profil kapasitas load, stress, spike, outage, dan soak, dibuktikan `test:report:capacity` dari tier kapasitas (fitur 12).

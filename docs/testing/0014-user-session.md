# Bukti fitur 15: Akses pengguna dan lifecycle sesi

Tanggal: 2026-10-06 (waktu UTC; waktu lokal UTC+7). Bukti fitur yang berlaku adalah gerbang akhir pukul 12.17 sampai 12.30 UTC (manifest tier cepat mulai 12:17:10Z, manifest tier keamanan selesai 12:30:21Z, laporan per push dibuat 12:30:24Z, dan `release.json` dibuat 12:30:30Z), sesudah `/develop` kelima milestone, `/check verify`, `/test`, `/check review` beserta perbaikan temuannya dan review ulang, serta `/document`. Kriteria: [spec 0014](../specs/0014-akses-pengguna-lifecycle-sesi/index.md) AC-1 sampai AC-15. Bukti berasal dari checkout `main` pada dasar `4aa511abb738b43b06276091f18937aca10eedbd` dengan seluruh perubahan fitur 15 yang belum masuk commit. SHA 256 pohon sumber `4cfa7461363c455bb3a2e2f67c2a6a18be5f8347e3cb9ffb662dda392027b480` sama pada awal dan akhir ketiga tier menurut manifest, dan SHA 256 keluaran `git status --porcelain` sama sebelum dan sesudah gerbang, jadi kode tidak berubah selama gerbang. Laporan ini, salinan bukti di `evidence/0014/`, scope, dan baris **Status** spec ditulis sesudah gerbang dan hanya mengubah dokumen.

**Status akhir:** keempat perintah gate per push lulus pada satu run berurutan tanpa retry. `bun run test:ci` 19 dari 19 langkah, `bun run test:ci:real` 7 dari 7 langkah dengan `Database artifact scan passed: 274 random values and 164 token fingerprints absent from 22 files.` dan `Restore evidence passed.` pada langkah `test:database:real`, `bun run test:ci:security` 1 dari 1 langkah, dan `bun run test:report` keluar 0 dengan `Gate passed`: 103 dari 103 skenario `passed` (termasuk AUTH-001 sampai AUTH-014 dan BKP-009), ketujuh alur kritis lulus (termasuk AUTH-012 dan AUTH-013), discovery dan ketiga pemindai lulus, pengikatan sah, `performance k6: smoke passed`, dan `deployment: passed (41 dari 41 check passed)`. `.local/feature-14/restore.json` berstatus `passed` tanpa `failures`, dengan field `sessions` `{ beforeRevokeStatus: 200, afterRevokeStatus: 401, revoked: 1, rerunRevoked: 0 }`. `bun run test:report:release` atas bundle lokal keluar 1 dengan status `incomplete`, seperti yang ditetapkan spec 0012 untuk bundle yang bukan run CI, dengan `grantsDeployment` `false`. AC-1 sampai AC-15 terpenuhi untuk bagian lokal. Run GitHub Actions di runner Linux (termasuk latency Argon2id pada backend `cpus` 1 dan stabilitas rasio median AUTH-005) baru dapat dibuktikan sesudah push dan dicatat sebagai bukti terpisah. Gerbang ini bukan kandidat release (`not_clean` dan `not_ci`), karena working tree belum masuk commit dan tidak berjalan di CI.

## Lingkungan

macOS 27.0 (arm64, Apple Silicon), Bun 1.4.2, Node 24.21.0 di host. Docker Desktop dengan Docker Engine 29.8.0 dan Docker Compose 5.5.1; mesin container melihat 10 CPU. Container proyek lain yang berjalan tanpa label `foundation.test` sepanjang gerbang, termasuk PostgreSQL Compose bersama milik proyek ini (`foundation-postgres-1`, tetap `Up` dan `healthy`) dan container `foundation-xcheck-e6a4f865` sisa tahap sebelumnya, tidak disentuh. Lima proses backend lama (`bun --no-env-file apps/backend/src/index.ts` dan `dist/backend/index.js`, dimulai pukul 01.00 waktu lokal dengan induk launchd) dan tiga proses `bun hold.ts` milik proyek lain tetap berjalan dan tidak disentuh; tidak satu pun mendengarkan port 8888 atau 8889. Tidak ada suite lain yang dijalankan bersamaan dengan langkah mana pun. Port 8888 dan 8889 kosong sebelum dan sesudah gerbang.

| Komponen | Identitas |
| --- | --- |
| PostgreSQL 18.6 | `foundation-postgres:18-pinned`, image id `sha256:9f5becc780eb7c629845f46b0f1a8cac904e1e616d5defb49fe7f5fbdb639a14`, linux arm64, base `oraclelinux:10-slim@sha256:0660af1f1bb56559b299d99d3b71d0ff51f9d593cecbd3154a46914704ec34d6`, paket `18.6-4PGDG.rhel10.2`; dibangun ulang dari pin yang sama oleh langkah `test:infrastructure` gerbang ini dan dipakai setiap suite nyata, termasuk cluster suite auth, kedua cluster `backup.test.ts`, dan database orkestrasi `test:readiness:real` |
| Image deployment | `foundation-frontend`, `foundation-backend`, dan `foundation-migrate` dengan tag `deploy-473534d66af6`, dibangun lokal dari root monorepo oleh `test:deployment:real` dengan revision `4aa511a` dan pohon sumber `4cfa7461…`, lalu dihapus pada pembersihan run; tidak didorong ke registry |
| Browser | Chromium Playwright pada 1280×812 dan 375×812 |

## Perintah dan hasil gerbang akhir

Gerbang menjalankan keempat perintah gate per push lalu `test:report:release`. Tier nyata memuat setiap suite nyata yang disentuh fitur ini: `test:database:real` (suite baru `tests/integration/database/auth.test.ts` dengan AUTH-001 sampai AUTH-010, BKP-009 di `backup.test.ts`, bukti `restore.json`, dan pemindaian dengan sidik token), `test:infrastructure` (image PostgreSQL), `test:database:migration` (sepuluh migration repository), `test:tooling:real` dan `test:readiness:real` (AUTH-010 dan AUTH-012 lewat browser dengan dua akun uji pada database milik run), `test:deployment:real` (lima check auth baru, AUTH-013 lewat edge, dan job `migrate` yang menjalankan `database/accounts.ts`), dan smoke k6. Tier cepat memuat AUTH-003 sampai AUTH-007 dan AUTH-009 sampai AUTH-011 di `test:integration`, AUTH-011 dan AUTH-012 di `test:frontend`, AUTH-012 tanpa database di `test:e2e`, AUTH-014 dan DEP-001 di `test:deployment:plan`, TOOL-003 di `test:tooling`, GATE-002 dan GATE-009 di `test:gate`, `api:check`, dan keempat typecheck yang kini memuat file fitur ini. Setiap script yang dirujuk registry `tests/scenarios/` tercakup. Setiap perintah dijalankan satu kali, berurutan, tanpa retry, dan tidak ada yang gagal.

| Perintah (waktu UTC) | Hasil aktual |
| --- | --- |
| `bun run test:ci` (12.17.10 sampai 12.21.42) | Exit 0, 19 dari 19 langkah `passed`. `test:scenarios`: `Scenario registries passed (108 unique IDs, 165 checks).`; `check:test-discovery`: 51 file test (Vitest 8, Playwright `playwright.config.ts` 5, Playwright `playwright.real.config.ts` 2, Playwright `playwright.deployment.config.ts` 2, `bun:test` 34); `check:workflow`: `Workflow lulus: application.yml (application 8 langkah, real 8 langkah, security 4 langkah, report 7 langkah), capacity.yml (capacity 7 langkah).`; `api:check`: `OpenAPI and SDK match stored artifacts across two runs`; `build:frontend` initial total 688,58 kB dengan warning anggaran 500 kB yang sudah ada, dan chunk lazy `account-page` 11,92 kB serta `sign-in-page` 5,37 kB; `check:frontend:bundle` lulus; keempat typecheck exit 0; `test:frontend` 214 test di 8 file; `test:integration` 705 test di 11 file dengan 7.110 assertion dalam 90,5 detik; `test:tooling` 55 test dengan 224 assertion dalam 37,7 detik; `test:gate` 270 test dengan 2.151 assertion dalam 63,5 detik; `test:performance:plan` 78 test dengan 1.538 assertion; `test:deployment:plan` 74 test dengan 1.368 assertion dalam 31,9 detik (termasuk 2 test AUTH-014, 34 test DEP-001, dan 16 test BKP-001); `test:e2e` 15 test dalam 10,9 detik. Seluruhnya 0 gagal dan 0 dilewati. |
| `bun run test:ci:real` (12.21.52 sampai 12.30.00) | Exit 0, 7 dari 7 langkah `passed` tanpa testcase dilewati: `test:infrastructure` 18 test dengan 205 assertion dalam 52,0 detik; `test:database:real` 169,8 detik, dengan `bun test` 126 test di 6 file dan 3.777 assertion dalam 168,0 detik di bawah batas 900 detik (`auth.test.ts` 36, `backup.test.ts` 38, `provision.test.ts` 27, `readiness.test.ts` 12, `health.test.ts` 8, `migration.test.ts` 5), baris `AUTH-005 median sign in duration: wrong password 23.6 ms, unknown email 23.8 ms, ratio 1.01`, lalu `Database artifact scan passed: 274 random values and 164 token fingerprints absent from 22 files.` dan `Restore evidence passed.`; `test:database:migration` 5 test dengan 60 assertion dalam 16,9 detik; `test:tooling:real` lulus dalam 38,0 detik (TOOL-001 12 check database dengan role nyata, 6 test Playwright di bawah `serve`, dan `artifact scan passed: 8 random values and 18 token fingerprints absent from 38 outputs and 15 files`); `test:readiness:real` lulus dalam 13,4 detik (6 test Playwright dan `Readiness artifact scan passed: 8 random values and 18 token fingerprints absent from 7 outputs and 15 files.`); `test:deployment:real` lulus dalam 91,5 detik dengan `41 check passed, 0 failed, 0 not_run`; dan `test:performance:smoke` sebagai langkah terakhir dalam 106,3 detik (4.404 iterasi sama dengan 4.404 request, 0 dropped iterations, 18 dari 18 threshold, 9 dari 9 check pengamatan, sepuluh migration pada database smoke, dan pemindaian credential tanpa temuan atas 28 output). |
| `bun run test:ci:security` (12.30.08 sampai 12.30.21) | Exit 0; gitleaks v8.30.1 atas 57 commit, `bun audit` 1.4.2 atas 487 paket, dan actionlint 1.7.12 atas `.github/workflows/application.yml` dan `.github/workflows/capacity.yml`, ketiganya `passed` dengan 0 temuan. Pemindai juga mencetak `Working tree tidak bersih: perubahan yang belum masuk commit tidak dipindai gitleaks.` (lihat *Pemeriksaan sesudah dokumen diperbarui*). |
| `bun run test:report` (12.30.24) | Exit 0 dengan `Gate passed`: ketiga tier `passed`, 103 skenario (0 failed, 0 missing_test, 0 not_run, 0 skipped, 103 passed), alur kritis APP-002, AUTH-012, AUTH-013, DEP-006, READY-006, READY-009, dan UI-001 `passed`, discovery `passed`, ketiga pemindai `passed`, `pengikatan sah`, `performance k6: smoke passed`, `deployment: passed (41 dari 41 check passed)`, `Kandidat release: bukan (not_clean fast, not_clean real, not_clean security, not_ci fast, not_ci real, not_ci security, not_ci)`. Bagian *Di luar cakupan* hanya memuat profil kapasitas (fitur 12). |
| `bun run test:report:release` (12.30.30) | Exit 1 dengan `Status release incomplete`, sesuai spec 0012 untuk bundle lokal: gate per push `passed` tetapi bukan kandidat, laporan kapasitas `incomplete`, alasan `capacity_incomplete`, `gate_not_candidate`, `capacity_not_candidate`, dan `candidate_differs`, `grantsDeployment: false`. Bundle kapasitas lokal masih dari gerbang fitur 12. Perintah hanya menulis `.local/feature-13/release.json` dan `release.md`; `.local/feature-12/report.json` tetap dengan waktu tulis 2026-10-05. |

Sesudah gerbang, daftar container, network, dan volume Docker sama dengan daftar yang diambil saat tier cepat baru mulai, tidak ada container berlabel `foundation.test`, tidak ada container atau network bernama `foundation-deploy`, `foundation-perf`, `foundation-readiness`, `foundation-auth`, atau `foundation-backup`, tidak ada image bertag `deploy-473534d66af6` yang tersisa, tidak ada proses orkestrasi yang tersisa, dan tidak ada listener pada port 8888 atau 8889. Dua perbedaan daftar: tag `foundation-postgres:18-pinned` kini menunjuk `9f5becc780eb`, dibangun dari pin yang sama oleh `test:infrastructure` seperti pada setiap tier nyata (image sebelumnya `d9ddf7a145df`), dan satu folder `foundation-openapi-cli-*` di `TMPDIR` yang ada pada daftar awal (diambil beberapa detik sesudah tier cepat mulai) sudah dihapus oleh gerbang itu sendiri.

Pemeriksaan mandiri atas bundle: ke 82 file bukti ketiga tier (27 tier cepat, 54 tier nyata termasuk file di folder screenshot, dan 1 tier keamanan) dihitung ulang SHA 256 nya dan semuanya sama dengan manifest. Ketiga manifest mencatat commit `4aa511a`, `clean` false, `ci` null, pohon sumber yang sama pada awal dan akhir tier, serta checksum input dan output yang sama pada ketiga tier. Salinan `restore.json` di bundle tier nyata sama byte demi byte dengan `.local/feature-14/restore.json` (`0abb9911…8c258c8`).

## Check deployment auth

Isi `detail` check auth di [`deployment-result.json`](evidence/0014/deployment-result.json), yang dijalankan bersama ke 36 check lama dengan urutan dan anggaran tabel *Perubahan deployment* spec.

| Check | Kriteria | Hasil gerbang akhir |
| --- | --- | --- |
| `auth_account_job` | AC-3, AC-13 | 2 akun uji dibuat job `migrate` image runner (`Account created`); `create` ulang keluar 1 `Account exists`; keluaran tanpa email dan password |
| `browser_flow` | AC-12, AC-13 | DEP-006 dan AUTH-013 lulus pada 1280×812 dan 375×812 tanpa pelanggaran CSP atau error; 1 POST masuk lewat edge |
| `auth_session_cookie` | AC-4, AC-13 | Masuk lewat edge 200 dengan satu `Set-Cookie` `__Host-foundation_session` `Path=/` `Secure` `HttpOnly` `SameSite=Strict` tanpa `Domain` dan `Max-Age`; GET sesi 200 |
| `auth_origin_csrf` | AC-9, AC-13 | 6 request lewat edge ditolak 403 backend dengan event `origin` atau `csrf`; keluar dengan token CSRF benar 204 lalu 401; total 6 masuk dari anggaran 10 |
| `auth_capacity` | AC-6, AC-13 | 8 dari 8 masuk bersamaan di container backend 200 dan 0 jawaban 503, jawaban 200 terlama 643 ms terhadap batas 2.000 ms; `/health/ready` bersamaan 200; tanpa restart dan OOMKilled |
| `auth_edge_rate_limit` | AC-6, AC-13 | 30 `POST /api/auth/session` lewat edge (paling banyak 5 bersamaan): 7 jawaban 401 backend dan 23 jawaban 429 edge tanpa upstream |
| `log_structure` | AC-10, AC-13 | 177 baris JSON edge dengan key dan tipe AC-10 spec 0012, dan log backend JSON production dengan 25 baris `auth` |
| `log_correlation` | AC-13 | `X-Request-Id` jawaban, baris log edge, dan baris log backend memuat ID yang sama, juga baris `auth` `sign_in` masuk lewat edge |
| `log_no_data` | AC-10 | 45 nilai (sentinel, password dan DSN run, password akun uji), email akun uji, dan 4 sidik token tidak ada di 16 keluaran |
| `artifact_scan` | AC-10 | 45 nilai run dan 4 sidik token tidak ada di 10 file bukti dan 5 keluaran container, dengan kontrol positif `true` |

## Bukti restore dan hook fitur 15

Isi [`restore.json`](evidence/0014/restore.json) dari run `test:database:real` gerbang ini, ditulis `backup.test.ts` pukul 12:25:33Z.

| Field | Hasil gerbang akhir |
| --- | --- |
| `status` dan `failures` | `passed`, `[]` |
| `serverVersion` | `18.6` |
| `backup` | `foundation-20261006T122358Z-manual`, alasan `manual`, 19.314 byte, 51 entri TOC, `pg_dump` 64 ms, `checksumVerified` true |
| `restore` | `durationMs` 607 terhadap batas 300.000, `provisioning` `verified`, `migrations` `Migrations: 0 applied, 11 skipped`, `readinessStatus` 200, `oldPasswordsRejected` `foundation_migrator`, `foundation_backend`, dan `foundation_backup` |
| `fingerprint` | `equal` true; `auth.password_credentials` 1 baris, `auth.sessions` 1, `auth.sign_in_attempts` 0, `common.schema_migrations` 11, `users.restore_fixture` 3, dan `users.users` 1; migration terakhir `0011-users-restore-fixture.sql` dari 11 (sepuluh migration repository ditambah fixture) |
| `sessions` | `beforeRevokeStatus` 200, `afterRevokeStatus` 401, `revoked` 1, `rerunRevoked` 0 (BKP-009) |
| `guards` | Kedua belas guard `passed` |
| `retention` | `kept` 7, `removed` 6, `leftovers` 3, dan `untouched` `archive`, `latest`, serta `notes.txt` |
| `secretScan` | 190 sumber, 42 nilai (termasuk password akun uji BKP-009), `findings` kosong |
| `boundary` | Kalimat tetap spec 0013: bukti pada dua cluster PostgreSQL 18 terisolasi milik run dengan data fixture, bukan bukti RTO environment, ukuran data nyata, jadwal backup, salinan di luar host, atau enkripsi penyimpanan |

Pemindaian orkestrasi `database-real.ts` ([`artifact-scan-database.json`](evidence/0014/artifact-scan-database.json)) memeriksa 274 nilai rahasia turunan label (termasuk password `backup-account` dan `account-1` sampai `account-256`) dan 164 sidik token atas 22 file (JUnit, `restore.json`, dan 20 file bundle frontend), ditambah keluaran `bun test` dan isi laporan pemindaian itu sendiri untuk sidik token, dengan kontrol positif `true` dan tanpa temuan. Pemindaian `test:readiness:real` ([`artifact-scan-readiness.json`](evidence/0014/artifact-scan-readiness.json)), `test:tooling:real` ([`artifact-scan-tooling.json`](evidence/0014/artifact-scan-tooling.json)), dan `test:deployment:real` ([`artifact-scan-deployment.json`](evidence/0014/artifact-scan-deployment.json)) juga berkontrol positif `true` dan tanpa temuan.

## Hasil per skenario

| Skenario | Kriteria | Bukti gerbang akhir | Status |
| --- | --- | --- | --- |
| `AUTH-001` | AC-1 | 1 test `tests/integration/database/auth.test.ts` (`test:database:real`), JUnit [`database.xml`](evidence/0014/database.xml) | `passed` |
| `AUTH-002` | AC-2 | 1 test `database/auth.test.ts`, JUnit [`database.xml`](evidence/0014/database.xml) | `passed` |
| `AUTH-003` | AC-3 | 6 test `database/auth.test.ts`, 4 test `tests/integration/backend/auth.test.ts` (`test:integration`, JUnit [`integration.xml`](evidence/0014/integration.xml)), dan check `auth_account_job` | `passed` |
| `AUTH-004` | AC-4 | 6 test `database/auth.test.ts` dan 3 test `backend/auth.test.ts` | `passed` |
| `AUTH-005` | AC-5 | 5 test `database/auth.test.ts` (rasio median 1,01) dan 6 test `backend/auth.test.ts` | `passed` |
| `AUTH-006` | AC-6 | 5 test `database/auth.test.ts`, 3 test `backend/auth.test.ts`, serta check `auth_capacity` dan `auth_edge_rate_limit` | `passed` |
| `AUTH-007` | AC-7 | 3 test `database/auth.test.ts` dan 1 test `backend/auth.test.ts` | `passed` |
| `AUTH-008` | AC-8 | 5 test `database/auth.test.ts` | `passed` |
| `AUTH-009` | AC-9 | 9 test `backend/auth.test.ts`, 2 test `tests/integration/backend/application.test.ts`, 2 test `database/auth.test.ts`, dan check `auth_origin_csrf` | `passed` |
| `AUTH-010` | AC-10 | 2 test `database/auth.test.ts`, 5 test `backend/auth.test.ts`, 1 test Playwright `tests/e2e/auth/auth.real.e2e.spec.ts` di masing masing `test:readiness:real` dan `test:tooling:real` (JUnit [`playwright-readiness-real.xml`](evidence/0014/playwright-readiness-real.xml) dan [`playwright-tooling-real.xml`](evidence/0014/playwright-tooling-real.xml)), serta check `log_no_data` dan `artifact_scan` | `passed` |
| `AUTH-011` | AC-11 | 3 test `tests/integration/contract/openapi-contract.test.ts` dan 78 test Vitest `auth-api.integration.spec.ts` (JUnit [`frontend.xml`](evidence/0014/frontend.xml)) | `passed` |
| `AUTH-012` | AC-10, AC-12 | 4 test Playwright `auth.real.e2e.spec.ts` di masing masing `test:readiness:real` dan `test:tooling:real`, 3 test `tests/e2e/auth/sign-in.e2e.spec.ts` (`test:e2e`, JUnit [`playwright.xml`](evidence/0014/playwright.xml)), serta 16, 31, dan 7 test Vitest `sign-in-page.spec.ts`, `account-page.spec.ts`, dan `session-state.spec.ts`; alur kritis | `passed` |
| `AUTH-013` | AC-12, AC-13 | 1 test Playwright `tests/e2e/deployment/auth.deployment.e2e.spec.ts` lewat edge (JUnit [`playwright-deployment.xml`](evidence/0014/playwright-deployment.xml)) dan check `auth_session_cookie`; alur kritis | `passed` |
| `AUTH-014` | AC-15 | 2 test `tests/integration/deployment/auth-static.test.ts` (`test:deployment:plan`, JUnit [`plan.xml`](evidence/0014/plan.xml)) | `passed` |
| `BKP-009` | AC-14 spec 0014 (AC-8 spec 0013 di registry) | 1 test terakhir `tests/integration/database/backup.test.ts`, JUnit [`database.xml`](evidence/0014/database.xml), dan field `sessions` `restore.json` | `passed` |

Jumlah test per skenario dihitung `test:report` dari testcase yang judul lengkapnya diawali tag di JUnit gerbang ini. GATE-002 (8 test, alur kritis termasuk AUTH-012 dan AUTH-013) dan GATE-009 (11 test, termasuk suite `auth.test.ts` di daftar suite nyata dan batas 900.000 ms) ada di [`gate.xml`](evidence/0014/gate.xml). Ke 88 skenario fitur lain pada laporan per push (APP, BKP-001 sampai BKP-008, DATA, DEP, GATE, INFRA, MIG, OPENAPI, PERF per push, READY, SDK, TOOL, dan UI) juga `passed` pada gerbang yang sama, termasuk test lama yang diubah fitur ini (DEP-001 34 test, DEP-007 18 test, SDK-005 2 test, OPENAPI-004 51 test, MIG-005, READY-007, UI-002, dan TOOL-003). Tabel lengkap dengan kolom template laporan release ada di [`report.md`](evidence/0014/report.md).

## Hasil per kriteria

| Kriteria | Hasil dan bukti |
| --- | --- |
| AC-1 | Terpenuhi. AUTH-001 memeriksa tabel, kolom, constraint, FK, index, owner `foundation_owner`, tanpa RLS, trigger, atau schema baru pada PostgreSQL 18.6; `test:database:migration` dan check `migration_step` memakai sepuluh migration repository, database smoke memuat sepuluh migration, dan `restore.json` mencatat `Migrations: 0 applied, 11 skipped` dengan provisioning ulang `verified`. |
| AC-2 | Terpenuhi. AUTH-002 menjalankan setiap baris diizinkan dan ditolak *Matriks grant backend*, `PUBLIC`, dan `foundation_backup` dengan `permission denied` pada PostgreSQL nyata. |
| AC-3 | Terpenuhi. AUTH-003 (6 test database dan 4 test backend) membuktikan bentuk, stream, exit, *Prioritas galat*, lock per akun untuk `set-password` dan `revoke-sessions --email`, pencabutan saat ganti password, dan idempotensi; check `auth_account_job` membuktikan perintah di image runner sebagai job `migrate`, termasuk `Account exists` exit 1. |
| AC-4 | Terpenuhi. AUTH-004 (6 test database dan 3 test backend) membuktikan masuk di kedua mode, hash token di database, rotasi, batas 10 sesi termasuk masuk bersamaan, dan hash yang berubah menjawab 401; check `auth_session_cookie` membuktikan atribut cookie `__Host-` lewat edge. |
| AC-5 | Terpenuhi. AUTH-005 membuktikan jawaban identik untuk email tidak terdaftar dan password salah, satu verifikasi per jalur, dan median 23,6 ms berbanding 23,8 ms (rasio 1,01, batas 1,5); prioritas 400, 403, dan 415 dibuktikan test backend tanpa database. |
| AC-6 | Terpenuhi untuk bagian lokal. AUTH-006 membuktikan batas 10 per kunci dalam 15 menit termasuk request bersamaan, pembersihan baris kedaluwarsa, dan slot verifikasi; `auth_capacity` 8 dari 8 masuk 200 dalam paling lama 643 ms di container backend, dan `auth_edge_rate_limit` 23 jawaban 429 dari edge tanpa upstream. |
| AC-7 | Terpenuhi. AUTH-007 membuktikan idle, absolut, sesi dicabut, cookie rusak dan ganda, perpanjangan paling sering 60 detik dengan waktu digeser lewat SQL admin, dan statement perpanjangan yang mengubah nol baris untuk sesi berakhir. |
| AC-8 | Terpenuhi. AUTH-008 membuktikan keluar, daftar, pencabutan sendiri, akses lintas pengguna 404 tanpa efek, token yang dikirim ulang ditolak, bentuk header dan `sessionId` yang salah 400, dan pencabutan timbal balik tanpa deadlock. |
| AC-9 | Terpenuhi. AUTH-009 membuktikan penolakan origin, `Sec-Fetch-Site`, form urlencoded, CSRF, jalur yang dirutekan berbeda dari target, dan production tanpa `PUBLIC_ORIGIN` yang gagal start; `auth_origin_csrf` membuktikan penolakan 403 lewat edge dengan event `origin` atau `csrf`. |
| AC-10 | Terpenuhi. Keempat orkestrasi memindai password akun uji dan sidik token dengan kontrol positif tanpa temuan (database 274 nilai dan 164 sidik, readiness dan tooling masing masing 8 nilai dan 18 sidik, deployment 45 nilai dan 4 sidik); AUTH-010 browser membuktikan cookie `HttpOnly` `SameSite=Strict`, storage tanpa nilai auth, dan token CSRF hanya di body `AuthSession`; `log_no_data` dan `check:frontend:bundle` lulus. |
| AC-11 | Terpenuhi. AUTH-011 membuktikan kontrak kelima operasi, 204 tanpa `content`, `$ref` `AuthError`, dan mutasi `REQUIRED_OPERATIONS`; 78 test adapter `AuthApi`; `api:check` identik pada dua run. |
| AC-12 | Terpenuhi. AUTH-012 lulus di `test:readiness:real`, `test:tooling:real`, `test:e2e`, dan 54 test Vitest halaman dan state sesi, mencakup setiap baris *State halaman*, keyboard, dan kedua viewport; READY-007 dan UI-002 membuktikan `/` dan `/kesiapan` production tanpa request `/api/`. |
| AC-13 | Terpenuhi untuk bagian lokal. `test:deployment:real` lulus 41 dari 41 check termasuk kelima check auth, AUTH-013 lewat edge, dan baris log `auth` yang diterima `log_structure` serta berkorelasi pada `log_correlation`. |
| AC-14 | Terpenuhi. BKP-009 sebagai test terakhir `backup.test.ts` mencatat `sessions` `{200, 401, 1, 0}` dan `restore.json` tetap `passed`; BKP-001 (16 test) memeriksa langkah 8, prosedur insiden, dan keputusan hook di `docs/rules/backup.md`; BKP-003 dan BKP-004 lulus dengan asersi baru. |
| AC-15 | Terpenuhi untuk bagian lokal. `tests/scenarios/auth.json` lolos `test:scenarios` (108 ID unik dan 165 check) dengan AUTH-012 dan AUTH-013 `critical`; GATE-009 lulus dengan suite auth; AUTH-014 dan BKP-001 lulus; dan `test:ci`, `test:ci:real`, serta `test:ci:security` lulus pada pohon sumber akhir. Pohon kandidat yang masuk commit dan run CI baru dibuktikan sesudah push. |

## Riwayat run

Gerbang ini adalah run pertama keempat perintah gate pada pohon sumber akhir. Run sebelumnya tercatat oleh tahap masing masing dan tidak diulang angkanya di sini: milestone 5 menjalankan gate lokal penuh (103 skenario), `/check verify` menjalankan gate lokal dan harness sendiri ([verify.md](../specs/0014-akses-pengguna-lifecycle-sesi/verify.md)), `/test` menambah 73 test dan menjalankan ketiga tier, dan review ulang menjalankan suite database auth (36 test), `test:integration` (705 test), `test:readiness:real` (6 test), dan `test:deployment:real` (41 check) sesudah perbaikan review. Pohon sumber berubah sesudah run tersebut (perbaikan review, CHANGELOG, dan scope), dan review ulang mencatat bahwa `test:ci:real`, `test:ci:security`, `test:tooling:real`, serta `test:database:real` penuh belum diulang sesudah perbaikan, sehingga gerbang ini menjalankan ulang seluruh tier pada pohon sumber akhir.

## Identitas artefak

| Artefak | SHA-256 |
| --- | --- |
| Pohon sumber gerbang akhir (ketiga manifest) | `4cfa7461363c455bb3a2e2f67c2a6a18be5f8347e3cb9ffb662dda392027b480` |
| `.github/workflows/application.yml` (tidak berubah sejak fitur 12) | `edda79e565b79b9a5d204e9aaf57df86d3eae11adb723f0bb31796e3eb0fe164` |
| `.github/workflows/capacity.yml` (tidak berubah sejak fitur 12) | `7b3305f463cc3eb4d43335a12362abf70bc8a3feb07b396061aaad62fd2fb052` |
| `package.json` (root script `db:accounts`) | `771df0a2fc1e86ea95601cd7f9b3829ac6b21c42a8d073a81b9a6ccdc2e64a13` |
| `bun.lock` (tidak berubah, tanpa dependency baru) | `709aa822bcd149ec2967ed79fffefe1248ddd47e8cfeee2146d68384c32de656` |
| `openapi.json` | `07536c3802337c07e7206e8554bb1a8cb991195c098f1bf875096fb4d1028f37` |
| `apps/frontend/sdk/` (manifest gate) | `bfebafca5383722977ce6358f579aa352800ba19e8a666b6611fc8c9a58a04ac` |
| `tests/scenarios/` (manifest gate) | `fb0d20873f914e99e1c795b91c5d4f65a377bf3fb327beccb956e1e70aed093d` |
| `apps/frontend/dist/frontend/` (keluaran ketiga tier) | `c9964376d0d59bede2667bf5d1609ef53a8b8efdd81cff56f60afb822a7aec01` |
| `dist/backend/index.js` (keluaran ketiga tier) | `dd928a72763b42d1afef82917e0182d596850b45079ec1aeeaf8922112e8e799` |
| `apps/backend/src/features/auth/auth.guard.ts` | `616a5bcb725aca5780302e1df786a33f3624b7ca032984d478b39446ad015551` |
| `apps/backend/src/features/auth/auth.routes.ts` | `80696323187c734a6b4a808d29b4d3ca5d3d2dbd0fdbe9ed9817c4434fdac9ec` |
| `apps/backend/src/features/auth/auth.queries.ts` | `e6a77b65e788ff04becc8f456af44d40163eabe7dbde457b312f3dc580d6a2a9` |
| `apps/backend/src/plugins/request-guard.ts` | `f615d850107ed075d13a7a6e616543b8e5358b6cdede2793b822572a904f82c0` |
| `libs/server/auth/credentials.ts` | `96ec2fd1f2e1658f71cbb6a802d8dfccf16a084577d04316d59b027edbfbf0a4` |
| `libs/server/auth/account-lock.ts` | `1505f301cabca03b533fe94fca8505dbb9c25a4fdc43064dc7ed075fb408503d` |
| `database/accounts.ts` | `a5408b2fd82aa479f63dc3b8622f70a8c7cdbd1ae98ea0aa0fca748fb3f32aa1` |
| `database/migrations/0010-auth-grant-backend-sign-in-attempts.sql` | `350d1c365d3b735e330cfd663cc55df635ffdb1cd03d8daa6890da9c41ae3cbe` |
| `database/Dockerfile` | `65c270b59f9fd64fba15e32280e331ea64fe8bb741ea9109d565a105edae6ba2` |
| `apps/frontend/edge/nginx.conf` | `33bb2d4256392d3b1e69fffb00d8e83c6f8b7116f0b4de089f74faad0a589455` |
| `deploy/compose.yaml` | `f867c10416b54a84771c7cf643b67c3d7e1d757f132e12f70a65f311c82fea71` |
| `tests/orchestration/token-fingerprints.ts` | `27d197daa174c45ae62111cf8457647476a0817bb87483b527c65f0a669c9492` |
| `tests/orchestration/database-real.ts` | `4688455f3a1eb4e54c51e7b824261ad21359ff567d214330aa02824a529eda98` |
| `tests/orchestration/deployment-real.ts` | `85578704027b4cf88f0abbca19ed4ea0cb4affb4f107300d49e2594b1d1ed2b7` |
| `tests/integration/database/auth.test.ts` | `6e1ff597114af3219d8018821dbe9002951def851e746f97653b6a9518fd612e` |
| `tests/integration/backend/auth.test.ts` | `0ed476b1301078e1d4366c721f2fb5b97c7ecd85fce9aa8369fb0bb7b589c13f` |
| `tests/integration/database/backup.test.ts` | `80fe491250dfaf054fb606aedf91fee8eee62e1cdaf70169969d25fc44eacae7` |
| `tests/integration/deployment/auth-static.test.ts` | `580a19b44281c103d1faeadc33c74fbe0c83a13087384b0796ef36c86fda5642` |
| `tests/scenarios/auth.json` | `03facdb02d963a0571013ede84c166fe4ff9341fa396e32f75aa04b09aadffd3` |
| `tests/scenarios/backup.json` | `333ef482d9a7591527bc417b1d0b8009ab7d74e6ae77a075826f1fdfc853ed87` |
| `docs/rules/backup.md` | `6d1f91b31897bf55dd7acc336a29a48fab48ea8a8ca8d398cea2fda9219fa0c8` |
| `docs/rules/security.md` | `836a2c80853b0c35d747dc64bf256fa07df183eee5ad9cbf923ff2eb5ddb3580` |
| `evidence/0014/restore.json` | `0abb991183ef99c3afaf5c70684953a77505f4d5a6e650828b8b106e70e258c8` |
| `evidence/0014/deployment-result.json` | `884588f4bf74153d6eb8aaee383397d13a6cb1227e3a117259c727d7b08f0692` |
| `evidence/0014/artifact-scan-database.json` | `4bbb02945149f33fa25b320d3e0db4a49354b765e115ddc31f52f3526b1fb8bb` |
| `evidence/0014/artifact-scan-readiness.json` | `c7e76828bce11c7d04aafe7f836ec7f11b437d750e383d2803bc1d17aedf51c7` |
| `evidence/0014/artifact-scan-tooling.json` | `5c5d5c9462696b49a3b15cfdd9107a67debf09e1e0c51b50d1433943c130b040` |
| `evidence/0014/artifact-scan-deployment.json` | `c93657343dcdce500233b4c0abcbcf7d7a610a613a3131db591a37bdef48ab3f` |
| `evidence/0014/database.xml` | `f8866312dde8052ad8f0bf0ead964c39f77a0c49b3babfa7e21059bb1e1bd3e3` |
| `evidence/0014/integration.xml` | `2891cc9841b1bdd4b0ca5f6bbf7be61dd14022d4ca20c63f99d19fa24dfadcd2` |
| `evidence/0014/frontend.xml` | `b72f44fcf8fcfd8d85a13dedb0c45bb182fd97170d17f8ca2f4eb036781ac4f7` |
| `evidence/0014/plan.xml` | `4f1d9fccb3cfc3cc5cc41e283167a6724004b1461acb6a2320a75bd2e73ab530` |
| `evidence/0014/playwright.xml` | `92d1265d211fab8dddca6f310fbda0d9526ec9a385c52c07b4c4cd2e74993fb3` |
| `evidence/0014/playwright-readiness-real.xml` | `0625668f27765c559f306f9cadac68c75f810fd9f32ecf2e6f2a318fffbc948a` |
| `evidence/0014/playwright-tooling-real.xml` | `de0e3d43d57980cf853032f32511a038d25734d156c40cc5a8ab16694ffb162c` |
| `evidence/0014/playwright-deployment.xml` | `2d81af21925fb84983f8e6ee3e81dc6841f61871d01f97ca0b15ba437b32f27d` |
| `evidence/0014/gate.xml` | `a641d8184246b342723349fddf8db5d70841eed8a47a8874f82f1ced407348c3` |
| `evidence/0014/manifest-fast.json` | `4b30f1a461713e772bd8ceedf9baf472b7b35b9f1aa4c827adb6196725b48211` |
| `evidence/0014/manifest-real.json` | `f0a26570876ecd65ff67d61c71ccbe69fb2f9167e1d81f7a2fe92d155877f861` |
| `evidence/0014/manifest-security.json` | `ae3509103a1b274bc52124cb741b9978dc94e3c93d93b60aa222f8d8b53c748b` |
| `evidence/0014/report.json` | `c02a8827ad5a6ba4a5386041a6a236572730ff2f7b51afe8c486cfae1750dc29` |
| `evidence/0014/report.md` | `1cac452379ec351933ed9672e25cde13b56db400131b240d0f79836266499dda` |
| `evidence/0014/release.json` | `d6e177d305d72234b2e4b180ec680d83030a076d96ced90e7bd99b12c5a1e1c5` |
| `evidence/0014/release.md` | `98621bc980f05c9c019f5261966aceabff0fc76ac97447a426e87d0ab3ebbc4a` |
| `evidence/0014/security.json` | `f2696f63d9abc8d7be17c8dcff98a0f4b53ced3ccb4800205e026d4a30538cfc` |

## Bukti yang disalin

Salinan di `evidence/0014/` berasal dari gerbang akhir. Path di dalamnya merujuk bundle `.local/` yang tidak masuk repository.

- Bukti restore dan pemindaian, disalin byte demi byte: [`restore.json`](evidence/0014/restore.json) (SHA 256 sama dengan manifest tier nyata) dan keempat pemindaian orkestrasi [`artifact-scan-database.json`](evidence/0014/artifact-scan-database.json), [`artifact-scan-readiness.json`](evidence/0014/artifact-scan-readiness.json), [`artifact-scan-tooling.json`](evidence/0014/artifact-scan-tooling.json), dan [`artifact-scan-deployment.json`](evidence/0014/artifact-scan-deployment.json).
- Hasil deployment: [`deployment-result.json`](evidence/0014/deployment-result.json) dari `.local/feature-13/result.json` dengan ke 41 check dan `detail` nya.
- Laporan per push dari `test:report`: [`report.json`](evidence/0014/report.json) dan [`report.md`](evidence/0014/report.md), beserta manifest [fast](evidence/0014/manifest-fast.json), [real](evidence/0014/manifest-real.json), dan [security](evidence/0014/manifest-security.json), serta [`security.json`](evidence/0014/security.json).
- Status release lokal: [`release.json`](evidence/0014/release.json) dan [`release.md`](evidence/0014/release.md).
- JUnit yang memuat skenario AUTH dan BKP-009: [`database.xml`](evidence/0014/database.xml) dari `.local/feature-5/database.xml`, [`integration.xml`](evidence/0014/integration.xml) dari `.local/feature-4/server.xml`, [`frontend.xml`](evidence/0014/frontend.xml) dari `.local/feature-4/frontend.xml`, [`plan.xml`](evidence/0014/plan.xml) dari `.local/feature-13/plan.xml`, [`playwright.xml`](evidence/0014/playwright.xml) dari `.local/feature-4/playwright.xml`, [`playwright-readiness-real.xml`](evidence/0014/playwright-readiness-real.xml) dari `.local/feature-10/playwright-real.xml`, [`playwright-tooling-real.xml`](evidence/0014/playwright-tooling-real.xml) dari `.local/feature-2/playwright-real.xml`, [`playwright-deployment.xml`](evidence/0014/playwright-deployment.xml) dari `.local/feature-13/playwright-deployment.xml`, dan [`gate.xml`](evidence/0014/gate.xml) dari `.local/feature-11/gate.xml`. Kesembilan file ini disalin tanpa atribut `hostname` dan lulus `xmllint --noout`, sehingga SHA 256 nya berbeda dari file asli di bundle.

Screenshot Playwright tetap di bundle lokal dan tidak disalin. Pemeriksaan `postgres://`, `postgresql://`, `/Users/`, `/var/folders`, `/private/tmp`, `hostname=`, nama host, dan alamat email atas seluruh salinan tidak menemukan apa pun.

## Batas bukti dan tindak lanjut

- Run GitHub Actions belum ada karena working tree belum masuk commit dan belum di push. Job `real` di runner `ubuntu-24.04` (latency verifikasi Argon2id pada container backend `cpus` 1 terhadap batas 2.000 ms `auth_capacity`, stabilitas rasio median AUTH-005 paling banyak 1,5 di runner yang bising, dan durasi `test:database:real` terhadap batas 900 detik serta `timeout-minutes` job) dan gitleaks atas commit fitur oleh job `security` dicatat sebagai bukti terpisah sesudah push. Bila rasio AUTH-005 gagal di CI, kegagalan itu diselidiki sebagai kemungkinan kebocoran waktu, bukan dilonggarkan; bila `auth_capacity` gagal, antrean atau batas container diubah lewat pembaruan spec, bukan parameter hash di bawah minimum OWASP.
- Seluruh run berjalan di macOS arm64 dengan Docker Desktop. Batas edge per client diuji lewat satu alamat client lokal, dan kapasitas masuk hanya dibuktikan `auth_capacity` (8 masuk bersamaan); profil k6 tidak berubah dan belum punya journey masuk (butir Follow-up spec).
- Angka kebijakan (idle 30 menit, absolut 12 jam, 10 percobaan per 15 menit per akun, edge 30 request per menit dengan burst 10, dan 10 sesi per pengguna) diputuskan agent atas delegasi pemilik dan menunggu penerimaan pemilik untuk produk nyata; risiko butir 4 hook backup (tanpa enkripsi atau tanda tangan backup di sisi client), kebutuhan hukum dan retensi email serta nama tampilan (termasuk 35 hari di backup), dan `key_hash` serta `accountKey` SHA 256 tanpa kunci (keputusan 77) tercatat sebagai risiko yang diterima di spec dan rationale.
- [Review awal](../reviews/2026-10-06-main-user-session.md) dan [review ulang](../reviews/2026-10-06-main-user-session-followup.md) berakhir Approve with nits tanpa blocker atau major yang tersisa. Minor review ulang tertutup sebagian oleh gerbang ini: `test:ci:real`, `test:ci:security`, `test:tooling:real`, dan `test:database:real` penuh (termasuk BKP-009 dan pemindaian sidik token) kini lulus pada pohon sesudah perbaikan. Bagian `verify.md` dari minor itu tetap terbuka: baris gate di bagian milestone 5 tanpa tanggal, belum ada langkah verifikasi untuk perilaku sesudah review (404 untuk jalur yang dirutekan berbeda, lock per akun operator, pencabutan timbal balik tanpa deadlock, dan trim `Content-Type` linear), kalimat amandemen spec lain yang sudah usang, dan tujuh kotak yang masih terbuka. Sepuluh nit juga tetap terbuka, termasuk `reloadList()` yang tidak dilacak, `ORDER BY` tanpa penentu seri akhir, index `window_started_at` untuk migration fitur 16, host `PUBLIC_ORIGIN` di bawah 4 karakter, catatan upgrade `FOUNDATION_PUBLIC_ORIGIN`, batas edge untuk route baca, dan komentar `csrfToken` yang usang.
- Catatan terbawa dari build: aturan nama tampilan menolak `\p{Cc}` di JavaScript sedangkan `users_display_name_check` memakai `[[:cntrl:]]` yang pada sebagian locale juga mencocokkan karakter seperti U+2028 (gagal keras sebagai `Account command failed`); ikon keluar di footer layout wrapper belum disambungkan; dan statement pembersihan percobaan dapat menghapus satu hitungan baru kunci lain saat balapan di bawah READ COMMITTED (dibangun sesuai teks spec).
- Pembersihan sesi dan sisa percobaan yang berakhir belum ada sampai job worker fitur 16; sampai itu baris sesi yang berakhir hanya dibatasi batas edge.
- Tier kapasitas `test:ci:capacity` tidak dijalankan ulang. Fitur ini tidak mengubah profil k6 atau orkestrasi kapasitas; smoke pada tier nyata gerbang ini lulus dengan 18 dari 18 threshold. Karena itu status release lokal memuat `capacity_incomplete` dan `candidate_differs`.
- `build:frontend` tetap memberi warning anggaran awal 500 kB (initial total 688,58 kB); anggaran error 1 MB terpenuhi.
- Laporan ini adalah bukti fitur, bukan bukti kesiapan release, dan status kesiapan apa pun tidak memberi izin deploy.

## Pemeriksaan sesudah dokumen diperbarui

Sesudah laporan ini, salinan di `evidence/0014/`, scope, dan baris **Status** spec 0014 ditulis, perintah berikut dijalankan sekali tanpa retry. Perubahan dokumen itu mengubah pohon sumber, jadi bundle gerbang di `.local/feature-11/evidence/` kini tidak lagi terikat pada working tree (`test:report` akan memberi `source_tree_differs`) sampai tier dijalankan ulang; bukti gerbang akhir tetap bundle yang dicatat di atas.

| Perintah | Hasil aktual |
| --- | --- |
| `bun run test:scenarios` | Exit 0, `Scenario registries passed (108 unique IDs, 165 checks).` |
| `bun run check:test-discovery` | Exit 0, 51 file test dengan pembagian yang sama. |
| `bun run check:workflow` | Exit 0, `Workflow lulus: application.yml (application 8 langkah, real 8 langkah, security 4 langkah, report 7 langkah), capacity.yml (capacity 7 langkah).` |
| `bun --no-env-file test ./tests/integration/deployment` | Exit 0, 74 test dengan 1.368 assertion dalam 32,0 detik, termasuk 2 test AUTH-014 dan 16 test BKP-001 yang membaca dokumen aturan. Dijalankan tanpa reporter JUnit, sehingga `.local/feature-13/plan.xml` tidak ditimpa. |
| `bun --no-env-file test ./tests/integration/gate` | Exit 0, 270 test dengan 2.151 assertion dalam 63,4 detik, termasuk aturan pengecualian pemindai untuk `docs/testing/evidence/<NNNN>/*.json`. Dijalankan tanpa reporter JUnit, sehingga `.local/feature-11/gate.xml` tidak ditimpa. |
| gitleaks atas working tree | Setiap file `git ls-files -co --exclude-standard` working tree (530 file, sekitar 11 MB) disalin ke folder scratchpad di luar repository (file `.env` lokal yang diabaikan Git tidak ikut; hanya keempat file `.env*.example` yang ikut), lalu image gitleaks yang dipin (`v8.30.1@sha256:c00b6bd0…abbb7f`) dijalankan mode `dir` atas sumber `.` dengan `tests/security/gitleaks.toml`, `--ignore-gitleaks-allow`, dan isolasi container yang sama dengan `check:security`. Hasilnya `no leaks found` atas sekitar 9,82 MB. Container memakai `--rm` dan tidak tersisa. |

Sesudah tabel ini ditulis, salinan dan pemindaian gitleaks yang sama diulang atas working tree akhir: exit 0 dengan `no leaks found` atas sekitar 9,82 MB, lalu folder salinan dihapus. Kalimat ini satu satunya perubahan sesudah pemindaian terakhir itu. Commit fitur sendiri baru dipindai gitleaks mode `git` oleh job `security` sesudah push.

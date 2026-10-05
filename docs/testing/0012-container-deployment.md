# Bukti fitur 13: Build container dan deployment terpisah

Tanggal: 2026-10-05 (waktu UTC; waktu lokal 2026-10-06 UTC+7). Bukti fitur yang berlaku adalah gerbang akhir pukul 20.18 sampai 20.29 UTC (manifest tier cepat mulai 20:18:53Z, manifest tier keamanan selesai 20:28:54Z, laporan per push dibuat sesudahnya, dan `release.json` dibuat 20:29:05Z), sesudah `/develop` kelima milestone beserta langkah penyelarasan 6 sampai 9 build plan, `/check verify`, `/test`, `/check review` beserta perbaikan temuannya, dan `/document`. Kriteria: [spec 0012](../specs/0012-build-container-deployment-terpisah/index.md) AC-1 sampai AC-12. Bukti berasal dari checkout `main` pada dasar `4c0b44f8df8b947ad313542bde11c8297fcc7135` dengan seluruh perubahan fitur 13 yang belum masuk commit. SHA 256 pohon sumber `fe7865ae48c6dd3e12c4b4a9f9dda413b4f3964a504980e7abd9f896430f5bcd` sama pada awal dan akhir ketiga tier menurut manifest, label ketiga image deployment mencatat pohon sumber yang sama, dan `git status --porcelain` sama sebelum dan sesudah gerbang, jadi kode tidak berubah selama gerbang. Laporan ini, salinan bukti di `evidence/0012/`, scope, dan baris **Status** spec ditulis sesudah gerbang dan hanya mengubah dokumen.

**Status akhir:** keempat perintah gate per push lulus pada satu run berurutan tanpa retry. `bun run test:ci` 19 dari 19 langkah, `bun run test:ci:real` 7 dari 7 langkah dengan `test:deployment:real` 36 dari 36 check, `bun run test:ci:security` 1 dari 1 langkah, dan `bun run test:report` keluar 0 dengan `Gate passed`: 80 dari 80 skenario `passed` (termasuk DEP-001 sampai DEP-009), kelima alur kritis lulus (APP-002, DEP-006, READY-006, READY-009, dan UI-001), discovery dan ketiga pemindai lulus, pengikatan sah, `performance k6: smoke passed`, dan `deployment: passed (36 dari 36 check passed)`. `bun run test:report:release` atas bundle lokal keluar 1 dengan status `incomplete`, seperti yang ditetapkan spec untuk bundle yang bukan run CI, dengan `grantsDeployment` `false` dan tanpa `image_differs`. AC-1 sampai AC-12 terpenuhi untuk bagian lokal. Job `real` di runner GitHub, artifact CI, dan status `ready` dari bundle CI yang diunduh baru dapat dibuktikan sesudah push dan run `capacity.yml` untuk commit yang sama. Gerbang ini bukan kandidat release (`not_clean` dan `not_ci`), karena working tree belum masuk commit dan tidak berjalan di CI.

## Lingkungan

macOS 27.0 (arm64, Apple M1 Max, 10 CPU, 32 GiB memory), Bun 1.4.2, Node 24.21.0, OpenSSL 3.6.3 di host. Docker Desktop dengan Docker Engine 29.8.0, Docker Compose 5.5.1, dan buildx 0.37.1; mesin container melihat 10 CPU dan 8.319.504.384 byte memory. Tujuh container proyek lain berjalan tanpa label `foundation.test` sepanjang gerbang, termasuk PostgreSQL Compose bersama milik proyek ini (`foundation-postgres-1`, tetap `Up` dan `healthy`), dan tidak ada yang disentuh. Tidak ada suite lain yang berjalan bersamaan dengan langkah mana pun. Port 8888 dan 8889 kosong sebelum dan sesudah gerbang.

Image yang dipakai:

| Komponen | Image dan digest |
| --- | --- |
| Image dasar edge | `node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe` (stage build Angular), `oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61` (stage install), dan `nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94` (stage akhir) |
| Image dasar backend dan runner migration | `oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61` |
| PostgreSQL 18.6 | `foundation-postgres:18-pinned`, image id `sha256:ae46ecb5a415709c581143261631a9063e753e85c37353083811d1637d91e775`, linux arm64, base `oraclelinux:10-slim@sha256:0660af1f1bb56559b299d99d3b71d0ff51f9d593cecbd3154a46914704ec34d6`, paket `18.6-4PGDG.rhel10.2`; dibangun ulang dari pin yang sama oleh langkah `test:infrastructure` gerbang ini dan dipakai oleh setiap suite nyata, termasuk topologi deployment |

Image deployment yang dibangun `test:deployment:real` dari salinan input build di folder `mkdtemp`, dengan root monorepo sebagai build context, lalu dihapus pada akhir run:

| Image | Image ID | Ukuran (byte) | User | File di stage akhir | Revision dan pohon sumber |
| --- | --- | --- | --- | --- | --- |
| frontend (edge) | `sha256:36e4250653e74f6099be23562b273fdd3b10a960c8936abf2216a7d04cea09dc` | 93.144.953 | `101:101` | 2.151 | `4c0b44f` dan `fe7865ae…0f5bcd` |
| backend | `sha256:536e32567062be140702aadd4c1bedd833db661435c655da33cd0c7cd9790809` | 275.358.657 | `1000:1000` | 3.782 | `4c0b44f` dan `fe7865ae…0f5bcd` |
| migrate | `sha256:6bc9cd27491672904b440206eb6e1b46797fb2a2f9064b78acbe09c155b04178` | 274.610.351 | `1000:1000` | 3.792 | `4c0b44f` dan `fe7865ae…0f5bcd` |

Tag ketiganya `foundation-<nama>:deploy-0dbea2d8761b` (run `0dbea2d8761b`). Image tidak didorong ke registry, dan tidak ada deploy ke environment luar.

## Perintah dan hasil gerbang akhir

Gerbang menjalankan keempat perintah gate per push lalu `test:report:release`. Tier nyata memuat setiap suite nyata yang disentuh fitur ini: `test:infrastructure`, `test:database:real` (dengan suite baru DEP-009), `test:database:migration`, `test:tooling:real`, `test:readiness:real` (route readiness memakai penjaga bersama baru), langkah baru `test:deployment:real`, dan smoke k6 atas `/api/status` dan `/api/readiness`. Tier cepat memuat langkah baru `test:deployment:plan` dan setiap suite yang file nya diubah fitur ini. Setiap script yang dirujuk registry `tests/scenarios/` tercakup. Setiap perintah dijalankan satu kali, berurutan, tanpa retry, dan tidak ada yang gagal.

| Perintah (waktu UTC) | Hasil aktual |
| --- | --- |
| `bun run test:ci` (20.18.53 sampai 20.23.11) | Exit 0, 19 dari 19 langkah `passed`. `test:scenarios`: `Scenario registries passed (85 unique IDs, 121 checks).`; `check:test-discovery`: 39 file test (Vitest 4, Playwright `playwright.config.ts` 4, Playwright `playwright.real.config.ts` 1, Playwright `playwright.deployment.config.ts` 1, `bun:test` 29); `check:workflow`: `Workflow lulus: application.yml (application 8 langkah, real 8 langkah, security 4 langkah, report 7 langkah), capacity.yml (capacity 7 langkah).`; `api:check`: `OpenAPI and SDK match stored artifacts across two runs`; `build:frontend` initial total 685,31 kB dengan warning anggaran 500 kB yang sudah ada; `check:frontend:bundle` lulus; keempat typecheck exit 0; `test:frontend` 81 test; `test:integration` 668 test dengan 4.101 assertion dalam 83,4 detik; `test:tooling` 54 test dengan 209 assertion; `test:gate` 268 test dengan 2.071 assertion dalam 60,6 detik; `test:performance:plan` 78 test dengan 1.538 assertion; `test:deployment:plan` 51 test dengan 933 assertion dalam 31,5 detik; `test:e2e` 12 test. Seluruhnya 0 gagal dan 0 dilewati. |
| `bun run test:ci:real` (20.23.18 sampai 20.28.35) | Exit 0, 7 dari 7 langkah `passed` tanpa testcase dilewati: `test:infrastructure` 18 test dalam 55,8 detik, `test:database:real` 37 test dengan 2.031 assertion dalam 54,7 detik (pemindaian artefak: 7 nilai acak tidak ada di 16 file), `test:database:migration` 5 test dalam 16,8 detik, `test:tooling:real` lulus dalam 29,8 detik, `test:readiness:real` lulus dalam 5,9 detik, `test:deployment:real` lulus dalam 87,2 detik dengan `36 check passed, 0 failed, 0 not_run`, dan `test:performance:smoke` sebagai langkah terakhir dalam 66,5 detik (4.403 iterasi sama dengan 4.403 request, 0 dropped iterations, 18 dari 18 threshold, dan pemindaian credential tanpa temuan atas 28 output). |
| `bun run test:ci:security` (20.28.44 sampai 20.28.54) | Exit 0; gitleaks v8.30.1 atas 47 commit, `bun audit` 1.4.2 atas 487 paket, dan actionlint 1.7.12 atas `.github/workflows/application.yml` dan `.github/workflows/capacity.yml`, ketiganya `passed` dengan 0 temuan. Pemindai juga mencetak `Working tree tidak bersih: perubahan yang belum masuk commit tidak dipindai gitleaks.` (lihat *Pemeriksaan sesudah dokumen diperbarui*). |
| `bun run test:report` (20.29) | Exit 0 dengan `Gate passed`: ketiga tier `passed`, 80 skenario (0 failed, 0 missing_test, 0 not_run, 0 skipped, 80 passed), alur kritis APP-002, DEP-006, READY-006, READY-009, dan UI-001 `passed`, discovery `passed`, ketiga pemindai `passed`, `pengikatan sah`, `performance k6: smoke passed`, `deployment: passed (36 dari 36 check passed)`, `Kandidat release: bukan (not_clean fast, not_clean real, not_clean security, not_ci fast, not_ci real, not_ci security, not_ci)`. Bagian *Di luar cakupan* hanya memuat profil kapasitas (fitur 12). |
| `bun run test:report:release` (20.29.05) | Exit 1 dengan `Status release incomplete`, sesuai spec untuk bundle lokal: gate per push `passed` tetapi bukan kandidat, laporan kapasitas `incomplete`, alasan `capacity_incomplete`, `gate_not_candidate`, `capacity_not_candidate`, dan `candidate_differs`, `grantsDeployment: false`. Tidak ada `image_differs`: label revision dan pohon sumber ketiga image sama dengan checkout. Bundle kapasitas lokal berasal dari gerbang fitur 12 (dasar `34e905d`, pohon sumber `7185cf7b…`), sehingga laporan kapasitas yang dihitung ulang tidak terikat pada checkout ini. Perintah hanya menulis `.local/feature-13/release.json` dan `release.md`; `.local/feature-11/report.json` dan `.local/feature-12/report.json` tetap dengan waktu tulis sebelumnya. |

Sesudah gerbang, daftar container, network, dan volume Docker sama dengan sebelum gerbang, tidak ada container atau image berlabel `foundation.test`, tidak ada network `foundation-deploy*`, daftar 11 folder `foundation-*` di `TMPDIR` sama sebelum dan sesudah gerbang, tidak ada proses orkestrasi yang tersisa, dan tidak ada listener pada port 8888 atau 8889. Satu perbedaan daftar image: tag `foundation-postgres:18-pinned` kini menunjuk `ae46ecb5a415`, dibangun dari pin yang sama oleh `test:infrastructure` seperti pada setiap tier nyata; image yang sebelumnya memakai tag itu (`94fbb8c11ed4`) tidak ada lagi.

Pemeriksaan mandiri atas bundle: ke 61 file bukti ketiga tier (24 tier cepat, 36 tier nyata termasuk file di folder screenshot, dan 1 tier keamanan) dihitung ulang SHA 256 nya dan semuanya sama dengan manifest. Ketiga manifest mencatat commit `4c0b44f`, `clean` false, `ci` null, dan pohon sumber yang sama pada awal dan akhir tier.

## Check deployment

Hasil `test:deployment:real` dari [`result.json`](evidence/0012/result.json) run `0dbea2d8761b` (20:26:01Z sampai 20:27:28Z). Kolom kriteria berasal dari `DEPLOYMENT_CHECKS` di `scripts/lib/gate.ts`, sama dengan tabel *Check deployment* spec. Detail diringkas dari `result.json`.

| Check | Kriteria | Hasil gerbang akhir |
| --- | --- | --- |
| `image_pins` | AC-1 | `passed`: 3 image dasar dipin tag dan digest |
| `image_context_sentinels` | AC-1, AC-2 | `passed`: 3 probe konteks sama dengan `expectedContext` (65 file) tanpa `.env` dan tanpa nilai sentinel; salinan tanpa `.env`, `node_modules`, `dist`, dan `.angular` |
| `image_filesystem` | AC-2 | `passed`: filesystem ketiga image tanpa nilai sentinel, password, DSN, atau path `.env`; isi stage akhir sesuai tabel *Image*; `checkFrontendBundle` lulus atas `/srv/frontend/` |
| `image_config` | AC-1, AC-2 | `passed`: `image inspect` dan `history` tanpa nilai sentinel; `USER` numerik, entrypoint, `STOPSIGNAL`, `HEALTHCHECK`, `ENV`, dan label sesuai tabel |
| `provisioning_step` | AC-3 | `passed`: `database/provision.ts --apply` keluar 0 lewat image runner |
| `readiness_before_migration` | AC-3, AC-4 | `passed`: `GET /health/ready` 503 `{"status":"unavailable"}` |
| `migration_step` | AC-3 | `passed`: perintah bawaan keluar 1 dengan `Use --apply`; migration 1 applied; rerun 0 applied dan 1 skipped; seed keluar 0 |
| `readiness_after_migration` | AC-3, AC-4 | `passed`: `GET /health/ready` 200 `{"status":"ready"}` tanpa restart backend |
| `tls_versions` | AC-5 | `passed`: ALPN `h2`; TLS 1.2 dengan cipher daftar tanpa session ticket; kontrol TLS 1.2 lulus dan TLS 1.1 ditolak dengan alert protocol version |
| `http_redirect` | AC-5 | `passed`: 12 request ke port HTTP dijawab 308 ke `https://localhost<path dan query>` dengan `Cache-Control: no-store`, tanpa HSTS dan tanpa upstream |
| `document_headers` | AC-5, AC-6 | `passed`: 28 jawaban di luar `/api/` memuat *Header dokumen* tepat, termasuk CSP final dan HSTS |
| `static_cache_fallback` | AC-6 | `passed`: aset ber hash `immutable` termasuk 304, 404 aset ber hash dan file berekstensi lain `no-cache`, path tanpa ekstensi `index.html` 200; 4 aset dari `index.html` |
| `api_forwarding` | AC-7 | `passed`: `/api/x.json` dan `/api/status` dengan query sampai ke backend (404 JSON backend, `upstreamStatus` 404 di log edge, baris log backend dengan ID edge) |
| `api_headers` | AC-7 | `passed`: 22 jawaban `/api/` memuat *Header API* tepat; jawaban edge `application/json` dan `no-store` |
| `api_stub_forwarding` | AC-7 | `passed`: stub menerima Host `localhost` tanpa header alamat client dan dengan `x-request-id` edge; 504 JSON; body 1.025 byte 413 tanpa sampai ke stub, 1.024 byte sampai |
| `cors_absent` | AC-7 | `passed`: tidak ada header `Access-Control-*` untuk Origin asing dan preflight |
| `edge_errors` | AC-7, AC-10 | `passed`: 13 bentuk traversal 400 dan body 1.025 byte 413 JSON; header 9.000 byte dan `/api/../../x` 400 bawaan nginx dengan *Header dokumen*; baris log edge `/api/../../x` 400 dengan `path` dan `upstreamStatus` kosong |
| `health_not_public` | AC-4, AC-7 | `passed`: 7 target di luar `/api/` dijawab `index.html` 200 dengan *Header dokumen* tanpa upstream; 2 target `/api/health` 404 JSON backend dengan *Header API* |
| `published_ports` | AC-8 | `passed`: hanya edge mempublikasikan port (HTTPS dan HTTP di 127.0.0.1); port backend dan postgres kosong |
| `network_isolation` | AC-8 | `passed`: `app` dan `data` `Internal: true`; `app` menjangkau backend `/health/live` 200 tetapi tidak `postgres:5432`; `data` menjangkau `postgres:5432` |
| `egress_blocked` | AC-8 | `passed`: kontrol `public` menjangkau `1.1.1.1:443`; `app` dan `data` tidak menjangkaunya dalam 3 detik |
| `compose_declaration` | AC-8, AC-10 | `passed`: `compose config --no-interpolate` tanpa override sama dengan tabel *Topologi* dan *Environment per service*, `json-file` 10m × 3, flag log PostgreSQL, tanpa nilai credential |
| `container_hardening` | AC-8 | `passed`: edge, backend, postgres, dan runner sesuai tabel (network, user numerik, CPU, memory, PIDs, read only, tmpfs, `CapDrop ALL`, `no-new-privileges`, restart `no`, stop timeout, healthcheck, `json-file`) |
| `container_environment` | AC-8 | `passed`: environment tambahan tepat tabel; backend hanya `DATABASE_URL` role `foundation_backend`, runner hanya `FOUNDATION_MIGRATOR_DATABASE_URL` |
| `browser_flow` | AC-6 | `passed`: DEP-006 lulus pada 1280×812 dan 375×812 tanpa pelanggaran CSP, error console, atau request `/api/` |
| `backend_shutdown_restart` | AC-9 | `passed`: stop backend 200 ms dengan exit 0 dan baris `stopped`; 30 jawaban (0 kali 504) lalu 502; 404 backend lagi 6.552 ms sesudah start tanpa restart edge |
| `backend_recreate` | AC-9 | `passed`: backend dibuat ulang dan diteruskan lagi 3 ms sesudah recreate tanpa restart edge; alamat network `app` sama pada run ini |
| `database_outage` | AC-4, AC-9 | `passed`: `/health/ready` 503 118 ms sesudah stop postgres, `/health/live` 200 dan edge `/` 200; 200 lagi 145 ms sesudah start tanpa restart backend |
| `edge_shutdown` | AC-9 | `passed`: stop edge (SIGQUIT) 321 ms dengan exit 0 |
| `log_structure` | AC-10 | `passed`: 142 baris JSON edge dengan key dan tipe AC-10, termasuk `status` 0 untuk stream HTTP/2 yang diakhiri tanpa jawaban; log backend JSON production (info hanya stdout, error hanya stderr) |
| `log_correlation` | AC-10 | `passed`: header `X-Request-Id`, baris log edge, dan baris log backend memuat ID yang sama; ID client tidak dipakai |
| `log_no_data` | AC-10 | `passed`: 43 nilai (sentinel query, Authorization, Cookie, header, body, termasuk saat 502; password dan DSN run) tidak ada di 14 keluaran container |
| `postgres_log_policy` | AC-10 | `passed`: `log_min_messages=log`, `log_min_error_statement=panic`, `log_error_verbosity=terse`; statement gagal bersentinel tidak masuk log |
| `topology_shutdown` | AC-9 | `passed`: `compose stop` 363 ms; edge, backend, dan postgres keluar 0 dalam stop grace masing masing |
| `artifact_scan` | AC-2, AC-11 | `passed`: 43 nilai run tidak ada di 9 file bukti dan 5 keluaran container ([`artifact-scan.json`](evidence/0012/artifact-scan.json)) |
| `cleanup` | AC-11 | `passed`: project, container bernama, image, dan folder run dihapus |

Batas bukti yang dicatat `result.json` dan ditampilkan `report.md`: topologi rujukan satu host Docker dengan sertifikat dari CA sementara; bukan bukti platform deployment, kapasitas, image di registry, atau ketiadaan kerentanan paket OS di image.

## Hasil per skenario

| Skenario | Kriteria | Bukti gerbang akhir | Status |
| --- | --- | --- | --- |
| `DEP-001` | AC-1, AC-2, AC-6, AC-7, AC-8, AC-10, AC-11, AC-12 | 29 test `tests/integration/deployment/static.test.ts` (`test:deployment:plan`, tier cepat), JUnit [`plan.xml`](evidence/0012/plan.xml) | `passed` |
| `DEP-002` | AC-4 | 16 test `tests/integration/backend/health.test.ts` (`test:integration`), JUnit [`integration.xml`](evidence/0012/integration.xml) | `passed` |
| `DEP-003` | AC-4 | 2 test `openapi-contract.test.ts` dan 2 test `readiness-contract.test.ts` (`test:integration`), 2 test Vitest `sdk-contract.integration.spec.ts` (`test:frontend`, [`frontend.xml`](evidence/0012/frontend.xml)), dan check `command` `api:check` | `passed` |
| `DEP-004` | AC-11, AC-12 | 15 test `tests/integration/gate/release.test.ts` (`test:gate`), JUnit [`gate.xml`](evidence/0012/gate.xml) | `passed` |
| `DEP-005` | AC-1 sampai AC-11 | check `command` `test:deployment:real` di tier nyata, exit 0, 36 dari 36 check | `passed` |
| `DEP-006` (alur kritis) | AC-6 | 2 test Playwright `tests/e2e/deployment/edge.deployment.e2e.spec.ts` lewat edge pada 1280×812 dan 375×812, JUnit [`playwright-deployment.xml`](evidence/0012/playwright-deployment.xml), screenshot [desktop](evidence/0012/edge-desktop.png) dan [mobile](evidence/0012/edge-mobile.png) | `passed` |
| `DEP-007` | AC-9, AC-10 | 17 test `tests/integration/backend/logging.test.ts` (`test:integration`), JUnit [`integration.xml`](evidence/0012/integration.xml) | `passed` |
| `DEP-008` | AC-8, AC-11 | 22 test `tests/integration/deployment/signal.test.ts` (`test:deployment:plan`), JUnit [`plan.xml`](evidence/0012/plan.xml) | `passed` |
| `DEP-009` | AC-4 | 8 test `tests/integration/database/health.test.ts` pada PostgreSQL 18.6 terisolasi (`test:database:real`, tier nyata), JUnit [`database.xml`](evidence/0012/database.xml) | `passed` |

Jumlah test per skenario dihitung `test:report` dari testcase yang judul lengkapnya diawali tag di JUnit gerbang ini. Ke 71 skenario fitur lain pada laporan per push (APP, DATA, GATE, INFRA, MIG, OPENAPI, PERF per push, READY, SDK, TOOL, dan UI) juga `passed` pada gerbang yang sama. Tabel lengkap dengan kolom template laporan release ada di [`report.md`](evidence/0012/report.md).

## Hasil per kriteria

| Kriteria | Hasil dan bukti |
| --- | --- |
| AC-1 | Terpenuhi. Ketiga Dockerfile dibangun dengan root monorepo sebagai build context dari salinan input build; `image_pins`, `image_context_sentinels`, dan `image_config` lulus, dan DEP-001 memeriksa bentuk Dockerfile, file ignore, dan pin. User numerik `101:101` dan `1000:1000` tercatat di [`images.json`](evidence/0012/images.json). |
| AC-2 | Terpenuhi. Probe konteks ketiga Dockerfile sama dengan `expectedContext` (65 file) tanpa `.env`, dan pemindaian filesystem, config, dan history image tidak menemukan nilai sentinel, password, atau DSN (`image_context_sentinels`, `image_filesystem`, `image_config`, `artifact_scan`). |
| AC-3 | Terpenuhi. Provisioning lewat image runner, perintah bawaan keluar 1 dengan `Use --apply`, migration 1 applied, rerun 0 applied dan 1 skipped, dan readiness 503 lalu 200 tanpa restart backend. |
| AC-4 | Terpenuhi. DEP-002 (16 test) dan DEP-009 (8 test pada PostgreSQL nyata) membuktikan live, ready, coalescing, batas 5.000 ms, dan pelepasan penanda; DEP-003 membuktikan kontrak dan `HealthService`; `health_not_public` dan `database_outage` membuktikan health hanya terjangkau dari jaringan internal dan readiness 503 lalu 200 saat database berhenti dan berjalan lagi. |
| AC-5 | Terpenuhi. `tls_versions` (ALPN `h2`, TLS 1.2 tanpa session ticket, TLS 1.1 ditolak sesudah kontrol positif), `http_redirect` (308 dengan `no-store`), dan HSTS pada `document_headers`. |
| AC-6 | Terpenuhi. `document_headers`, `static_cache_fallback`, dan `browser_flow` lulus; DEP-006 berjalan di bawah CSP final tanpa pelanggaran pada dua viewport, dan DEP-001 mengunci objek `optimization` production. |
| AC-7 | Terpenuhi. Hanya `location ^~ /api/` yang meneruskan ke backend; `api_forwarding`, `api_headers`, `api_stub_forwarding`, `cors_absent`, `edge_errors`, dan `health_not_public` lulus, termasuk 13 bentuk traversal, batas body 1.024 byte, header alamat client yang dikosongkan, dan 504 lewat stub. |
| AC-8 | Terpenuhi. `compose_declaration`, `published_ports`, `network_isolation`, `egress_blocked` dengan kontrol `public` yang berhasil, `container_hardening`, dan `container_environment` lulus; DEP-008 membuktikan pembersihan dengan nama eksplisit. |
| AC-9 | Terpenuhi. Stop backend 200 ms dengan exit 0 dan baris `stopped`, jendela 502 tanpa 504, forwarding kembali 6.552 ms sesudah start tanpa restart edge, recreate diteruskan lagi tanpa restart edge, readiness pulih 145 ms sesudah PostgreSQL berjalan lagi, stop edge 321 ms, dan stop topologi 363 ms; DEP-007 membuktikan proses production keluar tepat waktu. |
| AC-10 | Terpenuhi. `log_structure` (142 baris JSON edge), `log_correlation`, `log_no_data` (43 nilai tidak ada di 14 keluaran), `postgres_log_policy`, dan baris log edge `/api/../../x` pada `edge_errors` lulus; DEP-007 (17 test) membuktikan log backend production. |
| AC-11 | Terpenuhi. `test:deployment:plan` adalah langkah tier cepat sesudah `test:performance:plan`, `test:deployment:real` adalah langkah tier nyata sesudah `test:readiness:real` dan sebelum smoke, bukti `deployment` sah dan terikat pada manifest, laporan memuat bagian *Deployment* dengan kolom kriteria, dan DEP-008 membuktikan pembersihan pada SIGTERM, SIGINT, SIGHUP, dan batas total. |
| AC-12 | Terpenuhi untuk bagian lokal. `test:report:release` menghitung status dari bundle lokal, berakhir `incomplete` dengan alasan yang benar, hanya menulis `release.json` dan `release.md`, dan `grantsDeployment` `false`. Status `ready` dibuktikan DEP-004 dengan fixture dua identitas CI; status dari bundle CI asli menunggu push dan run `capacity.yml`. DEP-001 memeriksa string wajib di ketujuh dokumen dan larangan baris push, login, dan tag. |

## Riwayat run

Gerbang ini adalah run pertama keempat perintah gate pada pohon sumber akhir. Run sebelumnya tercatat oleh tahap masing masing dan tidak diulang angkanya di sini: milestone 5 menjalankan gate lokal penuh (19 dari 19, 7 dari 7, 1 dari 1, 36 dari 36 check), `/check verify` menjalankan `test:deployment:real` dua kali, `test:ci:real` sekali, enam run sinyal, satu run batas total, dan langkah operator dengan tangan ([verify.md](../specs/0012-build-container-deployment-terpisah/verify.md)), dan kedua review menjalankan ulang tier nyata dengan 36 dari 36 check. Uji mutasi tahap tahap itu sengaja membuat check gagal pada salinan sementara, dan hasilnya tercatat di `verify.md` dan kedua review. Pohon sumber berubah sesudah run tersebut (perbaikan review, `verify.md`, CHANGELOG, dan scope), sehingga gerbang ini menjalankan ulang seluruh tier pada pohon sumber akhir.

## Identitas artefak

| Artefak | SHA-256 |
| --- | --- |
| Pohon sumber gerbang akhir (ketiga manifest dan label ketiga image) | `fe7865ae48c6dd3e12c4b4a9f9dda413b4f3964a504980e7abd9f896430f5bcd` |
| `.github/workflows/application.yml` (tidak berubah sejak fitur 12) | `edda79e565b79b9a5d204e9aaf57df86d3eae11adb723f0bb31796e3eb0fe164` |
| `.github/workflows/capacity.yml` (tidak berubah sejak fitur 12) | `7b3305f463cc3eb4d43335a12362abf70bc8a3feb07b396061aaad62fd2fb052` |
| `package.json` | `d9c14419ac240d1da2612fe32399b1306d2249460359ea7c1b818e60e8ea1bd4` |
| `bun.lock` | `e74e16b34cde3c1a76d17328f5da63da16614409318218231e320d0a2e1fcc3f` |
| `openapi.json` | `f6c31a95f949fae4c3387a83362a2a3460cadd6c50802d9706e05bd23505b611` |
| `apps/frontend/sdk/` (manifest) | `e1edb26c945c62907c8025f605311980f31840754af8e8273ef67409bcaa03f0` |
| `deploy/compose.yaml` | `8d623cce22438fb763d266e66ce0b4c534417da94189fb4687675fc05a01507d` |
| `.env.deploy.example` | `53d9fb3cce72951841b0c92d2e40ac277a42f845b45ef0c7bb7aca66298acdf2` |
| `apps/frontend/Dockerfile` | `e6d8fbcf939813016f3183300dbd19ef181636ca1bf368f406387d720061018b` |
| `apps/backend/Dockerfile` | `6f5f9351c485d342993dabb1de340747232a2f89813b74cd907f2bb642fcfc6e` |
| `database/Dockerfile` | `47a5b4f13b0b053d9cfe0c6121eeef039df5671e22ce54d3ff3e1bdab16052df` |
| `apps/frontend/edge/nginx.conf` | `f1ccdc5ba614172825830132d917c15d0d53d8ee736b7613dc7dca5e3f50d548` |
| `apps/frontend/edge/document-headers.conf` | `2d36c5eb489cbe0d7b04fdb4a057d62987300590a5dd194a908a1b63f1621d70` |
| `apps/frontend/edge/api-headers.conf` | `ba49a898918b07d60ab8b68c3511cf77cf3096b43d084a4e38c767fd440e1838` |
| `tests/orchestration/deployment-real.ts` | `c8b9d8cc35c6f135648fd1e5d3683c2b36cb95fad971d4f7d70852fcab7c7170` |
| `tests/scenarios/deployment.json` | `8169f6f39d925882e0f05edf82a372b3b8b8f188c032dc43a59d4cc17f800c43` |
| `playwright.deployment.config.ts` | `aa6b8453bb7a3990a38f0a2193236dc8d825617765fcc2a359f8ce3c16d5a311` |
| `docs/rules/deployment.md` | `7a02c890e990d90095b895bcea93be70a9cd791275b8914d1f0d1cdae1ca4838` |
| `evidence/0012/result.json` | `43a52192b15ab442607f8e1ce1d9d503ee077b5c3f5306c1f6357706288c041c` |
| `evidence/0012/images.json` | `5a9c72cfcc0dbaf455dea0338f5e053520c076c02eb6ee4061471b9efe47f90b` |
| `evidence/0012/artifact-scan.json` | `1121e1894ff680b97199e6867a21b17c8244e857820a27564256fa4d4db271d8` |
| `evidence/0012/playwright-deployment.xml` | `7c62ca1dad3c8b1af0a2064354ca0d61266d62e748ca47bae1185452fc92d830` |
| `evidence/0012/plan.xml` | `df026152f74196d5409f5acb88e1361b790afb0dd69b92168b68b0e591b24102` |
| `evidence/0012/integration.xml` | `c1fa15d3951e274ed9b0c9c18ca28dbcec0a0305527abf0c48dbacf98271b591` |
| `evidence/0012/gate.xml` | `24a6eedd2a3d53d360ec4181081be5c08a30bda6c6ad7c714f84d710d379d3ee` |
| `evidence/0012/database.xml` | `3bf07ff5a23e9e16053a762670cd3450f6d5bad58a6f54dde2d5390619ead8e3` |
| `evidence/0012/frontend.xml` | `69c1fa0e8afa37aa3bc7c1dda09ab97f47406f7ebff98b0c14ffd491ae5c9aaa` |
| `evidence/0012/manifest-fast.json` | `3ec3ebb2cf322b9835bf0ff066d3f3de94d78ab4a160a3acacd1191decb0bc38` |
| `evidence/0012/manifest-real.json` | `f2004febcd8a5cf5365ae04c63dbfca31faa0cba3fad07b15575bb66df2f492b` |
| `evidence/0012/manifest-security.json` | `f6e495d15772f0dfa5cee256cb3779805aac43f8d6bfeebf7162ae8422b8773d` |
| `evidence/0012/report.json` | `9b5c222e4ee10ce16c83eb8a7f50608ed35f0b8b8809bccf19312a822f99f2e3` |
| `evidence/0012/report.md` | `c566d5588afb2801ccddac417b5b2d98797d1f24802b83ad7f11252b3a7f4062` |
| `evidence/0012/release.json` | `5c28dce662d35c355b6ad682dcd613b73f9801ee5431a51977fe2846bbbf5559` |
| `evidence/0012/release.md` | `ddd52bf050cb480b1e670dac387b4d80b76546414f4b20444d283c4ec93a0aac` |
| `evidence/0012/security.json` | `aad7f6d079afa24569d2209f8d013f1bbcdc28f3a78444f345875f7c40cf977e` |
| `evidence/0012/edge-desktop.png` | `987b538d1dfc273a35259e28e9cb35e72101a62e3ea178da59f7ac782801ca4b` |
| `evidence/0012/edge-mobile.png` | `e0a7bc73d74974d14c9d5194ca22c60dd55a5ccb0798e44a2025166b8277ffb0` |

Checksum input dan output di manifest sama pada ketiga tier, termasuk `apps/frontend/dist/frontend/` (`7f0c3a6487ab521b0c7f53e8d69db28ad4c4cfb6dd4e26d711eadc4e70d196d6`) dan `dist/backend/index.js` (`b2b99ba9a70fa229450eec9ef925c4c11fc6f6c1cc114ddbf27b901530e3de1a`).

## Bukti yang disalin

Salinan di `evidence/0012/` berasal dari gerbang akhir. Path di dalamnya merujuk bundle `.local/` yang tidak masuk repository.

- Bukti langkah deployment, disalin byte demi byte dan SHA 256 nya sama dengan manifest tier nyata: [`result.json`](evidence/0012/result.json), [`images.json`](evidence/0012/images.json), [`artifact-scan.json`](evidence/0012/artifact-scan.json), dan [`playwright-deployment.xml`](evidence/0012/playwright-deployment.xml).
- Screenshot DEP-006 lewat edge: [desktop 1280×812](evidence/0012/edge-desktop.png) dan [mobile 375×812](evidence/0012/edge-mobile.png). Test menjawab Google Fonts dengan body kosong, sehingga ikon Material tampil sebagai teks ligatur (misalnya `left_panel_c`, `logout`, dan `palette`) di screenshot desktop.
- Laporan per push dari `test:report`: [`report.json`](evidence/0012/report.json) dan [`report.md`](evidence/0012/report.md), beserta manifest [fast](evidence/0012/manifest-fast.json), [real](evidence/0012/manifest-real.json), dan [security](evidence/0012/manifest-security.json), serta [`security.json`](evidence/0012/security.json).
- Status release lokal: [`release.json`](evidence/0012/release.json) dan [`release.md`](evidence/0012/release.md).
- JUnit yang memuat skenario DEP: [`plan.xml`](evidence/0012/plan.xml) (DEP-001 dan DEP-008), [`integration.xml`](evidence/0012/integration.xml) dari `.local/feature-4/server.xml` (DEP-002, DEP-003, dan DEP-007), [`gate.xml`](evidence/0012/gate.xml) (DEP-004), [`database.xml`](evidence/0012/database.xml) (DEP-009), dan [`frontend.xml`](evidence/0012/frontend.xml) (DEP-003). Kelima file ini disalin tanpa atribut `hostname` dan lulus `xmllint --noout`, sehingga SHA 256 nya berbeda dari file asli di bundle.

Pemeriksaan `postgres://`, `postgresql://`, `/Users/`, `/var/folders`, `/private/tmp`, dan nama host atas seluruh salinan tidak menemukan apa pun; kata `password` hanya muncul sebagai teks detail check dan judul test.

## Batas bukti dan tindak lanjut

- Run GitHub Actions belum ada karena working tree belum masuk commit dan belum di push. Job `real` di runner `ubuntu-24.04` (Linux amd64, buildx di runner, GNU tar pada pemindaian image, tarikan image dasar baru dari Docker Hub, dan durasi tier nyata terhadap `timeout-minutes` 45), testcase DEP-007 jalur `connectionTimeout` di `.local/feature-4/server.xml` artifact `application-evidence`, serta gitleaks atas commit fitur oleh job `security` dicatat sebagai bukti terpisah sesudah push. Langkah terkait di `verify.md` (baris 387) dan butir Follow-up spec tetap terbuka sampai saat itu.
- Status `ready` hanya dibuktikan fixture DEP-004. Status dari bundle CI asli membutuhkan push ke `main`, run `capacity.yml` untuk commit yang sama, lalu prosedur unduh artifact di [aturan deployment](../rules/deployment.md).
- Tier kapasitas `test:ci:capacity` (manual, sekitar 98 menit) tidak dijalankan ulang pada gerbang ini. Fitur ini tidak mengubah profil k6, `plan.ts`, atau orkestrasi kapasitas; smoke pada tier nyata gerbang ini menjalankan rute yang sama lulus dengan 18 dari 18 threshold. Karena itu bundle kapasitas lokal tetap dari gerbang fitur 12, dan status release lokal memuat `capacity_incomplete` dan `candidate_differs`.
- Seluruh run berjalan di macOS arm64 dengan Docker Desktop. `backend_recreate` pada run ini mendapat alamat network `app` yang sama, jadi run ini sendiri tidak membuktikan resolusi ke alamat baru; resolusi ulang ke alamat baru dibuktikan probe milestone 1 dan langkah tangan `/check verify`. Cabang 504 jendela AC-9 tidak teramati (0 dari 30 jawaban), dan 504 dibuktikan lewat upstream stub.
- Paket OS ketiga image tidak dipindai pemindai kerentanan, sesuai batas bukti spec dan butir Follow-up.
- `build:frontend` tetap memberi warning anggaran awal 500 kB (initial total 685,31 kB); anggaran error 1 MB terpenuhi.
- [Review awal](../reviews/2026-10-05-main-container-deployment.md) dan [review ulang](../reviews/2026-10-05-main-container-deployment-followup.md) berakhir Approve with nits tanpa blocker atau major. Satu temuan minor tetap terbuka: saran grup khusus untuk key TLS di `docs/rules/deployment.md` tidak dapat dilakukan bila GID 101 sudah dipakai. Lima nit lain juga tetap terbuka (`description` route health untuk SDK, catatan `gzip` dan `sendfile`, saran probe `/api/` dari luar, pointer `AGENTS.md` untuk `/sync`, dan ukuran `deployment-real.ts`); nit kotak scope ditutup scope fitur ini.
- Butir Follow-up spec 0012 tetap terbuka, termasuk TLS ke database, domain dan daftar Host, rate limit edge, pengiriman log, registry dengan digest, pipeline deploy, dan healthcheck edge saat platform dipilih pemilik.
- Laporan ini adalah bukti fitur, bukan bukti kesiapan release, dan status kesiapan apa pun tidak memberi izin deploy.

## Pemeriksaan sesudah dokumen diperbarui

Sesudah laporan ini, salinan di `evidence/0012/`, scope, dan baris **Status** spec 0012 ditulis, perintah berikut dijalankan sekali tanpa retry. Perubahan dokumen itu mengubah pohon sumber, jadi bundle gerbang di `.local/feature-11/evidence/` kini tidak lagi terikat pada working tree (`test:report` akan memberi `source_tree_differs`) sampai tier dijalankan ulang; bukti gerbang akhir tetap bundle yang dicatat di atas.

| Perintah | Hasil aktual |
| --- | --- |
| `bun run test:scenarios` | Exit 0, `Scenario registries passed (85 unique IDs, 121 checks).` |
| `bun run check:test-discovery` | Exit 0, 39 file test dengan pembagian yang sama. |
| `bun run check:workflow` | Exit 0, `Workflow lulus: application.yml (application 8 langkah, real 8 langkah, security 4 langkah, report 7 langkah), capacity.yml (capacity 7 langkah).` |
| `bun --no-env-file test ./tests/integration/deployment/static.test.ts` | Exit 0, 29 test DEP-001 dengan 604 assertion, termasuk test yang membaca spec 0012. Dijalankan tanpa reporter JUnit, sehingga `.local/feature-13/plan.xml` milik bundle tidak ditimpa. |
| gitleaks atas working tree | Setiap file `git ls-files -co --exclude-standard` working tree disalin ke folder scratchpad di luar repository (file `.env` lokal yang diabaikan Git tidak ikut; hanya `.env.example`, `.env.infrastructure.example`, dan `.env.deploy.example` yang di commit), lalu image gitleaks yang dipin (`v8.30.1@sha256:c00b6bd0…abbb7f`) dijalankan mode `dir` dengan `tests/security/gitleaks.toml`, `--ignore-gitleaks-allow`, dan isolasi container yang sama dengan `check:security`. Run pertama memakai path sumber absolut `/repo` dan melaporkan 30 temuan `generic-api-key`, seluruhnya di `docs/testing/evidence/*/*.json` (termasuk file di `evidence/0001`, `0002`, `0010`, dan `0011` yang sudah masuk commit dan lulus gitleaks mode `git` pada tier keamanan), karena allowlist checksum repository berlabuh pada path relatif `^docs/testing/evidence/`. Run kedua dengan sumber `.` sehingga path relatif seperti pada mode `git` keluar 0 dengan `no leaks found` atas sekitar 7,35 MB. Container memakai `--rm` dan tidak tersisa. |

Sesudah tabel ini ditulis, salinan dan pemindaian gitleaks yang sama diulang atas working tree akhir: exit 0 dengan `no leaks found`, lalu folder salinan dihapus. Kalimat ini satu satunya perubahan sesudah pemindaian terakhir itu. Commit fitur sendiri baru dipindai gitleaks mode `git` oleh job `security` sesudah push.

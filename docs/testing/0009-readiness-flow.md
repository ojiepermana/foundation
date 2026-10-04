# Bukti fitur 10: Alur pemeriksaan kesiapan lintas aplikasi

Tanggal: 2026-10-04 (waktu lokal UTC+7). Gate pertama selesai pukul 05.32 pada build plan langkah 5 (`/develop`), dan gate ulang selesai pukul 06.55 sesudah `/check verify`, `/test`, `/check review`, dan perbaikan temuan review. Bukti fitur yang berlaku adalah gerbang akhir yang selesai pukul 08.08 (stempel JUnit `test:readiness:real` 2026-10-04T01:08:39Z), sesudah `/document` dan sesudah orkestrasi Docker dipindah ke `tests/orchestration/` (keputusan 58). Kedua gate sebelumnya tetap dicatat sebagai riwayat. Kriteria: [spec 0006](../specs/0006-alur-pemeriksaan-kesiapan/index.md). Bukti ini berasal dari checkout `main` pada dasar `a28527f63a10b17f7d693b3f7077f1123f9f7a13` dengan seluruh perubahan fitur 10 yang belum masuk commit. Perbaikan review tercatat di rationale (keputusan 51 sampai 57) dan di [verify.md](../specs/0006-alur-pemeriksaan-kesiapan/verify.md) bagian *Perbaikan sesudah review*.

## Lingkungan

macOS 27.0 (arm64), Bun 1.4.2, Node 24.21.0, TypeScript 6.0.3, Angular 22.2.0 dengan Vitest 4.1.11 melalui Angular CLI, Playwright 1.63.0 dengan Chromium bawaannya, Elysia 1.4.30, `@elysia/openapi` 1.4.16, dan `@ojiepermana/angular` 22.1.14 (komponen dan generator SDK). Docker Desktop dengan Docker Engine 29.8.0 dan Docker Compose 5.5.1. PostgreSQL 18.6 dari image `foundation-postgres:18-pinned`; pada gerbang akhir image itu ber ID `64623d72b487`, dibuat 2026-10-03, dan membawa label project Compose `foundation-infra-test-dfad7f76` dari build suite spec 0002. Versi dibaca dari `postgres --version` pada container `--rm` dengan ketiga label Compose dikosongkan. Gate pertama dan gate ulang mencatat ID `ee194ee187be` dengan label `foundation-infra-test-ccd098a0`; tag yang dipakai setiap suite nyata tetap sama. k6 tidak terpasang (`which k6` tidak menemukan binary).

Setiap suite nyata membuat container PostgreSQL 18 terisolasi miliknya sendiri lewat `docker run`. Selama gerbang akhir, PostgreSQL Compose bersama milik project ini (`foundation-postgres-1`, port host 55432) sudah berjalan sejak sebelum sesi dan tetap berjalan tanpa disentuh, begitu pula container project lain di host. Pada gate pertama dan gate ulang, container Compose bersama itu tidak berjalan. Port 8888, 8889, dan 8890 kosong sebelum dan sesudah gerbang akhir.

## Perintah dan hasil gerbang akhir

Gerbang akhir menjalankan seluruh gate proyek dan setiap suite nyata yang mencakup bagian yang disentuh fitur ini: backend dan pool (`test:database:real`, `test:tooling:real`), runner migration (`test:database:migration`), batas `scripts/` milik spec 0002 (`test:infrastructure`), dan alur browser nyata (`test:readiness:real`). Setiap perintah dijalankan satu kali tanpa retry, berurutan, dan tidak ada yang gagal. Kode tidak diubah selama gerbang ini.

| Perintah | Hasil aktual |
| --- | --- |
| `bun run api:sync` | Exit 0. Ekspor mencetak `OpenAPI exported without listener`, validasi mencetak `OpenAPI project checks passed`, dan generator mencetak `[sdk] standalone → sdk (schemas=4, operations=2, tags=1, files=13)`. Ketujuh belas checksum pada *Identitas artefak* dan `git status --porcelain` sama sebelum dan sesudah, tanpa file `openapi.json.*.tmp`. |
| `bun run test:ci` | Exit 0 dalam 114 detik. `check:dependencies` mencetak `Exact dependency pins, runtime engines and installed peers passed`; `test:scenarios` 58 ID unik; `api:check` mencetak `OpenAPI and SDK match stored artifacts across two runs`; `build:frontend` initial total 684,40 kB raw dan 154,05 kB transfer, chunk lazy `readiness-page` 9,21 kB raw (2,87 kB transfer), dengan warning anggaran 500 kB yang sama (lebih 184,41 kB); `check:frontend:bundle` lulus; `typecheck:backend`, `typecheck:contract`, dan `typecheck:e2e` exit 0; `build:backend` membundel 8 modul; `test:frontend` 4 file dan 79 test (`app.spec.ts` 1, `sdk-contract.integration.spec.ts` 6, `readiness-api.integration.spec.ts` 49, `readiness-page.spec.ts` 23); `test:integration` 630 test dan 2.728 assertion dalam 76,7 detik, 0 gagal (`application.test.ts` 20, `backend/readiness.test.ts` 26, `frontend-bundle.test.ts` 62, `openapi-contract.test.ts` 404, `openapi.test.ts` 48, `readiness-container.test.ts` 9, `readiness-contract.test.ts` 7, `sdk.test.ts` 54); `test:tooling` 29 test dan 79 assertion dalam 19,6 detik; `test:e2e` 12 test dalam 9,8 detik, termasuk kedua canary READY-006. |
| `bun run test:database:real` | Exit 0 dalam 42 detik. Build frontend untuk pemindaian artefak lulus, lalu suite database lulus 29 test dengan 1.413 assertion dalam 39,9 detik, 0 gagal: `migration.test.ts` 5 (16,9 detik), `readiness.test.ts` 12 (READY-008, 13,9 detik), dan `provision.test.ts` 12 (9,2 detik). Menurut output runner, test lonjakan 50 request saat tabel terkunci berlangsung 2.030 ms, test pause 5.183 ms, dan test SIGTERM saat pause 1.777 ms. Pemindaian mencetak `Database artifact scan passed: 7 random values absent from 16 files.` dan `.local/feature-5/artifact-scan.json` berisi `findings: []`. |
| `bun run test:database:migration` | Exit 0 dalam 17 detik, MIG-001 sampai MIG-005 lulus 5 test dengan 59 assertion dalam 16,6 detik, 0 gagal. |
| `bun run test:tooling:real` | Exit 0 dalam 9 detik. TOOL-001 lulus 12 pemeriksaan database dengan role hasil provisioning dan menolak target salah, penulisan metadata, keanggotaan writer, checksum, metadata yatim, migration kosong, role admin, serta database yang tidak tersedia tanpa mencetak credential. Bagian HTTP TOOL-007 memberi 200 `{"status":"ok"}` dari `/api/status` dan 200 `text/html` dari frontend lewat `serve`, lalu SIGTERM menghapus listener pada 8888 dan 8889. |
| `bun run test:infrastructure` | Exit 0 dalam 49 detik, 18 test dengan 173 assertion dalam 48,7 detik, 0 gagal dan 0 dilewati. INFRA-001 (termasuk batas kata `docker` di bawah `scripts/`) dan INFRA-005 (termasuk run bersarang tanpa daemon) lulus. |
| `bun run test:readiness:real` | Exit 0 dalam 7 detik. Output: `Isolated PostgreSQL 18 container foundation-readiness-a2905c55 started.`, `Isolated database provisioned and migrated.`, `Backend and frontend answered 200.`, satu test `READY-009 real database: ...` lulus dalam 2,3 detik, `Readiness artifact scan passed: 6 random values absent from 5 outputs and 7 files.`, lalu `READY-009 passed against the real database, backend, and frontend.` JUnit `tests="1" failures="0" skipped="0" errors="0"`; `.local/feature-10/artifact-scan.json` memindai output `provision`, `migrate`, `playwright`, `frontend`, dan `backend` serta JUnit dan enam file di `outputDir`, dengan `findings: []`. Screenshot `readiness-available-mobile.png` dan `readiness-recovered.png` dilihat langsung: kartu, jumlah `1`, waktu, dan tombol tampil utuh tanpa terpotong. |

Sesudah gerbang akhir, ketujuh belas checksum pada *Identitas artefak* cocok (`shasum -a 256 -c`), `git status --porcelain` sama dengan awal sesi, tidak ada container berlabel `foundation.test=readiness` maupun bernama `foundation-infra-test-*` atau `foundation-readiness-*`, dan tidak ada proses backend, `ng serve`, `bun test`, Vite, atau Playwright yang tersisa. Folder sementara `foundation-*` di `TMPDIR` yang ada sesudah gate sudah ada sebelum sesi ini (lihat *Batas bukti*).

Kedelapan JUnit di `evidence/0009/` berasal dari gerbang akhir, disalin tanpa atribut `hostname`, tidak memuat path absolut, dan lulus `xmllint --noout`: [frontend](evidence/0009/frontend.xml), [integration](evidence/0009/integration.xml), [tooling](evidence/0009/tooling.xml), dan [Playwright](evidence/0009/playwright.xml) dari `test:ci`; [database](evidence/0009/database.xml) dari `test:database:real`; [migration](evidence/0009/migration.xml) dari `test:database:migration`; [infrastruktur](evidence/0009/infrastructure.xml) dari `test:infrastructure`; dan [Playwright nyata](evidence/0009/playwright-real.xml) dari `test:readiness:real`. `test:tooling:real` tidak menulis JUnit; hasilnya adalah output yang dikutip di tabel.

## Gate ulang 06.55 sesudah perbaikan review

Bagian ini riwayat. Path `scripts/test-database-real.ts`, `scripts/test-readiness-real.ts`, dan `scripts/lib/readiness-container.ts` pada tabel ini adalah lokasi sebelum keputusan 58. Perintah gate ulang dijalankan masing masing satu kali tanpa retry. Run tambahan untuk reproduksi temuan dan kontrol mutasi tercatat di bagian *Kontrol mutasi*.

| Perintah | Hasil aktual |
| --- | --- |
| `bun run api:sync` | Exit 0 sesudah perubahan backend perbaikan review. Ekspor mencetak `OpenAPI exported without listener`, validasi mencetak `OpenAPI project checks passed`, dan generator mencetak `[sdk] standalone → sdk (schemas=4, operations=2, tags=1, files=13)`. Checksum `openapi.json`, kedua fixture `tests/fixtures/openapi/`, dan seluruh file `apps/frontend/sdk/` sama dengan awal sesi, tanpa file `openapi.json.*.tmp`. Perubahan backend tidak menyentuh kontrak, sehingga artefaknya identik. |
| `bun run api:check` | Exit 0, stdout `OpenAPI and SDK match stored artifacts across two runs`, terpisah maupun di dalam `test:ci`. |
| `bun run test:scenarios` | Exit 0, `Scenario references passed (58 unique IDs)`. |
| `bun run typecheck:backend` | Exit 0. |
| `bun run typecheck:contract` | Exit 0. Konfigurasi kini juga memuat `tests/integration/backend/readiness.test.ts`, `tests/integration/database/readiness.test.ts`, dan `scripts/test-database-real.ts` (keputusan 56). |
| `bun run typecheck:e2e` | Script baru, exit 0. `tsconfig.e2e.json` dengan `types: ["node"]` memeriksa keempat file `tests/e2e/readiness/`, `playwright.config.ts`, dan `playwright.real.config.ts`, beserta `scripts/lib/readiness-container.ts` yang diimpor. |
| `bun run build:frontend` | Exit 0. Initial total 684,40 kB raw dan 154,05 kB transfer. Chunk lazy `readiness-page` 9,21 kB raw (2,87 kB transfer). Warning anggaran 500 kB tetap muncul (lebih 184,41 kB); anggaran error 1 MB terpenuhi. |
| `bun run check:frontend:bundle` | Exit 0, stdout `Frontend imports and production browser assets passed the security scan.` |
| `bun run test:ci` | Exit 0 dalam 114 detik. `check:dependencies` lulus; `test:scenarios` 58 ID; `api:check` lulus; `build:frontend` 684,40 kB dengan warning anggaran yang sama; `check:frontend:bundle` lulus; `typecheck:backend`, `typecheck:contract`, dan `typecheck:e2e` exit 0; `build:backend` membundel 8 modul; `test:frontend` 4 file dan 79 test (`app.spec.ts` 1, `sdk-contract.integration.spec.ts` 6, `readiness-api.integration.spec.ts` 49, `readiness-page.spec.ts` 23) dengan satu baris `SDK contract backend listening on ...` dan satu baris `SDK contract backend stopped`; `test:integration` 629 test dan 2.703 assertion dalam 76,8 detik, 0 gagal (`application.test.ts` 20, `backend/readiness.test.ts` 26, `frontend-bundle.test.ts` 62, `openapi-contract.test.ts` 404, `openapi.test.ts` 48, `readiness-container.test.ts` 8, `readiness-contract.test.ts` 7, `sdk.test.ts` 54); `test:tooling` 29 test dengan 79 assertion; `test:e2e` 12 test dalam 9,7 detik. |
| `bun run test:database:real` | Exit 0 dalam 41 detik. Build frontend untuk pemindaian artefak lulus, lalu suite database lulus 29 test dengan 1.413 assertion dalam 39,8 detik, 0 gagal: `migration.test.ts` 5, `provision.test.ts` 12, dan `readiness.test.ts` 12 (READY-008, 13,9 detik menurut JUnit). Pemindaian mencetak `Database artifact scan passed: 7 random values absent from 16 files.` dan `.local/feature-5/artifact-scan.json` berisi `findings: []`. Sesudahnya tidak ada container `foundation.test=readiness`, proses backend, maupun folder `foundation-database-real-*`. |
| `bun run test:readiness:real` | Exit 0 dalam 6 detik. Output: `Isolated PostgreSQL 18 container foundation-readiness-ff230c59 started.`, `Isolated database provisioned and migrated.`, `Backend and frontend answered 200.`, satu test `READY-009 real database: ...` lulus dalam 1,2 detik, `Readiness artifact scan passed: 6 random values absent from 5 outputs and 7 files.`, lalu `READY-009 passed against the real database, backend, and frontend.` JUnit `tests="1" failures="0" skipped="0" errors="0"`; `.local/feature-10/artifact-scan.json` memindai output `provision`, `migrate`, `playwright`, `backend`, dan `frontend` serta JUnit dan enam file di `outputDir`, dengan `findings: []`. Sesudahnya tidak ada container `foundation.test=readiness`, port 8888 dan 8889 bebas, dan tidak ada proses `ng serve` maupun backend. |

Sesudah gate, checksum yang tercatat di *Identitas artefak* sama dengan awal sesi, dan `git status --porcelain` hanya bertambah satu path baru, `tsconfig.e2e.json`. Tidak ada proses backend, `ng serve`, `bun test`, atau Vite yang tersisa.

JUnit gate ulang (frontend, integration, Playwright, database, dan Playwright nyata) sempat disimpan di `evidence/0009/`, lalu diganti JUnit gerbang akhir dengan nama file yang sama.

## Kontrol mutasi

Setiap kontrol mengubah file sementara dari salinan cadangan, lalu file dikembalikan dan `cmp` memastikan isinya sama byte demi byte. Gerbang akhir tidak mengulang kontrol mutasi; hasil di bawah tercatat sebelum orkestrasi dipindah (keputusan 58), dan path pada kontrol itu adalah lokasi lama.

Kontrol registry langkah 5, dijalankan pada gate pertama: `testTag` READY-009 diubah menjadi `READY-099` membuat `test:scenarios` gagal dengan `Missing test tag for READY-009`, dan kriteria READY-007 `AC-9` menjadi `AC-19` membuatnya gagal dengan `Missing criterion for READY-007`.

Kontrol langkah 1 sampai 4 yang tercatat sudah dijalankan di verify.md pada sesi milestone masing masing: `index.html` production yang hilang, `dist/backend` yang hilang, port 8888 yang terpakai, SIGINT pada `test:readiness:real`, variable `FOUNDATION_READINESS_CONTAINER` kosong atau salah, dan container tanpa label harness.

Kontrol yang dijalankan pada sesi perbaikan review (2026-10-04), dengan hasil lengkap di verify.md:

- Impor spinner yang lebih dalam membuat pemeriksaan source READY-005 gagal (6 lulus, 1 gagal).
- Binding `aria-disabled` yang dihapus membuat 6 dari 23 test `readiness-page.spec.ts` gagal, dan elemen status yang dibungkus `@if` dan `@else` membuat test node yang sama gagal.
- `toLocaleString('en-US')` menggantikan `String(...)` membuat 7 dari 23 test `readiness-page.spec.ts` gagal.
- Dua mutasi `isDevMode()` menjadi `true` (navigasi dan route) membuat kedua test READY-007 gagal pada build production; sesudah dikembalikan dan build ulang, READY-007 lulus.
- Probe kebocoran credential membuat `test:readiness:real` keluar 1 dengan `Readiness test credential found in output or Playwright artifacts` dan `findings` berisi `leak-probe output`.
- Empat mutasi source READY-010 (script dipindah, teks label Compose, impor penjaga lain, tanpa `...READINESS_RUN_LABEL_ARGS`) dan satu mutasi baru (pembersihan `test:database:real` tanpa `readinessContainerMissing`) masing masing membuat test READY-010 terakhir gagal dengan pesan yang menyebut file dan aturannya.
- Mutasi penanda pada `readiness.service.ts`: `query.finally(release)`, penanda dilepas saat batas waktu, satu retry, pemeriksaan `busy` dihapus, dan `clearTimeout` dihapus, masing masing membuat test `backend/readiness.test.ts` gagal (9, 3, 4, 7, dan 1 test).
- Mutasi route `busy` ke 503 dan `appliedMigrations` sebagai string masing masing hanya ditangkap test route baru dengan pool tiruan.
- Mutasi `SET LOCAL` menjadi `SET` dan penghapusan baris batas statement masing masing ditangkap READY-008 (1 dan 2 test gagal).

## Hasil per skenario

| Skenario | Kriteria | Bukti | Status |
| --- | --- | --- | --- |
| `READY-001` | AC-1, AC-3, AC-4 | 12 test `bun:test` di `tests/integration/backend/readiness.test.ts` (`test:integration`), termasuk header `Host` yang tidak membentuk URL absolut dan test route dengan pool tiruan | `passed` |
| `READY-002` | AC-3, AC-4 | 14 test `bun:test` di file yang sama, termasuk timer batas yang dibersihkan | `passed` |
| `READY-003` | AC-5 | 6 test `bun:test` di `readiness-contract.test.ts`, ditambah `api:check` | `passed` |
| `READY-004` | AC-6 | 49 test Vitest di `readiness-api.integration.spec.ts` | `passed` |
| `READY-005` | AC-7, AC-8 | 23 test Vitest di `readiness-page.spec.ts`, ditambah 1 pemeriksaan source di `readiness-contract.test.ts` | `passed` |
| `READY-006` | AC-3, AC-7, AC-8 | 6 test Playwright: navigasi, proxy 503, tata letak, dan keyboard pada dua viewport, serta dua canary pembukaan langsung `/` | `passed`; kedua canary menegaskan cacat library yang diketahui masih ada, bukan bukti `aria-current` pada pemuatan pertama |
| `READY-007` | AC-9 | 2 test Playwright pada build production, ditambah `check:frontend:bundle` | `passed` |
| `READY-008` | AC-1, AC-2, AC-3, AC-4, AC-10 | 12 test `bun:test` pada PostgreSQL 18 nyata lewat `test:database:real`, termasuk `SET LOCAL`, error `57014` asli sesudah batas pendek, dan SIGTERM saat container di pause | `passed` (di luar `test:ci`) |
| `READY-009` | AC-2, AC-7, AC-8, AC-10 | 1 test Playwright dengan database, backend, dan frontend nyata lewat `test:readiness:real` | `passed` (di luar `test:ci`) |
| `READY-010` | AC-10 | 9 test `bun:test` di `readiness-container.test.ts`, tanpa Docker, termasuk lokasi modul penjaga dan pemakainya di luar `scripts/` (keputusan 58) | `passed` |

Jumlah test dihitung dari nama testcase dan testsuite di JUnit gerbang akhir `evidence/0009/`. Seluruh status `passed` di atas berasal dari run gerbang akhir.

## Hasil per kriteria

| Kriteria | Hasil dan bukti |
| --- | --- |
| AC-1 | Terpenuhi. READY-001 membuktikan urutan 404, 400, dan 503 pada handler, 400 lewat socket mentah untuk `Content-Length: 2` dan `Transfer-Encoding: chunked`, urutan yang sama untuk header `Host` yang tidak membentuk URL absolut (sebelumnya 500), 404 dari `createApp('production')` serta proses production dari `apps/backend/src/index.ts` dan `dist/backend/index.js`, dan `/api/status` tetap 200. Header `Host` dengan authority tidak sah masih menjawab 500 (temuan minor review ulang yang terbuka, lihat *Batas bukti*). READY-008 membuktikan `?x=1` tetap 400 saat pemeriksaan lain aktif, dan 400 pada backend yang diam tidak membuat request sah berikutnya 429. |
| AC-2 | Terpenuhi. READY-008 membaca jumlah `0` sesudah provisioning lalu `1` sesudah `migrate.ts --apply`, sama dengan banyaknya file `database/migrations/*.sql`, dan membuktikan `SET LOCAL` tidak mengubah `statement_timeout` sesi pool. READY-001 membuktikan bentuk 200 tepat tiga key lewat route dengan pool tiruan di `test:ci`. READY-009 menampilkan jumlah yang sama lewat browser, SDK, proxy, dan backend. |
| AC-3 | Terpenuhi. 503 tanpa pool lewat READY-001, READY-004, dan READY-006 (lewat proxy); batas 5.000 ms dan kegagalan terlambat tanpa log maupun `unhandledRejection` lewat READY-002 dan, dengan error `57014` asli, lewat READY-008 dalam proses; lock (503 antara 1.800 dan 3.000 ms), hak dicabut, pause (503 pada batas 5.000 ms), serta stop dan start pada database nyata lewat READY-008, dengan stderr backend kosong dan pemindaian respons serta output. Backend yang menerima SIGTERM saat pemeriksaannya tertahan container yang di pause keluar dengan exit code 0 dalam 3 detik. |
| AC-4 | Terpenuhi. READY-002 membuktikan satu pemeriksaan per instance, 429 tanpa query baru, pelepasan sesudah promise selesai, timer yang dibersihkan, dan tanpa retry. READY-001 membuktikan 200, 429, dan 503 dengan `no-store` lewat route di `test:ci`, serta 404 dari handler. READY-008 membuktikan lonjakan 50 request dengan tepat satu 503 dan 49 jawaban 429, serta `no-store` pada 200, 400, 429, dan 503 terhadap database nyata. |
| AC-5 | Terpenuhi. READY-003, `api:sync` dengan artefak identik, dan `api:check`. |
| AC-6 | Terpenuhi. READY-004 membuktikan setiap baris *Pemetaan adapter*, `unavailable` dari backend nyata tanpa database, dan `network` dari URL tertutup. |
| AC-7 | Terpenuhi menurut teks AC-7 yang berlaku. READY-005 membuktikan state, teks, waktu, jumlah, satu request, tanpa polling, pembatalan, route, dan `App.navItems`; READY-006 membuktikan `aria-current` sesudah item dipilih dari navigasi pada dua viewport dan pembukaan langsung `/` tanpa item lain yang bertanda; READY-009 membuktikan alur dengan database nyata. Pada pemuatan pertama, `Beranda` tanpa `aria-current` adalah cacat library yang diketahui pada `@ojiepermana/angular` 22.1.14 dengan `@angular/router` 22.2.0 (rationale, keputusan 47 sampai 50). Canary READY-006 lulus, artinya cacat itu masih ada; ini dicatat sebagai cacat yang diketahui, bukan bukti kriteria. |
| AC-8 | Terpenuhi untuk bukti otomatis. Pemeriksaan source READY-005 untuk impor library, READY-005 untuk elemen status yang dipakai ulang, READY-006 untuk Tab, Enter, Space, indikator focus, focus yang tetap pada tombol, dan elemen tidak terpotong dalam state `unavailable` pada 1280×812 dan 375×812, serta READY-009 untuk state `available` pada kedua viewport. Langkah pembaca layar belum dijalankan (Batas bukti). |
| AC-9 | Terpenuhi. READY-007 pada build `production` di dua viewport (navigasi hanya `Beranda`, `/kesiapan` berakhir di `/`, tanpa request `/api/`, origin luar hanya Google Fonts), dua mutasi `isDevMode()` yang ditangkap READY-007, dan `check:frontend:bundle`. |
| AC-10 | Terpenuhi. READY-008 lewat `test:database:real`, READY-009 lewat `test:readiness:real` dengan pemindaian credential pada output dan artefak, serta penjaga container READY-010, termasuk `readinessContainerMissing`. `test:database:real` kini menghapus container READY-008 dan menghentikan grup prosesnya pada timeout, SIGINT, dan SIGTERM. Kedua suite nyata berjalan di luar `test:ci` sampai fitur 11 menambahkan jalur CI dengan Docker. |

## Identitas artefak

| Artefak | SHA-256 |
| --- | --- |
| `openapi.json` | `e583aa33ea689908d8188f5b1338a441475c9a434e97589e0b47366da95f0c00` |
| `tests/fixtures/openapi/valid.json` | `e583aa33ea689908d8188f5b1338a441475c9a434e97589e0b47366da95f0c00` |
| `tests/fixtures/openapi/subset-full.json` | `53eb949b79a198b87e813d01f741814a2c50ea3c0dfaab0eab84859257bc946d` |
| `apps/frontend/sdk/.ojiepermana-sdk-manifest.json` | `360be3234bc8320cab677b8a1e2cdf88483796949d8197b3898562666887e561` |
| `apps/frontend/sdk/api-configuration.ts` | `1634c9c4e06b1eaeceffbce5197f99a3fa04cf0876720a1c72e0368c4b7bf38d` |
| `apps/frontend/sdk/api.ts` | `2c78f6d01a29287a695285cecea9d4139f1af9dbef82e3629cc3cdf943175fac` |
| `apps/frontend/sdk/base-service.ts` | `c5b3a06e24cb340b1ebb5fb3db325f8796c1b192d74f89ae6e9148004588d180` |
| `apps/frontend/sdk/fn/development/get-development-readiness.ts` | `5e9c93db1b8e7b0dce247ea214e1c9547fb0eddc769e88e2f746e06e0afc526e` |
| `apps/frontend/sdk/fn/development/get-development-status.ts` | `029aeb4343e3b7c2676ca703ef0f42fc86ea580a157e8ba0e521fab56faf2ccf` |
| `apps/frontend/sdk/models/development-status.ts` | `80cd83d48d86d580ef551656297fcf4c4eed31b1cdf0ead62b7dde5220034579` |
| `apps/frontend/sdk/models/readiness-available.ts` | `35ee8bd9c28f0144587778a0c912731977381ca461d69de880683cd0592e8b68` |
| `apps/frontend/sdk/models/readiness-busy.ts` | `ed1356df08e7eca9d6934b748df66de351c9b1b81660ffa8eecd841155b6d115` |
| `apps/frontend/sdk/models/readiness-unavailable.ts` | `e2f8b29c1131b2421994e6250f3f41d28bcb6c47e0b7532fd8619b3325249e3a` |
| `apps/frontend/sdk/public-api.ts` | `ffbccb87b2696b8abc57c24f714bae2da3bd859b557d83fe927417c30504bc47` |
| `apps/frontend/sdk/request-builder.ts` | `71d4d8454391adb6ee9943a4c8189ee2d1cba12fb85839e183a9accd4a149cd9` |
| `apps/frontend/sdk/services/development.service.ts` | `87581671aea67dc3d9720cbf6b9eacf70e6e2ea2138be0b2972dccfa5b91fb1c` |
| `apps/frontend/sdk/strict-http-response.ts` | `a26c41300e36f9188c2c6c2bb6ec1b3972468d4c5b01451459de7b6e0c561115` |

File SDK yang tidak disentuh fitur ini (`api-configuration.ts`, `api.ts`, `base-service.ts`, `get-development-status.ts`, `development-status.ts`, `request-builder.ts`, dan `strict-http-response.ts`) mempunyai checksum yang sama dengan laporan fitur 9. Ketujuh belas checksum di atas diperiksa ulang dengan `shasum -a 256 -c` sesudah gate ulang dan sekali lagi sebelum serta sesudah gerbang akhir, dan semuanya cocok.

## Ukuran bundle dan waktu

- Initial total production naik dari 675,94 kB raw dan 150,92 kB transfer pada gate fitur 9 ([laporan 0008](0008-sdk-contract.md)) menjadi 684,40 kB raw dan 154,05 kB transfer (bertambah 8,46 kB raw dan 3,13 kB transfer), karena barrel `@sdk` yang dimuat `app.config.ts` kini memuat satu operasi dan tiga model baru. Halaman kesiapan sendiri berada di chunk lazy `readiness-page` 9,21 kB raw. Angka 684,40 kB sama sejak langkah 1, dan perbaikan review tidak mengubahnya.
- Gerbang akhir: `test:database:real` 42 detik termasuk build frontend untuk pemindaian, dengan suite database 39,9 detik dan READY-008 13,9 detik. Spec memperkirakan READY-008 biasanya di bawah 60 detik, dan batas `run()` 300 detik tidak mendekati tercapai. Pada gate ulang READY-008 juga 13,9 detik (sebelumnya 9,9 detik; tambahannya terutama test error `57014` asli sekitar 2,2 detik dan test SIGTERM saat pause sekitar 1,8 detik).
- Gerbang akhir: `test:readiness:real` 7 detik dari awal sampai container dihapus; test READY-009 sendiri 2,3 detik (gate ulang: 6 dan 1,2 detik), sehingga pemulihan sesudah `docker start` pada Docker Desktop terjadi jauh di bawah batas 30 detik.
- Gerbang akhir: `test:ci` 114 detik, dengan `test:integration` 76,7 detik, `test:tooling` 19,6 detik, dan `test:e2e` 9,8 detik (gate ulang: 114 detik; gate pertama fitur ini: 112,3 detik; gate fitur 9: 109 detik). `test:database:migration` 17 detik, `test:tooling:real` 9 detik, dan `test:infrastructure` 49 detik.

## Gerbang akhir pertama: lokasi orkestrasi 2026-10-04

Bagian ini riwayat. Gerbang akhir pertama sesudah `/document` menemukan `bun run test:infrastructure` exit 1 dengan 16 lulus dan 2 gagal. INFRA-001 spec 0002 menolak kata `docker` di bawah `scripts/`, sedangkan fitur ini menempatkan `scripts/test-readiness-real.ts`, `scripts/test-database-real.ts`, dan `scripts/lib/readiness-container.ts` di sana; INFRA-005 gagal karena run bersarang tanpa daemon ikut menjalankan INFRA-001. Gate sebelumnya tidak menjalankan `test:infrastructure`, yang berada di luar `test:ci`. Ketiga file dipindah ke `tests/orchestration/readiness-real.ts`, `tests/orchestration/database-real.ts`, dan `tests/orchestration/readiness-container.ts` tanpa perubahan perilaku ([rationale, keputusan 58](../specs/0006-alur-pemeriksaan-kesiapan/rationale.md)), dan READY-010 mendapat satu test baru yang menjaga modul penjaga beserta pemakainya di luar `scripts/`. Path lama pada tabel gate ulang mencatat gate sebelumnya. Perintah di bawah dijalankan satu kali tanpa retry sesudah pemindahan.

| Perintah | Hasil aktual |
| --- | --- |
| `bun run test:infrastructure` | Exit 0; suite 48,4 detik menurut JUnit, 18 lulus, 0 gagal, 0 dilewati, 173 assertion. INFRA-001 dan INFRA-005, termasuk run bersarang tanpa daemon, lulus. |
| `bun run test:scenarios` | Exit 0, 58 ID unik. |
| `bun run typecheck:contract`, `bun run typecheck:e2e` | Exit 0. `tsconfig.contract.json` memuat kedua orkestrasi dari `tests/orchestration/`; `tsconfig.e2e.json` tidak berubah. |
| `bun run test:ci` | Exit 0 dalam 115 detik: `api:check` cocok, initial bundle 684,40 kB dengan warning anggaran yang sama, 79 test frontend, 630 test integration dengan 2.728 assertion (satu test READY-010 baru), 29 test tooling, 12 test e2e. |
| `bun run test:database:real` | Exit 0 dalam 41 detik, 29 lulus dengan 1.413 assertion, pemindaian artefak lulus untuk 7 nilai acak di 16 file. |
| `bun run test:readiness:real` | Exit 0 dalam 5 detik, READY-009 lulus dalam 1,2 detik, pemindaian lulus untuk 6 nilai acak di 5 output dan 7 file. |

Sesudah run, tidak ada container `foundation-infra-test-*` maupun `foundation-readiness-*`, port 8888 dan 8889 bebas, dan PostgreSQL Compose bersama yang sudah berjalan sebelum sesi ini tidak disentuh. Checksum pada *Identitas artefak* tidak berubah. Run ini tidak menjalankan `test:database:migration` maupun `test:tooling:real`; keduanya dijalankan pada gerbang akhir di atas. JUnit di `evidence/0009/` kini berasal dari gerbang akhir.

## Profil k6

`not_applicable`, sesuai baris *Profil k6* spec 0006. Spec tidak menetapkan target latency maupun throughput, concurrency dibatasi desain (satu pemeriksaan aktif per proses dan 429 tanpa antrean) dan dibuktikan lonjakan 50 request serentak READY-008 di `bun:test`, dan k6 tidak terpasang di host (`which k6` tidak menemukan binary). Repository juga belum mempunyai script `test:performance:*`. Kapasitas dan pemulihan pada beban menjadi milik fitur 12.

## Batas bukti

- Seluruh run berjalan di macOS arm64 dengan Docker Desktop. Linux, termasuk runner CI, belum dijalankan untuk READY-008 dan READY-009; keduanya berada di luar `test:ci` sampai fitur 11. Waktu pemulihan pada host Linux dapat berbeda, tetapi batas 15 dan 30 detik memberi ruang lebar.
- Kegagalan query sesudah batas dibuktikan pada unit READY-002 dengan fungsi jumlah pengganti dan dalam proses pada READY-008 dengan error `57014` asli dan `deadlineMs` 500. Lewat backend proses nyata, batas 5.000 ms selalu lebih besar dari batas statement dua detik, sehingga urutan itu tidak dibuat lewat HTTP.
- Backend yang mati saat `dev:frontend` berjalan (502 dari proxy) hanya dibuktikan pada tingkat pemetaan adapter READY-004.
- READY-007 bergantung pada `dist` production dari checkout yang sama. `test:ci` membangunnya ulang lebih dulu; run lokal dengan `dist` lama dapat memberi hasil yang tidak mewakili kode saat ini.
- Canary READY-006 menegaskan cacat `aria-current` library pada pemuatan pertama masih ada. Penutupnya bergantung pada rilis `@ojiepermana/angular` oleh pemilik (Follow-up spec 0006).
- Langkah pembaca layar (VoiceOver) belum dijalankan karena membutuhkan orang yang mendengarkan dan tidak ada manusia selama run pipeline. Langkah manual lain di verify.md tercatat sudah dijalankan pada sesi sebelumnya; sesi perbaikan review dan gerbang akhir tidak mengulangnya.
- Review ulang meninggalkan satu temuan minor terbuka: header `Host` dengan authority tidak sah, misalnya `%` atau `[::1`, masih membuat route menjawab 500, bukan urutan 404, 400, 503, 429 pada AC-1. `readiness.routes.ts` masih membaca path dan query lewat `new URL(request.url, URL_BASE)`, dan gerbang akhir tidak mengujinya ulang. Enam nit review juga tetap terbuka sebagai tindak lanjut.
- `typecheck:e2e` hanya mencakup file spec 0006. `tests/e2e/ui-shell/foundation-shell.e2e.spec.ts` (UI-001, spec 0007) masih gagal diperiksa tipenya pada dua baris `document.activeElement?.blur()` dan dicatat sebagai Follow-up, karena build plan melarang fitur ini mengubah test lama di luar daftar tertutupnya.
- Pembersihan `test:database:real` pada timeout, SIGINT, dan SIGTERM dibuktikan dengan run manual yang tercatat di verify.md, bukan test otomatis. Container `provision.test.ts` (spec 0004) masih hanya dibersihkan `afterAll` nya, sehingga menurut pembacaan kode run yang dihentikan saat suite itu berjalan dapat meninggalkannya (Follow-up spec 0006).
- Folder `foundation-readiness-test-9Oj0xx` di `TMPDIR`, dibuat pukul 03.43 oleh run READY-008 yang dihentikan sebelum sesi perbaikan, masih berisi `postgres.env` dengan password acak untuk container yang sudah tidak ada. Folder `foundation-db-test-TjeZhe` (2026-10-02) dan `foundation-openapi-cli-gWoY8C` (2026-10-03) juga sudah ada sebelum gerbang akhir. Ketiganya tidak dihapus karena bukan buatan sesi ini; run gerbang akhir tidak menambah folder baru.
- `test:tooling:real` masih memetakan PostgreSQL ke port host acak dengan `--rm`; prasyarat pemakaian ulang READY-009 untuk fitur 2 (port tetap) belum diterapkan dan menjadi milik fitur 2.
- Pemindaian credential mencari nilai acak run tersebut di output dan artefak; itu bukan pemindaian secret umum.
- Build frontend masih memberi warning anggaran initial bundle 500 kB yang sudah ada sebelum fitur ini.
- Laporan ini adalah bukti fitur, bukan bukti kesiapan release.

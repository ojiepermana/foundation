# Bukti fitur 2: Doctor dan serve pada aplikasi nyata

Tanggal: 2026-10-04 (waktu lokal UTC+7). Bukti fitur yang berlaku adalah gerbang akhir pukul 11.22 sampai 11.28 (stempel JUnit Playwright `test:tooling:real` 2026-10-04T04:25:19Z), sesudah `/develop`, `/check verify`, `/test`, `/check review` beserta perbaikan temuannya, dan `/document`. Kriteria: [spec 0003](../specs/0003-doctor-serve-aplikasi-nyata/index.md) AC-1 sampai AC-9. Bukti ini berasal dari checkout `main` pada dasar `b1ae733c5ca55cc865ef367bbe8c3d58383dc0b2` dengan seluruh perubahan fitur 2 yang belum masuk commit. SHA 256 keluaran `git diff` (`b9685161f221392c3f530dd55aecbae3b4056654bc3f0b1bffde9d4175fa10f0`) dan checksum setiap file yang belum dilacak sama sebelum dan sesudah gerbang, jadi kode tidak berubah selama gerbang. Keduanya diukur sebelum laporan ini, JUnit di `evidence/0005/`, scope, dan status spec diperbarui.

**Status akhir:** seluruh gate proyek dan suite nyata lulus pada satu run tanpa retry. TOOL-001 sampai TOOL-008 `passed`, dan AC-1 sampai AC-9 terpenuhi dengan batas di bawah: AC-5 hanya terbukti lewat fixture karena belum ada worker nyata, bukti aplikasi nyata hanya dari macOS dengan Chromium, dan suite nyata masih di luar `test:ci`. TOOL-007 tidak lagi parsial. Bagian bertanggal sesudah *Batas bukti* adalah riwayat pembangunan fitur ini. Pernyataan TOOL-007 parsial dan SHA 256 JUnit di sana hanya berlaku untuk saat itu, karena JUnit di `evidence/0005/` kini berasal dari gerbang akhir.

## Lingkungan

macOS 27.0 (arm64), Bun 1.4.2, Node 24.21.0, TypeScript 6.0.3, Angular 22.2.0 dengan Vitest 4.1.11 melalui Angular CLI, Playwright 1.63.0 dengan Chromium 153.0.8010.12 bawaannya, Elysia 1.4.30, dan `@ojiepermana/angular` 22.1.14. Docker Desktop dengan Docker Engine 29.8.0 dan Docker Compose 5.5.1. PostgreSQL 18.6 dari image `foundation-postgres:18-pinned` ber ID `4bfe8e9ca45b`, dibuat 2026-10-03, dengan label project Compose `foundation-infra-test-cf45f7fe`. Versi dibaca dari `postgres --version` pada container `--rm` dengan ketiga label Compose dikosongkan. `docker events` tidak mencatat event image selama gerbang, jadi setiap suite nyata memakai image yang sama. k6 tidak terpasang (`which k6` tidak menemukan binary).

Setiap suite nyata membuat container PostgreSQL 18 terisolasi miliknya sendiri. PostgreSQL Compose bersama milik project ini (`foundation-postgres-1`, port host 55432) sudah berjalan sebelum gerbang dan tidak disentuh, begitu pula container project lain di host. Port 8888, 8889, dan 8890 kosong dan `.local/serve.lock` tidak ada, sebelum maupun sesudah gerbang.

## Perintah dan hasil gerbang akhir

Gerbang menjalankan gate proyek `test:ci` dan setiap suite nyata yang mencakup bagian yang disentuh fitur ini: smoke doctor dan serve (`test:tooling:real`), spec READY-009 serta helper `tests/e2e/readiness/response-body.ts` yang juga dipakai smoke (`test:readiness:real`), backend dan database nyata (`test:database:real` dan `test:database:migration`), serta batas kata `docker` di bawah `scripts/` milik spec 0002 (`test:infrastructure`), karena fitur ini mengubah `scripts/`. Setiap script yang dirujuk registry `tests/scenarios/` tercakup. Setiap perintah dijalankan satu kali, berurutan, tanpa retry, dan tidak ada yang gagal.

| Perintah | Hasil aktual |
| --- | --- |
| `bun run test:ci` | Exit 0 dalam 129 detik. `check:dependencies` mencetak `Exact dependency pins, runtime engines and installed peers passed`; `test:scenarios` 58 ID unik; `api:check` mencetak `OpenAPI and SDK match stored artifacts across two runs`; `build:frontend` initial total 684,40 kB raw dan 154,05 kB transfer, dengan warning anggaran 500 kB yang sama (lebih 184,41 kB); `check:frontend:bundle` lulus; `typecheck:backend`, `typecheck:contract`, `typecheck:e2e`, dan `typecheck:tooling` exit 0; `build:backend` membundel 8 modul; `test:frontend` 4 file dan 79 test (`app.spec.ts` 1, `sdk-contract.integration.spec.ts` 6, `readiness-api.integration.spec.ts` 49, `readiness-page.spec.ts` 23); `test:integration` 630 test dan 2.734 assertion dalam 76,8 detik, 0 gagal (`application.test.ts` 20, `backend/readiness.test.ts` 26, `frontend-bundle.test.ts` 62, `openapi-contract.test.ts` 404, `openapi.test.ts` 48, `readiness-container.test.ts` 9, `readiness-contract.test.ts` 7, `sdk.test.ts` 54); `test:tooling` 54 test dan 209 assertion dalam 32,9 detik, 0 gagal, 0 dilewati; `test:e2e` 12 test dalam 10,0 detik, termasuk keenam test READY-006 yang kini membaca body lewat halaman. |
| `bun run test:tooling:real` | Exit 0 dalam 24 detik. Output: TOOL-001 lulus 12 pemeriksaan database dengan role hasil provisioning, lalu menolak target salah, hak tulis metadata, keanggotaan role penulis, checksum berbeda, metadata tanpa file, migration kosong, role admin, `USAGE` yang dicabut dari `auth`, `CREATEROLE`, `UPDATE`, `DELETE`, dan `TRUNCATE` pada metadata, schema konfigurasi yang tidak ada, `CREATE` pada `users` dan `public`, `CREATEDB`, pemilik metadata, metadata tidak terbaca, direktori migration hilang, serta file yang belum diterapkan; doctor tidak menulis metadata dan tidak menerapkan migration. TOOL-002 menolak listener asing pada 8889 sesudah preflight tanpa sinyal. `GET http://127.0.0.1:8888/api/status` memberi 200 `{"status":"ok"}` dan `GET http://127.0.0.1:8889/` memberi 200 `text/html`; URL Frontend dan Backend diumumkan sekali, berurutan, tepat sebelum siap; listener hanya `127.0.0.1:8888` dan `127.0.0.1:8889`. TOOL-005 memeriksa catatan owner dan `serve` kedua yang keluar 1 dengan `Serve lain dari checkout ini masih aktif.` READY-009 `1 passed` di bawah `serve` yang sama. 5 sesi `foundation_backend` sebelum SIGTERM; SIGTERM keluar 143 dan Ctrl+C pada `serve` kedua keluar 130, keduanya menghentikan kedua grup, membebaskan 8888 dan 8889, melepas lock, mencetak `Backend stopped`, dan tidak menyisakan sesi `foundation_backend`. Database yang dihapus ditolak tanpa credential, dan `serve` berhenti pada preflight sementara listener fixture tetap menjawab. Pemindaian: `6 random values absent from 36 outputs and 7 files`; `.local/feature-2/artifact-scan.json` berisi 0 temuan. JUnit `tests="1" failures="0" skipped="0" errors="0"`. |
| `bun run test:readiness:real` | Exit 0 dalam 5 detik. Output: `Isolated PostgreSQL 18 container foundation-readiness-580605a5 started.`, `Isolated database provisioned and migrated.`, `Backend and frontend answered 200.`, satu test READY-009 lulus, `Readiness artifact scan passed: 6 random values absent from 5 outputs and 7 files.`, lalu `READY-009 passed against the real database, backend, and frontend.` JUnit `tests="1" failures="0" skipped="0" errors="0"`; `.local/feature-10/artifact-scan.json` berisi 0 temuan. |
| `bun run test:database:real` | Exit 0 dalam 42 detik. Build frontend untuk pemindaian artefak lulus, lalu 29 test dengan 1.413 assertion lulus dalam 39,8 detik, 0 gagal: `migration.test.ts` 5, `readiness.test.ts` 12 (READY-008), dan `provision.test.ts` 12. Pemindaian mencetak `Database artifact scan passed: 7 random values absent from 16 files.`, dan `.local/feature-5/artifact-scan.json` berisi 0 temuan. |
| `bun run test:database:migration` | Exit 0 dalam 17 detik. MIG-001 sampai MIG-005 lulus 5 test dengan 59 assertion dalam 16,6 detik, 0 gagal. |
| `bun run test:infrastructure` | Exit 0 dalam 49 detik. 18 test dengan 173 assertion lulus dalam 48,9 detik, 0 gagal, 0 dilewati, termasuk INFRA-001 yang menolak kata `docker` di bawah `scripts/`. |

Sesudah gerbang, `git status --porcelain`, SHA 256 `git diff`, dan checksum file yang belum dilacak sama dengan awal gerbang. Tidak ada container bernama `foundation-readiness-*` atau `foundation-infra-test-*`, port 8888, 8889, dan 8890 bebas, `.local/serve.lock` tidak ada, dan tidak ada proses `serve`, backend, `ng serve`, `bun test`, atau Playwright yang tersisa. Tiga folder `foundation-*` di `TMPDIR` (`foundation-db-test-TjeZhe`, `foundation-openapi-cli-gWoY8C`, dan `foundation-readiness-test-9Oj0xx`) sudah ada sebelum gerbang, bukan buatan gerbang ini, dan jumlahnya tidak bertambah.

Screenshot `readiness-available-mobile.png` dan `readiness-unavailable-stopped.png` dari run `test:tooling:real` dilihat langsung. Pada 375 px, state tersedia menampilkan `Database dapat dibaca.`, waktu pemeriksaan, jumlah migration `1`, dan tombol `Periksa ulang` tanpa terpotong. Pada 1280 px, state database berhenti menampilkan pesan tidak tersedia dengan waktu pemeriksaan dan tanpa jumlah migration.

Kesembilan JUnit di `evidence/0005/` berasal dari gerbang ini, disalin tanpa atribut `hostname`, tidak memuat path absolut, dan lulus `xmllint --noout`: [tooling](evidence/0005/tooling.xml), [integration](evidence/0005/integration.xml), [frontend](evidence/0005/frontend.xml), dan [Playwright](evidence/0005/playwright.xml) dari `test:ci`; [Playwright nyata di bawah `serve`](evidence/0005/playwright-real.xml) dari `test:tooling:real`; [Playwright nyata kesiapan](evidence/0005/playwright-readiness-real.xml) dari `test:readiness:real`; [database](evidence/0005/database.xml) dari `test:database:real`; [migration](evidence/0005/migration.xml) dari `test:database:migration`; dan [infrastruktur](evidence/0005/infrastructure.xml) dari `test:infrastructure`. `tooling.xml` dan `playwright-real.xml` menggantikan file bernama sama dari bagian riwayat. Smoke sendiri tidak menulis JUnit; hasilnya adalah output yang dikutip di tabel, dan laporan pemindaiannya ada di `.local/feature-2/` yang tidak masuk repository.

## Hasil per skenario

| Skenario | Kriteria | Bukti | Status |
| --- | --- | --- | --- |
| `TOOL-001` | AC-1, AC-2, AC-3 | 4 test `bun:test` di `tests/integration/tooling/development.test.ts` (`test:tooling`), ditambah smoke `test:tooling:real` dengan seluruh kelompok penolakan role, privilege, schema, dan migration pada PostgreSQL 18.6 | `passed` |
| `TOOL-002` | AC-6 | 7 test fixture, ditambah listener asing nyata pada 8889 yang ditolak tanpa sinyal pada smoke | `passed` |
| `TOOL-003` | AC-5 | 10 test fixture | `passed`, fixture saja karena belum ada worker nyata |
| `TOOL-004` | AC-8 | 4 test fixture, ditambah SIGTERM (143) dan Ctrl+C (130) pada smoke dengan `Backend stopped` dan 0 sesi `foundation_backend` sesudahnya | `passed` |
| `TOOL-005` | AC-6, AC-7 | 16 test fixture, ditambah catatan owner dan `serve` kedua pada smoke | `passed` |
| `TOOL-006` | AC-4, AC-8 | 10 test fixture | `passed`, fixture |
| `TOOL-007` | AC-1, AC-2, AC-3, AC-4, AC-9 | Smoke `test:tooling:real` dan 1 test Playwright READY-009 terhadap `serve` | `passed` (di luar `test:ci`) |
| `TOOL-008` | AC-3, AC-5 | 3 test fixture | `passed` |

Jumlah test fixture dihitung dari nama testcase per tag di JUnit `tooling.xml` gerbang ini: 4, 7, 10, 4, 16, 10, dan 3, jumlahnya 54. Fitur ini juga mengubah file milik skenario spec 0006, yang ikut lulus pada gerbang yang sama: READY-006 (6 test Playwright di `test:e2e`, kini membaca body respons dari halaman lewat `response-body.ts`), READY-009 (1 test lewat `test:readiness:real`), dan READY-010 (9 test di `readiness-container.test.ts`, dengan smoke ini terdaftar sebagai pemakai penjaga).

## Hasil per kriteria

| Kriteria | Hasil dan bukti |
| --- | --- |
| AC-1 | Terpenuhi. Smoke membuktikan doctor menerima role `foundation_backend` hasil provisioning pada 12 pemeriksaan, lalu menolak setiap kelompok yang disebut di tabel perintah, dan setiap pesan dari run doctor di dalam smoke bebas credential, DSN, error mentah, dan SQL. Fixture TOOL-001 membuktikan `DATABASE_URL` yang hilang, PostgreSQL yang mati, skema URL yang salah, dan batas waktu database yang menerima koneksi tanpa menjawab. Syarat versi minimal 18 tidak mempunyai kasus negatif (*Batas bukti*). |
| AC-2 | Terpenuhi. Checksum berbeda, metadata tanpa file, migration kosong, direktori migration hilang, metadata tidak terbaca, dan file yang belum diterapkan ditolak pada PostgreSQL nyata. Isi `common.schema_migrations` dan efek migration yang tertunda sama sebelum dan sesudah doctor. |
| AC-3 | Terpenuhi. Smoke: dengan database yang sudah dihapus, `serve` berhenti pada preflight tanpa menjalankan layanan, dan listener fixture pada 8888 serta 8889 tetap menjawab. Fixture TOOL-008: mode production dan konfigurasi rusak gagal sebelum cleanup. Fixture TOOL-003: worker yang tidak dikenal ditolak sebelum lock. |
| AC-4 | Terpenuhi. Smoke: HTTP 200 dari `/api/status` dan `/`, pengumuman URL yang berurutan tepat sebelum siap, dan listener yang hanya terikat pada `127.0.0.1`. Fixture TOOL-006: respons salah, listener asing, pemilik port yang berubah sesudah probe dan sebelum pengumuman, serta batas 60 detik. |
| AC-5 | Terpenuhi lewat fixture saja (TOOL-003 dan TOOL-008). Belum ada worker aplikasi nyata (Follow-up 3 spec 0003). |
| AC-6 | Terpenuhi. Fixture TOOL-002 dan TOOL-005, ditambah listener asing nyata pada 8889 yang tetap hidup. |
| AC-7 | Terpenuhi. 16 test fixture TOOL-005 membuktikan satu pemulih pada satu waktu, guard sisa crash, catatan belum lengkap, dan identitas yang berubah. Smoke membuktikan `serve` kedua gagal tanpa mengganggu yang pertama. |
| AC-8 | Terpenuhi. Fixture TOOL-004 dan TOOL-006, ditambah SIGTERM dan Ctrl+C pada aplikasi nyata yang menghentikan kedua grup, melepas lock, dan menutup pool backend. Sinyal pada fase lock dan cleanup port ditangani kode, tetapi hanya fase doctor yang dikunci test (temuan minor review ulang yang masih terbuka). |
| AC-9 | Terpenuhi pada macOS. 54 test fixture `test:tooling` berjalan pada port sementara. Smoke memakai PostgreSQL 18.6 terisolasi yang diprovision dan dimigrasi lewat runner fitur 5 dan 6, frontend dan backend dari `serve`, request HTTP nyata, dan READY-009 melalui browser, SDK, proxy `/api` Angular, backend, dan database: state tersedia dengan jumlah migration pada 1280×812 dan 375×812, database berhenti tanpa jumlah lama, pulih sesudah `docker start` tanpa restart `serve`, lalu `serve` yang sama berhenti bersih. Pemindaian credential tidak menemukan apa pun. |

## Identitas artefak

| Artefak | SHA-256 |
| --- | --- |
| `evidence/0005/tooling.xml` | `f65f55babd9989748cef5d9ae7cf2086533959410b45b1e9a48aacfcc8a7d9e0` |
| `evidence/0005/integration.xml` | `6c54216a724c283e53c8b9cc7471c40b9eb5131ad3bd2602c35761c0b34d04dc` |
| `evidence/0005/frontend.xml` | `6355c9136465b7656bffa506400fb58486b8514b64375bba64e0df2e51948e01` |
| `evidence/0005/playwright.xml` | `958832205803d81679d344c19a365092c495ae79130ce211fe767d4b3a86dfc4` |
| `evidence/0005/playwright-real.xml` | `5d3433d7e15afc58fcd621256d7e4991a6ad7380ec4af520fa94b796d4be1d0b` |
| `evidence/0005/playwright-readiness-real.xml` | `0dd33b7b38c84a3146adcce37da4b7c2fbe4bddc376ac01ce22562ec8f64cd5a` |
| `evidence/0005/database.xml` | `0950fa1849305cefb0f1460f7b38c7dc41476e36947369a6f1ec09b1ef718c49` |
| `evidence/0005/migration.xml` | `694dbd4b41d6217d297781b15f3df8f55532e4776f6a531876b24310493f74d5` |
| `evidence/0005/infrastructure.xml` | `949c4e590f400285a70386577f4ae10c9a722511b7a54b59a310b789e6791790` |

Fitur ini tidak mengubah backend, sehingga `openapi.json` dan SDK tidak disentuh sesuai invariant 6 spec 0003; `api:check` di dalam `test:ci` membuktikan keduanya sama dengan artefak tersimpan.

## Kontrol mutasi

Gerbang akhir tidak mengulang kontrol mutasi. Kontrol yang sudah dijalankan tercatat di bagian riwayat: nama container READY-009 yang salah (*Alur browser fitur 10 melalui `serve`*), empat belas mutasi pada salinan `scripts/` dan run kontrol SIGKILL (*Perbaikan temuan review*), serta mutasi reviewer di [review ulang](../reviews/2026-10-04-main-doctor-serve-followup.md).

## Waktu

- `test:ci` 129 detik, sama dengan run terakhir bagian riwayat, dengan `test:integration` 76,8 detik, `test:tooling` 32,9 detik, dan `test:e2e` 10,0 detik.
- `test:tooling:real` 24 detik dari awal sampai container dihapus. READY-009 di bawah `serve` 1,22 detik menurut JUnit, jauh di bawah batas pemulihan 30 detik.
- `test:readiness:real` 5 detik, `test:database:real` 42 detik dengan suite 39,8 detik, `test:database:migration` 17 detik, dan `test:infrastructure` 49 detik.
- Initial bundle 684,40 kB raw dan 154,05 kB transfer, sama dengan gerbang fitur 10. Fitur ini tidak mengubah frontend.

## Profil k6

`not_applicable`. Spec 0003 tidak menetapkan target latency, throughput, atau beban. Doctor dan serve adalah tooling development untuk satu checkout, dan batas waktu yang ditetapkan spec (readiness 60 detik) dibuktikan test fixture TOOL-006. k6 tidak terpasang di host, dan repository belum mempunyai script `test:performance:*`.

## Batas bukti

- Seluruh run berjalan di macOS arm64 dengan Docker Desktop dan Chromium bawaan Playwright. Linux, termasuk runner CI, belum dijalankan. `test:tooling:real`, `test:readiness:real`, dan `test:database:real` berada di luar `test:ci` sampai fitur 11 menambah jalur CI dengan Docker. Gerbang ini menjalankan smoke satu kali; run sebelumnya tercatat di bagian riwayat, dan semuanya bukan studi stabilitas.
- AC-5 hanya terbukti lewat fixture karena belum ada worker aplikasi nyata.
- Syarat PostgreSQL minimal 18 tidak mempunyai kasus negatif, karena server versi lain hanya tersedia dari image yang tidak dipin (penolakan beralasan di review ulang).
- [Review ulang](../reviews/2026-10-04-main-doctor-serve-followup.md) meninggalkan satu temuan minor terbuka: sinyal pada fase lock dan cleanup port sudah ditangani kode, tetapi baru fase doctor yang dikunci test. Dari sembilan nit, dua diselesaikan oleh pembaruan dokumen gerbang ini (angka pada paragraf scope fitur 2 dan ringkasan status di awal laporan ini). Tujuh tetap terbuka: test TOOL-006 yang membutuhkan loopback IPv6, komentar handler sinyal di `scripts/serve.ts`, `freePort()` pada smoke, `BASE_ENV_KEYS` dan helper yang disalin di empat file, pesan `Startup dibatalkan.` sesudah layanan keluar, baris `test:tooling:real` di `docs/rules/testing.md` beserta larangan port nyata di `docs/rules/development-commands.md`, serta pemenggalan komentar di `readiness-container.test.ts`. Pengingat `AGENTS.md` tentang batas AC-6 menunggu `/sync`.
- `/check verify` mengamati bahwa backend di bawah `bun --watch` menutup listener dan pool saat SIGTERM tetapi prosesnya tidak keluar sendiri, sehingga `serve` bergantung pada eskalasi SIGKILL. Gerbang ini tidak mengukurnya ulang; smoke hanya mewajibkan exit 143 dalam 10 detik dan grup yang hilang.
- Pemindaian credential mencari nilai acak run tersebut pada output dan artefak; itu bukan pemindaian secret umum. Pemindaian byte pada screenshot PNG tidak membuktikan teks yang dirender, yang dibuktikan assertion READY-009.
- Checkbox fitur 2 pada Follow-up [spec 0006](../specs/0006-alur-pemeriksaan-kesiapan/index.md) belum dicentang, dan rationale spec 0006 keputusan 46 masih menyebut "ketiga pemakai" penjaga sementara READY-010 kini memuat lima file. Keduanya milik `/architect` atau `/sync`.
- Build frontend masih memberi warning anggaran initial bundle 500 kB yang sudah ada sebelum fitur ini.
- Laporan ini adalah bukti fitur, bukan bukti kesiapan release.

## Smoke pertama 2026-10-02

Bagian ini dan seluruh bagian bertanggal sesudahnya adalah riwayat. Kandidat saat itu: commit dasar `9227a71c26af7a36188116415bf94f5aaa3d2e4e` ditambah perubahan lokal pada `tests/integration/tooling-real/doctor-smoke.ts`. Sumber kriteria: [spec 0003](../specs/0003-doctor-serve-aplikasi-nyata/index.md), khususnya TOOL-001 dan bagian HTTP TOOL-007.

### Lingkungan dan perintah

`bun run test:tooling:real` membuat container sementara `foundation-postgres:18-pinned` pada port acak. Script memakai file environment berizin `0600`, menjalankan `database/provision.ts --apply` dan `database/migrate.ts --apply` dengan tiga credential terpisah, lalu menghapus container. Database dan volume Compose development tidak disentuh. Frontend dan backend dijalankan oleh `scripts/serve.ts` pada port 8889 dan 8888 hanya setelah script membuktikan kedua port kosong.

### Hasil aktual

Perintah keluar dengan status **0**. Doctor menerima role backend hasil provisioning: 12 pemeriksaan database lulus, termasuk target, versi, schema, batas role, privilege metadata, dan checksum migration. Doctor menolak target lain, hak `INSERT` metadata, keanggotaan role penulis, checksum berbeda, direktori migration kosong, role admin, serta database yang dihentikan. Output provisioning, migration, dan doctor diperiksa agar tidak memuat credential uji.

`serve` mengumumkan siap setelah preflight. GET backend `/api/status` memberi HTTP 200 dengan `{"status":"ok"}` dan GET frontend `/` memberi HTTP 200 dengan `Content-Type` HTML. Setelah SIGTERM ke supervisor, listener 8888 dan 8889 tidak tersisa. Script lama yang membuat schema contoh dan mengubah direktori migration proyek diganti dengan setup provisioning serta migration produk yang nyata.

### Batas bukti

Ini adalah smoke test CLI dan HTTP, tanpa JUnit. TOOL-007 masih **parsial**: alur Angular melalui SDK, proxy, backend, dan database di browser belum tersedia sebelum fitur 10. Pemeriksaan kegagalan database sesudah startup pada halaman juga menunggu fitur 10. Test fixture TOOL-002 sampai TOOL-006 dan TOOL-008 berada pada suite `bun run test:tooling`; hasil smoke ini tidak menggantikan review independen atau verifikasi penuh fitur 2.

## Pemeriksaan ulang 2026-10-03

Run terbaru menguji working tree di atas `cd9abcd`, termasuk validasi ulang pemilik port tepat sebelum `SIGTERM` dan `SIGKILL`. `bun run test:tooling` lulus **26 test, 75 assertion, 0 gagal, 0 dilewati**; JUnit tersanitasi ada di [evidence 0005](evidence/0005/tooling.xml). Cakupan fixture kini mencakup PID dengan waktu mulai berbeda, pemilik port yang berubah sebelum sinyal, path readiness worker HTTP, lock invocation yang belum lengkap, serta grup proses tercatat dari checkout berbeda. `bun run test:scenarios` lulus dengan 27 ID unik. TypeScript tooling, `typecheck:backend`, `build:backend`, dan `build:frontend` juga lulus.

`bun run test:tooling:real` lulus dengan PostgreSQL 18 terisolasi. Doctor menerima role runtime pada 12 pemeriksaan database, lalu menolak target salah, privilege tulis metadata, keanggotaan role penulis, checksum berbeda, metadata migration tanpa file, migration kosong, dan role admin. `serve` mengumumkan siap; `GET http://127.0.0.1:8888/api/status` memberi HTTP 200 dengan `{"status":"ok"}`, dan `GET http://127.0.0.1:8889/` memberi HTTP 200 dengan `Content-Type: text/html`. SIGTERM menghapus listener pada kedua port, dan pemeriksaan setelah database dihentikan gagal tanpa menampilkan credential.

Pada konfigurasi workstation biasa, `bun run doctor` dan `bun run serve` masing-masing keluar dengan status 1 karena database development lokal tidak aktif. Keduanya hanya menampilkan pesan koneksi yang disamarkan; `serve` berhenti pada preflight. Ini bukan bukti browser dan tidak menggantikan run PostgreSQL terisolasi di atas. Build frontend selesai dengan peringatan ukuran initial bundle 675.12 kB terhadap budget 500 kB.

TOOL-007 tetap **parsial**. Browser belum dapat menjalankan alur Angular melalui SDK, proxy, backend, dan database sampai fitur 10 tersedia; verifikasi browser serta respons halaman ketika database gagal masih terbuka. Scope 2 dan spec 0003 tetap `in-progress`.

## Gate regresi 2026-10-03

Pada kandidat `HEAD cd9abcd` ditambah perubahan working tree Scope 2, `bun run test:ci` keluar dengan status 0. Dependency dan 27 ID skenario lolos; `api:check` membuktikan dua sinkronisasi OpenAPI/SDK identik; build frontend, typecheck dan build backend lulus; test frontend lulus 1/1; test backend dan kontrak lulus 68/68 dengan 143 assertion; tooling lulus 26/26 dengan 75 assertion; dan Playwright lulus 2/2 pada viewport 1280×812 dan 375×812.

Playwright dalam gate ini hanya membuktikan kerangka aplikasi Scope 4 serta proxy ke route status. Ia belum menjalankan alur halaman kesiapan Scope 10 dan tidak mengubah status TOOL-007 dari parsial. Build frontend masih memperingatkan initial bundle 675,12 kB dibanding budget 500 kB.

Probe workstation terbaru menjalankan `bun run doctor` dan `bun run serve`; keduanya keluar dengan status 1 karena PostgreSQL development tidak tersedia dan tidak mencetak credential. Untuk memeriksa batas cleanup, listener fixture HTTP sementara pada 8888 dan 8889 tetap memberi body `probe-8888` dan `probe-8889` setelah `serve` gagal pada preflight; fixture kemudian ditutup oleh probe. Hasil ini membuktikan kegagalan preflight tidak mengganggu listener yang sedang ada, tetapi tidak menggantikan pembuktian browser TOOL-007.

## Pemeriksaan setelah commit UI 2026-10-03

Kandidat `HEAD 3585237` dengan perubahan Scope 2 yang masih lokal. Percobaan pertama `bun run test:tooling:real` keluar dengan status 1 setelah kedua layanan mulai, karena pemeriksaan readiness melaporkan `Listener frontend bukan milik invocation ini`. Shutdown menghapus listener; credential tidak muncul. Penyebabnya belum dapat direproduksi.

Tiga pengulangan berikutnya keluar dengan status 0. Dua memakai flag diagnostik dan instrumentasi sementara pada `readiness.ts`; yang ketiga memakai source asli tanpa flag. Setiap run memakai PostgreSQL 18 terisolasi; doctor menerima role backend, menolak kasus privilege dan metadata yang salah, `/api/status` serta halaman frontend mengembalikan HTTP 200, dan SIGTERM menghapus listener 8888 serta 8889. Probe proses terpisah juga menerima listener Angular melalui jalur spawn frontend dan supervisor. Instrumentasi diagnosis sudah dihapus, sehingga working tree tidak menyimpan perubahan `readiness.ts`. Catatan kegagalan awal dipertahankan sebagai kemungkinan race startup yang belum terjelaskan dan perlu dipertimbangkan pada gate akhir Scope 2.

Gate `bun run test:ci` pada kandidat yang sama lulus: 30 ID skenario, 1 frontend test, 81 integration test dengan 172 assertion, 26 tooling test dengan 75 assertion, dan 4 Playwright E2E. Playwright memverifikasi shell Scope 7 dan proxy backend Scope 4; ia belum membuktikan alur TOOL-007. Build frontend mencatat initial bundle 654,09 kB terhadap budget 500 kB.

## Race readiness dan bukti setelah perbaikan 2026-10-03

Kandidat tetap `HEAD 3585237` dengan perubahan Scope 2 lokal yang belum di-commit. Lingkungan: Bun 1.4.2, Node 24.21.0, macOS 27.0, Docker Engine 29.8.0, dan PostgreSQL 18.6 dari `foundation-postgres:18-pinned`.

Dua smoke tambahan sebelum perbaikan mengulang kegagalan `Listener frontend bukan milik invocation ini` setelah Angular selesai build dan mulai melayani port. Percobaan lain lulus. Shutdown tetap membersihkan listener pada setiap kegagalan. Tidak ada log mismatch pemilik dari pemeriksaan pertama; urutan kode menunjukkan port dapat belum terlihat pada snapshot pertama, lalu sudah terlihat pada pembacaan berikutnya. Percobaan gagal tidak menyimpan PID/PGID listener kedua, jadi kepemilikan tepat saat itu tidak dapat dipastikan. Implementasi lama menyatukan keadaan port kosong dan listener asing sebagai `false`, lalu menyebut setiap listener pada pembacaan kedua sebagai asing tanpa memeriksa ulang grupnya.

`inspectPortOwner` sekarang mengembalikan keadaan `absent`, `owned`, atau `foreign` dari satu snapshot listener. Readiness mengulang pemeriksaan untuk port yang masih kosong, menolak listener asing, lalu tetap memverifikasi kepemilikan setelah probe HTTP dan sebelum mengumumkan siap. Skenario regresi TOOL-006 mensimulasikan snapshot kosong diikuti listener invocation yang siap.

Sesudah perubahan, `bun run test:tooling:real` lulus **11 run berturut-turut** pada source tanpa instrumentasi diagnostik. Setiap run memeriksa 12 kondisi database positif, penolakan target/privilege/migration yang salah, respons nyata `GET /api/status` HTTP 200 dengan `{"status":"ok"}`, respons frontend `GET /` HTTP 200 bertipe HTML, dan shutdown SIGTERM yang membebaskan port 8888 serta 8889.

`bun run test:tooling` lulus **28 test, 78 assertion, 0 gagal, 0 dilewati**; JUnit terbaru disimpan pada [evidence 0005](evidence/0005/tooling.xml). Registry memuat 31 ID skenario. `bun run test:ci` lulus pada kandidat ini: 1 frontend test, 81 integration test/172 assertion, 28 tooling test/78 assertion, serta 4 Playwright E2E. Build frontend memperingatkan initial bundle 654.09 kB dibanding budget 500 kB.

Verifikasi penuh tetap **FAIL/incomplete untuk Scope 2** sampai browser Feature 10 dapat membuktikan SDK, proxy, backend, dan database dalam satu alur. [Checklist AC](../specs/0003-doctor-serve-aplikasi-nyata/verify.md) mencatat setiap status dan batas buktinya.

## Deadline readiness dan gate terbaru 2026-10-03

Reproduksi lokal memakai backend fixture yang menunggu 120 ms sebelum mengembalikan JSON sehat, dengan deadline readiness 25 ms. Implementasi menerima readiness setelah 124 ms. Penyebabnya, timer probe selalu 1,5 detik dan keberhasilan probe tidak diperiksa lagi terhadap deadline. `waitForReadiness` sekarang membatasi timer probe dengan waktu tersisa, memeriksa deadline sebelum menyatakan siap, dan membatasi jeda polling pada sisa waktu.

Regression test TOOL-006 menunda respons sehat 300 ms dengan deadline 80 ms dan memastikan layanan ditolak. `bun run test:tooling` lulus **29 test, 79 assertion, 0 gagal, 0 dilewati**. JUnit terbaru tersimpan di [evidence 0005](evidence/0005/tooling.xml).

Setelah perbaikan deadline, `bun run test:tooling:real` lulus kembali: 12 pemeriksaan database runtime, seluruh kasus privilege dan migration negatif, backend `/api/status` HTTP 200, frontend `/` HTTP 200 `text/html`, serta pelepasan listener 8888 dan 8889 setelah SIGTERM. `bun run test:ci` juga lulus pada working tree ini: 31 ID skenario, API/SDK dua run identik, frontend 1/1, integration 81/81 dengan 172 assertion, tooling 29/29 dengan 79 assertion, dan Playwright 4/4. Build frontend tetap memperingatkan initial bundle 654,09 kB terhadap budget 500 kB.

Pemeriksaan ini memperbaiki satu pelanggaran batas waktu AC-4 dan membuktikan regresinya. AC-9 masih belum terpenuhi karena browser belum menjalankan alur Feature 10 melalui SDK, proxy, backend, dan database; Scope 2 tetap `in-progress`.

## Alur browser fitur 10 melalui `serve` 2026-10-04

Kandidat: `HEAD b1ae733` ditambah perubahan lokal pada `tests/integration/tooling-real/doctor-smoke.ts`, `tests/scenarios/development-tooling.json`, dan script `test:tooling:real` di `package.json`. Lingkungan: Bun 1.4.2, Node 24.21.0, macOS 27.0, Docker Engine 29.8.0, Playwright 1.63.0 dengan Chromium, dan PostgreSQL 18 dari image `foundation-postgres:18-pinned`. Run ini tidak mencetak versi minor PostgreSQL; laporan sebelumnya dengan image yang sama mencatat 18.6. Sumber kriteria: [spec 0003](../specs/0003-doctor-serve-aplikasi-nyata/index.md) TOOL-007 dan AC-9, serta Follow-up fitur 2 pada [spec 0006](../specs/0006-alur-pemeriksaan-kesiapan/index.md).

### Perubahan smoke

- Container PostgreSQL terisolasi sekarang mengikuti penjaga READY-009 dari `tests/orchestration/readiness-container.ts` dengan pemilik `'browser'`: nama `foundation-readiness-<8 hex>`, label dari `READINESS_RUN_LABEL_ARGS`, port host loopback yang tetap, dan tanpa `--rm`. Label image diperiksa dengan `readinessImageLabelsAccepted` sebelum `docker run`. Penghapusan container selalu melewati penjaga yang sama (nama, `docker container inspect`, label), sehingga penjaga tidak diperluas.
- Setelah `serve` mengumumkan siap dan respons HTTP `/api/status` serta `/` lulus, smoke menjalankan `playwright.real.config.ts` terhadap `serve` dengan `FOUNDATION_READINESS_CONTAINER`. Hasil Playwright ditulis ke `.local/feature-2/` lewat `--output` dan `PLAYWRIGHT_JUNIT_OUTPUT_FILE`, sehingga bukti fitur 10 di `.local/feature-10/` tidak tersentuh (waktu ubah `playwright-real.xml` dan `artifact-scan.json` di sana sama sebelum dan sesudah run).
- Docker dan Playwright hanya menerima environment allow list spec 0006, tanpa `DATABASE_URL`. Script `test:tooling:real` kini memakai `bun --no-env-file`, sama seperti `test:readiness:real`.
- Sesudah alur browser, proses `serve` yang sama wajib masih hidup. SIGTERM wajib selesai dalam 10 detik dengan exit code 143, listener 8888 dan 8889 hilang, dan `.local/serve.lock` terlepas.
- Sesudah container dihapus, doctor wajib gagal. `serve` dengan database yang sudah tidak ada wajib keluar dengan status 1 pada preflight (`Doctor belum lulus`) tanpa menjalankan layanan apa pun, sementara listener fixture pada 8888 dan 8889 tetap menjawab `probe-8888` dan `probe-8889`, dan lock tetap terlepas (AC-3 pada aplikasi nyata).
- Pemindaian credential memeriksa enam nilai acak (tiga password dan tiga URL) pada seluruh output langkah dan layanan, JUnit, serta setiap file artefak Playwright. Laporannya ditulis ke `.local/feature-2/artifact-scan.json`. Satu temuan saja membuat smoke gagal.

### Hasil aktual

Run pertama `bun run test:tooling:real` keluar dengan status **0** dalam 16 detik.

Kontrol mutasi: nilai `FOUNDATION_READINESS_CONTAINER` diubah sementara menjadi `foundation-readiness-00000000`, nama yang lolos pola tetapi tidak ada. Playwright gagal dengan `Readiness container guard could not inspect the container`, dan smoke keluar dengan status **1** dengan pesan `READY-009 browser flow under serve failed`. Pada jalur gagal itu `serve` tetap berhenti, container dihapus lewat penjaga, port 8888 dan 8889 bebas, lock terlepas, dan tidak ada proses `serve`, backend, atau `ng serve` yang tersisa. Baris tersebut dikembalikan dan diperiksa ulang sebelum run berikutnya.

Run terakhir pada source tanpa mutasi keluar dengan status **0** dalam 15 detik. Output yang diamati:

- TOOL-001: 12 pemeriksaan database lulus dengan role hasil provisioning; target salah, hak tulis metadata, keanggotaan role penulis, checksum berbeda, metadata tanpa file, migration kosong, dan role admin ditolak.
- `GET http://127.0.0.1:8888/api/status` memberi HTTP 200 `{"status":"ok"}` dan `GET http://127.0.0.1:8889/` memberi HTTP 200 `text/html` setelah `serve` mengumumkan siap.
- READY-009 lulus 1 dari 1 test melalui browser, SDK, proxy `/api` Angular, backend, dan database: state tersedia dengan jumlah migration pada 1280×812 dan 375×812, periksa ulang, database dihentikan dengan state tidak tersedia tanpa jumlah lama, lalu pulih setelah `docker start` tanpa restart `serve`.
- SIGTERM: `serve` keluar dengan 143, listener 8888 dan 8889 hilang, dan lock terlepas.
- Database yang sudah dihapus ditolak doctor tanpa credential pada pesan; `serve` berhenti pada preflight dan listener fixture tetap menjawab.
- Pemindaian credential: 6 nilai acak tidak ditemukan pada 6 output (`provision`, `migrate`, `doctor`, `playwright`, `serve`, dan `serve preflight`) dan 7 file (JUnit, `.last-run.json`, dan lima screenshot), dengan 0 temuan.

JUnit Playwright run terakhir disalin tanpa atribut `hostname` ke [evidence 0005](evidence/0005/playwright-real.xml) (`tests="1"`, `failures="0"`, lulus `xmllint --noout`, tanpa path absolut, SHA 256 `b29953d0d21b2e63ce4b54e02cd7be0e3f3d7bd081572e85da58fcc02e56cfdb`).

Sesudah setiap run tidak ada container bernama `foundation-readiness-*`, port 8888 dan 8889 bebas, `.local/serve.lock` tidak ada, dan PostgreSQL Compose bersama yang sudah berjalan sebelumnya tidak disentuh.

Gate regresi `bun run test:ci` pada working tree yang sama keluar dengan status 0 dalam 115 detik: 58 ID skenario, OpenAPI dan SDK identik pada dua run, initial bundle 684,40 kB dengan warning anggaran 500 kB yang sama seperti sebelumnya, 79 test frontend, 630 integration test dengan 2.728 assertion, 29 tooling test dengan 79 assertion, dan 12 E2E pass. Backend tidak berubah, sehingga artefak OpenAPI dan SDK tidak disentuh sesuai invariant 6 spec 0003.

### Batas bukti

- TOOL-007 kini mempunyai bukti untuk AC-1 sampai AC-4 dan bagian aplikasi nyata AC-9 pada satu mesin macOS dengan Chromium. Linux belum dijalankan, dan smoke tetap berada di luar `test:ci` sampai fitur 11 menambah jalur CI dengan Docker.
- Smoke adalah script perintah tanpa JUnit sendiri; hanya bagian Playwright yang mempunyai JUnit. Dua run lulus dan satu run kontrol gagal sesuai harapan; ini bukan studi stabilitas.
- Pemindaian byte pada screenshot PNG tidak membuktikan bahwa teks yang dirender bebas credential. Teks halaman dibuktikan oleh assertion READY-009, yang hanya menerima teks aman.
- Repository belum mempunyai gerbang tipe untuk `doctor-smoke.ts`. Pemeriksaan `tsc` strict sementara lulus tanpa `noUncheckedIndexedAccess`; dengan flag itu, `scripts/doctor.ts` dan `scripts/lib/development.ts` yang tidak diubah fitur ini sudah gagal.
- Worker nyata belum ada, sehingga AC-5 tetap terbukti melalui fixture saja.

## Suite `/test` fitur 2 2026-10-04

Kandidat: `HEAD b1ae733` ditambah perubahan lokal fitur 2 yang belum di-commit. Lingkungan sama dengan bagian sebelumnya: Bun 1.4.2, Node 24.21.0, macOS 27.0, Docker, Playwright 1.63.0 dengan Chromium, dan PostgreSQL 18 dari image `foundation-postgres:18-pinned`. Cakupan adalah seluruh fitur 2, AC-1 sampai AC-9 [spec 0003](../specs/0003-doctor-serve-aplikasi-nyata/index.md). Kode aplikasi `scripts/doctor.ts`, `scripts/serve.ts`, dan `scripts/lib/` tidak diubah; yang berubah hanya test dan registry.

### Test baru

Langkah [verify.md](../specs/0003-doctor-serve-aplikasi-nyata/verify.md) yang sebelumnya diperiksa manual kini dikunci sebagai test yang dapat diulang.

Fixture `tests/integration/tooling/development.test.ts` mendapat 12 test baru dan berjalan lewat `bun run test:tooling` serta `test:ci`:

- TOOL-001: CLI doctor tanpa `DATABASE_URL`, dengan PostgreSQL yang mati, dan dengan URL berskema `mysql` keluar dengan status 1 tanpa password, DSN, atau error mentah. Doctor berhenti menunggu database yang menerima TCP tetapi tidak pernah menjawab dalam batas 7 detik (teramati sekitar 3 detik) dengan pesan aman.
- TOOL-003: doctor mewajibkan variable dan URL database milik worker terpilih tanpa mencetak nilainya, dan tidak memeriksa worker yang tidak dipilih. Worker tanpa port yang keluar saat startup menggagalkan startup sebelum URL diumumkan dan menghentikan grup lain. Worker tanpa port yang tetap hidup dianggap siap, lalu grupnya berhenti saat SIGTERM dengan exit 143. CLI `serve --worker tidak-ada` ditolak sebelum lock diambil.
- TOOL-005: `serve` kedua dari checkout yang sama keluar dengan status 1 dan pesan `Serve lain dari checkout ini masih aktif.` tanpa menjalankan doctor dan tanpa mengubah catatan owner. Catatan owner berizin `0600` di direktori `0700` dan hanya memuat token, checkout, UID, supervisor, serta grup, tanpa DSN atau environment. Grup dari checkout lain dan proses yang bukan leader grupnya ditolak.
- TOOL-008: CLI `serve` dalam mode production berhenti pada preflight tanpa menjalankan layanan dan melepas lock. Konfigurasi dengan port backend salah ditolak sebelum lock diambil.

Test CLI menjalankan salinan `scripts/` di checkout sementara. Dengan begitu test tidak memakai `.local/serve.lock` milik checkout ini dan tidak memberi sinyal pada port 8888 atau 8889.

Smoke nyata `tests/integration/tooling-real/doctor-smoke.ts` (`bun run test:tooling:real`) mendapat pemeriksaan berikut:

- TOOL-001: schema konfigurasi yang tidak ada, `CREATE` pada schema `users` dan `public`, atribut `CREATEDB`, role backend sebagai pemilik tabel metadata, metadata yang tidak dapat dibaca, repository tanpa direktori migration, dan file migration yang belum diterapkan ditolak tanpa error database mentah. Isi `common.schema_migrations` dan komentar schema `users` sama sebelum dan sesudah doctor, jadi doctor tidak menulis metadata dan tidak menerapkan migration. Setelah setiap perubahan dikembalikan, doctor kembali menerima database.
- TOOL-002: dengan database siap, listener proses lain pada 8889 membuat `serve` gagal setelah `Doctor lulus.` dengan pesan `Listener port bukan proses Foundation lama dari checkout ini.` Proses itu tetap hidup dan menjawab `asing`, tidak ada layanan yang dijalankan, dan lock terlepas.
- AC-4: baris `Frontend:` dan `Backend:` muncul satu kali, sesudah `Menjalankan frontend.`, berurutan, dan tepat sebelum `Layanan development siap.`
- TOOL-005: catatan owner dari `serve` yang berjalan memuat checkout ini, UID ini, PID `serve`, dan dua grup yang masing masing memimpin grup prosesnya, dengan izin `0600` dan `0700` tanpa credential. `serve` kedua keluar dengan status 1, catatan tidak berubah, dan `serve` pertama tetap menjawab pada 8888 dan 8889 sebelum alur browser berjalan.
- TOOL-004 dan TOOL-007: sesudah SIGTERM (exit 143) dan sesudah Ctrl+C pada `serve` nyata kedua (SIGINT, exit 130), kedua grup proses yang tercatat sudah tidak ada, port 8888 dan 8889 bebas, dan lock terlepas.

Registry `tests/scenarios/development-tooling.json` kini memetakan smoke nyata sebagai pemeriksaan tambahan untuk TOOL-001, TOOL-002, TOOL-004, dan TOOL-005, di samping fixture. Kriteria setiap ID tetap sesuai spec 0003.

### Hasil aktual

- `bun run test:tooling`: 41 pass, 0 fail, 151 assertion dalam sekitar 28 detik, pada empat run terpisah dan sekali lagi di dalam `test:ci`. JUnit tersanitasi (tanpa atribut `hostname`) dari run `test:ci` disimpan di [evidence 0005](evidence/0005/tooling.xml), lulus `xmllint --noout`, SHA 256 `7edc8ec943d8804d90132b6a1b04107d4fab22f79e93c42a1df9cc726374fe10`.
- `bun run test:tooling:real`: dua run keluar dengan status 0 (23 dan 22 detik). Setiap run menampilkan seluruh baris TOOL-001, TOOL-002, TOOL-004, TOOL-005, dan TOOL-007 di atas; READY-009 lulus 1 dari 1; pemindaian credential tidak menemukan 6 nilai acak pada 11 output dan 7 file. Sesudah setiap run tidak ada container `foundation-readiness-*`, port 8888 dan 8889 bebas, dan `.local/serve.lock` tidak ada.
- `bun run test:scenarios`: lulus dengan 58 ID unik.
- `bun run test:ci`: exit 0 dalam 124 detik. OpenAPI dan SDK identik pada dua run, 79 test frontend, 630 integration test dengan 2.728 assertion, 41 tooling test dengan 151 assertion, dan 12 E2E pass. Peringatan initial bundle 684,40 kB terhadap budget 500 kB sama seperti sebelumnya.

Tidak ada test yang gagal karena kode aplikasi, sehingga tidak ada bug aplikasi yang tercatat.

### Batas bukti

- AC-5 tetap terbukti melalui fixture saja karena belum ada worker aplikasi nyata.
- Smoke nyata masih di luar `test:ci` dan baru dijalankan pada macOS dengan Chromium. Dua run lulus bukan studi stabilitas.
- Bukti bahwa doctor tidak menulis membandingkan isi metadata dan efek migration yang tertunda; ia tidak mengamati setiap statement SQL. Larangan hak tulis role backend tetap diperiksa doctor sendiri.
- Pemeriksaan `tsc` strict sementara pada kedua file test lulus untuk kode baru, tetapi menandai test lama `TOOL-006 readiness rejects an HTTP response completed after the startup deadline` karena `server.port` bertipe `number | undefined`. Bun tidak memeriksa tipe test dan repository belum mempunyai gerbang tipe untuk folder ini.

## Perbaikan temuan review 2026-10-04

Kandidat: `HEAD b1ae733` ditambah perubahan lokal fitur 2 yang belum di-commit. Lingkungan sama dengan bagian sebelumnya. Sumber temuan: [review 2026-10-04](../reviews/2026-10-04-main-doctor-serve.md) dan temuan reviewer independen lain pada hari yang sama. Setiap temuan dibuktikan dulu, lalu diperbaiki dengan perubahan sekecil mungkin. Backend tidak berubah, sehingga OpenAPI dan SDK tidak disentuh sesuai invariant 6 spec 0003.

### Temuan yang terbukti

Pembuktian memakai salinan `scripts/` dan test di scratchpad di luar repository. Suite lama tetap hijau setelah setiap mutasi berikut, jadi celahnya nyata:

- Kedua `throw` pemilik port di `scripts/lib/readiness.ts` (sesudah probe dan sebelum pengumuman) diganti tanpa throw: 6 test TOOL-006 lulus.
- Pemeriksaan checkout dan UID catatan lama, penolakan guard sisa, sifat eksklusif guard, pemeriksaan ulang token dan supervisor, serta pemeriksaan inode di `scripts/lib/invocation.ts` dibuang: 9 test TOOL-005 lulus.
- Batas 60 detik diganti 100 menit, target worker dibuang dari rakitan readiness, dan pesan port doctor diganti: 41 test lulus.
- Ctrl+C dan SIGTERM saat preflight pada salinan checkout dengan database diam: `serve` keluar 130 dan 143 dalam sekitar 1 ms, `.local/serve.lock` tertinggal, dan run kedua meninggalkan direktori `serve.stale.<uuid>` yang tidak pernah dikembalikan.

### Perubahan

- `scripts/serve.ts`: handler SIGINT dan SIGTERM dipasang sebelum lock. Sinyal pada fase lock, preflight, atau cleanup menghentikan `serve` dengan exit 130 atau 143, mencetak `Serve dihentikan sebelum layanan dijalankan.`, dan tetap melepas lock, termasuk mengembalikan catatan lama yang sedang dipulihkan. `supervise()` memasang handlernya sendiri saat layanan mulai. Rakitan target readiness menjadi fungsi `readyTargets(config, workers)`, dan `supervise` menerima `waitForReadiness` sebagai dependency untuk test.
- `scripts/lib/readiness.ts`: konstanta `STARTUP_TIMEOUT_MS = 60000` dipakai `waitForReadiness` dan `supervise`.
- `scripts/lib/invocation.ts`: `Invocation.acquire(root, { processIdentity })` menerima pembaca identitas proses sebagai dependency, mengikuti pola `clearPorts` dan `waitForReadiness`.
- `scripts/doctor.ts`: peringatan port kini berbunyi `Sedang dipakai; serve hanya menggantikan proses Foundation lama dari checkout ini dan gagal bila pemiliknya lain.`
- `tests/integration/tooling/development.test.ts`: 13 test baru (rincian di bawah), assertion pesan peringatan port, `server.port!` pada test deadline lama, test worker yang keluar saat startup kini menunggu worker benar benar hilang tanpa jeda tetap, dan test worker tanpa port kini mempunyai batas 8 detik untuk shutdown serta mencetak output supervisor saat gagal.
- `tsconfig.tooling.json` dan script `typecheck:tooling` di `test:ci` memeriksa tipe kedua file test tooling (strict tanpa `noUncheckedIndexedAccess`).
- `tests/integration/contract/readiness-container.test.ts`: smoke ini terdaftar sebagai pemakai penjaga READY-010.
- `tests/integration/tooling-real/doctor-smoke.ts`: setiap run doctor di dalam smoke diperiksa bebas credential, DSN, error mentah, dan SQL, lalu ikut dipindai. Kasus negatif baru: `USAGE` dicabut dari `auth`, `CREATEROLE`, serta `UPDATE`, `DELETE`, dan `TRUNCATE` pada metadata. Listener 8888 dan 8889 harus terikat pada `127.0.0.1` saja. Sesudah SIGTERM dan Ctrl+C, backend harus mencetak `Backend stopped` dan `pg_stat_activity` tidak boleh memuat sesi `foundation_backend`; sebelum shutdown sesi itu wajib ada. Setiap request HTTP mempunyai batas 5 detik. Server fixture dibuat satu per satu. Jalur SIGKILL dan jalur gagal mengirim SIGKILL ke grup yang tercatat di `owner.json` lewat `signalVerifiedGroup`, hanya bila catatan itu ditulis `serve` yang dijalankan smoke ini, lalu menghapus catatan itu setelah semua prosesnya hilang. Smoke menolak mulai bila lock sudah ada.

Test fixture baru: TOOL-006 pemilik port berubah sesudah probe, berubah sebelum pengumuman, proses lain yang mengambil port (lewat `[::1]`) saat probe di bawah `supervise` tanpa pengumuman siap, dan batas 60 detik yang diteruskan `supervise`; TOOL-003 target readiness; TOOL-005 guard sisa crash, guard yang sedang dipegang, dua proses yang memulihkan catatan lama yang sama, catatan checkout atau user lain, token yang berubah, supervisor yang ternyata hidup, dan direktori lock yang diganti selama pemulihan; TOOL-004 Ctrl+C dan SIGTERM saat preflight.

### Kontrol mutasi sesudah perbaikan

Empat belas mutasi pada salinan `scripts/` kini masing masing membuat minimal satu test gagal: kedua `throw` pemilik port, kelima pemeriksaan pemulihan (ditambah pemeriksaan ulang supervisor secara terpisah), konstanta 60 detik, nilai bawaan di `supervise`, target worker, pesan doctor, handler sinyal awal, dan pelepasan lock saat sinyal.

Pada smoke nyata, salinan sementara dengan batas shutdown 1 ms memaksa jalur SIGKILL. Run kontrol keluar 1 dengan `Serve did not finish a clean SIGTERM shutdown within 10 seconds`. Run kontrol pertama tidak meninggalkan listener, proses, atau container, tetapi meninggalkan lock karena `serve` mati oleh SIGKILL; run nyata berikutnya lalu gagal pada `Serve lock remains after shutdown`, karena `serve` dengan listener asing mengembalikan catatan lama itu sesuai AC-7. Setelah smoke diubah agar menghapus catatan miliknya sendiri dan menolak mulai bila lock sudah ada, run kontrol kedua tidak meninggalkan listener, proses, container, maupun lock. Lock sisa run kontrol pertama dihapus manual setelah supervisor dan kedua grupnya terbukti tidak ada.

### Hasil aktual

- `bun run test:tooling`: 54 test, 209 assertion, 0 gagal, 0 dilewati, sekitar 33 detik. JUnit tersanitasi dari run terakhir disimpan di [evidence 0005](evidence/0005/tooling.xml) dan menggantikan file bagian `/test`, lulus `xmllint --noout`, SHA 256 `31433d6d541168129e37deadde5eed29e24b63b98751fea70fe418baa4aed87b`. Sebelum perubahan terakhir pada blok `finally` di `serve.ts` (handler sinyal kini dilepas sesudah lock dilepas), lima test yang peka waktu lulus 8 kali berturut turut, lalu 4 kali lagi saat tiga suite penuh dan beban CPU berjalan bersamaan.
- `bun run test:tooling:real`: empat run lulus dengan exit 0 dalam 24 sampai 25 detik, yang terakhir pada kode akhir. Setiap run menampilkan baris TOOL-001 sampai TOOL-007, listener `127.0.0.1:8888` dan `127.0.0.1:8889` saja, 5 sesi `foundation_backend` sebelum SIGTERM dan 0 sesudah SIGTERM serta Ctrl+C, READY-009 lulus 1 dari 1, dan pemindaian 6 nilai acak pada 36 output serta 7 file tanpa temuan. Sesudah setiap run tidak ada container `foundation-readiness-*`, port 8888 dan 8889 bebas, dan `.local/serve.lock` tidak ada.
- `bun run typecheck:tooling`: exit 0. Tanpa perbaikan `server.port!`, gerbang ini gagal dengan TS2322.
- `bun test ./tests/integration/contract/readiness-container.test.ts`: 9 pass dengan 123 assertion.
- `bun run test:scenarios`: lulus dengan 58 ID unik.
- `bun run test:ci`: exit 0 pada dua run, yang terakhir pada kode akhir dalam 129 detik. OpenAPI dan SDK identik pada dua run, 79 test frontend, 630 integration test dengan 2.734 assertion, 54 tooling test dengan 209 assertion, dan 12 E2E. Peringatan initial bundle 684,40 kB terhadap budget 500 kB sama seperti sebelumnya.

### Batas bukti

- Timeout 20 detik pada test worker tanpa port yang dilaporkan reviewer tidak dapat direproduksi: 6 run di bawah 20 proses `yes`, 5 run saat tiga suite penuh berjalan bersamaan, dan semua run lain lulus dalam sekitar 2 detik. Akar masalahnya belum terbukti. Test kini memberi batas sendiri dan output supervisor, sehingga kegagalan berikutnya membawa diagnosis.
- Syarat PostgreSQL minimal 18 belum mempunyai kasus negatif karena butuh server versi lain.
- Bukti aplikasi nyata hanya dari macOS dengan Chromium, dan smoke nyata masih di luar `test:ci`.
- Rationale spec 0006 keputusan 46 masih menyebut "ketiga pemakai" penjaga; daftar READY-010 kini memuat lima file. Spec tidak diubah pada langkah ini.

# Bukti fitur 12: Kapasitas dan pemulihan saat beban meningkat

Tanggal: 2026-10-05 (waktu UTC; waktu lokal UTC+7). Bukti fitur yang berlaku adalah gerbang akhir pukul 04.46 sampai 06.32 UTC (manifest tier cepat mulai 04:46:34Z, manifest tier kapasitas selesai 06:32:31Z, dan kedua laporan dibuat 06:32:43Z), sesudah `/develop` kelima milestone, `/check verify`, `/test`, `/check review` beserta perbaikan temuannya, dan `/document`. Kriteria: [spec 0011](../specs/0011-kapasitas-pemulihan-beban-meningkat/index.md) AC-1 sampai AC-10. Bukti berasal dari checkout `main` pada dasar `34e905dff01b66fc2b9cd51f6e6686b5008c247c` dengan seluruh perubahan fitur 12 yang belum masuk commit. SHA 256 pohon sumber `7185cf7b7a9f5a3cedff10c6a8ac0a452ceb284e1bbba380f2d9c33f33ca1514` sama pada awal dan akhir keempat tier (fast, real, security, dan capacity) menurut manifest, dan `git status --porcelain` sama sebelum dan sesudah gerbang, jadi kode tidak berubah selama gerbang. Laporan ini, salinan bukti di `evidence/0011/`, scope, dan baris **Status** spec ditulis sesudah gerbang dan hanya mengubah dokumen. Run sebelum gerbang ini, termasuk kegagalan run pertama tier kapasitas pada 2026-10-04, dicatat di bagian *Riwayat run*.

**Status akhir:** keempat perintah gate per push lulus pada satu run berurutan tanpa retry, dan `bun run test:report` keluar 0 dengan `Gate passed`: ketiga tier lulus, 71 dari 71 skenario `passed` (termasuk PERF-001, PERF-002, PERF-008, dan PERF-009), keempat alur kritis lulus, discovery dan ketiga pemindai lulus, pengikatan sah, dan `performance k6: smoke passed`. Tier kapasitas `bun run test:ci:capacity` lulus pada percobaan pertama gerbang ini tanpa retry: 5 dari 5 langkah `passed`, 0 dropped iterations pada setiap profil, dan setiap scenario laju tetap mencapai paling sedikit iterasi rencananya dengan ambang beban aktual menurut paragraf *Ambang beban aktual* spec. `bun run test:report:capacity` keluar 0 dengan `Laporan kapasitas passed`, PERF-003 sampai PERF-007 `passed`, dan pengikatan sah, dan `test:report` yang dijalankan lagi sesudahnya tetap `Gate passed`. AC-1 sampai AC-10 terpenuhi untuk bagian lokal; smoke pada job `real` di GitHub dan workflow manual `capacity.yml` baru dapat dibuktikan sesudah push. Gerbang ini bukan kandidat release (`not_clean` dan `not_ci`), karena working tree belum masuk commit dan tidak berjalan di CI.

## Lingkungan

macOS 27.0 (arm64, Apple M1 Max, 10 CPU, 32 GiB memory), Bun 1.4.2, Node 24.21.0. Docker Desktop dengan Docker Engine 29.8.0 dan Docker Compose 5.5.1; mesin container melihat 10 CPU dan 8.319.504.384 byte memory. Tujuh container proyek lain berjalan tanpa label `foundation.test` sepanjang gerbang, termasuk PostgreSQL Compose bersama milik proyek ini (`foundation-postgres-1`, tetap `Up` dan `healthy`), dan tidak ada yang disentuh. Tidak ada suite lain yang berjalan bersamaan dengan langkah mana pun. Port 8888 dan 8889 kosong sebelum dan sesudah gerbang.

Image yang dipakai, dari `tests/performance/images.json` dan identitas yang dicatat `result.json`:

| Komponen | Image dan digest |
| --- | --- |
| k6 2.3.0 | `grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34` |
| Bun 1.4.2 (backend) | `oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61` |
| PostgreSQL 18.6 | `foundation-postgres:18-pinned`, image id `sha256:0470b120c2ebef56573f3f66861a6a50bea3e6daf9c819c37c598fecf6ff5557`, linux arm64, base `oraclelinux:10-slim@sha256:0660af1f1bb56559b299d99d3b71d0ff51f9d593cecbd3154a46914704ec34d6`, paket `18.6-4PGDG.rhel10.2`; image id yang sama dipakai smoke, kelima profil kapasitas, dan suite nyata lain, dan dibaca `test:report` dari `image.json` tier nyata |

Batas resource setiap container mengikuti tabel topologi spec: PostgreSQL 2 CPU, 1 GiB, `shm-size` 128 MiB, 256 proses; backend 1 CPU, 512 MiB, 256 proses; k6 3 CPU, 2 GiB, 512 proses; k6 inspect 1 CPU, 512 MiB, 512 proses. Pool backend `max` 5 dengan `connectionTimeout` 3 detik. Data hanya riwayat migration (1 baris).

## Perintah dan hasil gerbang akhir

Gerbang menjalankan keempat perintah gate per push, lalu tier kapasitas dan laporannya, lalu `test:report` sekali lagi. Tier nyata memuat setiap suite nyata yang disentuh fitur ini: `test:infrastructure`, `test:database:real`, `test:database:migration`, `test:tooling:real`, dan `test:readiness:real` memakai `runProcessGroup` yang mendapat opsi `onOutput`, dan `test:performance:smoke` adalah langkah baru fitur ini. Tier kapasitas menjalankan kelima script profil yang ditambahkan fitur ini. Setiap script yang dirujuk registry `tests/scenarios/` tercakup. Setiap perintah dijalankan satu kali, berurutan, tanpa retry, dan tidak ada yang gagal.

| Perintah (waktu UTC) | Hasil aktual |
| --- | --- |
| `bun run test:ci` (04.46.34 sampai 04.50.03) | Exit 0, 18 dari 18 langkah `passed`. `test:scenarios`: `Scenario registries passed (76 unique IDs, 109 checks).`; `check:test-discovery`: 32 file test (Vitest 4, Playwright `playwright.config.ts` 4, Playwright `playwright.real.config.ts` 1, `bun:test` 23); `check:workflow`: `Workflow lulus: application.yml (application 8 langkah, real 8 langkah, security 4 langkah, report 7 langkah), capacity.yml (capacity 7 langkah).`; `api:check` lulus; `build:frontend` initial total 684,40 kB dengan warning anggaran 500 kB yang sudah ada; `typecheck:backend`, `typecheck:contract`, `typecheck:e2e`, dan `typecheck:tooling` exit 0; `test:frontend` 79 test; `test:integration` 630 test dengan 2.748 assertion; `test:tooling` 54 test dengan 209 assertion; `test:gate` 253 test dengan 1.815 assertion dalam 50,0 detik; `test:performance:plan` 78 test dengan 1.538 assertion dalam 22,9 detik; `test:e2e` 12 test. Seluruhnya 0 gagal dan 0 dilewati. |
| `bun run test:ci:real` (04.50.18 sampai 04.53.51) | Exit 0, 6 dari 6 langkah `passed` tanpa testcase dilewati: `test:infrastructure` 18 test dalam 50,4 detik, `test:database:real` 29 test dengan 1.413 assertion dalam 41,6 detik, `test:database:migration` 5 test dalam 16,8 detik, `test:tooling:real` lulus dalam 29,8 detik, `test:readiness:real` lulus dalam 5,9 detik, dan `test:performance:smoke` sebagai langkah terakhir dalam 68,8 detik dengan `k6 inspect cocok dengan optionsFor` untuk keenam profil dan `pemindaian credential tanpa temuan atas 28 output`. |
| `bun run test:ci:security` (04.53.56 sampai 04.54.06) | Exit 0; gitleaks v8.30.1 atas 43 commit, `bun audit` 1.4.2 atas 487 paket, dan actionlint 1.7.12 atas `.github/workflows/application.yml` dan `.github/workflows/capacity.yml`, ketiganya `passed` dengan 0 temuan. Pemindai juga mencetak `Working tree tidak bersih: perubahan yang belum masuk commit tidak dipindai gitleaks.` (lihat *Pemeriksaan sesudah dokumen diperbarui*). |
| `bun run test:report` (04.54) | Exit 0 dengan `Gate passed`: ketiga tier `passed`, 71 skenario (0 failed, 0 missing_test, 0 not_run, 0 skipped, 71 passed), alur kritis APP-002, READY-006, READY-009, dan UI-001 `passed`, discovery `passed`, ketiga pemindai `passed`, `pengikatan sah`, `performance k6: smoke passed`, `Kandidat release: bukan (not_clean fast, not_clean real, not_clean security, not_ci fast, not_ci real, not_ci security, not_ci)`. PERF-003 sampai PERF-007 tidak ada di laporan per push. |
| `bun run test:ci:capacity` (04.54.27 sampai 06.32.31) | Exit 0 dalam 5.884 detik, 5 dari 5 langkah `passed`: load 686,4 detik, stress 757,3 detik, spike 464,8 detik, outage 249,7 detik, dan soak 3.725,8 detik, masing masing dengan empat bukti wajib dan tanpa `leftoverPorts` atau kode alasan; manifest mencatat tier `capacity`, 20 file bukti dengan SHA 256, `clean` false, dan `ci` null. |
| `bun run test:report:capacity` (06.32) | Exit 0 dengan `Laporan kapasitas passed`: tier `passed` (5 dari 5 langkah), 5 skenario (0 failed, 0 missing_test, 0 not_run, 0 skipped, 5 passed), `pengikatan sah`, `performance k6: load passed, stress passed, spike passed, outage passed, soak passed`, `Kandidat release: bukan (not_clean, not_ci)`. |
| `bun run test:report` lagi (06.32) | Exit 0 dengan `Gate passed` dan ringkasan yang sama dengan run pertama; `report.json` hanya berbeda pada `generatedAt`, jadi bundle kapasitas di samping bundle per push tidak mengubah gate per push. |

Sesudah gerbang, `docker ps -a --filter label=foundation.test` dan `docker network ls --filter label=foundation.test=performance` kosong, tidak ada proses `docker stats` yang tersisa, dan tidak ada listener pada port 8888 atau 8889. Daftar 11 folder `foundation-*` di `TMPDIR` sama sebelum dan sesudah gerbang; ketiga folder `foundation-perf-*` di antaranya sudah ada sebelum gerbang dan bukan buatan gerbang ini. Setiap `artifact-scan.json` memeriksa 6 nilai credential run tanpa temuan.

Pemeriksaan mandiri atas bundle: ke 69 file bukti keempat tier (23 tier cepat, 25 tier nyata, 1 tier keamanan, dan 20 tier kapasitas, termasuk file di folder screenshot) dihitung ulang SHA 256 nya dan semuanya sama dengan manifest. Keempat manifest mencatat commit `34e905d`, `clean` false, `ci` null, dan pohon sumber yang sama pada awal dan akhir tier.

## Beban target dan aktual

Satu iterasi sama dengan satu request. Smoke berasal dari tier nyata gerbang ini, dan kelima profil lain dari tier kapasitas gerbang ini.

| Profil | Model dan durasi | Iterasi rencana | Iterasi dan request aktual | Dropped iterations | VU maksimum | Scenario mulai sesudah T0 |
| --- | --- | --- | --- | --- | --- | --- |
| smoke | S0 (100 dan 10 per detik), 40 detik | 4.400 | 4.403 dan 4.403 | 0 | 40 | 0 ms |
| load | N (1.000 dan 50 per detik), 660 detik | 661.500 | 661.497 dan 661.497 | 0 | 220 | 1 ms |
| stress | N, naik ke O (4.000 dan 1.000 per detik), 300 detik O, kembali ke N, 730 detik | 2.275.500 | 2.275.472 dan 2.275.472 | 0 | 1.000 | 3 ms |
| spike | N, lonjakan 60 detik ke O, kembali ke N, 440 detik | 687.250 | 687.221 dan 687.221 | 0 | 1.110 | 2 ms |
| outage | N selama 220 detik, PostgreSQL berhenti T0 + 90 sampai T0 + 150 detik | 231.000 | 231.002 dan 231.002 | 0 | 110 | 1 ms |
| soak | N, 3.660 detik | 3.811.500 | 3.811.497 dan 3.811.497 | 0 | 220 | 0 ms |

Iterasi rencana menjumlahkan seluruh scenario dari `plan.ts`, termasuk scenario naik dan turun (laju awal ditambah laju akhir, dibagi dua, dikali detik). Setiap scenario laju tetap pada keenam profil mencapai iterasi rencananya atau lebih (paling banyak 2 iterasi di atas rencana), jadi tidak ada scenario yang mendekati ambang beban aktualnya; misalnya `status_settle` stress dan spike 10.001 iterasi terhadap ambang `count>=9900`, `readiness_before` spike 6.000 terhadap `count>=5990`, dan `readiness_recover` stress 9.000 terhadap `count>=8990`. Selisih total terhadap rencana hanya berasal dari scenario naik dan turun, yang diikat `count>=0`.

## Latency dan readiness pada fase bertarget

Latency dalam milidetik. Target normal: `status` p95 di bawah 10 dan p99 di bawah 25, readiness 200 p95 di bawah 25 dan p99 di bawah 50, rasio tersedia paling sedikit 0,98. Target beban lebih menambah 429 p95 di bawah 10 dan rasio tersedia paling sedikit 0,20. Pada fase N, latency 429 hanya dicatat tanpa target.

| Profil dan fase | Target | `status` p95 dan p99 | Readiness 200 p95 dan p99 | 429 p95 | Rasio tersedia |
| --- | --- | --- | --- | --- | --- |
| smoke `steady` | N | 1,75 dan 2,96 | 6,35 dan 8,81 | 1,40 | 0,9967 |
| load `steady` | N | 0,61 dan 1,73 | 3,10 dan 4,62 | 14,42 | 0,9995 |
| stress `hold` | O | 0,26 dan 2,59 | 0,64 dan 1,32 | 0,65 | 0,6395 |
| stress `recover` | N | 0,48 dan 1,61 | 2,80 dan 4,48 | 2,87 | 0,9986 |
| spike `before` | N | 0,60 dan 1,80 | 3,03 dan 4,64 | 2,77 | 0,9975 |
| spike `spike` | O | 0,35 dan 3,57 | 0,68 dan 1,88 | 1,11 | 0,5999 |
| spike `after` | N | 0,74 dan 1,95 | 3,38 dan 4,81 | 1,85 | 0,9979 |
| outage `before` | N | 0,63 dan 1,85 | 2,96 dan 4,53 | 0,61 | 0,9997 |
| outage `after` | N | 0,63 dan 1,82 | 3,30 dan 4,71 | 1,12 | 0,9993 |
| soak `steady` | N | 0,41 dan 1,47 | 2,75 dan 4,47 | 4,49 | 0,9996 |

Jumlah threshold yang lulus: smoke 18 dari 18, load 18 dari 18, stress 45 dari 45, spike 54 dari 54, outage 40 dari 40, soak 18 dari 18.

## Outage database

| Aspek | Hasil gerbang akhir |
| --- | --- |
| Stop PostgreSQL | dikirim T0 + 90.006 ms, selesai dalam 209 ms (batas kirim 90.000 sampai 91.000, selesai paling lama 8.000 ms) |
| Start PostgreSQL | dikirim T0 + 150.001 ms, selesai dalam 123 ms (batas kirim 150.000 sampai 151.000, selesai paling lama 5.000 ms) |
| Readiness pada `stopping` (88 sampai 101 detik) | 103 jawaban 200, 538 jawaban 429, 9 jawaban 503; 503 terlama 3.001,92 ms |
| Readiness pada `outage` (101 sampai 145 detik) | 0 jawaban 200, 962 jawaban 429, 1.238 jawaban 503; 503 p95 11,43 ms dan terlama 3.002,63 ms |
| Readiness pada `recovering` (145 sampai 160 detik) | 492 jawaban 200, 1 jawaban 429, 257 jawaban 503; 503 terlama 15,21 ms |
| `status` pada `stopping`, `outage`, dan `recovering` | p95 1,04, 0,58, dan 0,39 ms; seluruhnya 200 (13.000, 44.000, dan 15.000 request) |
| Waktu pemulihan readiness | 154 ms sesudah start terjadwal (`readiness_recovery_ms`) |
| Pool | `pool_reconnect` lulus dengan 60 sampel sesi `foundation_backend` pada fase `after`; 175 sampel `pg_stat_activity` berhasil dan 60 gagal selama database berhenti |
| Backend | tanpa restart, tanpa OOM, stderr 0 byte |

## Resource, pool, dan generator

CPU dalam persen satu CPU, memory dalam MiB. Kolom generator adalah rata rata CPU k6 terbesar di antara fase terukur (batas 240) dan memory k6 maksimum (batas 1.638).

| Profil | Backend CPU rata rata dan maksimum | Backend memory puncak (batas 128) | PostgreSQL memory puncak | Generator CPU dan memory | CPU k6 maksimum per sampel | Pool sesi dan sesi aktif maksimum | Check pengamatan |
| --- | --- | --- | --- | --- | --- | --- | --- |
| smoke | 5,19 dan 7,25 | 22,32 | 44,67 | 16,97 dan 41,28 | 20,21 | 5 dan 1 | 9 dari 9 |
| load | 10,73 dan 15,15 (`steady` 11,10, batas 50) | 29,61 | 46,07 | 44,32 dan 282,3 | 56,58 | 5 dan 1 | 10 dari 10 |
| stress | 19,69 dan 30,81 | 36,28 | 46,80 | 76,94 dan 1.120,26 | 96,22 | 5 dan 1 | 9 dari 9 |
| spike | 13,20 dan 27,58 | 37,66 | 46,12 | 78,95 dan 788,6 | 93,66 | 5 dan 1 | 9 dari 9 |
| outage | 10,20 dan 14,76 | 27,88 | 45,61 | 49,41 dan 152,0 | 63,17 | 5 dan 1 | 11 dari 11 |
| soak | 9,74 dan 15,64 (`steady` 9,78, batas 50) | 30,77 | 46,32 | 43,26 dan 1.020,0 | 95,64 | 5 dan 1 | 11 dari 11 |

Generator tidak jenuh pada beban O: rata rata CPU k6 pada `hold` dan `spike` 76,94 dan 78,95 persen satu CPU, sepertiga batas `generator_cpu`. Memory k6 terbesar pada stress, 1.120,26 MiB atau 68,4 persen batas `generator_memory`. Pertumbuhan memory backend pada soak 0,65 MiB (batas 16 MiB), dan `pg_stat_activity` soak mencatat 3.671 sampel tanpa gagal. Selisih jam container dengan host 6 sampai 8 ms pada setiap pengukuran sebelum T0 dan sesudah k6 keluar.

## Hasil per skenario

| Skenario | Kriteria | Bukti | Status |
| --- | --- | --- | --- |
| `PERF-001` | AC-1 sampai AC-7, AC-10 | 58 test `bun:test` di `tests/integration/performance/plan.test.ts` (`test:performance:plan`, tier cepat), JUnit [`plan.xml`](evidence/0011/plan.xml) | `passed` (laporan per push) |
| `PERF-002` | AC-1 sampai AC-6, AC-10 | check `command` `test:performance:smoke` di tier nyata, exit 0, [`result-smoke.json`](evidence/0011/result-smoke.json) | `passed` (laporan per push) |
| `PERF-003` | AC-4, AC-5, AC-6 | check `command` `test:performance:load` di tier kapasitas, exit 0 | `passed` (laporan kapasitas) |
| `PERF-004` | AC-4, AC-5, AC-6, AC-8 | check `command` `test:performance:stress` di tier kapasitas, exit 0 | `passed` (laporan kapasitas) |
| `PERF-005` | AC-4, AC-5, AC-6, AC-8 | check `command` `test:performance:spike` di tier kapasitas, exit 0 | `passed` (laporan kapasitas) |
| `PERF-006` | AC-4, AC-5, AC-6, AC-7 | check `command` `test:performance:outage` di tier kapasitas, exit 0 | `passed` (laporan kapasitas) |
| `PERF-007` | AC-4, AC-5, AC-6 | check `command` `test:performance:soak` di tier kapasitas, exit 0 | `passed` (laporan kapasitas) |
| `PERF-008` | AC-9, AC-10 | 58 test di `tests/integration/gate/capacity.test.ts` (`test:gate`) ditambah check `command` `check:workflow` | `passed` (laporan per push) |
| `PERF-009` | AC-2, AC-4, AC-5, AC-6, AC-10 | 20 test di `tests/integration/performance/signal.test.ts` (`test:performance:plan`), JUnit [`plan.xml`](evidence/0011/plan.xml) | `passed` (laporan per push) |

Jumlah test per skenario dihitung `test:report` dari testcase yang judul lengkapnya diawali tag di JUnit gerbang ini. Ke 67 skenario fitur lain pada laporan per push (APP, DATA, GATE, INFRA, MIG, OPENAPI, READY, SDK, TOOL, dan UI) juga `passed` pada gerbang yang sama. Tabel lengkap dengan kolom template laporan release ada di [`report.md`](evidence/0011/report.md) per push dan [`report-capacity.md`](evidence/0011/report-capacity.md).

## Hasil per kriteria

| Kriteria | Hasil dan bukti |
| --- | --- |
| AC-1 | Terpenuhi. Model beban, fase, alokasi VU, dan thresholds ada di modul murni `plan.ts`, dan PERF-001 memeriksa aturan impor dengan parser TypeScript, `optionsFor` keenam profil, dan fixture inspect nyata. Smoke gerbang ini menjalankan `k6 inspect --execution-requirements` atas keenam profil tanpa `--env` dan mencetak `k6 inspect cocok dengan optionsFor`. VU maksimum setiap run sama dengan tabel *Alokasi VU* (40, 220, 1.000, 1.110, 110, dan 220). |
| AC-2 | Terpenuhi. Keenam run membuat network, PostgreSQL, backend, dan k6 sendiri dengan nama `foundation-perf-*-<hex>` dan menghapusnya; sesudah gerbang tidak ada container atau network berlabel `foundation.test=performance`. Pemeriksaan sebelum run (`env_file_present`, `environment_too_small`, `environment_busy`, `pin_invalid`, image, dan inspect) lulus pada mesin ini, dan jalur gagalnya dibuktikan PERF-009 serta run nyata `/check verify` di [verify.md](../specs/0011-kapasitas-pemulihan-beban-meningkat/verify.md). |
| AC-3 | Terpenuhi. `checks` `rate==1` dan `unexpected_responses` `count==0` lulus pada keenam profil, jadi setiap respons cocok dengan tabel *Klasifikasi respons*, termasuk 429 dan 503 pada fase outage. PERF-001 menguji `classify` dan kedua journey. |
| AC-4 | Terpenuhi. Seluruh 193 threshold keenam profil lulus, termasuk ambang beban aktual baru dan `dropped_iterations` `count==0`. Exit 99 menjadi `k6_thresholds_failed` dibuktikan probe (f), PERF-009, dan run pertama 2026-10-04 (bagian *Riwayat run*). |
| AC-5 | Terpenuhi. Setiap `result.json` mencatat beban rencana dan aktual per scenario, `http_reqs` sama dengan `iterations` pada keenam profil, scenario mulai paling lambat 3 ms sesudah T0, dan check generator lulus dengan rata rata CPU k6 paling tinggi 78,95 persen satu CPU dan memory paling tinggi 1.120,26 MiB. |
| AC-6 | Terpenuhi. Seluruh check *Pengamatan resource* lulus (9, 10, 9, 9, 11, dan 11 check), `observation.json` tertulis dan masuk bundle, dan nilai pada bagian *Resource, pool, dan generator* berada di bawah batasnya. |
| AC-7 | Terpenuhi. Stop dan start dikirim dalam 6 ms dan 1 ms sesudah jadwal, fase `outage` tidak memberi jawaban 200, setiap 503 tiba dalam kurang dari 5.500 ms (terlama 3.002,63 ms), `status` tetap 200, readiness pulih 154 ms sesudah start terjadwal, dan pool membuka sesi lagi tanpa restart backend. |
| AC-8 | Terpenuhi. Stress `hold` dan spike `spike` memenuhi target beban lebih (rasio tersedia 0,6395 dan 0,5999, 429 p95 0,65 dan 1,11 ms), dan stress `recover` serta spike `after` memenuhi target normal. |
| AC-9 | Terpenuhi untuk bagian lokal. `test:performance:plan` adalah langkah tier cepat, smoke adalah langkah terakhir tier nyata, tier kapasitas berjalan lewat `scripts/gate.ts capacity`, `test:report` tidak memuat PERF-003 sampai PERF-007, `test:report:capacity` lulus dengan pengikatan sah, `check:workflow` dan actionlint lulus untuk kedua workflow, dan registry memuat PERF-001 sampai PERF-009. Workflow `capacity.yml` dan job `real` di GitHub belum berjalan karena belum di push. |
| AC-10 | Terpenuhi. Setiap `result.json` memuat blok `environment` dengan key `containerEngine` dan enam kalimat `limits`, kedua laporan menampilkan label "mesin container", INFRA-001 lulus sehingga `scripts/` tetap tanpa kata itu, dan setiap `artifact-scan.json` tidak menemukan credential. Pemeriksaan `postgres://`, `password`, `/Users/`, `/var/folders`, dan `/private/tmp` atas salinan di `evidence/0011/` tidak menemukan apa pun. |

## Riwayat run

Run sebelum gerbang akhir tercatat di sini agar kegagalan awal tidak tertutup oleh hasil yang lulus.

| Run | Pohon sumber | Ambang beban aktual | Hasil |
| --- | --- | --- | --- |
| Tier kapasitas pertama, 2026-10-04 20.12 sampai 20.44 UTC (langkah 6 build plan) | `2a67d316…c150379` | lama, 99,9 persen | `failed`: spike gagal `k6_thresholds_failed` pada `iterations{scenario:status_settle}` 9.986, di bawah `count>=9990`, tanpa dropped iterations; outage dan soak `not_run`; `test:report:capacity` keluar 1 |
| Tier kapasitas ulang, 2026-10-04 20.46 sampai 22.24 UTC, tanpa perubahan kode | `2a67d316…c150379` | lama, 99,9 persen | `passed`, lima profil, `test:report:capacity` `passed` |
| `/check verify`, 2026-10-05 02.29 sampai 04.07 UTC | `4d9f5cad…aa47e0` | baru | `passed` dalam 5.884 detik tanpa retry, lima profil dengan 0 dropped iterations, `test:report:capacity` `passed` dengan pengikatan sah |
| Gerbang akhir laporan ini, 2026-10-05 04.54 sampai 06.32 UTC | `7185cf7b…ca1514` | baru | `passed` tanpa retry, lima profil dengan 0 dropped iterations, `test:report:capacity` `passed` dengan pengikatan sah |

Pohon sumber berubah sesudah run `/check verify`, sehingga bundle nya tidak lagi terikat pada checkout, dan gerbang akhir menjalankan ulang seluruh tier pada pohon sumber akhir.

### Kegagalan run pertama

Pada run pertama, spike gagal hanya karena satu threshold beban aktual: `iterations{scenario:status_settle}` 9.986, sedangkan ambangnya saat itu `count>=9990` (99,9 persen dari 10.000 iterasi rencana fase `settle`, 10 detik pada 1.000 iterasi per detik). Ke 53 threshold lain lulus, `dropped_iterations` 0, `http_reqs` sama dengan `iterations` (687.206), dan 9 dari 9 check pengamatan lulus. Scenario laju tetap lain pada run yang sama berselisih paling banyak 2 iterasi dari rencana. CPU k6 pada jendela `settle` (T0 + 250 sampai 260 detik) 27 sampai 58 persen satu CPU dan naik ke 61,5 persen pada T0 + 260,6 detik, saat `settle` berakhir dan `after` dimulai, jauh di bawah batas `generator_cpu` 240.

Kesimpulan penyelidikan: executor laju tetap k6 berhenti tepat pada akhir durasinya. Bila generator sedang tertinggal beberapa milidetik saat itu (jeda penjadwalan atau garbage collector di mesin container bersama), iterasi yang belum sempat dimulai tidak dihitung sebagai dropped iterations, tetapi juga tidak masuk `iterations`. Atribusi ini diduga dari bentuk datanya, bukan hasil probe tersendiri. Pada fase 10 detik, ambang 99,9 persen hanya memberi ruang 10 iterasi, kira kira 10 ms ketertinggalan di batas fase. Tidak ada cacat kode yang ditemukan, dan beban, target, serta kode tidak diubah sebelum run ulang. Sesudah review, keputusan agent atas delegasi pemilik pada 2026-10-04 (spec 0011, paragraf *Ambang beban aktual*, dan rationale keputusan 62) menetapkan ambang yang tetap 99,9 persen tetapi tidak pernah lebih dari rencana dikurangi jumlah VU scenario, sehingga `status_settle` kini `count>=9900`. Dengan ambang baru, run `/check verify` dan gerbang akhir lulus berturut turut tanpa retry, dan pada gerbang akhir setiap scenario laju tetap mencapai rencananya.

## Hasil probe langkah 1

Probe dijalankan pada milestone 1 (2026-10-04) dengan file sementara di luar repository, seperti dicatat di [verify.md](../specs/0011-kapasitas-pemulihan-beban-meningkat/verify.md):

| Probe | Hasil |
| --- | --- |
| (a) profil TypeScript dengan impor `.ts` relatif | berjalan pada k6 2.3.0 |
| (b) `k6 inspect --execution-requirements` dengan `--network none` tanpa `--env` | berjalan; keluarannya memuat `scenarios` dan `thresholds` |
| (c) `summaryTrendStats` dengan `count` | diterima; ringkasan memuat statistik `count` |
| (d) threshold atas submetrik tanpa sampel | lulus dan dibaca 0 |
| (e) `setup()` yang melempar galat | k6 keluar 107 |
| (f) salinan smoke dengan `p(95)<0` | k6 keluar 99, `handleSummary` tetap menulis ringkasan, orkestrasi keluar 1 dengan `k6_thresholds_failed` |
| (g) `foundation-postgres:18-pinned` dengan `--cap-drop ALL`, `no-new-privileges`, dan `--pids-limit 256` | siap menerima koneksi sebagai `USER postgres` |

## Identitas artefak

| Artefak | SHA-256 |
| --- | --- |
| Pohon sumber gerbang akhir (keempat manifest dan kedua laporan) | `7185cf7b7a9f5a3cedff10c6a8ac0a452ceb284e1bbba380f2d9c33f33ca1514` |
| `.github/workflows/application.yml` | `edda79e565b79b9a5d204e9aaf57df86d3eae11adb723f0bb31796e3eb0fe164` |
| `.github/workflows/capacity.yml` | `7b3305f463cc3eb4d43335a12362abf70bc8a3feb07b396061aaad62fd2fb052` |
| `package.json` | `1d085a593c0410aa6897be8cab7914b3fd141b22ebfa7ed4c5e9d52a655f8475` |
| `bun.lock` | `e74e16b34cde3c1a76d17328f5da63da16614409318218231e320d0a2e1fcc3f` |
| `openapi.json` | `e583aa33ea689908d8188f5b1338a441475c9a434e97589e0b47366da95f0c00` |
| `infrastructure/postgres/pins.json` | `63fe647f7df56c5e94a0e5cb6483d845eeea548dcfdbe991c50e95c234f438c4` |
| `tests/performance/images.json` | `c1da2b99171f3d2b1b6ad1955218f18563031d1f0029b8ddc579d8f7d90a26d7` |
| `tests/performance/helpers/plan.ts` | `92242f401afab482cbbd864133c9daf5c4fcc0dc0fbd101ade2433fadac52818` |
| `tests/performance/helpers/expectations.ts` | `78d780a7853cb38776cb65f0b646d18ee32f6cfd41422a11a45d248dda34e8f6` |
| `tests/orchestration/performance-real.ts` | `efc202efe16c0dade120b3e32d893a5939775f37d909e31706a2a474141744a9` |
| `tests/scenarios/performance.json` | `de987803012107e2bb4c178c472d85067213b17a5daaaadd4665bea9fa06af0b` |
| `evidence/0011/result-smoke.json` | `34747c7ffaed5b957702957076dccf23cdd8395b98817107437a0d367debba08` |
| `evidence/0011/result-load.json` | `09529f69ba6c80fb5a0198719d6b2717fb72b7124fb8e9721170a4cfe5dc64aa` |
| `evidence/0011/result-stress.json` | `1e896ebed684fd73f701399010fc577a140bd080115849cfecc70658cf457af7` |
| `evidence/0011/result-spike.json` | `ac390d1bca7297473ab576bc472fe2167b46a3844d5e15e8550b16bde031691e` |
| `evidence/0011/result-outage.json` | `b0c38c86a8f78ac08c5706a96a5874c0485b09f5dc134b09dddb181db79aa638` |
| `evidence/0011/result-soak.json` | `0c7b5c4c2a2a3ce0b3bef1bfe37b2c3c22c7304c323bd0ef9cf08fc0ca41bb8c` |
| `evidence/0011/plan.xml` | `c692e666e7bdc7b375c7b1463697f73061a226b097362b4e9c168a50780de7ae` |
| `evidence/0011/manifest-fast.json` | `15a249ad14ca405eb6ba64feca62fe4047a96acd0941a2f5c3d5d40660f816f3` |
| `evidence/0011/manifest-real.json` | `79c52604e84e0095281419c23c47cdf65b193f7767769eaa9fcd28d930735492` |
| `evidence/0011/manifest-security.json` | `fa8180a006f764152174d58256728ef7cdaa9f4a5a3dcda154f517900892544b` |
| `evidence/0011/manifest-capacity.json` | `4827033630ff26833e76afa89533ac74734c0ae26d6a8c94c902305161c84423` |
| `evidence/0011/report.json` | `006c680b4a751818f6ce4733d1a894f99ff3a4cf58311779c73a3b1dc3915085` |
| `evidence/0011/report.md` | `faaf4646b0ef154bb314dcaf71633e7f42da3cef4a4db0d66f829b89b634da11` |
| `evidence/0011/report-capacity.json` | `b8ab76dd172b6ad56bf6305b4437b75703e475056a9225c2c115210dff4bf90d` |
| `evidence/0011/report-capacity.md` | `c472102c9684f69a4b19f42aed11ef9f1dd8e6ab3b8e21c85b89599a06a4ada3` |
| `evidence/0011/report-capacity-run-1.json` | `3babaed22e75d22e911cc297fe67d9141306c9270147fc03829bd2bae5e9e4bc` |
| `evidence/0011/result-spike-run-1.json` | `bd9578dfea82e1933af1b04c72028ebaedb8b20ce73dca16d4b74ac00e8fccfa` |

Checksum input dan output di manifest sama pada ketiga tier per push, termasuk `apps/frontend/dist/frontend/` (`747ea3fc972f80b102cefab6fd0184c279add2edd2764e4c5f8b301c395b0683`) dan `dist/backend/index.js` (`7f0d92c719ae41ec6ba4b8f928626d84ed65731384c022fba224cfbdf1b7ec40`). `openapi.json` sama dengan laporan fitur 11, karena fitur ini tidak mengubah backend.

## Bukti yang disalin

Salinan di `evidence/0011/` berasal dari gerbang akhir kecuali dua file riwayat, dan disalin byte demi byte kecuali `plan.xml`. Path di dalamnya merujuk bundle `.local/` yang tidak masuk repository.

- `result.json` keenam profil: [smoke](evidence/0011/result-smoke.json) dari bundle tier nyata, serta [load](evidence/0011/result-load.json), [stress](evidence/0011/result-stress.json), [spike](evidence/0011/result-spike.json), [outage](evidence/0011/result-outage.json), dan [soak](evidence/0011/result-soak.json) dari bundle tier kapasitas. SHA 256 keenamnya sama dengan manifest masing masing.
- Laporan per push dari `test:report` pukul 04.54: [`report.json`](evidence/0011/report.json) dan [`report.md`](evidence/0011/report.md), beserta manifest [fast](evidence/0011/manifest-fast.json), [real](evidence/0011/manifest-real.json), dan [security](evidence/0011/manifest-security.json).
- Laporan kapasitas: [`report-capacity.json`](evidence/0011/report-capacity.json), [`report-capacity.md`](evidence/0011/report-capacity.md), dan [manifest tier kapasitas](evidence/0011/manifest-capacity.json).
- JUnit `test:performance:plan` (PERF-001 dan PERF-009): [`plan.xml`](evidence/0011/plan.xml), disalin tanpa atribut `hostname` dan lulus `xmllint --noout`, sehingga SHA 256 nya berbeda dari file asli di bundle tier cepat.
- Riwayat run pertama yang gagal (2026-10-04, ambang lama): laporan kapasitas pukul 20.44 [`report-capacity-run-1.json`](evidence/0011/report-capacity-run-1.json) dan [`result-spike-run-1.json`](evidence/0011/result-spike-run-1.json) dengan threshold `count>=9990` yang gagal. Salinan run ulang 2026-10-04 diganti salinan gerbang akhir; angkanya tetap dapat dibaca di riwayat Git file ini.

Pemeriksaan `postgres://`, `postgresql://`, `password`, `/Users/`, `/var/folders`, `/private/tmp`, dan nama host atas seluruh salinan tidak menemukan apa pun.

## Batas bukti dan tindak lanjut

Keenam kalimat *Batas bukti* tercatat di setiap `result.json` dan ditampilkan kedua laporan: alur yang diukur hanya diagnostik komposisi development; backend satu container dengan 1 CPU dan 512 MiB dari image Bun slim dengan source yang di mount; k6 dan backend berbagi loopback tanpa proxy, TLS, atau latency jaringan nyata; data hanya riwayat migration (1 baris); mesin dipakai bersama (Docker Desktop di macOS bersama tujuh container lain); dan breakpoint tidak dicari. Angka di laporan ini karena itu hanya sebanding dengan run pada kelas environment yang sama, bukan perkiraan kapasitas produk.

- Run GitHub Actions belum ada karena working tree belum masuk commit dan belum di push. Smoke pada job `real` di runner Linux, workflow manual `capacity.yml` (`gh workflow run capacity.yml --ref main`), artifact `capacity-evidence`, ringkasan job, dan kandidat release kapasitas dari `workflow_dispatch` pada `refs/heads/main` dicatat sebagai bukti terpisah sesudah push. Langkah terkait di `verify.md` dan butir Follow-up spec tetap terbuka sampai saat itu.
- Seluruh run berjalan di macOS arm64 dengan Docker Desktop. Linux amd64 pada runner 4 vCPU belum diukur: batas container satu run berjumlah 6 CPU, sehingga ruang generator, dropped iterations smoke S0 dengan ruang 100 ms, dan pola 503 sekitar 3 detik saat PostgreSQL berhenti dapat berbeda di sana.
- Ambang beban aktual baru sudah lulus dua kali berturut turut di mesin ini tanpa retry. Kegagalan run pertama 2026-10-04 dengan ambang lama tetap tercatat di atas, dan Follow-up spec meminta kembali ke `/architect` dengan data run bila scenario laju tetap kurang dari ambang baru tanpa dropped iterations.
- `docker stats` pada Docker Desktop 29.8.0 menampilkan `0.00%` dan `0B / 0B` untuk container yang dibuat atau berhenti, bukan `--` seperti ditulis spec; memory PostgreSQL karena itu terbaca 0 MiB selama outage, dan PostgreSQL pada fase itu dikecualikan dari cakupan sampel.
- gitleaks pada tier keamanan hanya memindai riwayat yang sudah masuk commit (43 commit sampai `34e905d`); pemeriksaan pada commit sementara di bagian *Pemeriksaan sesudah dokumen diperbarui* menutup celah itu untuk working tree saat laporan ini ditulis, tetapi commit fitur yang sebenarnya baru terpindai job `security` sesudah push.
- [Review ulang](../reviews/2026-10-04-main-capacity-recovery-followup.md) menyisakan satu temuan minor kode yang tetap terbuka: cabang gagal tertutup untuk `docker ps` sesudah k6 (`setup_failed environment_read`) belum diuji. Temuan minor dokumennya ditutup sebagian oleh laporan ini dan salinan bukti baru; butir Follow-up `index.md` tentang ambang baru yang belum dijalankan, kalimat penutup keputusan 62 di `rationale.md`, dan kalimat CHANGELOG yang menyebut laporan ini berisi run 2026-10-04 belum diperbarui dan menjadi tugas `/sync` atau `/architect`. Enam nit review juga tetap terbuka.
- Catatan untuk `/sync` dari tahap sebelumnya tetap terbuka: baris *Penjaga container* spec 0011 juga perlu menerima pesan Docker Engine 29 `network <name> not found`, daftar test gate yang diubah belum menyebut GATE-001 `discovery.test.ts` dan pesan pemakaian GATE-004, serta catatan amandemen spec 0010 dan spec 0009 (`onOutput`).
- Pemindaian credential setiap profil mencari nilai acak run itu pada output dan artefak, bukan pemindaian secret umum.
- Laporan ini adalah bukti fitur, bukan bukti kesiapan release.

## Pemeriksaan sesudah dokumen diperbarui

Sesudah laporan ini, salinan di `evidence/0011/`, scope, dan baris **Status** spec 0011 ditulis, perintah berikut dijalankan sekali tanpa retry. Perubahan dokumen itu mengubah pohon sumber, jadi bundle gerbang di `.local/feature-11/evidence/` kini tidak lagi terikat pada working tree (`test:report` dan `test:report:capacity` akan memberi `source_tree_differs`) sampai tier dijalankan ulang; bukti gerbang akhir tetap bundle yang dicatat di atas.

| Perintah | Hasil aktual |
| --- | --- |
| `bun run test:scenarios` | Exit 0, `Scenario registries passed (76 unique IDs, 109 checks).` |
| `bun run check:test-discovery` | Exit 0, 32 file test dengan pembagian yang sama. |
| `bun run check:workflow` | Exit 0, `Workflow lulus: application.yml (application 8 langkah, real 8 langkah, security 4 langkah, report 7 langkah), capacity.yml (capacity 7 langkah).` |
| `bun run typecheck:tooling` | Exit 0. |
| `check:security` pada commit sementara | Clone `--no-hardlinks` di folder scratchpad di luar repository, lalu setiap file `git ls-files -co --exclude-standard` working tree disalin (tanpa file `.env` lokal) dan di commit sebagai satu commit sementara. `bun --no-env-file tests/orchestration/security-scan.ts` dari clone itu keluar 0 dengan working tree bersih: gitleaks `v8.30.1` lulus tanpa temuan atas 44 commit, termasuk seluruh perubahan fitur ini, laporan ini, dan ke 17 file `evidence/0011/`; `bun audit` lulus atas 487 paket; actionlint lulus atas kedua workflow. Sesudah tabel ini ditulis, pemeriksaan yang sama diulang pada clone baru dari working tree akhir: ketiga pemindai kembali `passed` tanpa temuan atas 44 commit dan `security.json` berstatus `passed` dengan working tree bersih. Kedua clone dihapus sesudahnya, dan tidak ada container `foundation-security-*` yang tersisa. |

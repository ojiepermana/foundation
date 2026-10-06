# Bukti fitur 14: Backup dan pemulihan data

Tanggal: 2026-10-06 (waktu UTC; waktu lokal UTC+7). Bukti fitur yang berlaku adalah gerbang akhir pukul 03.29 sampai 03.42 UTC (manifest tier cepat mulai 03:29:51Z, manifest tier keamanan selesai 03:41:52Z, laporan per push dibuat 03:42:00Z, dan `release.json` dibuat 03:42:08Z), sesudah `/develop` kelima milestone, `/check verify`, `/test`, `/check review` beserta perbaikan temuannya dan review ulang, serta `/document`. Kriteria: [spec 0013](../specs/0013-backup-pemulihan-data/index.md) AC-1 sampai AC-9. Bukti berasal dari checkout `main` pada dasar `ad1dbf24b6605ac2802712c0723fd500475e0159` dengan seluruh perubahan fitur 14 yang belum masuk commit. SHA 256 pohon sumber `5512cee2da4d6e6dc0a8e9c0085cba50dd7187c2ccf1d2a846ce644c9d43af58` sama pada awal dan akhir ketiga tier menurut manifest, dan `git status --porcelain` sama sebelum dan sesudah gerbang, jadi kode tidak berubah selama gerbang. Laporan ini, salinan bukti di `evidence/0013/`, scope, dan baris **Status** spec ditulis sesudah gerbang dan hanya mengubah dokumen.

**Status akhir:** keempat perintah gate per push lulus pada satu run berurutan tanpa retry. `bun run test:ci` 19 dari 19 langkah, `bun run test:ci:real` 7 dari 7 langkah dengan `Restore evidence passed.` pada langkah `test:database:real`, `bun run test:ci:security` 1 dari 1 langkah, dan `bun run test:report` keluar 0 dengan `Gate passed`: 88 dari 88 skenario `passed` (termasuk BKP-001 sampai BKP-008), kelima alur kritis lulus, discovery dan ketiga pemindai lulus, pengikatan sah, `performance k6: smoke passed`, dan `deployment: passed (36 dari 36 check passed)`. `.local/feature-14/restore.json` berstatus `passed` tanpa `failures`, kedua belas guard `passed`, restore sampai readiness 200 dalam 539 ms terhadap batas 300.000 ms, dan file itu ada di bundle tier nyata sebagai bukti wajib berjenis `data` dengan SHA 256 yang sama dengan aslinya. `bun run test:report:release` atas bundle lokal keluar 1 dengan status `incomplete`, seperti yang ditetapkan spec 0012 untuk bundle yang bukan run CI, dengan `grantsDeployment` `false` dan tanpa `image_differs`. AC-1 sampai AC-9 terpenuhi untuk bagian lokal. Run GitHub Actions di runner Linux dan latihan restore ulang sesudah perubahan review baru dapat dibuktikan sesudah push dan dicatat sebagai bukti terpisah. Gerbang ini bukan kandidat release (`not_clean` dan `not_ci`), karena working tree belum masuk commit dan tidak berjalan di CI.

## Lingkungan

macOS 27.0 (arm64, Apple Silicon), Bun 1.4.2, Node 24.21.0 di host. Docker Desktop dengan Docker Engine 29.8.0 dan Docker Compose 5.5.1; mesin container melihat 10 CPU. Container proyek lain yang berjalan tanpa label `foundation.test` sepanjang gerbang, termasuk PostgreSQL Compose bersama milik proyek ini (`foundation-postgres-1`, tetap `Up` dan `healthy`), tidak disentuh. Tidak ada suite lain yang berjalan bersamaan dengan langkah mana pun. Port 8888 dan 8889 kosong sebelum dan sesudah gerbang.

| Komponen | Identitas |
| --- | --- |
| PostgreSQL 18.6 | `foundation-postgres:18-pinned`, image id `sha256:5cdc9215330d115fe6e3fb2d3f5eb5a4cdae2ce0821b1d1f2ce4eb08480d0bef`, linux arm64, base `oraclelinux:10-slim@sha256:0660af1f1bb56559b299d99d3b71d0ff51f9d593cecbd3154a46914704ec34d6`, paket `18.6-4PGDG.rhel10.2`; dibangun ulang dari pin yang sama oleh langkah `test:infrastructure` gerbang ini dan dipakai oleh setiap suite nyata, termasuk kedua cluster, run Compose `deploy/backup.yaml`, dan container alat `backup.test.ts` |
| Image job backup dan restore | Sama dengan baris di atas lewat nilai bawaan `FOUNDATION_POSTGRES_IMAGE`; `pg_dump`, `pg_restore`, `psql`, dan `sha256sum` dari image itu, tanpa image atau alat baru |
| Server sumber dan target | PostgreSQL 18.6 menurut `serverVersion` di `restore.json` |

## Perintah dan hasil gerbang akhir

Gerbang menjalankan keempat perintah gate per push lalu `test:report:release`. Tier nyata memuat setiap suite nyata yang disentuh fitur ini: `test:database:real` (BKP-002 di `provision.test.ts` dan BKP-003 sampai BKP-007 di suite baru `backup.test.ts`, dengan bukti `restore.json`), `test:infrastructure` (image PostgreSQL yang dipakai job backup), `test:database:migration`, `test:tooling:real` (provisioning dan `serve` yang kini menyaring variable backup), `test:readiness:real`, `test:deployment:real` (konteks image runner memuat `database/fingerprint.ts` lewat daftar izin `!database/*.ts`), dan smoke k6. Tier cepat memuat BKP-001 di `test:deployment:plan`, BKP-008 di `test:tooling`, GATE-008 dan GATE-009 di `test:gate`, kedua typecheck yang kini memuat file fitur ini, dan setiap suite lain yang file nya diubah fitur ini. Setiap script yang dirujuk registry `tests/scenarios/` tercakup. Setiap perintah dijalankan satu kali, berurutan, tanpa retry, dan tidak ada yang gagal.

| Perintah (waktu UTC) | Hasil aktual |
| --- | --- |
| `bun run test:ci` (03.29.51 sampai 03.34.12) | Exit 0, 19 dari 19 langkah `passed`. `test:scenarios`: `Scenario registries passed (93 unique IDs, 129 checks).`; `check:test-discovery`: 41 file test (Vitest 4, Playwright `playwright.config.ts` 4, Playwright `playwright.real.config.ts` 1, Playwright `playwright.deployment.config.ts` 1, `bun:test` 31); `check:workflow`: `Workflow lulus: application.yml (application 8 langkah, real 8 langkah, security 4 langkah, report 7 langkah), capacity.yml (capacity 7 langkah).`; `api:check`: `OpenAPI and SDK match stored artifacts across two runs`; `build:frontend` initial total 685,31 kB dengan warning anggaran 500 kB yang sudah ada; `check:frontend:bundle` lulus; keempat typecheck exit 0, termasuk `typecheck:contract` dengan `backup.test.ts` dan `database/fingerprint.ts` serta `typecheck:tooling` dengan `backup-static.test.ts`; `test:frontend` 81 test; `test:integration` 668 test dengan 4.101 assertion dalam 83,2 detik; `test:tooling` 55 test dengan 222 assertion dalam 37,7 detik (termasuk BKP-008); `test:gate` 270 test dengan 2.126 assertion dalam 61,9 detik (termasuk GATE-008 dan GATE-009 untuk bukti restore dan suite backup); `test:performance:plan` 78 test dengan 1.538 assertion; `test:deployment:plan` 67 test dengan 1.157 assertion dalam 31,5 detik (termasuk 16 test BKP-001); `test:e2e` 12 test. Seluruhnya 0 gagal dan 0 dilewati. |
| `bun run test:ci:real` (03.34.23 sampai 03.41.13) | Exit 0, 7 dari 7 langkah `passed` tanpa testcase dilewati: `test:infrastructure` 18 test dengan 205 assertion dalam 51,6 detik; `test:database:real` 153,5 detik, dengan `bun test` 89 test di 5 file dan 3.012 assertion dalam 151,3 detik di bawah batas 600 detik, lalu `Database artifact scan passed: 17 random values absent from 17 files.` dan `Restore evidence passed.`; `test:database:migration` 5 test dalam 16,9 detik; `test:tooling:real` lulus dalam 30,6 detik (TOOL-001 12 check database dengan role nyata, TOOL-007 dengan pemindaian 6 nilai acak atas 36 keluaran dan 7 file); `test:readiness:real` lulus dalam 5,9 detik; `test:deployment:real` lulus dalam 85,0 detik dengan `36 check passed, 0 failed, 0 not_run`; dan `test:performance:smoke` sebagai langkah terakhir dalam 66,9 detik (4.403 iterasi sama dengan 4.403 request, 0 dropped iterations, 18 dari 18 threshold, 9 dari 9 check pengamatan, dan pemindaian credential tanpa temuan atas 28 output). |
| `bun run test:ci:security` (03.41.21 sampai 03.41.52) | Exit 0; gitleaks v8.30.1 atas 53 commit, `bun audit` 1.4.2 atas 487 paket, dan actionlint 1.7.12 atas `.github/workflows/application.yml` dan `.github/workflows/capacity.yml`, ketiganya `passed` dengan 0 temuan. Pemindai juga mencetak `Working tree tidak bersih: perubahan yang belum masuk commit tidak dipindai gitleaks.` (lihat *Pemeriksaan sesudah dokumen diperbarui*). |
| `bun run test:report` (03.42.00) | Exit 0 dengan `Gate passed`: ketiga tier `passed`, 88 skenario (0 failed, 0 missing_test, 0 not_run, 0 skipped, 88 passed), alur kritis APP-002, DEP-006, READY-006, READY-009, dan UI-001 `passed`, discovery `passed`, ketiga pemindai `passed`, `pengikatan sah`, `performance k6: smoke passed`, `deployment: passed (36 dari 36 check passed)`, `Kandidat release: bukan (not_clean fast, not_clean real, not_clean security, not_ci fast, not_ci real, not_ci security, not_ci)`. Bagian *Di luar cakupan* hanya memuat profil kapasitas (fitur 12). |
| `bun run test:report:release` (03.42.08) | Exit 1 dengan `Status release incomplete`, sesuai spec 0012 untuk bundle lokal: gate per push `passed` tetapi bukan kandidat, laporan kapasitas `incomplete`, alasan `capacity_incomplete`, `gate_not_candidate`, `capacity_not_candidate`, dan `candidate_differs`, `grantsDeployment: false`, tanpa `image_differs`. Bundle kapasitas lokal masih dari gerbang fitur 12. Perintah hanya menulis `.local/feature-13/release.json` dan `release.md`; `.local/feature-11/report.json` dan `.local/feature-12/report.json` tetap dengan waktu tulis sebelumnya. |

Sesudah gerbang, daftar container, network, dan volume Docker sama dengan sebelum gerbang, tidak ada container berlabel `foundation.test`, tidak ada container maupun network bernama `foundation-backup-` atau `foundation-deploy`, daftar 11 folder `foundation-*` di `TMPDIR` sama sebelum dan sesudah gerbang, tidak ada proses orkestrasi yang tersisa, dan tidak ada listener pada port 8888 atau 8889. Satu perbedaan daftar image: tag `foundation-postgres:18-pinned` kini menunjuk `5cdc9215330d`, dibangun dari pin yang sama oleh `test:infrastructure` seperti pada setiap tier nyata; image yang sebelumnya memakai tag itu (`b5c5cce6ff9c`) tidak ada lagi.

Pemeriksaan mandiri atas bundle: ke 62 file bukti ketiga tier (24 tier cepat, 37 tier nyata termasuk file di folder screenshot, dan 1 tier keamanan) dihitung ulang SHA 256 nya dan semuanya ada di manifest. Ketiga manifest mencatat commit `ad1dbf2`, `clean` false, `ci` null, dan pohon sumber yang sama pada awal dan akhir tier. Salinan `restore.json` di bundle tier nyata sama byte demi byte dengan `.local/feature-14/restore.json` (`85d78417…a3bdf`), dan manifest tier nyata mencatatnya sebagai `kind` `data`, `required` true, dan `present` true sesudah JUnit dan pemindaian langkah `test:database:real`.

## Bukti restore

Isi [`restore.json`](evidence/0013/restore.json) dari run `test:database:real` gerbang ini, ditulis `backup.test.ts` pukul 03:37:47Z menurut tabel *Isi restore.json* spec.

| Field | Hasil gerbang akhir |
| --- | --- |
| `status` dan `failures` | `passed`, `[]` |
| `serverVersion` | `18.6` |
| `backup` | `foundation-20261006T033614Z-manual`, alasan `manual`, 6.754 byte, 17 entri TOC, `pg_dump` 61 ms, `checksumVerified` true (`sha256sum --check --strict` di container alat lulus dan hash yang dihitung ulang di Bun sama) |
| `restore` | `durationMs` 539 (dari awal run Compose `restore` BKP-004 sampai readiness 200 pertama, batas 300.000), `provisioning` `verified`, `migrations` `Migrations: 0 applied, 2 skipped`, `readinessStatus` 200, `oldPasswordsRejected` `foundation_migrator`, `foundation_backend`, dan `foundation_backup` |
| `fingerprint` | `equal` true; `common.schema_migrations` 2 baris dan `users.restore_fixture` 3 baris, 1 sequence, migration terakhir `0002-users-restore-fixture.sql` dari 2 |
| `guards` | Kedua belas guard `passed`: `invalid_name`, `incomplete_backup`, `checksum_mismatch`, `checksum_wrong_file`, `archive_invalid`, `missing_admin_url`, `invalid_target`, `target_not_provisioned`, `target_not_empty`, `major_mismatch`, `restore_failed`, dan `history_drift` |
| `retention` | `kept` 7 nama (backup baru, 1, 34, 36, 37, 38, dan 39 hari), `removed` 6 nama (40 sampai 45 hari), `leftovers` 3 file (`.partial` lalu `.dump` dan `.dump.sha256` set tidak lengkap), `untouched` `archive`, `latest`, dan `notes.txt`, tepat seperti baris BKP-007 spec |
| `secretScan` | 182 sumber, 39 nilai, `findings` kosong |
| `boundary` | Kalimat tetap spec: bukti pada dua cluster PostgreSQL 18 terisolasi milik run dengan data fixture, bukan bukti RTO environment, ukuran data nyata, jadwal backup, salinan di luar host, atau enkripsi penyimpanan |

Pemindaian orkestrasi `database-real.ts` ([`artifact-scan.json`](evidence/0013/artifact-scan.json)) memeriksa 17 nilai rahasia turunan label, termasuk label `backup` dan `restore-*` beserta DSN nya, atas 17 file (JUnit, `restore.json`, dan 15 file bundle frontend) tanpa temuan.

## Hasil per skenario

| Skenario | Kriteria | Bukti gerbang akhir | Status |
| --- | --- | --- | --- |
| `BKP-001` | AC-1, AC-3, AC-4, AC-9 | 16 test `tests/integration/deployment/backup-static.test.ts` (`test:deployment:plan`, tier cepat), JUnit [`plan.xml`](evidence/0013/plan.xml) | `passed` |
| `BKP-002` | AC-2 | 15 test `tests/integration/database/provision.test.ts` pada PostgreSQL 18.6 terisolasi (`test:database:real`, tier nyata), JUnit [`database.xml`](evidence/0013/database.xml) | `passed` |
| `BKP-003` | AC-3, AC-4, AC-8 | 4 test `tests/integration/database/backup.test.ts` (`test:database:real`), JUnit [`database.xml`](evidence/0013/database.xml) | `passed` |
| `BKP-004` | AC-5, AC-8 | 3 test `backup.test.ts`, JUnit [`database.xml`](evidence/0013/database.xml) | `passed` |
| `BKP-005` | AC-6, AC-8 | 15 test `backup.test.ts`, JUnit [`database.xml`](evidence/0013/database.xml) | `passed` |
| `BKP-006` | AC-3, AC-4, AC-5, AC-6, AC-8 | 10 test `backup.test.ts`, JUnit [`database.xml`](evidence/0013/database.xml) | `passed` |
| `BKP-007` | AC-7, AC-8 | 5 test `backup.test.ts`, JUnit [`database.xml`](evidence/0013/database.xml) | `passed` |
| `BKP-008` | AC-4 | 1 test `tests/integration/tooling/development.test.ts` (`test:tooling`, tier cepat), JUnit [`tooling.xml`](evidence/0013/tooling.xml) | `passed` |

Jumlah test per skenario dihitung `test:report` dari testcase yang judul lengkapnya diawali tag di JUnit gerbang ini. GATE-008 (3 test, termasuk tiga belas bentuk berkas `restore.json` untuk `restorePassed`) dan GATE-009 (11 test, termasuk test `interruptedSuite` untuk `backup.test.ts`) ada di [`gate.xml`](evidence/0013/gate.xml), dan DATA-001 sampai DATA-005 tetap lulus tanpa diubah di `provision.test.ts`. Ke 80 skenario fitur lain pada laporan per push (APP, DATA, DEP, GATE, INFRA, MIG, OPENAPI, PERF per push, READY, SDK, TOOL, dan UI) juga `passed` pada gerbang yang sama. Tabel lengkap dengan kolom template laporan release ada di [`report.md`](evidence/0013/report.md).

## Hasil per kriteria

| Kriteria | Hasil dan bukti |
| --- | --- |
| AC-1 | Terpenuhi. `docs/rules/backup.md` menetapkan setiap baris *Keputusan operasi* (RPO 24 jam, RTO 4 jam, retensi 35 hari dengan 7 backup lengkap terbaru, cakupan, akses, penyimpanan, enkripsi, checksum, pemantauan `check` 26 jam, dan latihan per 30 hari), runbook sepuluh langkah, dan prosedur insiden empat baris. BKP-001 memeriksa setiap string tabel *Dokumen yang diperbarui* secara harfiah dan bentuk runbook, prosedur insiden, dan hook fitur 15. |
| AC-2 | Terpenuhi. BKP-002 (15 test) menjalankan setiap baris *Kasus provisioning role backup* dengan exit, pesan, dan report tepat tanpa perubahan pada kasus gagal, privilege negatif, batas `pg_authid` sesudah `SET ROLE pg_read_all_data`, dan runner yang tetap lulus `verifyIdentity`; test DATA lama lulus tanpa diubah, dan test terakhir mengembalikan cluster bersama ke keadaan sebelum BKP-002. |
| AC-3 | Terpenuhi. BKP-001 mengunci `deploy/backup.yaml` terhadap *Topologi backup* dan bentuk kedua script, termasuk kategori yang hanya dibuktikan statis (`time limit`, `killed`, `archive invalid`, `internal`, dan `Retention failed`). BKP-003 membuktikan `create` untuk ketiga alasan dengan tiga file 0600, checksum, manifest, dan isi archive; BKP-006 membuktikan setiap kategori komponen nyata, termasuk `interrupted` lewat TERM, INT, dan `docker stop`, dengan folder sama persis. |
| AC-4 | Terpenuhi. Teks dump memuat sentinel fixture tanpa password, DSN, sentinel pengaturan database, `CREATE ROLE`, `PASSWORD`, atau `SCRAM-SHA-256`; `secretScan` 182 sumber dan 39 nilai tanpa temuan; argumen proses yang dibaca `docker top` tanpa password pada BKP-006; dan BKP-008 membuktikan `serve` menghapus kedua variable backup dari proses anak. |
| AC-5 | Terpenuhi. BKP-004 (3 test): restore ke target baru yang diprovision dengan empat password baru, provisioning ulang hanya `verified`, `Migrations: 0 applied, 2 skipped`, fingerprint sama, readiness 200, password sumber ditolak, dan `restore.durationMs` 539 ms. BKP-006 membuktikan fingerprint yang menunggu lock target berakhir `Fingerprint failed`. |
| AC-6 | Terpenuhi. BKP-005 (15 test) menjalankan setiap guard dalam *Urutan uji target* dengan bukti target tidak berubah, dan kedua belas guard `passed` di `restore.json`; BKP-006 membuktikan penolakan DSN admin target, restore tanpa `FOUNDATION_RESTORE_DATA_NETWORK` yang berhenti di Compose, serta TERM dan INT saat `psql` menunggu lock dengan exit 143 dan 130. |
| AC-7 | Terpenuhi. BKP-007 (5 test) membuktikan retensi dengan nilai tepat (7 disimpan, 6 dihapus, 3 file sisa, 3 entri tidak disentuh) dan setiap hasil tabel *Check*, termasuk checksum sebelum umur. |
| AC-8 | Terpenuhi. `restore.json` berstatus `passed` dan ada di bundle tier nyata sebagai bukti wajib berjenis `data`; `database-real.ts` menghapus file lama, memindai label baru, memberi `bun test` batas 600 detik, dan mencetak `Restore evidence passed.`; registry `tests/scenarios/backup.json` lulus `test:scenarios`; GATE-008 dan GATE-009 lulus di `test:gate`; kedua typecheck memeriksa file baru; dan `test:ci:real` lulus. |
| AC-9 | Terpenuhi untuk catatan latihan pertama. `docs/testing/restore-drill-template.md` dan [catatan latihan 2026-10-06](restore-drills/2026-10-06-topologi-rujukan-lokal.md) lulus BKP-001 (heading tetap, commit, pohon input build, empat image ID, tanpa DSN atau password). Latihan itu mengukur RPO 13 menit 17 detik dan RTO latihan 16,8 detik sampai readiness 200, dengan pemeriksaan isolasi langkah 10 keluar 1 dan kontrol bridge keluar 0; `/check verify` mengulang langkah 1 sampai 10 dengan RTO 16,4 detik. Aturan deployment, template laporan release, dan langkah pencabutan sesi `tidak berlaku sampai fitur 15` diperiksa BKP-001. Latihan ulang sesudah perubahan review masih tindak lanjut (lihat *Batas bukti*). |

## Riwayat run

Gerbang ini adalah run pertama keempat perintah gate pada pohon sumber akhir. Run sebelumnya tercatat oleh tahap masing masing dan tidak diulang angkanya di sini: milestone 5 menjalankan gate lokal penuh pada pohon sebelum review (19 dari 19, 7 dari 7, 1 dari 1, dan 88 skenario), `/check verify` menjalankan gate lokal, harness sendiri dengan 148 entri ledger, dan latihan runbook ulang ([verify.md](../specs/0013-backup-pemulihan-data/verify.md)), `/test` menambah 12 test dan menjalankan `test:database:real` dengan 85 test, dan review ulang menjalankan `test:database:real` dengan 89 test dalam 151,5 detik. Uji mutasi tahap tahap itu sengaja membuat test gagal pada salinan sementara, dan hasilnya tercatat di `verify.md` dan kedua review (dua belas dari empat belas mutasi reviewer tertangkap). Pohon sumber berubah sesudah run tersebut (perbaikan review, CHANGELOG, dan scope), sehingga gerbang ini menjalankan ulang seluruh tier pada pohon sumber akhir.

## Identitas artefak

| Artefak | SHA-256 |
| --- | --- |
| Pohon sumber gerbang akhir (ketiga manifest) | `5512cee2da4d6e6dc0a8e9c0085cba50dd7187c2ccf1d2a846ce644c9d43af58` |
| `.github/workflows/application.yml` (tidak berubah sejak fitur 12) | `edda79e565b79b9a5d204e9aaf57df86d3eae11adb723f0bb31796e3eb0fe164` |
| `.github/workflows/capacity.yml` (tidak berubah sejak fitur 12) | `7b3305f463cc3eb4d43335a12362abf70bc8a3feb07b396061aaad62fd2fb052` |
| `package.json` (tidak berubah sejak fitur 13) | `d9c14419ac240d1da2612fe32399b1306d2249460359ea7c1b818e60e8ea1bd4` |
| `bun.lock` (`source-map-js` 1.2.2, perubahan keamanan terpisah di CHANGELOG) | `709aa822bcd149ec2967ed79fffefe1248ddd47e8cfeee2146d68384c32de656` |
| `openapi.json` (tidak berubah) | `f6c31a95f949fae4c3387a83362a2a3460cadd6c50802d9706e05bd23505b611` |
| `deploy/backup.yaml` | `dfc6780c460df95cdc06a66b6dbfb65a726d32e5d7f3f315c599bc4985e9ba6a` |
| `deploy/backup/foundation-backup.sh` | `adb0e490c6c501daf43b20965630dda1654572cadc10981f8fd20af708b7a96a` |
| `deploy/backup/foundation-restore.sh` | `84bbeeb2d72d8bb4651243efb77bcd0cd2588b016c89e214a34f1fbcb6d772ec` |
| `database/fingerprint.ts` | `15e97633c3e6ace8f996c54015ad93bad7408816aa65cc79417857fc5e7e4305` |
| `database/provision.ts` | `6214ea647e295fef02660b220d820eb7dd93bf204a2b3a55d53f701284ece41d` |
| `.env.backup.example` | `0a745f3ecd14930b9ce6388f398d00bef6422e3e3c3f6ca1301ea23c801c3b28` |
| `tests/orchestration/database-real.ts` | `f4b738c40664a8a2be338e58a3b36e228cd9444853a43f87f8023cc6c6a69e13` |
| `tests/orchestration/restore-evidence.ts` | `326554c06360cad138d525e8a771a36f35d442991a0d83b5a6812f9cbb331e26` |
| `tests/scenarios/backup.json` | `b56a45bbd37727ffb4b3502ee0087eb59499669cfda40dff74c7772bb681e80f` |
| `tests/integration/database/backup.test.ts` | `b23e03a5aa8a50a77efaea809ca1430ea831afffdd6c244d40008ab52fcc5db1` |
| `tests/integration/deployment/backup-static.test.ts` | `b75a7fee4d9bc0f1f6efd2c04e77c4bfcfd7afff1175f69686b1fddb2e1d9705` |
| `docs/rules/backup.md` | `94ef7a9cf7171ea2f7ab3b91b2e59c28b3a9e5c0b48542ce6e9ab4ddaec69050` |
| `docs/testing/restore-drill-template.md` | `00dff9d8d40a9ee7605357c6742d5268100477f67834ec1eeceb81a19b0f1a7b` |
| `docs/testing/restore-drills/2026-10-06-topologi-rujukan-lokal.md` | `e2931b0313846e4b735996a36fdb0029227f2ca8dc3a3ee0a0ff91ce93bf05c5` |
| `evidence/0013/restore.json` | `85d78417467042e6f7e1ab55b6974cb531c9f7535d07f59c25a8d556670a3bdf` |
| `evidence/0013/artifact-scan.json` | `bf7216fd5a697bd3c4b9e720bf16b761e154ac068914f0594fb5f6d7e83c7164` |
| `evidence/0013/database.xml` | `9206c14f10c169b9d80eedc5a02f5715ebce656699162474416b681afa6321bb` |
| `evidence/0013/plan.xml` | `6c0fe95fa6ce8a9d18779ecf813e0b3b226327aae85474df6d0a636eceb5f83d` |
| `evidence/0013/tooling.xml` | `727a5e86ef6b91d30209bce0a60ca5bf68231a544c7874281597188f05cb557c` |
| `evidence/0013/gate.xml` | `2c4e4e0aa09f984661743ef15c58cf21a46a258996265d7fa25e6f341a465d19` |
| `evidence/0013/manifest-fast.json` | `446846dca88d8b5bac1fe294763819df85c169a53a333a0208029314b409283b` |
| `evidence/0013/manifest-real.json` | `41490bab63286a9752dd7c12888220416ce9d27c3ce725812d9c23f3f49f0624` |
| `evidence/0013/manifest-security.json` | `c7f8cbe0ecba1bb8004d90374e242702bd3f356d28f03faf2de39dc278a787c2` |
| `evidence/0013/report.json` | `6b1052741ab8263280d0c855407347649256a0a331441a647644a605e0167ea9` |
| `evidence/0013/report.md` | `691e1f91e736f6e62a7d5727224ffb63a01b6e925817c8cf40b3c9924552a3b2` |
| `evidence/0013/release.json` | `3809662fa459d4453389ba150de0de0022ef4b36f6feee8383435768dcb17e88` |
| `evidence/0013/release.md` | `9bb14df420c33e167e683db544166d0e2ae6a23708964572644fdf951e6b861a` |
| `evidence/0013/security.json` | `b7a2b192fe206d8fc890739a7f6ba0b1df1fd9be6b4a38be93bee916c57c680a` |

Checksum input dan output di manifest sama pada ketiga tier, termasuk `apps/frontend/dist/frontend/` (`7f0c3a6487ab521b0c7f53e8d69db28ad4c4cfb6dd4e26d711eadc4e70d196d6`) dan `dist/backend/index.js` (`b2b99ba9a70fa229450eec9ef925c4c11fc6f6c1cc114ddbf27b901530e3de1a`), keduanya sama dengan gerbang fitur 13 karena fitur ini tidak mengubah frontend atau backend.

## Bukti yang disalin

Salinan di `evidence/0013/` berasal dari gerbang akhir. Path di dalamnya merujuk bundle `.local/` yang tidak masuk repository.

- Bukti restore, disalin byte demi byte dan SHA 256 nya sama dengan manifest tier nyata: [`restore.json`](evidence/0013/restore.json) dan pemindaian orkestrasi [`artifact-scan.json`](evidence/0013/artifact-scan.json).
- Laporan per push dari `test:report`: [`report.json`](evidence/0013/report.json) dan [`report.md`](evidence/0013/report.md), beserta manifest [fast](evidence/0013/manifest-fast.json), [real](evidence/0013/manifest-real.json), dan [security](evidence/0013/manifest-security.json), serta [`security.json`](evidence/0013/security.json).
- Status release lokal: [`release.json`](evidence/0013/release.json) dan [`release.md`](evidence/0013/release.md).
- JUnit yang memuat skenario BKP dan pemeriksaan bukti restore: [`plan.xml`](evidence/0013/plan.xml) dari `.local/feature-13/plan.xml` (BKP-001), [`database.xml`](evidence/0013/database.xml) dari `.local/feature-5/database.xml` (BKP-002 sampai BKP-007), [`tooling.xml`](evidence/0013/tooling.xml) dari `.local/feature-4/tooling.xml` (BKP-008), dan [`gate.xml`](evidence/0013/gate.xml) dari `.local/feature-11/gate.xml` (GATE-008 dan GATE-009). Keempat file ini disalin tanpa atribut `hostname` dan lulus `xmllint --noout`, sehingga SHA 256 nya berbeda dari file asli di bundle.

Pemeriksaan `postgres://`, `postgresql://`, `/Users/`, `/var/folders`, `/private/tmp`, `hostname=`, dan nama host atas seluruh salinan tidak menemukan apa pun.

## Batas bukti dan tindak lanjut

- Run GitHub Actions belum ada karena working tree belum masuk commit dan belum di push. Job `real` di runner `ubuntu-24.04` (bind mount folder backup dengan UID host dan mode 0700, network external `internal: true`, `docker compose --progress quiet`, format `docker top`, dan durasi `test:database:real` terhadap `timeout-minutes` 45) serta gitleaks atas commit fitur oleh job `security` dicatat sebagai bukti terpisah sesudah push, sesuai butir Follow-up spec.
- Seluruh run berjalan di macOS arm64 dengan Docker Desktop, yang menampilkan bind mount sebagai owner 0:0 dan membiarkan UID mana pun menulis, sehingga aturan owner UID dan GID folder backup belum terbukti pada Linux.
- [Catatan latihan 2026-10-06](restore-drills/2026-10-06-topologi-rujukan-lokal.md) memakai antarmuka sebelum perubahan review (restore lewat `FOUNDATION_DATA_NETWORK`, kini `FOUNDATION_RESTORE_DATA_NETWORK`) dan image PostgreSQL `4e3191d2…`, yang tidak lagi dapat dicocokkan karena `test:infrastructure` membangun ulang tag itu dengan image ID baru setiap kali. Latihan ulang pada topologi rujukan sesudah perubahan review masih butir Follow-up spec; menurut template laporan release, latihan yang belum dijalankan sesudah perubahan alat backup dicatat sebagai bukti yang belum lengkap untuk release, bukan sebagai lulus.
- Latihan lokal tidak menjalankan edge, sehingga RTO sampai trafik edge tidak terukur; data latihan hanya `common.schema_migrations` 1 baris. Penjadwal, retensi log 35 hari, alert `check`, salinan di luar host, dan enkripsi at rest belum terbukti dan menunggu platform yang dipilih pemilik. Kode proyek tidak mengunggah backup ke mana pun.
- `restore.json` memakai data fixture pada container lokal, bukan bukti RTO environment atau ukuran data nyata, seperti kalimat `boundary` nya.
- Tier kapasitas `test:ci:capacity` tidak dijalankan ulang. Fitur ini tidak mengubah profil k6 atau orkestrasi kapasitas; smoke pada tier nyata gerbang ini lulus dengan 18 dari 18 threshold. Karena itu status release lokal memuat `capacity_incomplete` dan `candidate_differs`.
- [Review awal](../reviews/2026-10-06-main-backup-restore.md) dan [review ulang](../reviews/2026-10-06-main-backup-restore-followup.md) berakhir Approve with nits tanpa blocker atau major. Tiga temuan minor review ulang tetap terbuka: batas userinfo `split_dsn` untuk password yang salah encoding, cabang `category()` libpq dan `permission denied` dari `pg_dump` tanpa bukti runtime, dan `verify.md` yang belum mengikuti amandemen AC (14 kotak masih terbuka). Dua belas nit juga tetap terbuka, termasuk pointer `docs/rules/backup.md` di `AGENTS.md` untuk `/sync`; nit kotak induk `Bangun` di scope ditutup scope fitur ini.
- Butir Follow-up spec 0013 lain tetap terbuka: isi hook fitur 15, salinan di luar host otomatis dan penjadwal saat platform dipilih, spec arsip WAL bila RPO perlu di bawah 24 jam, bagian restore di `report.md` bila diminta pemilik release, dan aturan role worker fitur 16.
- `build:frontend` tetap memberi warning anggaran awal 500 kB (initial total 685,31 kB); anggaran error 1 MB terpenuhi.
- Laporan ini adalah bukti fitur, bukan bukti kesiapan release, dan status kesiapan apa pun tidak memberi izin deploy.

## Pemeriksaan sesudah dokumen diperbarui

Sesudah laporan ini, salinan di `evidence/0013/`, scope, dan baris **Status** spec 0013 ditulis, perintah berikut dijalankan sekali tanpa retry. Perubahan dokumen itu mengubah pohon sumber, jadi bundle gerbang di `.local/feature-11/evidence/` kini tidak lagi terikat pada working tree (`test:report` akan memberi `source_tree_differs`) sampai tier dijalankan ulang; bukti gerbang akhir tetap bundle yang dicatat di atas.

| Perintah | Hasil aktual |
| --- | --- |
| `bun run test:scenarios` | Exit 0, `Scenario registries passed (93 unique IDs, 129 checks).` |
| `bun run check:test-discovery` | Exit 0, 41 file test dengan pembagian yang sama. |
| `bun run check:workflow` | Exit 0, `Workflow lulus: application.yml (application 8 langkah, real 8 langkah, security 4 langkah, report 7 langkah), capacity.yml (capacity 7 langkah).` |
| `bun --no-env-file test ./tests/integration/deployment` | Exit 0, 67 test dengan 1.157 assertion dalam 31,8 detik, termasuk 16 test BKP-001 yang membaca spec 0013, dokumen aturan, template, dan catatan latihan. Dijalankan tanpa reporter JUnit, sehingga `.local/feature-13/plan.xml` tidak ditimpa. |
| gitleaks atas working tree | Setiap file `git ls-files -co --exclude-standard` working tree (451 file, sekitar 9 MB) disalin ke folder scratchpad di luar repository (file `.env` lokal yang diabaikan Git tidak ikut; hanya keempat file `.env*.example` yang ikut), lalu image gitleaks yang dipin (`v8.30.1@sha256:c00b6bd0…abbb7f`) dijalankan mode `dir` atas sumber `.` dengan `tests/security/gitleaks.toml`, `--ignore-gitleaks-allow`, dan isolasi container yang sama dengan `check:security`. Exit 0 dengan `no leaks found` atas sekitar 8,29 MB. Container memakai `--rm` dan tidak tersisa. |

Sesudah tabel ini ditulis, salinan dan pemindaian gitleaks yang sama diulang atas working tree akhir: exit 0 dengan `no leaks found` atas sekitar 8,30 MB, lalu folder salinan dihapus. Kalimat ini satu satunya perubahan sesudah pemindaian terakhir itu. Commit fitur sendiri baru dipindai gitleaks mode `git` oleh job `security` sesudah push.

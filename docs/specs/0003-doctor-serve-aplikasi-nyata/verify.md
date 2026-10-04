# Verifikasi doctor dan serve pada aplikasi nyata

## Kandidat dan lingkungan

Kandidat adalah `HEAD 358523782beb0505dd5555d74026a586d5c6f538` ditambah perubahan lokal Scope 2 yang belum di-commit. Verifikasi dijalankan pada 2026-10-03 dengan Bun 1.4.2, Node 24.21.0, macOS 27.0, Docker Engine 29.8.0, dan PostgreSQL 18.6 dari image `foundation-postgres:18-pinned`.

## Status skenario

| Skenario | Bukti yang diamati | Status |
| --- | --- | --- |
| `TOOL-001` | JUnit TOOL-001 lulus. Smoke PostgreSQL memeriksa 12 kondisi role/migration positif, menolak target salah, privilege tulis, membership role penulis, checksum salah, metadata tanpa file, migration kosong, role admin, dan database mati; tidak ada credential pada output. [Laporan](../../testing/0005-doctor-serve-real-smoke.md) | Lulus |
| `TOOL-002` | Tujuh test fixture meliputi cleanup listener terdaftar, escalasi sinyal, listener asing, PID dipakai ulang, validasi pemilik port sebelum sinyal, dan grup worker tanpa port. | Lulus, fixture |
| `TOOL-003` | Lima test fixture meliputi pilihan worker eksplisit, isolasi credential, konfigurasi/path readiness, dan respons worker HTTP. Tidak ada worker aplikasi yang terdaftar saat ini. | Lulus, fixture |
| `TOOL-004` | Tiga test fixture membuktikan kegagalan layanan, termination, Ctrl+C, dan penghentian turunan. | Lulus, fixture |
| `TOOL-005` | Enam test fixture membuktikan lock aktif, lock belum lengkap, pemulihan stale, checkout berbeda, race invocation, dan cleanup grup lama. | Lulus, fixture |
| `TOOL-006` | Enam test fixture meliputi timeout, respons tepat, listener asing, body salah, HTML tidak valid, retry setelah snapshot port kosong, dan penolakan respons yang selesai setelah deadline. Smoke nyata setelah perbaikan race kepemilikan port lulus 11 kali berturut-turut. | Lulus |
| `TOOL-007` | PostgreSQL 18.6, doctor, frontend/backend nyata melalui `serve`, HTTP 200 untuk `/` dan `/api/status`, serta shutdown SIGTERM dibuktikan. Browser melalui SDK, proxy, dan database belum tersedia karena halaman Feature 10 belum dibangun. [Laporan](../../testing/0005-doctor-serve-real-smoke.md) | Parsial |
| `TOOL-008` | Satu test fixture membuktikan mode production dan konfigurasi/database development yang tidak valid gagal sebelum cleanup. Worker yang tidak dikenal diuji pada TOOL-003. | Lulus, fixture |

## Konformansi acceptance

- **AC-1: terpenuhi.** Doctor menerima role runtime minimum pada PostgreSQL nyata dan menolak target atau privilege yang dilarang tanpa membocorkan credential.
- **AC-2: terpenuhi.** Nama, checksum, metadata tanpa file, migration kosong, dan database yang tidak tersedia diperiksa pada smoke nyata.
- **AC-3: terpenuhi.** Preflight berjalan sebelum startup; pemeriksaan workstation dengan database mati gagal aman, dan probe listener yang sudah hidup tetap menjawab.
- **AC-4: terpenuhi.** `serve` mengumumkan siap setelah backend mengembalikan JSON yang tepat dan frontend mengembalikan HTML; klasifikasi listener sekarang membedakan port kosong, milik invocation, dan asing dari satu snapshot.
- **AC-5: terpenuhi melalui fixture.** Pemilihan worker, path readiness, dan isolasi environment diuji. Tidak ada worker aplikasi nyata untuk dijalankan.
- **AC-6: terpenuhi melalui fixture.** Cleanup membuktikan kepemilikan lama dan menolak checkout, PID, grup, atau listener yang berubah.
- **AC-7: terpenuhi melalui fixture.** Race invocation, pemulihan stale, dan lock belum lengkap diuji.
- **AC-8: terpenuhi.** Kegagalan layanan, Ctrl+C, termination, turunan proses, serta listener setelah shutdown diuji.
- **AC-9: belum terpenuhi.** Fixture, PostgreSQL, HTTP, dan shutdown terbukti; alur browser fitur 10 melalui SDK, proxy, dan database belum dibangun. Permukaan tersebut belum dapat dijalankan.

**Verdict `/check verify`: FAIL untuk penyelesaian penuh Scope 2.** AC-1 sampai AC-8 memiliki bukti, tetapi AC-9 masih memerlukan permukaan browser Feature 10. Scope dan spec tetap `in-progress`; kotak Verify tidak ditandai selesai.

## Hasil runner dan gate

`bun run test:tooling` lulus dengan 29 test, 79 assertion, 0 gagal, dan 0 dilewati. JUnit terbaru tersedia di [evidence 0005](../../testing/evidence/0005/tooling.xml). `bun run test:scenarios` lulus dengan 31 ID unik.

`bun run test:ci` lulus: 31 ID skenario; API/SDK deterministik pada dua run; frontend 1/1; integration 81/81 dengan 172 assertion; tooling 29/29 dengan 79 assertion; Playwright 4/4. Build frontend tetap memberi peringatan initial bundle 654.09 kB dibanding budget 500 kB.

Smoke nyata `bun run test:tooling:real` sebelumnya lulus 11 kali berturut-turut setelah perbaikan race kepemilikan port. Run terbaru setelah perbaikan deadline juga lulus, memakai PostgreSQL 18.6 terisolasi, memverifikasi doctor dan respons HTTP nyata, lalu mengonfirmasi listener 8888 dan 8889 hilang setelah SIGTERM. Bukti itu tetap tidak menutup browser TOOL-007.

## Langkah verifikasi dari /develop · spec 0003 · diperbarui 2026-10-04

_Langkah ini diturunkan dari acceptance criteria dan tabel Value sourcing spec 0003 untuk seluruh fitur 2, setelah milestone alur browser fitur 10 selesai dibangun. `/check verify` dapat menjalankannya; `/test` dapat mengunci langkah yang tahan lama. Bagian di atas adalah hasil verifikasi 2026-10-03 dan tidak diubah._

### UI / manual

- [x] Setelah `bun run test:tooling:real` lulus, buka screenshot di `.local/feature-2/test-results/` → `readiness-available-desktop.png` dan `readiness-available-mobile.png` menampilkan `Database dapat dibaca.` beserta jumlah migration, `readiness-unavailable-stopped.png` menampilkan `Database tidak tersedia. Pastikan PostgreSQL berjalan, lalu periksa ulang.` tanpa jumlah lama, DSN, SQL, atau stack, dan `readiness-recovered.png` kembali tersedia → AC-9
- [x] Pada PostgreSQL development yang sudah diprovision dan dimigrasi, dengan `DATABASE_URL` milik `foundation_backend`, jalankan `bun run serve`, lalu buka `http://127.0.0.1:8889/kesiapan` lewat menu `Kesiapan` → state tersedia dengan jumlah migration sama dengan jumlah file `database/migrations/*.sql`; tekan Ctrl+C → exit 130, port 8888 dan 8889 bebas, dan `.local/serve.lock` hilang → AC-4, AC-8, AC-9
- [x] Saat `serve` dari langkah sebelumnya masih berjalan, jalankan `bun run serve` kedua dari checkout yang sama → invocation kedua gagal dengan `Serve lain dari checkout ini masih aktif.` dan halaman `/kesiapan` pada invocation pertama tetap menjawab → AC-7
- [x] Jalankan listener asing pada 8889 (misalnya `bun -e "Bun.serve({ hostname: '127.0.0.1', port: 8889, fetch: () => new Response('asing') })"`), lalu `bun run serve` dengan database siap → startup gagal tanpa sinyal ke listener itu, dan `curl http://127.0.0.1:8889/` tetap memberi `asing` → AC-6

### Perintah

- [x] `bun run test:tooling:real` → exit 0 dengan baris `TOOL-001: 12 database checks passed with the real provisioned role` dan baris penolakan target, hak tulis metadata, keanggotaan penulis, checksum, metadata tanpa file, migration kosong, serta role admin → AC-1, AC-2
- [x] Run yang sama → `GET .../api/status -> 200 {"status":"ok"}` dan `GET http://127.0.0.1:8889/ -> 200 text/html` setelah `serve` siap → AC-3, AC-4
- [x] Run yang sama → READY-009 `1 passed` di bawah `serve` (tersedia, periksa ulang, database berhenti, pulih tanpa restart), lalu `the same serve stayed up from the first check through recovery` → AC-9
- [x] Run yang sama → `SIGTERM shutdown exited 143, removed listeners on ports 8888 and 8889, and released the serve lock` → AC-8
- [x] Run yang sama → `serve stopped at preflight on the unavailable database, started no service, and left the listeners on 8888 and 8889 answering` → AC-3
- [x] `cat .local/feature-2/artifact-scan.json` → `findings` kosong, `secretsChecked` 6, dan `outputsScanned` memuat `serve`, `serve preflight`, serta `playwright` → AC-1, AC-9
- [x] Ubah sementara `FOUNDATION_READINESS_CONTAINER` di smoke menjadi nama yang lolos pola tetapi tidak ada, jalankan `bun run test:tooling:real`, lalu kembalikan → exit 1 dengan `READY-009 browser flow under serve failed`, dan sesudahnya port bebas, lock hilang, serta `docker ps -a --filter label=foundation.test=readiness` kosong → AC-8, AC-9
- [x] `bun run test:tooling` → 29 pass, 0 fail, dengan tag TOOL-001 sampai TOOL-006 dan TOOL-008 → AC-1 sampai AC-8
- [x] `bun run doctor` tanpa `DATABASE_URL` atau dengan database mati → exit 1 dan pesan aman tanpa DSN, password, SQL, atau error PostgreSQL mentah → AC-1, AC-3
- [x] `NODE_ENV=production bun run serve` dan `bun run serve --worker tidak-ada` → keduanya exit 1 sebelum cleanup dengan pesan aman → AC-3, AC-5
- [x] `bun run test:scenarios` → lulus, dan TOOL-007 di `tests/scenarios/development-tooling.json` memetakan AC-1, AC-2, AC-3, AC-4, serta AC-9 dengan pemeriksaan `command` dan `playwright` pada `test:tooling:real` → AC-9
- [x] `bun run test:ci` → exit 0 sebagai regresi → AC-1 sampai AC-8

### Value sourcing

- [x] Schema wajib dari `database.schemas`: panggil `runDoctor` dari script sementara dengan salinan konfigurasi yang menambah schema yang tidak ada → pemeriksaan schema berstatus `error` → AC-1
- [x] Nama database dari `database.expectedName`: smoke memakai `other_database` → `Target database` berstatus `error` → AC-1
- [x] Role dan privilege dari katalog PostgreSQL: smoke memberi `INSERT`, keanggotaan `metadata_writer`, lalu memakai URL admin → `Privilege metadata` dan `Role database` berstatus `error` → AC-1
- [x] Migration yang diharapkan dari file: pada salinan root sementara, tambahkan satu file `.sql` yang belum diterapkan, lalu jalankan doctor terhadap database smoke → `Migration` berstatus `error`; direktori kosong juga gagal → AC-2
- [x] Migration terapan dari `common.schema_migrations`: smoke mengubah checksum dan menambah baris tanpa file → `Migration` berstatus `error` → AC-2
- [x] Host, port, entry, dan worker dari konfigurasi serta `--worker`: output `serve` mengumumkan `Frontend: http://127.0.0.1:8889` dan `Backend: http://127.0.0.1:8888`; worker tak dikenal ditolak → AC-4, AC-5
- [x] Respons backend dari kontrak `/api/status`: test TOOL-006 `readiness times out on the wrong HTTP body` → gagal dan grup dihentikan → AC-4
- [x] Respons frontend berupa HTML: test TOOL-006 `readiness rejects a non HTML frontend body` → gagal → AC-4
- [x] Batas startup 60 detik dengan monotonic clock: test TOOL-006 `readiness timeout stops the supervised process` dan `readiness rejects an HTTP response completed after the startup deadline` → gagal tepat waktu → AC-4
- [x] Target worker HTTP dari `port` dan `readinessPath`: test TOOL-003 `worker HTTP readiness path is required and local` dan `selected HTTP worker must answer on its configured readiness path` → AC-5
- [x] Identitas invocation: saat `serve` berjalan, baca `.local/serve.lock/owner.json` → memuat token, UID, checkout kanonik, supervisor, serta PID, waktu mulai, dan PGID setiap grup, tanpa DSN atau environment, dengan izin file `0600` dan direktori `0700` → AC-6, AC-7
- [x] Proses yang boleh dihentikan: test TOOL-002 `rejects a reused PID identity` dan `rechecks port ownership immediately before SIGTERM` serta `before SIGKILL` → tidak ada sinyal ke proses yang identitasnya berubah → AC-6
- [x] Listener yang boleh menjawab probe: test TOOL-006 `readiness accepts owned HTTP responses and rejects a foreign port` → listener asing ditolak → AC-4
- [x] URL yang diumumkan: pada output smoke atau `serve`, baris `Frontend:` dan `Backend:` muncul hanya setelah seluruh readiness lulus dan tepat sebelum `Layanan development siap.` → AC-4

### Cakupan acceptance criteria

- AC-1: smoke TOOL-001, pemindaian credential, doctor tanpa database, tiga baris Value sourcing pertama, dan TOOL-001 fixture.
- AC-2: smoke checksum, metadata tanpa file, migration kosong, dan file migration tambahan.
- AC-3: preflight gagal pada aplikasi nyata dengan listener tetap hidup, mode production, worker tak dikenal, dan TOOL-001 fixture.
- AC-4: HTTP nyata di bawah `serve`, URL yang diumumkan, dan test TOOL-006.
- AC-5: TOOL-003 dan worker tak dikenal; belum ada worker nyata.
- AC-6: listener asing pada 8889, `owner.json`, dan TOOL-002 serta TOOL-005.
- AC-7: invocation kedua pada aplikasi nyata dan TOOL-005.
- AC-8: SIGTERM dengan exit 143, Ctrl+C manual, jalur gagal kontrol mutasi, dan TOOL-004.
- AC-9: fixture `test:tooling`, smoke PostgreSQL 18 dengan READY-009 di bawah `serve`, screenshot, dan pemindaian artefak.

## Pemeriksaan ulang setelah perbaikan review · 2026-10-04

Kandidat: `HEAD b1ae733` ditambah perubahan lokal fitur 2 yang belum di-commit, termasuk perbaikan temuan [review 2026-10-04](../../reviews/2026-10-04-main-doctor-serve.md). Lingkungan: Bun 1.4.2, Node 24.21.0, macOS 27.0, Docker, Playwright 1.63.0 dengan Chromium, dan PostgreSQL 18 dari image `foundation-postgres:18-pinned`. Bagian ini menggantikan status skenario, konformansi, dan verdict 2026-10-03 di atas untuk seluruh fitur 2. Bagian lama tetap disimpan sebagai riwayat. Setiap hasil di bawah diamati pada sesi ini.

### Status skenario

| Skenario | Bukti yang diamati | Status |
| --- | --- | --- |
| `TOOL-001` | 4 test fixture. Smoke nyata: 12 pemeriksaan database lulus dengan role hasil provisioning; target salah, hak tulis metadata, keanggotaan role penulis, checksum, metadata tanpa file, migration kosong, role admin, schema yang tidak ada, `USAGE` dicabut dari `auth`, `CREATE` pada `users` dan `public`, `CREATEDB`, `CREATEROLE`, `UPDATE`, `DELETE`, dan `TRUNCATE` pada metadata, pemilik metadata, metadata tidak terbaca, direktori migration hilang, file yang belum diterapkan, dan database mati ditolak. Setiap pesan dari 25 run doctor di dalam smoke diperiksa bebas credential, DSN, error mentah, dan SQL. | Lulus |
| `TOOL-002` | 7 test fixture. Smoke nyata: listener asing pada 8889 ditolak tanpa sinyal. | Lulus |
| `TOOL-003` | 10 test fixture, termasuk target readiness dari konfigurasi dan `--worker` (`readyTargets`). Belum ada worker aplikasi nyata. | Lulus, fixture |
| `TOOL-004` | 4 test fixture, termasuk Ctrl+C dan termination saat preflight yang melepas lock dan mengembalikan catatan lama. Smoke nyata: SIGTERM (143) dan Ctrl+C (130) menghentikan kedua grup, membebaskan 8888 dan 8889, melepas lock, backend mencetak `Backend stopped`, dan tidak ada sesi `foundation_backend` yang tersisa di PostgreSQL. | Lulus |
| `TOOL-005` | 16 test fixture, termasuk guard sisa crash, guard yang sedang dipegang, dua proses yang memulihkan catatan lama yang sama, catatan dari checkout atau user lain, serta token, supervisor, dan direktori lock yang berubah selama pemulihan. Smoke nyata: catatan owner dan `serve` kedua. | Lulus |
| `TOOL-006` | 10 test fixture, termasuk pemilik port yang berubah sesudah probe dan sebelum pengumuman, proses lain yang mengambil port saat probe lewat `supervise`, dan batas 60 detik yang diteruskan `supervise`. | Lulus, fixture |
| `TOOL-007` | Smoke nyata: doctor, `serve` dengan frontend dan backend nyata yang hanya mendengarkan pada `127.0.0.1`, HTTP 200 untuk `/` dan `/api/status`, READY-009 melalui browser, SDK, proxy, backend, dan database, shutdown, preflight gagal tanpa mengganggu listener, serta pemindaian credential pada 36 output dan 7 file tanpa temuan. | Lulus |
| `TOOL-008` | 3 test fixture. | Lulus, fixture |

### Konformansi acceptance

- **AC-1: terpenuhi.** Seluruh aturan role pada AC-1 kini mempunyai kasus negatif pada PostgreSQL nyata, kecuali versi di bawah 18 (lihat batas bukti).
- **AC-2: terpenuhi.** Nama, checksum, metadata tanpa file, metadata tidak terbaca, direktori hilang, migration kosong, dan file yang belum diterapkan ditolak tanpa tulis database.
- **AC-3: terpenuhi.** Preflight gagal pada aplikasi nyata tidak mengganggu listener; mode production, konfigurasi rusak, dan worker tak dikenal gagal sebelum cleanup.
- **AC-4: terpenuhi.** Pemilik port diperiksa pada setiap probe dan tepat sebelum URL diumumkan; batas 60 detik terkunci test; frontend dan backend nyata hanya terikat pada `127.0.0.1`.
- **AC-5: terpenuhi melalui fixture.** Belum ada worker aplikasi nyata.
- **AC-6: terpenuhi.** Fixture dan listener asing nyata pada 8889.
- **AC-7: terpenuhi.** Satu pemulih pada satu waktu, guard sisa crash, dan perubahan identitas selama pemulihan kini terkunci test.
- **AC-8: terpenuhi.** Sinyal pada setiap fase melepas lock; penutupan pool backend terbukti lewat `Backend stopped` dan `pg_stat_activity`.
- **AC-9: terpenuhi pada macOS.** Fixture `test:tooling` serta smoke PostgreSQL 18 dengan READY-009 di bawah `serve`.

**Verdict pemeriksaan ulang: PASS untuk AC-1 sampai AC-9 spec 0003**, dengan batas bukti di bawah. Verdict FAIL 2026-10-03 tidak berlaku lagi karena alur browser fitur 10 kini berjalan di bawah `serve`.

### Hasil runner

- `bun run test:tooling`: 54 test, 209 assertion, 0 gagal, 0 dilewati. JUnit tersanitasi ada di [evidence 0005](../../testing/evidence/0005/tooling.xml).
- `bun run test:tooling:real`: empat run lulus dengan exit 0 dalam 24 sampai 25 detik, yang terakhir pada kode akhir. Satu run gagal karena lock lama yang ditinggalkan run kontrol; smoke kini memeriksa lock sebelum mulai dan menghapus catatan `serve` miliknya sendiri pada jalur gagal. Dua run kontrol yang memaksa SIGKILL pada `serve` saat shutdown gagal sesuai harapan; sesudah run kontrol kedua tidak ada listener, proses, container, maupun lock yang tersisa.
- `bun run typecheck:tooling`: exit 0 untuk `development.test.ts` dan `doctor-smoke.ts`.
- `bun run test:ci`: exit 0 pada dua run, yang terakhir pada kode akhir dalam 129 detik; 58 ID skenario, `api:check` identik pada dua run, 79 test frontend, 630 integration test dengan 2.734 assertion, 54 tooling test dengan 209 assertion, dan 12 E2E. Peringatan initial bundle 684,40 kB terhadap budget 500 kB sama seperti sebelumnya.

Rincian perubahan dan kontrol mutasi ada di [laporan 0005](../../testing/0005-doctor-serve-real-smoke.md).

### Batas bukti

- Bukti aplikasi nyata hanya dari macOS dengan Chromium; smoke nyata masih di luar `test:ci` sampai fitur 11.
- Syarat PostgreSQL minimal 18 tidak mempunyai kasus negatif karena butuh server versi lain.
- AC-5 tetap terbukti melalui fixture saja.

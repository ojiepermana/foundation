# 0003. Doctor dan serve pada aplikasi nyata

**Date**: 2026-10-01
**Status**: Accepted

## Summary

Anda dapat memeriksa prasyarat database nyata sebelum aplikasi development dijalankan. `serve` lalu menunggu respons HTTP frontend dan backend, menjaga proses dari invocation lain, dan membersihkan proses yang dibuatnya saat berhenti. Perubahan ini melengkapi tooling yang sudah ada tanpa membuat supervisor baru.

## Requirements

**User stories**: Sebagai pengembang, Anda dapat mengetahui alasan lingkungan belum siap tanpa membocorkan credential. Anda dapat menjalankan aplikasi nyata dan mendapat URL hanya setelah layanan menjawab. Anda dapat mengulang perintah tanpa menghentikan proses milik aplikasi atau checkout lain.

**Acceptance criteria**:

1. **AC-1**: `bun run doctor` memeriksa PostgreSQL nyata dengan role backend runtime dan nama database development yang dinyatakan di konfigurasi. PostgreSQL minimal 18, schema `common`, `users`, dan `auth` tersedia sesuai konfigurasi, role mempunyai `USAGE` yang dibutuhkan tetapi bukan superuser, pemilik metadata, atau anggota role yang dapat menulis metadata. Role tidak dapat membuat database, role, atau objek pada schema aplikasi dan `public`, dapat membaca `common.schema_migrations`, dan tidak mempunyai privilege `INSERT`, `UPDATE`, `DELETE`, atau `TRUNCATE` pada tabel itu. Pemeriksaan mempunyai batas waktu, tidak menulis database, tidak menjalankan migration atau seed, tidak menghentikan listener, dan tidak mencetak DSN, password, SQL mentah, atau error database mentah.
2. **AC-2**: Doctor membandingkan seluruh file SQL di `database/migrations/` dengan nama dan checksum SHA 256 pada `common.schema_migrations`. File yang belum diterapkan, metadata tanpa file, checksum berbeda, metadata tidak dapat dibaca, direktori migration yang belum siap, atau daftar file SQL kosong menghasilkan status gagal. `serve` tidak menjalankan migration secara otomatis.
3. **AC-3**: `serve` menjalankan preflight yang sama sebelum menyentuh listener. Jika preflight gagal, proses dan port yang sudah aktif tetap hidup. `NODE_ENV=production`, konfigurasi tidak valid, dan prasyarat yang hilang juga menghentikan startup dengan status gagal dan pesan aman.
4. **AC-4**: Setelah preflight lulus, `serve` menjalankan frontend pada `127.0.0.1:8889` dan backend pada `127.0.0.1:8888`. Status siap hanya diumumkan setelah GET `/` pada frontend memberi HTTP 200 berupa dokumen HTML dan GET `/api/status` pada backend memberi HTTP 200 dengan JSON `{ "status": "ok" }`. Listener yang menjawab setiap probe dan yang ada tepat sebelum URL diumumkan wajib terbukti milik grup proses baru dari invocation ini. Seluruh layanan wajib siap dalam 60 detik. Kegagalan respons, identitas listener, atau batas waktu menghentikan seluruh grup proses yang dibuat invocation ini dan mengembalikan status gagal. Pemeriksaan HTTP ini hanya berlangsung saat startup.
5. **AC-5**: Worker hanya berjalan jika terdaftar dan dipilih lewat `--worker`. Worker terpilih dengan port HTTP wajib mempunyai path readiness eksplisit di `config/development.json` dan menjawab HTTP 200 pada host serta port yang terdaftar. Worker tanpa port dianggap siap jika prosesnya tetap hidup selama pemeriksaan startup. URL database backend tidak diwariskan otomatis ke worker, dan frontend tidak menerima secret backend atau worker.
6. **AC-6**: Setelah preflight, `serve` boleh mengganti listener Foundation lama hanya bila identitas proses, user, checkout, grup proses, dan kepemilikannya oleh invocation lama dapat dibuktikan hingga tepat sebelum setiap sinyal. Listener dari checkout lain, aplikasi lain, user lain, atau identitas yang tidak pasti membuat startup gagal tanpa sinyal ke proses itu. Port lain, PostgreSQL, dan proses yang tidak terkait tetap hidup. Pergantian identitas atau pemakai port selama cleanup membuat startup gagal.
7. **AC-7**: Dua invocation `serve` dari checkout yang sama tidak menjalankan cleanup dan startup bersamaan. Invocation kedua gagal dengan pesan jelas dan membiarkan yang pertama hidup. Catatan invocation lama yang sudah tidak aktif dapat dipulihkan dengan satu pemulih pada satu waktu untuk mengganti proses Foundation lama; catatan yang belum lengkap ditunggu paling lama 5 detik sebelum gagal aman. Identitas PID atau grup proses yang berubah tidak boleh dianggap proses lama.
8. **AC-8**: Ctrl+C, termination, kegagalan startup, atau keluarnya satu layanan menghentikan semua grup proses milik invocation tersebut, termasuk turunan watcher. Exit code menunjukkan kegagalan jika layanan gagal. Catatan kepemilikan proses dilepas setelah shutdown; resource backend, termasuk pool database ketika tersedia, ditutup oleh lifecycle backend. Proses lain tidak dihentikan.
9. **AC-9**: Test fixture pada port sementara membuktikan prasyarat gagal, cleanup aman, pergantian listener, race dua invocation, timeout readiness, worker terpilih, dan shutdown. Bukti aplikasi nyata memakai PostgreSQL 18 yang telah diprovision melalui fitur 5 dan 6, frontend serta backend yang dijalankan oleh `serve`, request HTTP nyata, dan alur browser fitur 10. Hasil yang belum dapat dijalankan dicatat sebagai belum terbukti, bukan lulus.
   - *Amandemen 2026-10-06 (spec [0014](../0014-akses-pengguna-lifecycle-sesi/index.md), tabel Amandemen spec lain)*: `test:tooling:real` membuat dua akun uji sesudah migration lewat `database/accounts.ts create`, dengan email dan password acak turunan seed run yang masuk daftar pindai, lalu menjalankan `tests/e2e/auth/auth.real.e2e.spec.ts` di bawah `serve` bersama spec browser lain dengan *Sidik token uji* spec 0014. `serve` menghapus `FOUNDATION_ACCOUNT_PASSWORD` dari environment anak, sama seperti variable provisioning. Teks lama di atas tidak berubah.

## Decision

**Chosen option**: Selesaikan tooling yang ada dengan preflight database nyata, pemeriksaan HTTP saat startup, serta catatan kepemilikan invocation dan proses.

Perubahan berada di `scripts/doctor.ts`, `scripts/serve.ts`, dan `scripts/lib/`. Satu lock invocation per checkout melindungi startup. Catatan proses menyimpan identitas yang dapat diverifikasi sebelum proses lama diberi sinyal dan sebelum layanan baru dinyatakan siap. `serve` menolak listener yang tidak dapat dibuktikan sebagai milik checkout ini. Pilihan kedua adalah menolak semua port terpakai dan meminta penghentian manual; itu lebih sederhana, tetapi menghilangkan pergantian proses Foundation lama yang Anda pilih.

## Feature design

**Data model sketch**: Tidak ada entitas persisten baru dan tidak ada migration milik fitur ini. Doctor hanya membaca `common.schema_migrations` dengan role backend. Schema `common`, `users`, `auth`, role, grants, dan runner migration disiapkan oleh fitur 5 dan 6 sebelum pembuktian aplikasi nyata.

**State transitions**:

`idle` → `lock acquired` → `preflight passed` → `old listeners checked and cleared` → `services starting` → `ready` → `stopping` → `idle`.

Setiap kegagalan sebelum `services starting` melepaskan catatan invocation tanpa menghentikan proses lain. Setiap kegagalan setelah proses dimulai menghentikan grup proses yang dibuat invocation ini sebelum melepaskan catatan. Invocation kedua tidak mengubah state invocation aktif. Catatan lama tanpa pemilik aktif ditinjau lagi sebelum dipulihkan.

**Interface surface**:

| Perintah atau input | Masukan | Hasil | Kesalahan penting |
| --- | --- | --- | --- |
| `bun run doctor` | `config/development.json`, `DATABASE_URL`, file migration, pilihan worker | Daftar pemeriksaan dengan status `ok`, `warning`, atau `error`; exit 0 hanya jika tidak ada error | Database, metadata, role, file, atau konfigurasi tidak siap menghasilkan exit 1 dan pesan aman |
| `bun run serve` | Masukan doctor dan pilihan worker yang sama | Log startup, lalu URL frontend dan backend setelah readiness lulus; tetap hidup sampai shutdown | Preflight, lock, identitas listener, startup, atau readiness gagal menghasilkan exit bukan nol |
| `--worker <nama>` | Nama dari `workers` pada konfigurasi | Worker terpilih ikut preflight, startup, dan readiness | Nama tidak dikenal atau `readinessPath` worker HTTP hilang ditolak sebelum cleanup |
| `workers.<nama>.readinessPath` | Path absolut lokal diawali `/`, tanpa URL, query, atau fragment | GET ke `127.0.0.1:<port><path>` | Path tidak valid atau respons selain HTTP 200 gagal dalam batas startup |

**Value sourcing**:

| Aksi | Nilai yang dipakai atau ditampilkan | Sumber |
| --- | --- | --- |
| Doctor | Schema yang wajib ada | `config/development.json` bagian `database.schemas`, saat ini `common`, `users`, `auth` |
| Doctor | Nama database yang benar | `config/development.json` bagian `database.expectedName`, diset oleh fitur 5 sesuai target provisioning; pada Compose development saat ini bernama `foundation` |
| Doctor | Role dan privilege runtime | PostgreSQL `current_user`, `current_database()`, katalog role, membership, schema, owner metadata, privilege efektif pada tabel, serta percobaan SELECT metadata dengan `DATABASE_URL` runtime; role migrator dan owner berasal dari kontrak fitur 5 dan 6 |
| Doctor | Migration yang diharapkan | Nama dan byte file `database/migrations/*.sql`, checksum SHA 256 dihitung dari byte tersebut |
| Doctor | Migration terapan | `common.schema_migrations.name` dan `checksum`, dibaca tanpa hak tulis |
| Serve | Host, port, entry, dan pilihan worker | `config/development.json` dan argumen `--worker` |
| Serve | Respons backend yang diharapkan | Kontrak route development `/api/status` pada spec 0001 |
| Serve | Respons frontend yang diharapkan | GET `/` pada host dan port frontend di konfigurasi, HTTP 200 dan `Content-Type` HTML |
| Serve | Batas startup | 60 detik dari keputusan fitur ini, dihitung dengan monotonic clock sejak proses pertama dijalankan |
| Serve | Target worker HTTP | Port dan `readinessPath` pada entri worker terpilih |
| Serve | Identitas invocation aktif atau lama | Catatan lokal yang dibuat `serve`, UID, checkout kanonik, token acak, PID, waktu mulai proses dari OS, ID grup proses, serta port yang masih dipegang |
| Serve | Proses yang boleh dihentikan | Identitas proses dan grup yang cocok dengan catatan lama dari checkout ini serta hasil pemeriksaan OS tepat sebelum setiap sinyal |
| Serve | Listener yang boleh menjawab probe | PID dan grup proses baru milik invocation ini, dibandingkan dengan pemegang port pada setiap probe dan sebelum pengumuman URL |
| Serve | URL yang diumumkan | `host` dan port pada konfigurasi setelah seluruh readiness lulus |

**Key invariants**:

1. Lock invocation memakai pembuatan direktori atomik di `.local/` sebelum doctor. Setelah memilikinya, `serve` menulis catatan owner lewat file sementara dan rename atomik. Catatan memuat token acak, UID, path checkout kanonik, PID supervisor beserta waktu mulai OS, lalu PID, waktu mulai, dan ID grup setiap layanan setelah spawn. Catatan baru yang belum lengkap ditunggu paling lama 5 detik, bukan langsung diambil alih.
2. Pemulihan lock lama memakai guard pemulihan yang juga dibuat atomik, sehingga hanya satu pemulih dapat meninjau catatan lama. Pemulih memeriksa owner mati, identitas file lock yang sama, dan semua grup yang masih tercatat sebelum memindahkan catatan lama lalu mencoba lock baru. Jika guard atau identitas tidak pasti, gagal dengan instruksi penghentian manual. Guard yang tersisa dari crash tidak diambil alih otomatis.
3. Catatan di `.local/` mempunyai izin hanya untuk user lokal dan tidak memuat DSN, credential, atau environment proses. PID saja tidak cukup karena dapat dipakai ulang. Sebelum `SIGTERM` dan `SIGKILL`, periksa ulang UID, waktu mulai OS, grup proses, checkout, dan port. Jika identitas leader grup tidak dapat diverifikasi, jangan memberi sinyal dan minta penghentian manual.
4. Probe readiness memakai GET tanpa redirect, hanya ke `127.0.0.1` dan port terdaftar, dengan batas waktu per request yang lebih pendek dari batas 60 detik. Pemegang port harus berasal dari grup proses baru pada setiap probe dan tepat sebelum URL diumumkan. Backend harus mengembalikan bentuk JSON yang tepat. Frontend harus memberi HTTP 200 dan tipe dokumen HTML. HTTP probe tidak menggantikan verifikasi render browser atau kesiapan database setelah startup.
5. `serve` tidak menjalankan Compose, provisioning, migration, seed, atau cleanup port PostgreSQL. Satu kegagalan wajib tetap gagal walaupun pemeriksaan lain lulus. Direktori migration tanpa file SQL tidak dianggap siap.
6. Perubahan backend yang dibuat saat implementasi fitur ini mengikuti `api:sync`, `api:check`, build frontend, dan test kontrak. Jika backend tidak berubah, artefak OpenAPI dan SDK tidak perlu disentuh.

**Security model**: Perintah hanya untuk development lokal. Hanya proses user yang sama dari checkout yang sama dan terbukti milik invocation lama yang boleh dihentikan. Role backend hanya membaca metadata migration; runner terpisah memegang hak tulis dan DDL. Doctor tidak mencetak secret atau pesan PostgreSQL mentah. Respons readiness tidak boleh memuat DSN, SQL, stack, atau informasi sensitif. Tidak ada endpoint HTTP baru untuk tooling ini. Route `/api/status` tetap hanya pada komposisi development sesuai spec 0001.

**Configuration required**: `DATABASE_URL` backend memakai role runtime hasil fitur 5. `database.expectedName` menyebut database yang diprovision oleh fitur 5, saat ini `foundation` pada Compose development. `workers.<nama>.readinessPath` wajib bila worker mempunyai `port`. Tidak ada secret, schema, atau credential baru. Batas 60 detik dan aturan probe ditetapkan oleh tooling, bukan environment yang dapat melemahkan gate secara diam diam.

**Critical test scenarios**:

1. `TOOL-001`: doctor gagal aman pada prasyarat hilang, database salah, role terlalu tinggi atau mempunyai hak tulis metadata, migration kosong atau belum terapan, checksum berbeda, dan metadata tanpa file. Listener fixture tetap hidup. Membuktikan **AC-1**, **AC-2**, **AC-3**.
2. `TOOL-002`: proses fixture yang ditandai sebagai Foundation lama dapat diganti; proses asing, checkout lain, PID yang dipakai ulang, grup proses yang berubah, dan port lain tetap hidup. Membuktikan **AC-6**.
3. `TOOL-003`: worker dipilih eksplisit, path HTTP wajib dan divalidasi, worker tanpa port dinilai dari proses, secret tetap terpisah. Membuktikan **AC-5**.
4. `TOOL-004`: kegagalan layanan dan shutdown menutup grup serta turunan, lalu melepas catatan invocation. Membuktikan **AC-8**.
5. `TOOL-005`: dua invocation serentak hanya mengizinkan satu startup; invocation kedua tidak mengganggu yang pertama. Catatan lama dipulihkan oleh satu pemulih, sedangkan catatan belum lengkap dan identitas berubah gagal aman. Membuktikan **AC-6**, **AC-7**.
6. `TOOL-006`: frontend dan backend fixture baru diumumkan siap setelah respons yang tepat dari grup baru; listener asing yang merebut port, respons salah, proses keluar, serta batas 60 detik menghentikan grup baru saja. Membuktikan **AC-4**, **AC-8**.
7. `TOOL-007`: pada PostgreSQL 18 terisolasi yang telah diprovision, doctor lulus dengan role backend minimum; `serve` membuka frontend dan backend nyata, proxy serta browser mencapai alur fitur 10; kegagalan database tidak membocorkan credential. Membuktikan **AC-1** sampai **AC-4** dan **AC-9**.
8. `TOOL-008`: mode production, konfigurasi rusak, dan worker tidak dikenal gagal sebelum cleanup. Membuktikan **AC-3**, **AC-5**.

## Build plan

Urutan mengikuti Tracer Bullet pada scope. Jalur tipis pertama membuktikan preflight, startup, dan HTTP pada aplikasi nyata setelah fitur 5, 6, serta 10 menyediakan database dan alur browser. Perluasan berikutnya menguatkan batas proses dan kegagalan. Fitur ini tidak membuat migration.

1. Selaraskan doctor dengan role dan metadata hasil fitur 5 dan 6. Jalankan pemeriksaan PostgreSQL nyata, termasuk hasil negatif, tanpa mengubah database. Tambahkan satu bukti startup frontend dan backend dengan respons HTTP sesuai kontrak yang sudah ada. Memenuhi **AC-1**, **AC-2**, **AC-3**, **AC-4**.
2. Tambahkan lock invocation atomik, catatan identitas proses dan grup, guard pemulihan, cleanup yang hanya menerima Foundation lama dari checkout ini, dan penolakan checkout atau proses asing. Uji race dua invocation serta pemulihan catatan lama pada port fixture. Memenuhi **AC-3**, **AC-6**, **AC-7**.
3. Tambahkan readiness 60 detik, aturan worker HTTP, isolasi environment, dan shutdown grup yang lengkap. Uji respons salah, timeout, worker tanpa HTTP, exit layanan, Ctrl+C, serta termination. Memenuhi **AC-4**, **AC-5**, **AC-8**.
4. Dalam kelompok perubahan yang sama dengan cleanup, perbarui `docs/rules/development-commands.md` agar hanya proses Foundation lama dari checkout yang sama yang boleh dihentikan. Perbarui registry `tests/scenarios/development-tooling.json` dan dokumentasi operasi. Jalankan `test:tooling`, pemeriksaan tipe dan build yang relevan, lalu pembuktian aplikasi nyata dan browser setelah dependensi siap. Catat hasil yang belum tersedia secara jujur. Memenuhi **AC-1** sampai **AC-9**.

## Consequences

**Positive**: URL yang diumumkan sudah menjawab HTTP. Checkout dan proses lain terlindungi dari cleanup. Doctor memberi alasan aman ketika database atau migration belum siap.

**Negative**: Startup memerlukan waktu sampai 60 detik dan catatan kepemilikan proses menambah keadaan lokal yang perlu dipulihkan setelah crash. Listener Foundation lama yang tidak mempunyai bukti kepemilikan harus dihentikan manual.

**Neutral**: Readiness HTTP diperiksa saat startup saja. Kesiapan database sesudah startup dan render browser tetap diuji oleh alur fitur 10, bukan disimpulkan dari `/api/status`. Worker nyata baru dapat dibuktikan ketika entri worker tersedia.

## Follow-up

1. Fitur 5 dan 6 menetapkan role, grants, metadata, serta runner yang menjadi prasyarat pembuktian database nyata. Fitur 10 menyediakan alur browser yang memakai metadata `common`.
2. Pada implementasi, selaraskan aturan lama yang saat ini mengizinkan cleanup semua listener user lokal dengan keputusan baru yang hanya mengizinkan proses Foundation lama dari checkout yang sama.
3. Jika worker HTTP pertama ditambahkan, tetapkan `readinessPath` dan skenario nyata milik worker tersebut sebelum menyatakan worker siap.

## Rationale

Alasan dan pilihan yang dibandingkan ada di [rationale.md](rationale.md).

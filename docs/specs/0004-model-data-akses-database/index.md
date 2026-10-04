# 0004. Model data dan batas akses database

**Date**: 2026-10-01
**Status**: Accepted

## Summary

Foundation menyiapkan tiga schema dan satu tabel riwayat migration sebelum alur aplikasi memakai database. Role owner, migrator, dan backend dipisah agar aplikasi dapat membaca riwayat tanpa mengubah struktur. Provisioning berjalan sebagai perintah tersendiri dan berhenti bila bentuk objek yang sudah ada tidak sesuai.

## Requirements

**User stories**: Sebagai pengembang, Anda dapat menyiapkan batas akses database dengan satu perintah yang aman diulang. Sebagai pemilik operasi, Anda dapat membuktikan bahwa backend membaca metadata dengan role minimum dan tidak dapat mengambil hak migrator.

**Acceptance criteria**:

1. **AC-1**: `bun run db:provision --apply` hanya menerima `FOUNDATION_ADMIN_DATABASE_URL` dari environment lokal yang disiapkan terpisah dari `.env.infrastructure`, memeriksa `session_user` dan `current_user` sama sama `foundation_admin`, `current_database() = foundation`, dan PostgreSQL minimal 18 sebelum mutasi. Perintah tidak berjalan otomatis dari Compose, `doctor`, `serve`, backend, atau runner migration. Tanpa `--apply`, URL admin, atau password untuk role yang perlu dibuat, serta pada koneksi gagal atau target salah, perintah keluar bukan nol tanpa perubahan dan tanpa mencetak DSN, password, SQL mentah, atau error database mentah.
2. **AC-2**: Pada database kosong yang benar, provisioning membuat `common`, `users`, dan `auth`, serta `common.schema_migrations`. Tabel biasa ini memiliki tepat tiga kolom: `name text PRIMARY KEY` berupa nama file lengkap, `checksum text NOT NULL` dengan CHECK tepat 64 karakter heksadesimal huruf kecil, dan `applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()`. Tabel awal kosong, tanpa kolom atau constraint tambahan, index selain primary key, trigger, inheritance, atau partition. Belum ada tabel pengguna atau sesi maupun relasi lintas schema.
3. **AC-3**: Semua objek baru dimiliki `foundation_owner` tanpa login. `foundation_migrator` memiliki login terpisah dan hanya keanggotaan `foundation_owner` dengan `SET TRUE`, `INHERIT FALSE`, dan `ADMIN FALSE`, sehingga DDL serta penulisan metadata dilakukan setelah `SET ROLE`. `foundation_backend` mempunyai login terpisah, `CONNECT` ke database, `USAGE` pada tiga schema, dan `SELECT` pada metadata tanpa grant option, tetapi tidak memiliki DDL persisten maupun sementara, hak tulis metadata, kepemilikan objek, privilege melalui `PUBLIC` atau keanggotaan transitif, maupun kemampuan mengambil hak owner atau migrator. Ketiga role bukan superuser dan tidak dapat membuat role, database, replika, atau melewati RLS. Role worker belum dibuat sampai worker nyata membutuhkan akses.
4. **AC-4**: Seluruh privilege database `CONNECT`, `CREATE`, dan `TEMPORARY` melalui `PUBLIC` dicabut; `foundation_backend` dan `foundation_migrator` hanya mendapat `CONNECT`. Seluruh privilege schema `public` melalui `PUBLIC` dicabut. Search path runtime backend dan migrator disetel pada level role di database `foundation` menjadi hanya `pg_catalog`; SQL objek aplikasi selalu memakai nama schema. Tidak ada default grant tabel `users` atau `auth` kepada backend maupun worker. Fitur pemilik objek berikutnya memberi grant spesifik melalui migration dan testnya.
5. **AC-5**: Provisioning aman diulang dan dua invocation bersamaan diserialkan dalam satu transaksi serta koneksi memakai `pg_advisory_xact_lock(638727, 5)` dengan batas tunggu lima detik. Pemeriksaan katalog, DDL, dan grant memakai transaksi itu; kegagalan atau interupsi membatalkan seluruh perubahan. Password role yang sudah ada tidak diubah dan tidak dapat diverifikasi lewat katalog; test membuktikannya dengan koneksi lama. Hanya grant langsung yang dinyatakan pada matriks perbaikan boleh diperbaiki. Bentuk atau owner objek, atribut role, membership, default ACL, grant option, dan privilege efektif dari jalur lain yang menyimpang membuat proses gagal aman tanpa menghapus atau mengambil alih objek tersebut.
6. **AC-6**: Factory `Bun.SQL` bersama berada di `libs/server/database/`, tanpa mengimpor konfigurasi aplikasi. URL yang disediakan divalidasi saat pool dibuat tanpa dicetak; `max` berupa bilangan bulat 1 sampai 5 dengan default 5 dan koneksi mempunyai batas tiga detik. Backend membuat paling banyak satu pool per proses saat `DATABASE_URL` ada, membuka koneksi saat query pertama, dan menutup pool secara idempotent dalam batas shutdown lima detik saat `SIGINT`, `SIGTERM`, atau startup gagal setelah pool dibuat. Query baru saat penutupan ditolak terkontrol. Backend yang dijalankan langsung tanpa URL masih melayani route dasar; route database fitur 10 nanti memberi respons 503 terkontrol. `bun run serve` tetap menolak URL atau database yang belum siap melalui `doctor`.
7. **AC-7**: Test PostgreSQL 18 nyata membuktikan `SELECT common.schema_migrations` berhasil, sedangkan mutasi metadata, DDL schema, `CREATE TEMP TABLE`, `SET ROLE` ke owner, serta lookup `schema_migrations` tanpa nama schema ditolak untuk backend. Test membuktikan target salah, drift struktural dan privilege, pengulangan, persaingan invocation, penutupan pool, dan absennya credential pada log, artefak, serta bundle frontend.
   - *Amandemen 2026-10-04 (spec [0010](../0010-pengujian-skenario-gate-ci/index.md), AC-4)*: `tests/integration/database/provision.test.ts` mendaftarkan folder sementara lalu container `foundation-db-test-<8 hex>` pada modul `tests/orchestration/signal-cleanup.ts` sebelum `docker run`, sehingga SIGINT atau SIGTERM ke `bun test` menjalankan `docker rm -f` atas container itu dan menghapus folder yang memuat env file nya, lalu keluar 130 atau 143. Sebelumnya `bun test` berhenti tanpa `afterAll` dan meninggalkan container berisi password acak. Perubahan ini juga menutup tindak lanjut keputusan 53 spec 0006 tentang container suite ini. ID, judul, dan assertion test lama tidak berubah.

## Decision

**Chosen option**: Provisioning administrator terpisah membuat batas schema, metadata, dan role; migrator memakai `SET ROLE` ke owner; backend memakai pool `Bun.SQL` sendiri dengan privilege baca minimum. Role dan grant untuk objek bisnis berikutnya ditetapkan per fitur.

**Implementation skills**: `elysiajs` (`.agents/skills/elysiajs/SKILL.md`) untuk lifecycle backend. Aturan SQL, schema, dan privilege proyek tetap berasal dari `docs/rules/database.md` serta `docs/rules/security.md`.

## Feature design

**Data model sketch**:

| Objek | Kolom atau isi | Owner | Relasi |
| --- | --- | --- | --- |
| `common.schema_migrations` | `name text PRIMARY KEY`, `checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$')`, `applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()` | `foundation_owner` | Tidak ada FK |
| `users` | Schema kosong sampai fitur pengguna | `foundation_owner` | Tidak ada |
| `auth` | Schema kosong sampai fitur autentikasi | `foundation_owner` | Tidak ada |

Tabel metadata harus berupa relation biasa `relkind = r` dengan tiga kolom dalam urutan di atas. Constraint bernama `schema_migrations_pkey`, `schema_migrations_checksum_hex`, dan tiga constraint `NOT NULL` yang dibuat PostgreSQL 18 untuk kolom wajib. Hanya index yang menopang primary key yang boleh ada. Baris yang sudah ditulis runner boleh tetap ada pada rerun. Provisioning membandingkan tipe, nullability, default, constraint, index, owner, dan jenis relation dari katalog sebelum menerima tabel lama.

**Matriks role dan privilege**:

| Role | Atribut dan membership | Database `foundation` | Schema | Metadata |
| --- | --- | --- | --- | --- |
| `foundation_owner` | `NOLOGIN NOINHERIT`; `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`; tanpa membership | Tidak perlu login | Owner `common`, `users`, `auth` | Owner tabel |
| `foundation_migrator` | `LOGIN NOINHERIT`; atribut tinggi semua false; anggota owner hanya `SET TRUE, INHERIT FALSE, ADMIN FALSE` | `CONNECT` saja | Mengakses sebagai owner sesudah `SET ROLE` | Menulis sebagai owner sesudah `SET ROLE` |
| `foundation_backend` | `LOGIN NOINHERIT`; atribut tinggi semua false; tidak menjadi anggota role lain, termasuk secara transitif | `CONNECT` saja, tanpa `CREATE` atau `TEMPORARY` | `USAGE` saja pada `common`, `users`, `auth`; tidak mendapat privilege `public` | `SELECT` saja tanpa grant option |
| `PUBLIC` | Semua role | Tanpa `CONNECT`, `CREATE`, `TEMPORARY` | Tanpa privilege pada `public`, `common`, `users`, `auth` | Tanpa privilege |

Grant langsung yang hilang pada backend atau migrator boleh ditambahkan. Grant langsung berlebih pada backend, `PUBLIC`, atau schema yang tercantum boleh dicabut. Jika privilege efektif tetap berlebih karena grant option, membership, role lain, atau default ACL, provisioning gagal; ia tidak mencabut hak milik role lain. Atribut role, keanggotaan owner, owner objek, dan bentuk tabel yang menyimpang juga gagal, bukan diperbaiki. Pemeriksaan akhir memakai privilege efektif, bukan hanya daftar GRANT langsung.

**State transitions**: Belum diprovision → provision selesai → rerun memverifikasi bentuk dan memperbaiki grant yang diketahui. Drift struktural → gagal tanpa perbaikan otomatis. Migration fitur 6 menambah baris riwayat melalui migrator setelah file berhasil diterapkan.

**Interface surface**:

| Perintah atau fungsi | Masukan | Hasil | Kesalahan utama |
| --- | --- | --- | --- |
| `bun run db:provision --apply` | `FOUNDATION_ADMIN_DATABASE_URL`, password migrator dan backend hanya jika role baru | Nama objek dengan status `created`, `verified`, atau `repaired`, tanpa secret | Exit 1 untuk flag, credential, target, versi, drift, lock, atau koneksi yang gagal; pesan aman |
| `createDatabasePool(url, options)` | URL dari aplikasi pemanggil, `max` opsional 1 sampai 5 | Satu client `Bun.SQL` dengan default `max: 5` yang dapat dipakai ulang dan ditutup | URL tidak valid saat pembuatan, koneksi gagal saat query tanpa membocorkan URL |
| Backend `index.ts` | `DATABASE_URL` opsional untuk start langsung | Pool dibuat sekali bila URL ada, ditutup saat shutdown | URL tidak ada membuat route database nanti 503, tanpa mematikan route dasar |

**Value sourcing**:

| Aksi | Nilai yang dipakai atau dihasilkan | Sumber |
| --- | --- | --- |
| Provisioning | Nama target dan minimum versi | `foundation` dan PostgreSQL 18 dari scope serta spec 0002 |
| Provisioning | Koneksi admin dan password role baru | Tiga variable environment lokal pada interface di atas |
| Provisioning | Identitas admin aktual | `session_user` dan `current_user` dari koneksi, dibandingkan dengan `foundation_admin` |
| Provisioning | Nama schema, role, tabel, kolom, dan grant | Kontrak tetap dalam spec ini, bukan argumen bebas |
| Provisioning | Urutan dua invocation dan batas tunggu | Advisory key tetap `(638727, 5)` dan `lock_timeout = '5s'` pada transaksi yang sama |
| Provisioning | Status `created`, `verified`, `repaired` | Hasil perbandingan katalog sebelum dan setelah mutasi yang diizinkan |
| Metadata | `name` dan `checksum` baris baru | Runner fitur 6 dari nama dan byte file SQL |
| Metadata | `applied_at` | `transaction_timestamp()` pada transaksi migration |
| Backend | URL runtime dan batas pool | `DATABASE_URL`, default 5 dan maksimum 5 dari keputusan fitur ini |
| Backend | Batas koneksi dan shutdown | Tiga detik untuk koneksi; lima detik untuk lifecycle dari `apps/backend/src/index.ts` |
| Doctor | Database dan privilege yang diharapkan | `config/development.json` serta katalog PostgreSQL sesuai spec 0003 |

**Key invariants**:

1. Provisioning hanya menerima argumen `--apply`. URL admin diisi operator dari koneksi Compose yang terpisah dan tidak dimuat otomatis dari `.env.infrastructure`. Script memvalidasi protokol PostgreSQL, identitas login aktual, database, versi, serta password role baru minimal 16 karakter. Jika role sudah ada, password input opsional dan hash yang tersimpan tidak dibaca atau dibandingkan.
2. Dalam satu transaksi dan koneksi, provisioning menetapkan `lock_timeout = '5s'`, mengambil `pg_advisory_xact_lock(638727, 5)`, memeriksa katalog, lalu menjalankan DDL dan grant. Kunci pertama adalah namespace tetap Foundation; kunci kedua adalah nomor fitur 5. Timeout, sinyal, atau error membatalkan transaksi. Pemeriksaan identitas sebelum transaksi tidak memberi izin mutasi sebelum identitas ditinjau ulang di dalamnya.
3. Pada rerun, hanya perubahan pada matriks grant yang ditetapkan di atas boleh dilakukan. Output hanya menyebut nama objek dan `created`, `verified`, atau `repaired`; kegagalan selalu exit 1 dengan pesan kategori aman. Tidak ada introspeksi password lama.
4. Role owner tidak login. Migrator `NOINHERIT` dan hanya dapat menjadi owner lewat `SET ROLE`; backend tidak dapat menjadi keduanya. Password yang sudah ada tidak disentuh saat rerun. Rotasi merupakan operasi terpisah.
5. `PUBLIC` tidak mendapat privilege database atau schema aplikasi. Backend hanya membaca metadata; grant untuk tabel berikutnya tidak diwariskan otomatis. Lookup tanpa schema pada objek aplikasi tidak menemukan tabel karena search path hanya `pg_catalog`; fungsi dan objek `pg_catalog` tetap dapat dipakai.
6. Factory pool tidak membuat query atau resource saat modul diimpor. URL PostgreSQL divalidasi saat factory dipanggil tanpa dicetak; pool memakai maksimum lima koneksi dan batas koneksi tiga detik. Satu proses memiliki poolnya sendiri; komposisi route tidak membuka koneksi. Backend menghentikan penerimaan request sebelum menutup pool, sehingga query baru saat shutdown tidak diteruskan. Penutupan bersifat idempotent dan berbagi batas lifecycle lima detik dengan `app.stop(true)`.

**Security model**: `foundation_admin` dari spec 0002 hanya untuk provisioning. Migrator menulis schema dan metadata dengan hak owner yang dipilih secara eksplisit. Backend dan browser tidak menerima credential admin atau migrator. Semua nilai SQL dinamis memakai parameter; nama objek tetap dan tidak berasal dari input pengguna. Error kepada operator dan klien disaring dari DSN, password, SQL mentah, serta stack.

**Configuration required**:

| Variable | Pemakai | Tujuan |
| --- | --- | --- |
| `FOUNDATION_ADMIN_DATABASE_URL` | `db:provision` saja | Koneksi `foundation_admin` ke database `foundation` |
| `FOUNDATION_MIGRATOR_PASSWORD` | `db:provision` saat role baru | Password login migrator, tidak diubah pada rerun |
| `FOUNDATION_BACKEND_PASSWORD` | `db:provision` saat role baru | Password login backend, tidak diubah pada rerun |
| `DATABASE_URL` | Backend dan `doctor` | Koneksi role `foundation_backend`; tidak diwariskan ke frontend atau worker |

**Critical test scenarios**:

1. `DATA-001`: provisioning PostgreSQL 18 bersih membuat schema, metadata, role, owner, serta grant tepat; rerun mempertahankan password dan keadaan. Membuktikan **AC-1** sampai **AC-5**.
2. `DATA-002`: target atau login salah, versi tidak sesuai, drift owner, kolom, constraint, membership, atau default ACL, password role baru kosong, dan mode tanpa `--apply` gagal tanpa mutasi dan tanpa kebocoran secret. Membuktikan **AC-1**, **AC-2**, **AC-5**.
3. `DATA-003`: backend dapat membaca `common.schema_migrations`, tetapi `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `CREATE` schema, `CREATE TEMP TABLE`, `SET ROLE foundation_owner`, dan `SELECT * FROM schema_migrations` ditolak; migrator dapat `SET ROLE` dan menulis metadata. Periksa privilege efektif dari `PUBLIC`, grant langsung, serta membership. Membuktikan **AC-3**, **AC-4**, **AC-7**.
4. `DATA-004`: dua provisioning serentak pada PostgreSQL terisolasi memakai kunci yang sama; satu membuat objek dan yang lain memverifikasi keadaan akhir, tanpa role atau grant ganda. Lock lebih dari lima detik gagal aman dan perubahan parsial tidak menetap. Membuktikan **AC-5**.
5. `DATA-005`: backend dengan dan tanpa URL menjaga route dasar, satu pool dipakai ulang, URL invalid ditolak aman, koneksi ditutup pada SIGINT atau SIGTERM, dan URL tidak masuk output, JUnit, atau bundle frontend. Membuktikan **AC-6**, **AC-7**.

## Build plan

Urutan Tracer Bullet dimulai dengan database terisolasi, satu provisioning lengkap, dan query runtime yang dibolehkan. Lalu perluas ke drift, persaingan, dan lifecycle backend. Feature 6 tetap menjalankan migration secara terpisah.

1. Buat `database/provision.ts` dan kontrak konfigurasi untuk target tetap, flag `--apply`, transaksi, advisory lock, role, schema, tabel metadata, dan grant. Buktikan `DATA-001` pada PostgreSQL 18 terisolasi. Memenuhi **AC-1** sampai **AC-5**.
2. Buat factory pool di `libs/server/database/` dan hubungkan lifecycle backend tanpa membuat ekspor OpenAPI memerlukan database. Jalankan `api:sync`, `api:check`, build frontend, dan test backend. Buktikan `DATA-005`. Memenuhi **AC-6**, **AC-7**.
3. Tambah test negatif privilege, drift, target salah, rerun, dan dua invocation, lalu perbarui registry serta petunjuk credential lokal. Buktikan `DATA-002` sampai `DATA-004` dan jalankan gate yang relevan. Memenuhi **AC-1** sampai **AC-7**.

## Consequences

**Positive**: Backend dapat membaca metadata dengan role minimum; migration dan aplikasi tidak berbagi credential; perubahan privilege terlihat sebagai kontrak yang bisa diuji.

**Negative**: Provisioning menambah perintah dan dua credential lokal. Drift struktural memerlukan pemeriksaan operator, bukan diperbaiki diam diam.

**Neutral**: `users` dan `auth` masih kosong. Runner fitur 6 memverifikasi bentuk metadata lalu mengisi riwayat migration. Alur database fitur 10 memakai pool ini dan tetap memerlukan keputusan endpoint serta responsnya sendiri.

## Follow-up

1. Fitur 6 harus memvalidasi tabel metadata dan memakai role migrator untuk setiap migration serta seed yang dipilih.
2. Fitur 10 harus memakai pool backend yang sama dan mengembalikan 503 terkontrol ketika URL atau database tidak tersedia.
3. Rotasi credential dan target deployment selain database development `foundation` memerlukan perintah atau spec tersendiri.

## Rationale

Alasan dan pilihan yang dibandingkan ada di [rationale.md](rationale.md).

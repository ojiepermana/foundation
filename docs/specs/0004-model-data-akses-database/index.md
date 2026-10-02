# 0004. Model data dan batas akses database

**Date**: 2026-10-01
**Status**: Proposed

## Summary

Foundation menyiapkan tiga schema dan satu tabel riwayat migration sebelum alur aplikasi memakai database. Role owner, migrator, dan backend dipisah agar aplikasi dapat membaca riwayat tanpa mengubah struktur. Provisioning berjalan sebagai perintah tersendiri dan berhenti bila bentuk objek yang sudah ada tidak sesuai.

## Requirements

**User stories**: Sebagai pengembang, Anda dapat menyiapkan batas akses database dengan satu perintah yang aman diulang. Sebagai pemilik operasi, Anda dapat membuktikan bahwa backend membaca metadata dengan role minimum dan tidak dapat mengambil hak migrator.

**Acceptance criteria**:

1. **AC-1**: `bun run db:provision --apply` memakai koneksi administrator yang diberikan melalui environment lokal, menolak target selain database `foundation` atau PostgreSQL di bawah versi 18, dan tidak berjalan otomatis dari Compose, `doctor`, `serve`, backend, atau runner migration. Tanpa `--apply`, target atau credential yang hilang, dan kegagalan koneksi menghasilkan exit bukan nol tanpa perubahan serta tanpa mencetak DSN atau password.
2. **AC-2**: Pada database kosong yang benar, provisioning membuat `common`, `users`, dan `auth`, serta `common.schema_migrations`. Tabel memiliki `name text` sebagai primary key berupa nama file lengkap, `checksum text NOT NULL` dengan CHECK tepat 64 karakter heksadesimal huruf kecil, dan `applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()`. Belum ada tabel pengguna atau sesi maupun relasi lintas schema.
3. **AC-3**: Objek tersebut dimiliki `foundation_owner` tanpa login. `foundation_migrator` memiliki login terpisah dan dapat `SET ROLE foundation_owner` untuk DDL serta penulisan metadata. `foundation_backend` mempunyai login terpisah, `CONNECT` ke database, `USAGE` pada tiga schema, dan `SELECT` pada metadata, tetapi tidak memiliki DDL, hak tulis metadata, kepemilikan objek, atau keanggotaan yang memungkinkan mengambil hak owner atau migrator. Role worker belum dibuat sampai worker nyata membutuhkan akses.
4. **AC-4**: Akses `CONNECT` melalui `PUBLIC` dan `CREATE` pada schema `public` dicabut. Search path runtime backend dan migrator hanya `pg_catalog`; seluruh SQL aplikasi memakai nama schema. Tidak ada default grant tabel `users` atau `auth` kepada backend maupun worker. Fitur pemilik objek berikutnya memberi grant spesifik melalui migration dan testnya.
5. **AC-5**: Provisioning aman diulang dan dua invocation bersamaan diserialkan oleh advisory lock database dalam transaksi. Password role yang sudah ada tidak diubah pada pengulangan. Grant yang diketahui dapat diperbaiki, termasuk pencabutan hak berlebih pada metadata, sedangkan bentuk atau owner schema, tabel, role, dan membership yang menyimpang membuat proses gagal aman tanpa menghapus atau mengambil alih objek tersebut.
6. **AC-6**: Factory `Bun.SQL` bersama berada di `libs/server/database/`, tanpa mengimpor konfigurasi aplikasi. Backend membuat paling banyak satu pool per proses dengan maksimum lima koneksi saat `DATABASE_URL` ada, membuka koneksi saat query pertama, dan menutup pool saat shutdown. Backend yang dijalankan langsung tanpa URL masih melayani route dasar; route database fitur 10 nanti memberi respons 503 terkontrol. `bun run serve` tetap menolak URL atau database yang belum siap melalui `doctor`.
7. **AC-7**: Test PostgreSQL 18 nyata membuktikan akses yang diizinkan dan penolakan `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `CREATE`, perubahan role, serta query tanpa nama schema. Test juga membuktikan target salah, drift, pengulangan, persaingan invocation, dan penutupan pool. Tidak ada credential pada log, artefak, atau bundle frontend.

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

**State transitions**: Belum diprovision → provision selesai → rerun memverifikasi bentuk dan memperbaiki grant yang diketahui. Drift struktural → gagal tanpa perbaikan otomatis. Migration fitur 6 menambah baris riwayat melalui migrator setelah file berhasil diterapkan.

**Interface surface**:

| Perintah atau fungsi | Masukan | Hasil | Kesalahan utama |
| --- | --- | --- | --- |
| `bun run db:provision --apply` | `FOUNDATION_ADMIN_DATABASE_URL`, `FOUNDATION_MIGRATOR_PASSWORD`, `FOUNDATION_BACKEND_PASSWORD` | Ringkasan objek yang dibuat atau diverifikasi, tanpa secret | Target atau versi salah, drift, koneksi gagal, lock gagal |
| `createDatabasePool(url, options)` | URL dari aplikasi pemanggil, `max` dengan batas awal 5 | Satu client `Bun.SQL` yang dapat dipakai ulang dan ditutup | URL tidak valid atau koneksi gagal saat query |
| Backend `index.ts` | `DATABASE_URL` opsional untuk start langsung | Pool dibuat sekali bila URL ada, ditutup saat shutdown | URL tidak ada membuat route database nanti 503, tanpa mematikan route dasar |

**Value sourcing**:

| Aksi | Nilai yang dipakai atau dihasilkan | Sumber |
| --- | --- | --- |
| Provisioning | Nama target dan minimum versi | `foundation` dan PostgreSQL 18 dari scope serta spec 0002 |
| Provisioning | Koneksi admin dan password role baru | Tiga variable environment lokal pada interface di atas |
| Provisioning | Nama schema, role, tabel, kolom, dan grant | Kontrak tetap dalam spec ini, bukan argumen bebas |
| Metadata | `name` dan `checksum` baris baru | Runner fitur 6 dari nama dan byte file SQL |
| Metadata | `applied_at` | `transaction_timestamp()` pada transaksi migration |
| Backend | URL runtime dan batas pool | `DATABASE_URL`, maksimum 5 dari keputusan fitur ini |
| Doctor | Database dan privilege yang diharapkan | `config/development.json` serta katalog PostgreSQL sesuai spec 0003 |

**Key invariants**:

1. Provisioning memeriksa database dan versi sebelum mutasi, mengambil advisory lock, lalu memeriksa bentuk objek sebelum melakukan perubahan dalam satu transaksi. Gagal memeriksa identitas berarti tidak menebak atau mengambil alih objek.
2. Role owner tidak login. Migrator `NOINHERIT` dan hanya dapat menjadi owner lewat `SET ROLE`; backend tidak dapat menjadi keduanya. Password yang sudah ada tidak disentuh saat rerun. Rotasi merupakan operasi terpisah.
3. `PUBLIC` tidak mendapat koneksi database atau hak membuat objek di `public`. Backend hanya membaca metadata; grant untuk tabel berikutnya tidak diwariskan otomatis.
4. Factory pool tidak membuat query atau resource saat modul diimpor. Satu proses memiliki poolnya sendiri; komposisi route tidak membuka koneksi. Penutupan pool mempunyai batas waktu agar shutdown tetap tertib.

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
2. `DATA-002`: target salah, versi tidak sesuai, drift owner atau kolom, password kosong, dan mode tanpa `--apply` gagal tanpa mutasi dan tanpa kebocoran secret. Membuktikan **AC-1**, **AC-2**, **AC-5**.
3. `DATA-003`: role backend dapat `SELECT` metadata, tetapi ditolak pada mutasi, DDL, pengambilalihan owner, serta tabel domain tanpa grant; migrator dapat `SET ROLE` dan menulis metadata. Membuktikan **AC-3**, **AC-4**, **AC-7**.
4. `DATA-004`: dua provisioning serentak menghasilkan keadaan akhir tunggal; tidak ada role atau grant ganda. Membuktikan **AC-5**.
5. `DATA-005`: backend dengan dan tanpa URL menjaga route dasar, satu pool dipakai ulang, koneksi ditutup saat shutdown, dan URL tidak masuk bundle frontend. Membuktikan **AC-6**, **AC-7**.

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

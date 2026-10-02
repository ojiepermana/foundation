# 0005. Migration dan seed terpisah

**Date**: 2026-10-02
**Status**: Accepted

## Summary

Runner database menerapkan perubahan schema satu kali dan mencatat file yang sudah berhasil. Seed berjalan lewat perintah terpisah untuk mengisi data awal tanpa mengubah startup aplikasi. Setiap perubahan memakai role migrator dan transaksi, sehingga kegagalan tidak meninggalkan riwayat palsu.

## Requirements

**User stories**: Sebagai pengembang, Anda dapat menerapkan migration yang belum dijalankan dengan aman, lalu mengulang perintah tanpa mengubah hasil. Sebagai operator, Anda dapat melihat file yang tertahan karena checksum, urutan, atau hak akses tanpa melihat credential atau SQL mentah.

**Acceptance criteria**:

1. **AC-1**: `bun run db:migrate --apply` dan `bun run db:seed --apply` hanya memakai `FOUNDATION_MIGRATOR_DATABASE_URL` dari environment lokal. Sebelum mengganti role, keduanya memeriksa `session_user` dan `current_user` bernama `foundation_migrator`, database `foundation`, PostgreSQL minimal 18, serta membership owner sesuai spec 0004. Setelah memperoleh lock, runner memakai `SET LOCAL ROLE foundation_owner`, membuktikan `current_user` menjadi owner, lalu memeriksa metadata `common.schema_migrations` dan privilege efektif sebelum mutasi. Pergantian role berakhir bersama transaksi sehingga koneksi pool tidak mempertahankan role owner. Flag, URL, target, atau privilege salah menghasilkan exit bukan nol tanpa perubahan. Compose, backend, worker, `doctor`, dan `serve` tidak menjalankan kedua perintah otomatis.
2. **AC-2**: Migration berasal dari file reguler UTF 8 `database/migrations/` yang lokasinya diturunkan dari root repository berdasarkan lokasi modul runner, bukan direktori kerja pemanggil. Nama file `NNNN-domain-slug.sql` memakai nomor global empat digit berurutan mulai `0001`, tanpa duplikasi, gap, symlink pada direktori atau entri, file kosong, atau lebih dari satu statement SQL per file. File pertama `0001-common-metadata-comment.sql` memberi komentar tetap pada `common.schema_migrations` sebagai baseline. Direktori migration kosong gagal; direktori seed kosong sah dan dilaporkan sebagai nol seed.
3. **AC-3**: Runner menghitung checksum SHA 256 dari byte mentah setiap file migration dan membaca `name`, `checksum`, `applied_at` dari metadata. Nama yang sudah diterapkan harus merupakan prefix tepat dari daftar file lokal dan checksumnya harus cocok. File hilang, berubah, urutan tersisip, atau baris metadata asing membuat perintah gagal sebelum SQL baru dijalankan. Rerun dengan file yang sama melaporkan nol migration baru dan tidak mengubah riwayat.
4. **AC-4**: Seluruh migration yang belum diterapkan pada satu invocation berjalan dalam satu transaksi PostgreSQL berisolasi `READ COMMITTED`, memakai satu koneksi, `SET LOCAL ROLE foundation_owner`, dan advisory lock yang juga menahan provisioning fitur 5. Runner membaca dan memvalidasi ulang riwayat setelah kedua lock diperoleh, sehingga invocation kedua melihat commit invocation pertama sebelum menentukan file pending. SQL file serta penulisan riwayat atomik. Dua runner bersamaan tidak menerapkan file dua kali; timeout lock lima detik gagal aman. Statement pengendali transaksi dan SQL yang tidak dapat berjalan dalam transaksi ditolak, tanpa mode nontransaksi pada fitur ini. Kegagalan file ke berapa pun membatalkan seluruh batch yang belum terapan.
5. **AC-5**: `db:seed` memakai URL, role, target, validasi file, lock, dan transaksi yang sama tetapi tidak menulis `common.schema_migrations`. Sebelum seed, seluruh migration lokal harus sudah terapan dengan checksum cocok. Setiap file seed yang kelak ditambahkan dijalankan ulang pada setiap invocation dan harus idempotent menurut spec serta test fitur pemiliknya. Pada keadaan awal tanpa file seed, perintah sukses dengan nol perubahan setelah validasi prasyarat. Kegagalan satu seed membatalkan seluruh batch seed.
6. **AC-6**: Output hanya memuat nama file yang diterapkan atau dilewati dan jumlah akhir. Kegagalan menunjukkan kategori aman dan nama file bila relevan, tanpa DSN, password, isi SQL, error database mentah, stack, atau data bisnis. Credential migrator tidak masuk frontend, backend runtime, artefak build, maupun log.
7. **AC-7**: Test PostgreSQL 18 terisolasi membuktikan baseline, rerun, checksum dan urutan rusak, file tidak valid, rollback, persaingan runner, batas lock, seed kosong dan seed idempotent, identitas role yang salah, serta tidak adanya kebocoran credential. Registry menghubungkan MIG-001 sampai MIG-005 dengan kriteria ini.

## Decision

**Chosen option**: Runner Bun terpisah memakai `Bun.SQL`, file SQL tunggal yang diurutkan global, dan satu transaksi untuk batch migration. Seed memakai perintah terpisah dan diuji idempotent per file. Provisioning fitur 5 tetap menjadi satu satunya pembuat role, schema, dan metadata.

## Feature design

**Data model sketch**:

| Objek | Isi atau perubahan | Owner | Relasi |
| --- | --- | --- | --- |
| `common.schema_migrations` | Tabel fitur 5 tetap dengan `name` primary key, checksum 64 hex kecil, dan `applied_at` waktu transaksi | `foundation_owner` | Satu baris per file migration berhasil |
| `0001-common-metadata-comment.sql` | `COMMENT ON TABLE common.schema_migrations IS 'Foundation migration history'` | Dijalankan sebagai `foundation_owner` | Baris `0001` ditulis dalam transaksi yang sama |
| `database/seeds/` | Kosong pada fitur ini | Tidak ada objek baru | File berikutnya mengikuti spec pemilik data |

Tidak ada schema atau tabel bisnis baru. Keputusan penempatan metadata di `common` berasal dari spec 0004 dan scope fitur 5; `users` dan `auth` tetap kosong.

**State transitions**: File lokal `pending` → `applying` → `applied` bersama baris metadata saat commit. Error sebelum commit mengembalikan semua file `applying` menjadi `pending`. File yang sudah `applied` dan cocok dilewati. Drift checksum atau urutan menghentikan invocation sebelum eksekusi.

**Interface surface**:

| Perintah | Masukan | Output aman | Kegagalan utama |
| --- | --- | --- | --- |
| `bun run db:migrate --apply` | URL migrator dan file `database/migrations/*.sql` | Nama file baru dan jumlah applied/skipped | Target, role, file, metadata, lock, atau SQL gagal dengan exit 1 |
| `bun run db:seed --apply` | URL migrator dan file `database/seeds/*.sql` | Nama seed dan jumlah dijalankan; nol bila kosong | Target, role, file, lock, atau SQL gagal dengan exit 1 |

**Value sourcing**:

| Aksi | Nilai yang dihasilkan | Sumber |
| --- | --- | --- |
| Koneksi | Target, login, dan versi | `FOUNDATION_MIGRATOR_DATABASE_URL`, `session_user`, `current_user`, `current_database()`, dan `server_version_num` PostgreSQL |
| File | Nama, domain, nomor, urutan, dan byte | Entri reguler pada direktori tetap di `database/` yang diturunkan dari lokasi modul runner; pola `NNNN-domain-slug.sql` dan nomor berurutan dari spec ini |
| Baseline | Komentar dan nama file awal | SQL literal pada `0001-common-metadata-comment.sql` dan kontrak tabel spec 0004 |
| Migration | Checksum baru | SHA 256 dari byte file sebelum decoding; disimpan dalam hex kecil |
| Migration | Waktu penerapan | Default `transaction_timestamp()` pada `common.schema_migrations` dari spec 0004 |
| Migration | Status applied/skipped dan jumlah | Perbandingan urutan file lokal dengan baris `common.schema_migrations` yang dibaca setelah kedua lock pada transaksi `READ COMMITTED` |
| Seed | Nama dan jumlah dijalankan | Daftar file seed lokal pada invocation itu; tidak ada riwayat seed |
| Seed | Kesiapan schema | Perbandingan semua file migration lokal dengan `common.schema_migrations`, memakai aturan **AC-3** |
| Lock | Kunci dan batas tunggu | Kunci provisioning `(638727, 5)` dan kunci runner `(638727, 6)` dengan `lock_timeout = '5s'` |

**Key invariants**:

1. Kedua perintah menerima tepat `--apply`. URL divalidasi sebagai PostgreSQL, tanpa opsi target database bebas. Pool runner mempunyai maksimum satu koneksi; modul yang diimpor tidak membuka koneksi.
2. Discovery memakai root repository kanonis dari lokasi modul runner, bukan `process.cwd()`, dan menolak symlink pada direktori `database`, `migrations`, `seeds`, maupun entri file. Discovery juga menolak file nonreguler, byte tidak valid UTF 8, BOM, file kosong, nama tidak sesuai, nomor duplikat atau terputus. Setiap file dibaca sekali; checksum dan SQL yang dieksekusi berasal dari buffer byte yang sama. Daftar diurutkan menurut nomor; migration pertama wajib baseline yang disebut di atas. Seed memakai pola dan urutan sendiri mulai `0001` bila ada file.
3. Pemindai leksikal membedakan statement SQL dari semicolon dalam string, identifier, dollar quote, dan komentar. Tepat satu statement substantif per file; semicolon akhir opsional. Statement `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `PREPARE TRANSACTION`, `SET ROLE`, `RESET ROLE`, dan perubahan session authorization ditolak sebelum eksekusi. PostgreSQL menolak operasi lain yang tidak dapat berjalan dalam transaksi dan runner melakukan rollback.
4. Runner memulai transaksi `READ COMMITTED` pada satu koneksi, memvalidasi identitas login, target, versi, dan membership sebagai migrator, lalu memperoleh kunci `(638727, 5)` agar tidak beririsan dengan provisioning dan `(638727, 6)` untuk runner migration serta seed. Runner menjalankan `SET LOCAL ROLE foundation_owner`, memeriksa `current_user`, bentuk metadata, dan privilege, kemudian membaca serta memvalidasi riwayat **setelah** kedua lock. SQL file tepercaya dari repo dijalankan tanpa interpolasi input dan riwayat ditulis lewat parameter. Role owner hanya berlaku selama transaksi; runner membuktikan role kembali menjadi migrator sebelum koneksi dipakai lagi atau pool ditutup.
5. Sebelum eksekusi, metadata harus cocok dengan bentuk fitur 5; applied rows harus membentuk prefix lengkap file lokal dengan checksum identik. Tidak ada pemulihan otomatis untuk file yang diubah atau hilang.
6. Seed menuntut semua migration lokal sudah terapan dan cocok, tidak membuat baris riwayat, serta tidak pernah dipanggil oleh migration atau startup. Tanggung jawab idempotensi SQL seed berada pada fitur yang memperkenalkannya, dibuktikan dengan dua eksekusi terhadap PostgreSQL nyata.

**Security model**: Hanya role `foundation_migrator` yang terhubung, lalu secara eksplisit memakai `foundation_owner` untuk SQL file dan metadata. Backend tetap hanya membaca metadata. File SQL dianggap kode tepercaya dari repository, bukan input HTTP atau argumen pengguna; nama file tidak menjadi identifier SQL. Kesalahan SQL diringkas tanpa nilai query atau credential. Seed domain berikutnya harus menetapkan privilege dan data yang boleh diubah dalam spec fiturnya.

**Configuration required**: `FOUNDATION_MIGRATOR_DATABASE_URL` hanya untuk runner. Password di URL berasal dari role migrator hasil provisioning fitur 5; tidak dibagikan ke `DATABASE_URL` backend atau browser.

**Critical test scenarios**:

1. `MIG-001`: PostgreSQL 18 bersih yang telah diprovision menerapkan baseline dan mencatat checksum serta waktu; rerun nol perubahan dan doctor menemukan seluruh file cocok. Membuktikan **AC-1** sampai **AC-4**, **AC-7**.
2. `MIG-002`: file terapan diubah/hilang, nomor disisipkan/gap, metadata asing, dan file nonreguler atau lebih dari satu statement gagal sebelum mutasi. Membuktikan **AC-2**, **AC-3**, **AC-6**, **AC-7**.
3. `MIG-003`: file kedua sengaja gagal setelah file pertama pending, lalu kedua perubahan serta metadata pending tidak menetap; SQL nontransaksi dan transaction control ditolak. Membuktikan **AC-4**, **AC-7**.
4. `MIG-004`: dua invocation bersamaan menghasilkan satu penerapan dan satu skip berdasarkan riwayat yang dibaca ulang setelah lock; role kembali menjadi migrator setelah transaksi. Lock lebih dari lima detik gagal aman; URL admin/backend dan target salah ditolak tanpa secret. Membuktikan **AC-1**, **AC-4**, **AC-6**, **AC-7**.
5. `MIG-005`: seed kosong melaporkan nol setelah migration siap; migration tertinggal menahan seed. Harness PostgreSQL 18 terisolasi membuat dan membersihkan tabel serta data fixture hanya di schema `users`, tanpa menambah file migration atau seed produk. File seed fixture idempotent dijalankan dua kali dan menghasilkan satu hasil, sedangkan error seed membatalkan seluruh batch tanpa mengubah metadata migration. Membuktikan **AC-5** sampai **AC-7**.

## Build plan

1. Buat baseline SQL dan `db:migrate` dengan discovery, pemeriksaan metadata, checksum, transaksi, serta lock yang berbagi kunci provisioning. Buktikan satu penerapan dan rerun pada PostgreSQL 18 terisolasi. Memenuhi **AC-1** sampai **AC-4**, **AC-7**.
2. Tambah pemindai satu statement serta test file rusak, drift, rollback, dua invocation, dan credential aman. Memenuhi **AC-2** sampai **AC-4**, **AC-6**, **AC-7**.
3. Tambah `db:seed` dengan direktori kosong, runner transaksi bersama, dan fixture idempotent, lalu perbarui registry, README, serta bukti doctor terhadap metadata nyata. Memenuhi **AC-1**, **AC-5** sampai **AC-7**.

## Consequences

**Positive**: Riwayat migration cocok dengan file yang tepat dan tidak dapat tertulis tanpa perubahan schema yang berhasil. Provisioning, migration, dan runtime memakai credential berbeda.

**Negative**: Satu statement per file menambah jumlah file. Satu batch transaksi membuat migration besar menahan lock lebih lama; SQL yang membutuhkan operasi nontransaksi perlu spec tersendiri.

**Neutral**: Tidak ada seed bisnis awal. Fitur 10 hanya membaca metadata dan tidak memerlukan tabel produk contoh.

## Follow-up

1. Fitur yang menambah data bisnis menentukan schema, migration, privilege, dan test seed idempotent miliknya sendiri.
2. SQL yang harus berjalan di luar transaksi, bila benar benar diperlukan, memerlukan spec terpisah untuk pemulihan dan pencatatan yang aman.
3. Setelah fitur ini dibangun, fitur 2 membuktikan doctor dan serve terhadap database nyata serta alur fitur 10.

## Rationale

Alasan dan pilihan yang dibandingkan ada di [rationale.md](rationale.md).

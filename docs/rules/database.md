# Aturan database

Foundation menggunakan PostgreSQL minimal versi 18. PostgreSQL 18 menjadi baseline development dan integration test. Kompatibilitas versi yang lebih baru harus diverifikasi sebelum dinyatakan didukung.

Akses database menggunakan client native `Bun.SQL` dan SQL langsung tanpa ORM.

Server PostgreSQL development dapat dijalankan melalui `docker-compose.yml` root sesuai [aturan infrastruktur](infrastructure.md), memakai image buatan proyek dari `infrastructure/postgres/` (Oracle Linux 10 slim dengan paket PGDG), bukan image resmi `postgres:18`. Compose mengelola server database saja; credential administrator provisioning dipisahkan dari role migration/backend/worker. Schema, grants, migration, dan seed tetap melalui langkah terpisah, bukan startup Compose atau aplikasi.

## Schema berdasarkan domain

Satu database menggunakan beberapa schema berdasarkan domain:

| Schema | Isi |
| --- | --- |
| `common` | Metadata/infrastruktur bersama, termasuk `common.schema_migrations`. Bukan tempat seluruh tabel bisnis secara otomatis. |
| `users` | Identitas bisnis pengguna, profil, dan data domain pengguna sesuai specs. |
| `auth` | Credential/hash password, sesi, reset/verifikasi token, serta data autentikasi/otorisasi sesuai specs. |
| Schema domain lain | Ditambahkan ketika domain fitur membutuhkan batas sendiri dan telah diputuskan dalam scope/specs. |

Nama yang disepakati adalah `common`, `users`, dan `auth`. `users` merupakan schema domain pengguna, bukan schema baru untuk setiap pengguna aplikasi. Schema bukan database terpisah dan bukan isolasi tenant dengan sendirinya; privilege dan pemeriksaan akses tetap diperlukan sesuai [aturan keamanan](security.md).

Seluruh query, DDL, FK, view, dan operasi seed memakai identifier berkualifikasi, seperti `users.users`, `auth.sessions`, dan `common.schema_migrations`. Jangan bergantung pada default `public` atau nama tabel yang dipilih melalui input client. Relasi lintas schema dalam database yang sama diperbolehkan dan dicatat eksplisit dalam specs, misalnya sesi `auth` merujuk pengguna `users`.

Gunakan `search_path` runtime yang hanya mencakup schema tepercaya, dengan `pg_catalog` eksplisit dan objek aplikasi selalu berkualifikasi. Role runtime tidak dapat membuat objek pada schema di search path. Periksa dan batasi privilege `CREATE` pada schema `public`, terutama pada database hasil upgrade; jangan menganggap default seluruh instalasi sama.

Saat menjalankan `/scope` atau `/architect`, agent menanyakan schema data fitur dan pembagian entitas lintas schema jika keputusan belum tersedia. Catat pilihan pada scope dan rincian per entitas pada specs. Keputusan schema baru tidak dibuat diam-diam oleh agent/subagent; pekerjaan independen dapat berjalan sambil menunggu keputusan, tetapi migration/query yang bergantung padanya menunggu jawaban.

## Role dan privilege

- Pisahkan role pemilik/migration dari role runtime backend dan masing-masing worker. Runtime bukan superuser, tidak memiliki hak membuat role/database atau DDL, dan tidak menjadi pemilik objek bisnis.
- Berikan `USAGE` pada schema dan privilege tabel/sequence yang diperlukan saja. `USAGE` tidak dengan sendirinya memberi akses tabel. Worker tidak otomatis mempunyai akses credential/sesi di `auth`.
- Role backend mendapat akses baca metadata migration untuk preflight; hanya runner migration yang menulis metadata dan mengubah struktur. Seed menggunakan role serta operasi yang diputuskan eksplisit.
- Atur default privilege untuk objek baru sesuai role yang benar-benar membuatnya, lalu verifikasi permission setelah migration. Hindari grant semua privilege pada semua schema untuk mengatasi error akses.
- Uji keberhasilan akses yang diizinkan dan kegagalan akses lintas domain yang dilarang. Detail role, grants, dan bila perlu RLS untuk tenant dicatat dalam specs; pemisahan schema tidak menggantikan otorisasi backend.

## Struktur dan batas tanggung jawab

```text
foundation/
├── package.json
├── bun.lock
├── docker-compose.yml
├── infrastructure/
│   └── postgres/
│       ├── Dockerfile
│       ├── docker-entrypoint.sh
│       └── pins.json
├── apps/
│   ├── frontend/
│   ├── backend/
│   └── worker/
├── libs/
│   ├── contracts/
│   └── server/
│       └── database/
│           └── client.ts
└── database/
    ├── Dockerfile
    ├── migrate.ts
    ├── seed.ts
    ├── migrations/
    │   ├── 0001-create-schemas.sql
    │   ├── 0002-users-create-users.sql
    │   └── 0003-auth-create-sessions.sql
    └── seeds/
        └── initial-data.sql
```

Nama migration dan seed merupakan contoh. `infrastructure/postgres/` berisi image server PostgreSQL development yang dibangun Compose root; data cluster berada pada volume `pgsql_data` di `/var/lib/pgsql`. Dockerfile pada `database/` diperlukan jika runner dijalankan melalui container. Struktur ini tidak mewajibkan pembuatan file contoh sebelum ada kebutuhan.

| Lokasi | Tanggung jawab |
| --- | --- |
| `apps/backend/` | Endpoint, aturan bisnis, dan query operasional fitur. |
| `apps/worker/` | Pekerjaan bisnis di latar belakang dan query yang dibutuhkan pekerjaan tersebut. |
| `infrastructure/postgres/` | Image server PostgreSQL 18 proyek, entrypoint inisialisasi, dan pin build untuk test serta CI. Tidak berisi migration, seed, atau SQL aplikasi. |
| `libs/server/database/` | Infrastruktur koneksi PostgreSQL yang dapat digunakan backend, worker, dan runner database. |
| `database/` | Migration, seed, dan runner pengelolaan skema atau data awal. |

Migration dan seed tidak berada di `apps/`. Backend dan worker tidak menjalankannya saat startup. File tersebut juga tidak ditempatkan di `libs/server/database/`, yang hanya berisi infrastruktur runtime bersama.

## Client dan query operasional

- `client.ts` menyediakan factory client. Aplikasi atau runner memasok konfigurasi; library tidak mengimpor konfigurasi aplikasi tertentu.
- Setiap proses memiliki pool sendiri dan menggunakan kembali client tersebut. Jangan membuat client baru untuk setiap request atau query.
- Atur kapasitas pool dengan memperhitungkan jumlah container backend dan worker. Tutup pool ketika proses berhenti.
- Gunakan tagged template dan parameter query untuk nilai dinamis. Jangan menggabungkan input pengguna ke string SQL.
- Jika identifier SQL perlu dinamis, gunakan fasilitas identifier yang sesuai dan batasi pilihan yang diizinkan.
- Untuk perubahan yang harus atomik, gunakan transaksi Bun.SQL. Semua query dalam transaksi memakai client transaksi yang sama, bukan client pool di luar transaksi.
- Jangan menelan kesalahan lalu menganggap transaksi berhasil. Pastikan kegagalan membatalkan transaksi sesuai alur fitur.
- Simpan query khusus fitur dekat dengan logika bisnisnya. Infrastruktur koneksi bersama tidak menjadi kumpulan seluruh query aplikasi.

## Migration dan seed

- Migration berupa file SQL berurutan di `database/migrations/`.
- Gunakan satu urutan global untuk seluruh schema agar FK dan dependensi lintas schema dapat diterapkan konsisten. Nama file menyebut domain; jangan membuat penomoran independen yang mengabaikan dependensi antarschema.
- `migrate.ts` merupakan runner project menggunakan Bun dan Bun.SQL, bukan fitur migration otomatis dari ORM.
- Bootstrap runner menyiapkan schema `common` dan tabel `common.schema_migrations` sebelum membaca riwayat. Metadata mempunyai `name` unik untuk nama file lengkap, `checksum` SHA-256 dari byte file SQL, dan waktu penerapan; migration berikutnya menyiapkan schema serta objek domain sesuai urutan. Bootstrap dan perubahan tetap menggunakan role migration serta lock yang sama.
- Runner memvalidasi target database dan minimum versi PostgreSQL sebelum menjalankan perubahan.
- Catat migration yang berhasil beserta checksum. Jangan mengubah migration yang sudah diterapkan; buat migration baru untuk perubahan berikutnya.
- Koordinasikan eksekusi dengan lock database agar beberapa runner tidak menerapkan migration bersamaan.
- Terapkan perubahan dan pencatatan migration dalam transaksi ketika jenis perintah SQL mendukungnya. Perintah yang tidak dapat berjalan dalam transaksi harus ditangani secara eksplisit.
- Jalankan seed secara eksplisit melalui `seed.ts`, terpisah dari migration. Tentukan target environment dan perilaku pengulangan seed, tanpa menghapus atau menimpa data bisnis secara diam-diam.

## Eksekusi dan container

Runner database berjalan sekali lalu selesai. Runner bukan aplikasi worker yang terus hidup.

Jalankan migration sebagai langkah deployment tersendiri sebelum aplikasi yang memerlukan skema baru dijalankan. Koordinasikan perubahan skema dengan kebutuhan backend dan worker dalam specs fitur.

Script dikelola melalui `package.json` root. Jika menggunakan container, Dockerfile berada di `database/Dockerfile` dan build context tetap root monorepo. Runner tidak memiliki `package.json` terpisah.

Image PostgreSQL yang dipakai untuk environment project harus memenuhi minimum versi 18. Server development memakai `infrastructure/postgres/Dockerfile`; Dockerfile runner di `database/` menjalankan proses Bun dan tidak menjadi container server PostgreSQL.

## Koordinasi agent

Agent utama dan setiap subagent yang mengubah koneksi, query, skema, migration, seed, atau deployment database wajib membaca aturan ini.

Tetapkan satu penanggung jawab untuk migration, penomoran file, dan infrastruktur database bersama. Subagent fitur menyampaikan kebutuhan perubahan skema serta dependensinya sebelum implementasi yang bergantung pada perubahan tersebut.

## Referensi

- [Schema dan privilege PostgreSQL 18](https://www.postgresql.org/docs/18/ddl-schemas.html).
- [Dokumentasi PostgreSQL 18](https://www.postgresql.org/docs/18/index.html).
- [Client SQL native Bun](https://bun.com/docs/runtime/sql).

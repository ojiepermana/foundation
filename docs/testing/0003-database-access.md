# Bukti fitur 5: model data dan akses database

Tanggal verifikasi ulang: 2026-10-02. Kandidat saat pengujian: commit dasar `9724703cbcf6163c83286ceee22a535bc5e343f8` bersama perbaikan lokal hasil review fitur 5. Sumber kriteria: [spec 0004](../specs/0004-model-data-akses-database/index.md), skenario DATA-001 sampai DATA-005. Hasil review ulang dicatat terpisah dari run pengujian ini.

## Environment

Suite `bun run test:database:real` membuat container sementara dari `foundation-postgres:18-pinned` dengan nama, port, dan password acak. Container dan credential test dibersihkan setelah suite. Database development serta volume Compose `foundation` tidak dipakai.

## Hasil

| Pemeriksaan | Hasil | Bukti |
| --- | --- | --- |
| Provisioning awal, pengulangan, password lama, transaksi, dan role | Lulus | DATA-001, 1 test |
| Target salah, drift tabel dan CHECK checksum, atribut role, membership, default ACL, grant option, dan perbaikan grant `PUBLIC` | Lulus | DATA-002, 5 test |
| Hak backend yang diizinkan dan penolakan mutasi, DDL, tabel sementara, `SET ROLE`, serta lookup tanpa schema | Lulus | DATA-003, 1 test |
| Dua invocation bersamaan dan lock timeout lima detik | Lulus | DATA-004, 2 test |
| Validasi pool, penggunaan ulang koneksi, route dasar dengan dan tanpa URL, SIGTERM, serta SIGINT | Lulus | DATA-005, 3 test |

`bun run test:database:real`: **17 lulus, 0 gagal, 133 assertion** pada 2026-10-02. Dua belas test DATA menyumbang 74 assertion, lima test MIG fitur 6 menyumbang 59. [Salinan JUnit](evidence/0003/database.xml) menghapus hostname lokal; file asli berada di `.local/feature-5/database.xml`. Perintah ini juga membangun frontend dengan tiga URL dan dua password database sintetis di environment build, lalu memeriksa tujuh nilai acak run tersebut, yaitu seed, tiga password, dan tiga URL, pada JUnit serta 13 file bundle. [Hasil pemeriksaan artefak](evidence/0003/artifact-scan.json) mencatat 14 file diperiksa tanpa temuan dan checksum JUnit asli. `bun run test:ci` lulus pada kandidat lokal yang sama, termasuk pemeriksaan dependency, 27 ID skenario, reproduksi OpenAPI/SDK, build frontend/backend, 1 test frontend, 68 test backend/kontrak, 20 test tooling, dan 2 E2E. [CI remote sebelumnya](https://github.com/ojiepermana/foundation/actions/runs/36971135331) lulus untuk SHA dasar; hasil CI remote perbaikan review belum tersedia saat laporan ditulis. Suite database belum menjadi bagian CI remote.

## Verifikasi runtime

Perintah `bun .local/feature-5/verify-runtime.ts` selesai dengan exit 0 pada PostgreSQL 18 sementara. [Log yang disaring](evidence/0003/runtime.txt) mencatat output CLI dan query katalog. Provisioning pertama membuat tiga role, tiga schema, dan tabel metadata; pengulangan mempertahankan role dan berhasil tanpa password baru. Target salah serta drift kolom ditolak. Query menunjukkan lima constraint yang disepakati, satu index primary key, tanpa tabel bisnis di `users` atau `auth`. Owner objek adalah `foundation_owner`, `foundation_backend` hanya memiliki baca metadata, dan `search_path` runtime berisi `pg_catalog`.

Percobaan backend untuk menulis metadata, membuat tabel biasa atau sementara, mengambil role owner, dan membaca tabel tanpa nama schema semuanya ditolak. CHECK checksum yang dilemahkan dengan `OR true` ditolak saat provisioning diulang. Grant `TEMPORARY` yang sengaja diberikan ke `PUBLIC` diperbaiki pada rerun; lock timeout sekitar lima detik gagal aman, sedangkan dua rerun bersamaan lulus. Migration baseline kemudian diterapkan sekali, tercatat dengan checksum dan waktu, dan dilewati pada rerun.

Pool memakai ulang koneksi dan menolak query setelah ditutup. Backend menjawab `GET /api/status` dengan HTTP 200 dan `{"status":"ok"}` tanpa membuka koneksi database untuk route dasar. Proses berhenti dengan exit 0 pada SIGTERM dan SIGINT. Startup dengan port yang sudah dipakai keluar 1 dengan pesan aman. Output provisioning tidak memuat credential uji.

## Batas bukti

[Review independen awal](../reviews/2026-10-02-database-access.md) menemukan validasi CHECK checksum yang menerima drift serta dua celah kecil pada lifecycle dan cakupan test. Perbaikan menolak CHECK yang melemah, menutup pool meski listener gagal berhenti, dan menambah test backend tanpa URL serta SIGINT. [Review ulang](../reviews/2026-10-02-database-access-followup.md) memberi verdict Approve tanpa temuan baru dan menjalankan ulang 17 test serta scan tujuh canary. Suite database membutuhkan image PostgreSQL 18 lokal; jalur CI container terpisah masih perlu ditetapkan oleh fitur 11. Runner fitur 6 sudah tersedia, sedangkan alur database lintas UI fitur 10 belum ada; `doctor`/`serve` fitur 2 belum dapat dibuktikan tuntas pada aplikasi nyata. Build frontend memberi warning budget awal 675,12 kB terhadap batas 500 kB; build tetap berhasil dan warning ini tidak berasal dari kode database.

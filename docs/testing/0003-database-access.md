# Bukti awal fitur 5: model data dan akses database

Tanggal: 2026-10-02. Kandidat: perubahan lokal fitur 5 sebelum review independen. Sumber kriteria: [spec 0004](../specs/0004-model-data-akses-database/index.md), skenario DATA-001 sampai DATA-005.

## Environment

Suite `bun run test:database:real` membuat container sementara dari `foundation-postgres:18-pinned` dengan nama, port, dan password acak. Container dan credential test dibersihkan setelah suite. Database development serta volume Compose `foundation` tidak dipakai.

## Hasil

| Pemeriksaan | Hasil | Bukti |
| --- | --- | --- |
| Provisioning awal, pengulangan, password lama, transaksi, dan role | Lulus | DATA-001, 1 test |
| Target salah, drift tabel, atribut role, membership, default ACL, grant option, dan perbaikan grant `PUBLIC` | Lulus | DATA-002, 4 test |
| Hak backend yang diizinkan dan penolakan mutasi, DDL, tabel sementara, `SET ROLE`, serta lookup tanpa schema | Lulus | DATA-003, 1 test |
| Dua invocation bersamaan dan lock timeout lima detik | Lulus | DATA-004, 2 test |
| Validasi pool, penggunaan ulang koneksi, penutupan, route dasar dengan pool lazy, dan SIGTERM | Lulus | DATA-005, 2 test |

`bun run test:database:real`: 10 lulus, 0 gagal, 64 assertion. JUnit lokal: `.local/feature-5/database.xml`. `bun run test:ci`: lulus, termasuk pemeriksaan dependency, registry, OpenAPI/SDK, build frontend/backend, 1 test frontend, 68 test integration backend/contract, 20 test tooling, dan 2 E2E. `bun run api:sync` dan `api:check` meregenerasi serta membandingkan artefak OpenAPI/SDK; output tetap identik.

## Batas bukti

Review independen dan `/check verify` fitur 5 belum dijalankan. Suite database belum masuk `test:ci` karena membutuhkan image PostgreSQL 18 lokal; jalur CI container terpisah masih perlu ditetapkan oleh fitur 11. Runner migration fitur 6 dan alur database lintas UI fitur 10 belum tersedia, sehingga `doctor`/`serve` fitur 2 belum dapat dibuktikan tuntas pada aplikasi nyata. Build frontend memberi warning budget awal 675,12 kB terhadap batas 500 kB; build tetap berhasil dan warning ini tidak berasal dari kode database.

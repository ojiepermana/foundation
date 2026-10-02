# Bukti fitur 6: migration dan seed terpisah

Tanggal: 2026-10-02. Sumber kriteria: [spec 0005](../specs/0005-migration-seed-terpisah/index.md), skenario MIG-001 sampai MIG-005. Kandidat saat pengujian adalah checkout `main` pada commit dasar `db21ead2d133b4307b9330628b3ecc72b4c1c2aa` dengan perubahan fitur 6 yang belum di-commit. Bukti ini berlaku untuk perubahan yang diuji; hasil CI remote setelah push dicatat terpisah.

## Lingkungan dan perubahan

Suite database membuat PostgreSQL 18 sementara dari image `foundation-postgres:18-pinned` dengan port dan credential acak. Suite tidak memakai database development atau volume Compose pengguna. Runner baru membaca SQL dari `database/migrations/` dan `database/seeds/`, memeriksa identitas migrator, file, checksum, serta riwayat di `common.schema_migrations`, lalu memakai transaksi dan advisory lock. Migration awal hanya memberi komentar pada tabel metadata. Belum ada seed bisnis.

Perintah `db:migrate --apply` dan `db:seed --apply` memerlukan `FOUNDATION_MIGRATOR_DATABASE_URL` saat dipanggil. `serve` menghapus credential admin dan migrator dari environment backend serta worker dan mencegah Bun memuat ulang `.env` untuk proses tersebut. README menjelaskan urutan provisioning, migration, dan startup.

## Hasil

`bun run test:database:real` selesai dengan exit 0: **15 lulus, 0 gagal, 123 assertion**. Lima test MIG menyumbang 59 assertion. [Salinan JUnit MIG](evidence/0004/migration.xml) memuat hasil kelima skenario; atribut hostname lokal dihapus. JUnit asli berada di `.local/feature-6/migration.xml` dan gabungan database di `.local/feature-5/database.xml` pada checkout ini.

| Skenario | Bukti PostgreSQL 18 |
| --- | --- |
| MIG-001 | Baseline terapan sekali, checksum byte dan waktu tercatat, rerun melewati file, doctor menerima riwayat. |
| MIG-002 | File berubah, hilang, urutan salah, symlink, format rusak, SQL majemuk, dan metadata asing ditolak sebelum mutasi. |
| MIG-003 | Kegagalan file berikutnya membatalkan batch; perintah transaksi, role, otorisasi sesi, dan operasi nontransaksi ditolak. |
| MIG-004 | Dua runner bersaing menghasilkan satu penerapan; lock timeout gagal aman, role pulih, identitas dan target salah ditolak tanpa membocorkan secret. |
| MIG-005 | Seed kosong melaporkan nol; migration yang tertinggal menahan seed; fixture seed idempotent aman diulang dan rollback bila gagal. |

Verifikasi CLI terpisah pada PostgreSQL 18 sementara menjalankan migration pertama dan kedua serta seed kosong. Hasilnya masing masing satu file diterapkan, nol file baru dengan satu skip, dan nol seed. Query langsung menemukan satu baris riwayat dengan checksum dan waktu, serta komentar tabel `Foundation migration history`. Output CLI tidak memuat credential uji.

`bun run test:ci` selesai dengan exit 0. Gate ini memeriksa dependency, 27 ID skenario, reproduksi OpenAPI dan SDK, build frontend dan backend, 1 test frontend, 68 test backend dan kontrak, 20 test tooling, serta 2 test Playwright. Test tooling membuktikan isolasi credential proses `serve`. Build frontend masih memberi warning ukuran bundle awal 675,12 kB terhadap batas 500 kB; build tetap berhasil.

## Review dan batas bukti

[Review independen awal](../reviews/2026-10-02-migration-seed.md) menemukan bahwa `SET LOCAL SESSION AUTHORIZATION` belum ditolak sebelum eksekusi. Pemindai dan MIG-003 diperbaiki; [review ulang GPT-6 Sol](../reviews/2026-10-02-migration-seed-followup.md) memberi **Approve** tanpa temuan terbuka pada perbaikan tersebut. Suite final di atas dijalankan setelah perbaikan.

Suite database membutuhkan Docker lokal dan belum menjadi bagian `test:ci`; integrasi container pada CI adalah pekerjaan fitur 11. Fixture seed hanya ada di test, sehingga idempotensi seed bisnis berikutnya tetap harus dibuktikan oleh fitur yang menambahkannya. Bukti ini tidak menyatakan kesiapan production Foundation atau menutup integrasi `doctor` dan `serve` fitur 2.

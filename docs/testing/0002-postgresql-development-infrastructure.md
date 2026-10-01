# Bukti fitur 3: infrastruktur PostgreSQL development

## Status dan kandidat

**Status fitur: in progress.** Implementasi, pemeriksaan spec, pengujian, dan dokumentasi sudah dilakukan. [Review awal](../reviews/2026-09-28-postgresql-development-infrastructure.md) meminta perbaikan. Dua temuan tentang jumlah test dan pembuktian password lama sudah diperbaiki serta diuji pada 2026-10-01. Review ulang belum tersedia, sehingga laporan ini tidak menyatakan fitur selesai.

**Kesiapan production Foundation: incomplete.** Fitur ini menyediakan database development. Role runtime, schema, migration, integrasi aplikasi, dan gate CI database memiliki scope berikutnya.

Kandidat yang diuji adalah commit `8baedf69a29f4b68f98d6407a34da657a4a44fcc` dengan perubahan lokal pada `tests/integration/infrastructure/postgres.test.ts`. SHA-256 file test saat pengujian adalah `2474dc3343351bb255bd6879eb1ee4eccdcbed297516fd67904e56b1de5b02bb`. Perubahan lokal itu belum menjadi commit saat laporan ditulis. [Spec 0002](../specs/0002-infrastruktur-postgresql-development/index.md) dan [checklist verifikasi](../specs/0002-infrastruktur-postgresql-development/verify.md) menetapkan hasil yang diperiksa.

Pengujian berjalan pada macOS arm64 dengan Bun 1.4.2 dan Docker 29.8.0. Image test memakai base `oraclelinux:10-slim` dari digest indeks multi arsitektur pada `pins.json`, paket `postgresql18-server` versi `18.6-4PGDG.rhel10.2`, dan server PostgreSQL 18.6. [Identitas image](evidence/0002/image.json) mencatat image ID, arsitektur, UID proses, paket, serta waktu pencatatan run.

## Perubahan yang didokumentasikan

Compose root membangun image PostgreSQL proyek dari `infrastructure/postgres/` dan hanya menjalankan layanan database. Cluster baru dibuat pada volume `pgsql_data` melalui staging, memakai SCRAM, locale `C.UTF-8`, timezone `UTC`, dan data checksums. Entrypoint menolak password yang tidak memenuhi batas serta cluster yang rusak, dan tidak menginisialisasi ulang cluster yang sudah ada. Password administrator diberikan saat runtime lewat `.env.infrastructure`, terpisah dari `.env` aplikasi.

Build test memakai `pins.json` agar versi base dan paket dapat diulang. Suite `INFRA-001` sampai `INFRA-006` memakai project Compose, port, dan password acak milik run test. Cleanup dibatasi pada project uji. Perintah development, batas credential, dan cara memperbarui image dijelaskan pada `README.md` serta `docs/rules/infrastructure.md`.

## Hasil pemeriksaan

`bun run test:infrastructure` pada 2026-10-01 selesai dengan exit 0: **16 lulus, 0 gagal, 0 dilewati, 135 assertion**. [Salinan JUnit](evidence/0002/infrastructure.xml) menyimpan 16 nama test dan jumlah hasil. Nama host dihapus dari salinan tersebut. JUnit asli tetap berada di `.local/feature-3/infrastructure.xml` pada checkout ini. Tidak ada container, network, atau volume `foundation-infra-test-*` tersisa setelah suite.

`DOCKER_HOST=unix:///nonexistent/docker.sock bun test ./tests/integration/infrastructure` selesai dengan exit 0: **4 lulus, 12 dilewati dengan alasan daemon tidak dapat dihubungi, 0 gagal**. [Output mode tanpa daemon](evidence/0002/no-daemon.txt) mencatat hasilnya. `bun run test:scenarios` juga lulus dengan 14 ID unik dan referensi yang valid. Pemeriksaan registry membuktikan pemetaan skenario, bukan eksekusi test.

Build terkunci tambahan untuk arm64 dan amd64 dengan `--no-cache` serta versi paket yang sama dicatat pada [bukti reproduksibilitas](evidence/0002/reproducibility.json) dari 2026-09-28. Build amd64 dijalankan melalui emulasi Docker Desktop pada host arm64. Eksekusi native amd64 belum dibuktikan.

| Skenario | Hasil yang dibuktikan |
| --- | --- |
| INFRA-001 | Compose hanya berisi PostgreSQL, validasi konfigurasi tidak mencetak secret, dan file credential tidak masuk Git atau environment Bun. |
| INFRA-002 | Image terkunci sesuai pin, paket server tanpa contrib, proses bukan root, dan identitas image tercatat. |
| INFRA-003 | Startup mencapai healthy, koneksi admin SCRAM berhasil, konfigurasi cluster sesuai, password salah ditolak, dan doctor menolak role superuser untuk runtime. |
| INFRA-004 | Identitas cluster bertahan setelah `down` dan `up`; shutdown selesai tertib tanpa recovery pada start berikutnya. |
| INFRA-005 | Cleanup hanya menyentuh project uji, dan test yang membutuhkan Docker diberi status dilewati saat daemon tidak tersedia. |
| INFRA-006 | Staging sisa dapat dipulihkan, data directory rusak ditolak, input inisialisasi tidak valid ditolak, dan perubahan password di env tidak mengganti password cluster lama. |

AC-9 mengenai dokumentasi diperiksa secara manual pada `README.md`, `docs/rules/infrastructure.md`, dan `docs/rules/database.md`, sebagaimana dicatat pada checklist verifikasi.

## Temuan review dan tindak lanjut

Review awal menemukan laporan 11 test yang tertinggal setelah suite bertambah menjadi 16 test. Scope dan checklist sekarang mencatat 16 hasil lulus berdasarkan run baru. Review juga menemukan bahwa test perubahan password hanya menolak password baru. Test sekarang membuka koneksi baru dengan password lama dan memeriksa role `foundation_admin`; run Docker lulus sesudah perubahan itu.

Review ulang tetap perlu dijalankan pada kandidat ini. Suite infrastruktur belum termasuk `test:ci`, dan eksekusi native amd64 menunggu runner CI fitur 11. Bukti ini tidak mencakup role runtime, migration, alur frontend ke database, atau kesiapan production.

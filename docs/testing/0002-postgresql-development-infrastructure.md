# Bukti fitur 3: infrastruktur PostgreSQL development

## Status dan kandidat

**Status fitur: done.** Implementasi, pemeriksaan spec, pengujian, dan dokumentasi sudah dilakukan. [Review awal](../reviews/2026-09-28-postgresql-development-infrastructure.md) meminta perbaikan; jumlah test dan bukti password lama sudah diperbaiki. [Review ulang pertama](../reviews/2026-10-03-main.md) menemukan urutan verifikasi RPM dan refresh cache build. [Review ulang kedua](../reviews/2026-10-03-main-followup.md) menemukan RPM unsigned masih lolos dan satu keputusan spec yang tertinggal. [Review ulang ketiga](../reviews/2026-10-03-main-final.md) meminta bukti penolakan signer lain dan signature rusak. [Review ulang keempat](../reviews/2026-10-03-main-final2.md) mereproduksi impor key tambahan lewat bundle. [Review ulang kelima](../reviews/2026-10-03-main-final3.md) menunjukkan bahwa short ID 32 bit dengan `sort -u` belum membuktikan fingerprint key tambahan. [Review final](../reviews/2026-10-03-main-final4.md) menyetujui kandidat dengan dua temuan minor, keduanya diperbaiki sebelum suite akhir.

**Kesiapan production Foundation: incomplete.** Fitur ini menyediakan database development. Role runtime, schema, migration, integrasi aplikasi, dan gate CI database memiliki scope berikutnya.

Kandidat ini dikembangkan di atas branch `main` pada `df102ca`; [review final](../reviews/2026-10-03-main-final4.md) dan bukti di bawah mencatat hasil yang diterima. [Spec 0002](../specs/0002-infrastruktur-postgresql-development/index.md) dan [checklist verifikasi](../specs/0002-infrastruktur-postgresql-development/verify.md) menetapkan hasil yang diperiksa.

Pengujian berjalan pada macOS arm64 dengan Bun 1.4.2 dan Docker 29.8.0. Image test memakai base `oraclelinux:10-slim` dari digest indeks multi arsitektur pada `pins.json`, paket `postgresql18-server` versi `18.6-4PGDG.rhel10.2`, dan server PostgreSQL 18.6. [Identitas image](evidence/0002/image.json) mencatat image ID, arsitektur, UID proses, paket, serta waktu pencatatan run.

## Perubahan yang didokumentasikan

Compose root membangun image PostgreSQL proyek dari `infrastructure/postgres/` dan hanya menjalankan layanan database. Cluster baru dibuat pada volume `pgsql_data` melalui staging, memakai SCRAM, locale `C.UTF-8`, timezone `UTC`, dan data checksums. Entrypoint menolak password yang tidak memenuhi batas serta cluster yang rusak, dan tidak menginisialisasi ulang cluster yang sudah ada. Password administrator diberikan saat runtime lewat `.env.infrastructure`, terpisah dari `.env` aplikasi.

Build test memakai `pins.json` agar versi base dan paket dapat diulang. Suite `INFRA-001` sampai `INFRA-006` memakai project Compose, port, dan password acak milik run test. Cleanup dibatasi pada project uji. Perintah development, batas credential, dan cara memperbarui image dijelaskan pada `README.md` serta `docs/rules/infrastructure.md`.

## Hasil pemeriksaan

`bun run test:infrastructure` pada 2026-10-03 selesai dengan exit 0: **18 lulus, 0 gagal, 0 dilewati, 168 assertion**. [Salinan JUnit](evidence/0002/infrastructure.xml) mencatat run terbaru tanpa hostname; JUnit lokal berada di `.local/feature-3/infrastructure.xml`. Test INFRA-002 memakai helper produksi untuk menolak bundle dengan sertifikat kedua sebelum import global, RPM unsigned, signature rusak, serta signature valid dari key lain yang dipercaya sebelum payload atau scriptlet dipasang. `bun run test:scenarios` lulus dengan 27 ID unik dan referensi valid.

`DOCKER_HOST=unix:///nonexistent/docker.sock bun test ./tests/integration/infrastructure` selesai dengan exit 0: **4 lulus, 12 dilewati dengan alasan daemon tidak dapat dihubungi, 0 gagal**. [Output mode tanpa daemon](evidence/0002/no-daemon.txt) mencatat hasil historis tersebut. Pemeriksaan registry saat ini lulus dengan 27 ID unik; pemeriksaan registry membuktikan pemetaan skenario, bukan eksekusi test.

Build terkunci terbaru pada arm64 dan amd64 memakai base digest serta versi paket `18.6-4PGDG.rhel10.2` yang sama. Build amd64 dijalankan melalui emulasi Docker Buildx pada host arm64; eksekusi native amd64 belum dibuktikan. [Bukti reproduksibilitas](evidence/0002/reproducibility.json) mencatat image ID dan UID proses. [Perbandingan refresh](evidence/0002/dev-refresh.json) membuktikan base image tetap sama, rebuild `--pull` memakai cache instalasi, dan `--pull --no-cache` menjalankannya ulang.

| Skenario | Hasil yang dibuktikan |
| --- | --- |
| INFRA-001 | Compose hanya berisi PostgreSQL, validasi konfigurasi tidak mencetak secret, dan file credential tidak masuk Git atau environment Bun. |
| INFRA-002 | Image terkunci sesuai pin, signature RPM diwajibkan dari key PGDG, paket unsigned ditolak sebelum terpasang, paket server tanpa contrib, proses bukan root, dan identitas image tercatat. |
| INFRA-003 | Startup mencapai healthy, koneksi admin SCRAM berhasil, konfigurasi cluster sesuai, password salah ditolak, dan doctor menolak role superuser untuk runtime. |
| INFRA-004 | Identitas cluster bertahan setelah `down` dan `up`; shutdown selesai tertib tanpa recovery pada start berikutnya. |
| INFRA-005 | Cleanup hanya menyentuh project uji, dan test yang membutuhkan Docker diberi status dilewati saat daemon tidak tersedia. |
| INFRA-006 | Staging sisa dapat dipulihkan, data directory rusak ditolak, input inisialisasi tidak valid ditolak, dan perubahan password di env tidak mengganti password cluster lama. |

AC-9 mengenai dokumentasi diperiksa secara manual pada `README.md`, `docs/rules/infrastructure.md`, dan `docs/rules/database.md`, sebagaimana dicatat pada checklist verifikasi.

## Temuan review dan tindak lanjut

Review awal menemukan laporan historis 11 test yang tertinggal setelah suite bertambah menjadi 16 test. Kandidat berikutnya mencatat 16 hasil lulus. Review juga menemukan bahwa test perubahan password hanya menolak password baru. Test sekarang membuka koneksi baru dengan password lama dan memeriksa role `foundation_admin`; run Docker lulus sesudah perubahan itu. Hasil sebelumnya yang mencatat 158 dan 161 assertion adalah run kandidat terdahulu.

Review ulang kedua menemukan RPM tanpa signature diterima oleh mode default RPM 4.19.1.1, meskipun `--checksig` exit 0. Probe Oracle Linux 10 membuktikan `%_pkgverify_level all` menolak checksig dan instalasi. Review ulang ketiga meminta bukti signature rusak dan signer tak diizinkan; kandidat menambahkan keduanya melalui helper produksi. Review ulang keempat mereproduksi impor key tambahan melalui bundle dan pemasangan payload/scriptlet oleh signer itu. Perbaikan sementara menggunakan RPM database tertutup, lalu review kelima mengingatkan bahwa identitas RPM `%{VERSION}` hanya short ID 32 bit dan `sort -u` menghilangkan multiplicity. Helper kini memakai GnuPG `show-only` pada homedir sementara untuk memastikan hanya satu sertifikat primary dengan fingerprint penuh yang sama dengan konstanta; RPM database sementara tetap memeriksa satu record sebelum import global. Paket GnuPG dan seluruh dependency baru dibuang, sedangkan `pgdg-redhat-repo` tetap ada. Review final menyetujui dengan nits: assertion offset lintas file dan jumlah changelog diperbaiki, lalu suite akhir lulus 18 test dengan 168 assertion. Build arm64 dan buildx amd64 berhasil, dan perbandingan cache pada base tetap membuktikan `--pull` memakai cache sedangkan `--no-cache` menjalankan ulang pemasangan. Suite infrastruktur belum termasuk `test:ci`, dan eksekusi native amd64 menunggu runner CI fitur 11. Bukti ini tidak mencakup role runtime, migration, alur frontend ke database, atau kesiapan production.

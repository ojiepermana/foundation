# Verifikasi doctor dan serve pada aplikasi nyata

## Kandidat dan lingkungan

Kandidat adalah `HEAD 358523782beb0505dd5555d74026a586d5c6f538` ditambah perubahan lokal Scope 2 yang belum di-commit. Verifikasi dijalankan pada 2026-10-03 dengan Bun 1.4.2, Node 24.21.0, macOS 27.0, Docker Engine 29.8.0, dan PostgreSQL 18.6 dari image `foundation-postgres:18-pinned`.

## Status skenario

| Skenario | Bukti yang diamati | Status |
| --- | --- | --- |
| `TOOL-001` | JUnit TOOL-001 lulus. Smoke PostgreSQL memeriksa 12 kondisi role/migration positif, menolak target salah, privilege tulis, membership role penulis, checksum salah, metadata tanpa file, migration kosong, role admin, dan database mati; tidak ada credential pada output. [Laporan](../../testing/0005-doctor-serve-real-smoke.md) | Lulus |
| `TOOL-002` | Tujuh test fixture meliputi cleanup listener terdaftar, escalasi sinyal, listener asing, PID dipakai ulang, validasi pemilik port sebelum sinyal, dan grup worker tanpa port. | Lulus, fixture |
| `TOOL-003` | Lima test fixture meliputi pilihan worker eksplisit, isolasi credential, konfigurasi/path readiness, dan respons worker HTTP. Tidak ada worker aplikasi yang terdaftar saat ini. | Lulus, fixture |
| `TOOL-004` | Tiga test fixture membuktikan kegagalan layanan, termination, Ctrl+C, dan penghentian turunan. | Lulus, fixture |
| `TOOL-005` | Enam test fixture membuktikan lock aktif, lock belum lengkap, pemulihan stale, checkout berbeda, race invocation, dan cleanup grup lama. | Lulus, fixture |
| `TOOL-006` | Enam test fixture meliputi timeout, respons tepat, listener asing, body salah, HTML tidak valid, retry setelah snapshot port kosong, dan penolakan respons yang selesai setelah deadline. Smoke nyata setelah perbaikan race kepemilikan port lulus 11 kali berturut-turut. | Lulus |
| `TOOL-007` | PostgreSQL 18.6, doctor, frontend/backend nyata melalui `serve`, HTTP 200 untuk `/` dan `/api/status`, serta shutdown SIGTERM dibuktikan. Browser melalui SDK, proxy, dan database belum tersedia karena halaman Feature 10 belum dibangun. [Laporan](../../testing/0005-doctor-serve-real-smoke.md) | Parsial |
| `TOOL-008` | Satu test fixture membuktikan mode production dan konfigurasi/database development yang tidak valid gagal sebelum cleanup. Worker yang tidak dikenal diuji pada TOOL-003. | Lulus, fixture |

## Konformansi acceptance

- **AC-1: terpenuhi.** Doctor menerima role runtime minimum pada PostgreSQL nyata dan menolak target atau privilege yang dilarang tanpa membocorkan credential.
- **AC-2: terpenuhi.** Nama, checksum, metadata tanpa file, migration kosong, dan database yang tidak tersedia diperiksa pada smoke nyata.
- **AC-3: terpenuhi.** Preflight berjalan sebelum startup; pemeriksaan workstation dengan database mati gagal aman, dan probe listener yang sudah hidup tetap menjawab.
- **AC-4: terpenuhi.** `serve` mengumumkan siap setelah backend mengembalikan JSON yang tepat dan frontend mengembalikan HTML; klasifikasi listener sekarang membedakan port kosong, milik invocation, dan asing dari satu snapshot.
- **AC-5: terpenuhi melalui fixture.** Pemilihan worker, path readiness, dan isolasi environment diuji. Tidak ada worker aplikasi nyata untuk dijalankan.
- **AC-6: terpenuhi melalui fixture.** Cleanup membuktikan kepemilikan lama dan menolak checkout, PID, grup, atau listener yang berubah.
- **AC-7: terpenuhi melalui fixture.** Race invocation, pemulihan stale, dan lock belum lengkap diuji.
- **AC-8: terpenuhi.** Kegagalan layanan, Ctrl+C, termination, turunan proses, serta listener setelah shutdown diuji.
- **AC-9: belum terpenuhi.** Fixture, PostgreSQL, HTTP, dan shutdown terbukti; alur browser fitur 10 melalui SDK, proxy, dan database belum dibangun. Permukaan tersebut belum dapat dijalankan.

**Verdict `/check verify`: FAIL untuk penyelesaian penuh Scope 2.** AC-1 sampai AC-8 memiliki bukti, tetapi AC-9 masih memerlukan permukaan browser Feature 10. Scope dan spec tetap `in-progress`; kotak Verify tidak ditandai selesai.

## Hasil runner dan gate

`bun run test:tooling` lulus dengan 29 test, 79 assertion, 0 gagal, dan 0 dilewati. JUnit terbaru tersedia di [evidence 0005](../../testing/evidence/0005/tooling.xml). `bun run test:scenarios` lulus dengan 31 ID unik.

`bun run test:ci` lulus: 31 ID skenario; API/SDK deterministik pada dua run; frontend 1/1; integration 81/81 dengan 172 assertion; tooling 29/29 dengan 79 assertion; Playwright 4/4. Build frontend tetap memberi peringatan initial bundle 654.09 kB dibanding budget 500 kB.

Smoke nyata `bun run test:tooling:real` sebelumnya lulus 11 kali berturut-turut setelah perbaikan race kepemilikan port. Run terbaru setelah perbaikan deadline juga lulus, memakai PostgreSQL 18.6 terisolasi, memverifikasi doctor dan respons HTTP nyata, lalu mengonfirmasi listener 8888 dan 8889 hilang setelah SIGTERM. Bukti itu tetap tidak menutup browser TOOL-007.

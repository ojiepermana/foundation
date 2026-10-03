# Bukti sementara fitur 2: doctor dan serve pada aplikasi nyata

Tanggal: 2026-10-02. Kandidat: commit dasar `9227a71c26af7a36188116415bf94f5aaa3d2e4e` ditambah perubahan lokal pada `tests/integration/tooling-real/doctor-smoke.ts`. Sumber kriteria: [spec 0003](../specs/0003-doctor-serve-aplikasi-nyata/index.md), khususnya TOOL-001 dan bagian HTTP TOOL-007.

## Lingkungan dan perintah

`bun run test:tooling:real` membuat container sementara `foundation-postgres:18-pinned` pada port acak. Script memakai file environment berizin `0600`, menjalankan `database/provision.ts --apply` dan `database/migrate.ts --apply` dengan tiga credential terpisah, lalu menghapus container. Database dan volume Compose development tidak disentuh. Frontend dan backend dijalankan oleh `scripts/serve.ts` pada port 8889 dan 8888 hanya setelah script membuktikan kedua port kosong.

## Hasil aktual

Perintah keluar dengan status **0**. Doctor menerima role backend hasil provisioning: 12 pemeriksaan database lulus, termasuk target, versi, schema, batas role, privilege metadata, dan checksum migration. Doctor menolak target lain, hak `INSERT` metadata, keanggotaan role penulis, checksum berbeda, direktori migration kosong, role admin, serta database yang dihentikan. Output provisioning, migration, dan doctor diperiksa agar tidak memuat credential uji.

`serve` mengumumkan siap setelah preflight. GET backend `/api/status` memberi HTTP 200 dengan `{"status":"ok"}` dan GET frontend `/` memberi HTTP 200 dengan `Content-Type` HTML. Setelah SIGTERM ke supervisor, listener 8888 dan 8889 tidak tersisa. Script lama yang membuat schema contoh dan mengubah direktori migration proyek diganti dengan setup provisioning serta migration produk yang nyata.

## Batas bukti

Ini adalah smoke test CLI dan HTTP, tanpa JUnit. TOOL-007 masih **parsial**: alur Angular melalui SDK, proxy, backend, dan database di browser belum tersedia sebelum fitur 10. Pemeriksaan kegagalan database sesudah startup pada halaman juga menunggu fitur 10. Test fixture TOOL-002 sampai TOOL-006 dan TOOL-008 berada pada suite `bun run test:tooling`; hasil smoke ini tidak menggantikan review independen atau verifikasi penuh fitur 2.

## Pemeriksaan ulang 2026-10-03

Run terbaru menguji working tree di atas `cd9abcd`, termasuk validasi ulang pemilik port tepat sebelum `SIGTERM` dan `SIGKILL`. `bun run test:tooling` lulus **26 test, 75 assertion, 0 gagal, 0 dilewati**; JUnit tersanitasi ada di [evidence 0005](evidence/0005/tooling.xml). Cakupan fixture kini mencakup PID dengan waktu mulai berbeda, pemilik port yang berubah sebelum sinyal, path readiness worker HTTP, lock invocation yang belum lengkap, serta grup proses tercatat dari checkout berbeda. `bun run test:scenarios` lulus dengan 27 ID unik. TypeScript tooling, `typecheck:backend`, `build:backend`, dan `build:frontend` juga lulus.

`bun run test:tooling:real` lulus dengan PostgreSQL 18 terisolasi. Doctor menerima role runtime pada 12 pemeriksaan database, lalu menolak target salah, privilege tulis metadata, keanggotaan role penulis, checksum berbeda, metadata migration tanpa file, migration kosong, dan role admin. `serve` mengumumkan siap; `GET http://127.0.0.1:8888/api/status` memberi HTTP 200 dengan `{"status":"ok"}`, dan `GET http://127.0.0.1:8889/` memberi HTTP 200 dengan `Content-Type: text/html`. SIGTERM menghapus listener pada kedua port, dan pemeriksaan setelah database dihentikan gagal tanpa menampilkan credential.

Pada konfigurasi workstation biasa, `bun run doctor` dan `bun run serve` masing-masing keluar dengan status 1 karena database development lokal tidak aktif. Keduanya hanya menampilkan pesan koneksi yang disamarkan; `serve` berhenti pada preflight. Ini bukan bukti browser dan tidak menggantikan run PostgreSQL terisolasi di atas. Build frontend selesai dengan peringatan ukuran initial bundle 675.12 kB terhadap budget 500 kB.

TOOL-007 tetap **parsial**. Browser belum dapat menjalankan alur Angular melalui SDK, proxy, backend, dan database sampai fitur 10 tersedia; verifikasi browser serta respons halaman ketika database gagal masih terbuka. Scope 2 dan spec 0003 tetap `in-progress`.

## Gate regresi 2026-10-03

Pada kandidat `HEAD cd9abcd` ditambah perubahan working tree Scope 2, `bun run test:ci` keluar dengan status 0. Dependency dan 27 ID skenario lolos; `api:check` membuktikan dua sinkronisasi OpenAPI/SDK identik; build frontend, typecheck dan build backend lulus; test frontend lulus 1/1; test backend dan kontrak lulus 68/68 dengan 143 assertion; tooling lulus 26/26 dengan 75 assertion; dan Playwright lulus 2/2 pada viewport 1280×812 dan 375×812.

Playwright dalam gate ini hanya membuktikan kerangka aplikasi Scope 4 serta proxy ke route status. Ia belum menjalankan alur halaman kesiapan Scope 10 dan tidak mengubah status TOOL-007 dari parsial. Build frontend masih memperingatkan initial bundle 675,12 kB dibanding budget 500 kB.

Probe workstation terbaru menjalankan `bun run doctor` dan `bun run serve`; keduanya keluar dengan status 1 karena PostgreSQL development tidak tersedia dan tidak mencetak credential. Untuk memeriksa batas cleanup, listener fixture HTTP sementara pada 8888 dan 8889 tetap memberi body `probe-8888` dan `probe-8889` setelah `serve` gagal pada preflight; fixture kemudian ditutup oleh probe. Hasil ini membuktikan kegagalan preflight tidak mengganggu listener yang sedang ada, tetapi tidak menggantikan pembuktian browser TOOL-007.

## Pemeriksaan setelah commit UI 2026-10-03

Kandidat `HEAD 3585237` dengan perubahan Scope 2 yang masih lokal. Percobaan pertama `bun run test:tooling:real` keluar dengan status 1 setelah kedua layanan mulai, karena pemeriksaan readiness melaporkan `Listener frontend bukan milik invocation ini`. Shutdown menghapus listener; credential tidak muncul. Penyebabnya belum dapat direproduksi.

Tiga pengulangan berikutnya keluar dengan status 0. Dua memakai flag diagnostik dan instrumentasi sementara pada `readiness.ts`; yang ketiga memakai source asli tanpa flag. Setiap run memakai PostgreSQL 18 terisolasi; doctor menerima role backend, menolak kasus privilege dan metadata yang salah, `/api/status` serta halaman frontend mengembalikan HTTP 200, dan SIGTERM menghapus listener 8888 serta 8889. Probe proses terpisah juga menerima listener Angular melalui jalur spawn frontend dan supervisor. Instrumentasi diagnosis sudah dihapus, sehingga working tree tidak menyimpan perubahan `readiness.ts`. Catatan kegagalan awal dipertahankan sebagai kemungkinan race startup yang belum terjelaskan dan perlu dipertimbangkan pada gate akhir Scope 2.

Gate `bun run test:ci` pada kandidat yang sama lulus: 30 ID skenario, 1 frontend test, 81 integration test dengan 172 assertion, 26 tooling test dengan 75 assertion, dan 4 Playwright E2E. Playwright memverifikasi shell Scope 7 dan proxy backend Scope 4; ia belum membuktikan alur TOOL-007. Build frontend mencatat initial bundle 654,09 kB terhadap budget 500 kB.

## Race readiness dan bukti setelah perbaikan 2026-10-03

Kandidat tetap `HEAD 3585237` dengan perubahan Scope 2 lokal yang belum di-commit. Lingkungan: Bun 1.4.2, Node 24.21.0, macOS 27.0, Docker Engine 29.8.0, dan PostgreSQL 18.6 dari `foundation-postgres:18-pinned`.

Dua smoke tambahan sebelum perbaikan mengulang kegagalan `Listener frontend bukan milik invocation ini` setelah Angular selesai build dan mulai melayani port. Percobaan lain lulus. Shutdown tetap membersihkan listener pada setiap kegagalan. Tidak ada log mismatch pemilik dari pemeriksaan pertama; urutan kode menunjukkan port dapat belum terlihat pada snapshot pertama, lalu sudah terlihat pada pembacaan berikutnya. Percobaan gagal tidak menyimpan PID/PGID listener kedua, jadi kepemilikan tepat saat itu tidak dapat dipastikan. Implementasi lama menyatukan keadaan port kosong dan listener asing sebagai `false`, lalu menyebut setiap listener pada pembacaan kedua sebagai asing tanpa memeriksa ulang grupnya.

`inspectPortOwner` sekarang mengembalikan keadaan `absent`, `owned`, atau `foreign` dari satu snapshot listener. Readiness mengulang pemeriksaan untuk port yang masih kosong, menolak listener asing, lalu tetap memverifikasi kepemilikan setelah probe HTTP dan sebelum mengumumkan siap. Skenario regresi TOOL-006 mensimulasikan snapshot kosong diikuti listener invocation yang siap.

Sesudah perubahan, `bun run test:tooling:real` lulus **11 run berturut-turut** pada source tanpa instrumentasi diagnostik. Setiap run memeriksa 12 kondisi database positif, penolakan target/privilege/migration yang salah, respons nyata `GET /api/status` HTTP 200 dengan `{"status":"ok"}`, respons frontend `GET /` HTTP 200 bertipe HTML, dan shutdown SIGTERM yang membebaskan port 8888 serta 8889.

`bun run test:tooling` lulus **28 test, 78 assertion, 0 gagal, 0 dilewati**; JUnit terbaru disimpan pada [evidence 0005](evidence/0005/tooling.xml). Registry memuat 31 ID skenario. `bun run test:ci` lulus pada kandidat ini: 1 frontend test, 81 integration test/172 assertion, 28 tooling test/78 assertion, serta 4 Playwright E2E. Build frontend memperingatkan initial bundle 654.09 kB dibanding budget 500 kB.

Verifikasi penuh tetap **FAIL/incomplete untuk Scope 2** sampai browser Feature 10 dapat membuktikan SDK, proxy, backend, dan database dalam satu alur. [Checklist AC](../specs/0003-doctor-serve-aplikasi-nyata/verify.md) mencatat setiap status dan batas buktinya.

## Deadline readiness dan gate terbaru 2026-10-03

Reproduksi lokal memakai backend fixture yang menunggu 120 ms sebelum mengembalikan JSON sehat, dengan deadline readiness 25 ms. Implementasi menerima readiness setelah 124 ms. Penyebabnya, timer probe selalu 1,5 detik dan keberhasilan probe tidak diperiksa lagi terhadap deadline. `waitForReadiness` sekarang membatasi timer probe dengan waktu tersisa, memeriksa deadline sebelum menyatakan siap, dan membatasi jeda polling pada sisa waktu.

Regression test TOOL-006 menunda respons sehat 300 ms dengan deadline 80 ms dan memastikan layanan ditolak. `bun run test:tooling` lulus **29 test, 79 assertion, 0 gagal, 0 dilewati**. JUnit terbaru tersimpan di [evidence 0005](evidence/0005/tooling.xml).

Setelah perbaikan deadline, `bun run test:tooling:real` lulus kembali: 12 pemeriksaan database runtime, seluruh kasus privilege dan migration negatif, backend `/api/status` HTTP 200, frontend `/` HTTP 200 `text/html`, serta pelepasan listener 8888 dan 8889 setelah SIGTERM. `bun run test:ci` juga lulus pada working tree ini: 31 ID skenario, API/SDK dua run identik, frontend 1/1, integration 81/81 dengan 172 assertion, tooling 29/29 dengan 79 assertion, dan Playwright 4/4. Build frontend tetap memperingatkan initial bundle 654,09 kB terhadap budget 500 kB.

Pemeriksaan ini memperbaiki satu pelanggaran batas waktu AC-4 dan membuktikan regresinya. AC-9 masih belum terpenuhi karena browser belum menjalankan alur Feature 10 melalui SDK, proxy, backend, dan database; Scope 2 tetap `in-progress`.

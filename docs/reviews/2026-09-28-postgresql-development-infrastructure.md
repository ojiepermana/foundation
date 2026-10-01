# Review, main, 2026-09-28

**Reviewed by**: Claude Sonnet (author on Claude Opus)
**Scope**: 17 files, commits `d9ae256..8baedf6` (`b777510`, `b20a39b`, `8baedf6`)
**Verdict**: Changes requested

## Summary

Fitur ini memberi Anda image PostgreSQL 18 buatan sendiri di atas Oracle Linux 10 slim dengan paket PGDG, entrypoint minimal dengan inisialisasi staging atomik, Compose yang hanya mengelola infrastruktur, dan suite `bun:test` terisolasi INFRA-001 sampai INFRA-006. Saya membangun ulang langkah verifikasi kunci Dockerfile (rantai fingerprint GPG PGDG untuk `aarch64`) langsung di container Oracle Linux dan hasilnya cocok persis dengan konstanta di kode, jadi bagian paling sensitif dari perubahan ini terbukti benar, bukan sekadar terlihat benar. Entrypoint, docker-compose.yml, dan suite test juga konsisten dengan spec 0002 serta aturan project. Satu temuan Major: `docs/scope/scope.md` dan `verify.md` masih melaporkan suite lulus 11/11, padahal komit terakhir menambah 5 test baru sehingga suite sebenarnya berisi 16 test, dan bukti nyata di `.local/feature-3/infrastructure.xml` sendiri menunjukkan 16/16. Selain itu ada satu celah kecil pada bukti otomatis untuk AC-3.

## Major

### 🟠 Jumlah test yang dilaporkan lulus tidak sesuai dengan suite sebenarnya, `docs/scope/scope.md:89` dan `docs/specs/0002-infrastruktur-postgresql-development/verify.md:55`

**Problem**: Kedua dokumen ini menyatakan suite `bun run test:infrastructure` lulus "11/11" atau "11 pass, 0 skip, 0 fail". Saat komit `b20a39b` dibuat, itu benar, `tests/integration/infrastructure/postgres.test.ts` memang berisi 11 test. Tetapi komit terakhir `8baedf6` ("cover init guards, secret leaks, and daemonless skips") menambah 5 test baru (INFRA-005 nested tanpa daemon, INFRA-003 password tidak muncul di log, INFRA-003 zona waktu, INFRA-006 password env berubah diabaikan, INFRA-006 password pendek/identifier tidak valid), sehingga file test sekarang berisi 16 test. Komit itu memperbarui centang `/test` di `scope.md` tetapi tidak memperbarui angka "11/11" di baris yang sama, dan tidak menyentuh `verify.md` sama sekali. Bukti nyata yang Anda simpan sendiri di `.local/feature-3/infrastructure.xml` (dibuat 11:43, sebelum commit 11:50) memang menunjukkan `tests="16" failures="0" skipped="0"`, jadi eksekusi sebenarnya benar dan lengkap, hanya narasinya yang tertinggal.

**Why it matters**: `docs/rules/testing.md` menetapkan "status test tetap mencerminkan hasil sebenarnya" sebagai aturan keras, dan scope.md adalah dokumen yang dipakai `/sync` serta reviewer berikutnya sebagai sumber kebenaran tanpa menjalankan ulang suite. Siapa pun yang membaca scope.md atau verify.md saja (tanpa membuka `.local/feature-3/`, yang memang tidak masuk git) akan mengira hanya ada 11 skenario terbukti, bukan 16, dan tidak tahu bahwa lima pemeriksaan penting (termasuk pembuktian bahwa skenario tanpa daemon dilaporkan dilewati, bukan lulus, yaitu tepat hal yang dilarang testing.md) baru ditambahkan belakangan.

**Suggested fix**: Perbarui angka di `scope.md:89` dan checklist AC-8 di `verify.md:55` menjadi 16 pass, 0 skip, 0 fail, dan sebutkan lima skenario yang ditambahkan komit terakhir. Jadikan kebiasaan menjalankan ulang suite serta menyegarkan angka evidence setiap kali `/test` menambah test, sebelum menandai langkah scope selesai.

## Minor

### 🟡 Test AC-3 "password lama tetap berlaku" tidak membuktikan separuh kedua klaimnya, `tests/integration/infrastructure/postgres.test.ts:435`

**Problem**: Test `INFRA-006 cluster yang ada tidak diinisialisasi ulang saat password di env berubah` membuktikan `system_identifier` tidak berubah dan password baru ditolak (`rejection(main, replacement)`), tapi tidak pernah menyambung ulang dengan `main.password` (password lama) untuk membuktikan itu masih diterima. `verify.md:25` secara eksplisit meminta dua hal, "password lama tetap berlaku, password baru ditolak", tetapi versi otomatisnya hanya membuktikan bagian kedua.

**Why it matters**: Kalau suatu saat perubahan pada entrypoint atau image secara tidak sengaja merusak role SCRAM lama (misalnya efek samping dari perubahan lain yang tidak menyentuh `system_identifier`), suite ini tetap hijau karena tidak ada assertion yang gagal untuk kasus itu. Celah ini kecil karena invariannya kuat dari desain (`initialize()` tidak pernah dipanggil ulang), tapi tetap sebuah kriteria AC yang dinyatakan lulus tanpa bukti otomatis penuh.

**Suggested fix**: Tambahkan satu `connect(main)` dengan password asli (default) dan `SELECT 1` yang berhasil, sebelum atau sesudah pemeriksaan `rejection`, di dalam test yang sama.

## Nits

- ⚪ `tests/integration/infrastructure/postgres.test.ts:360`, urutan test "password tidak muncul di log" bergantung pada dijalankan sebelum INFRA-004 (sudah dikomentari di kode), aman karena `bun:test` menjalankan test dalam satu file secara berurutan, tapi kerapuhan ini pantas disebut juga di `verify.md` supaya perubahan urutan test di masa depan tidak diam diam merusak asumsi ini.

## Strengths

- Rantai verifikasi GPG PGDG di `infrastructure/postgres/Dockerfile:16-37` benar benar saya jalankan ulang di container `oraclelinux:10-slim` untuk arsitektur `aarch64`: fingerprint SHA1 yang dihitung dari key yang diunduh cocok persis dengan konstanta di Dockerfile, key ID pendek yang terimpor (`b9738825`) cocok dengan delapan karakter terakhir fingerprint, dan `rpmkeys --checksig` lulus. Ini bukan asumsi, ini terbukti jalan.
- Pola staging plus `mv -T` atomik di `docker-entrypoint.sh:14-57`, ditambah `rmdir /var/lib/pgsql/18/data` di akhir Dockerfile, secara benar mencegah folder data kosong bawaan paket dianggap sebagai cluster valid saat volume baru dipasang, sebuah detail halus yang mudah terlewat tapi sudah ditangani dan diuji (INFRA-006).
- Suite test memakai project name unik, port bebas, dan password acak per run (`createStack()`), menutup dengan cleanup berpagar (`assertTestProject`) yang menolak menghapus apa pun di luar awalan `foundation-infra-test-`, dan test "INFRA-005 tanpa daemon" secara cerdas menjalankan file test itu sendiri sebagai proses bersarang untuk membuktikan bahwa tanpa Docker, skenario dilaporkan dilewati dengan alasan, bukan lulus diam diam.
- Validasi input di entrypoint (regex identifier untuk `POSTGRES_USER`/`POSTGRES_DB`, panjang minimum password, larangan baris baru) diuji langsung dengan payload yang menyerupai SQL injection (`foundation"; DROP DATABASE postgres; --`) dan payload itu ditolak sebelum pernah menyentuh `postgres --single`.

## Test coverage

Suite `tests/integration/infrastructure/postgres.test.ts` (16 test, dijalankan nyata dengan Docker menurut `.local/feature-3/infrastructure.xml`, 0 gagal 0 dilewati) menutup AC-1 sampai AC-8 secara otomatis: build terkunci dan identitas image, konfigurasi cluster (locale, encoding, timezone, checksums, aturan `pg_hba`), koneksi admin dan penolakan password salah, persistensi lewat `system_identifier`, shutdown tertib, inisialisasi staging yang terputus, `PGDATA` rusak, batas secret di Git/Bun/log, dan cleanup yang hanya menyentuh resource project uji. AC-9 (dokumentasi) diperiksa manual, dan saya membaca ketiga file yang disebut (`docs/rules/infrastructure.md`, `docs/rules/database.md`, `README.md`) serta mengonfirmasi tidak ada lagi rujukan ke image resmi `postgres:18` sebagai image yang dipakai di ketiganya.

Dua kesenjangan bukti tercatat di atas: angka pass yang dilaporkan di `scope.md`/`verify.md` tidak sesuai suite sebenarnya (Major), dan test AC-3 untuk "password lama tetap berlaku" belum membuktikan separuh klaimnya secara otomatis (Minor). Reproduksibilitas AC-2 (dua build terkunci menghasilkan digest dan versi sama) dibuktikan manual di `.local/feature-3/reproducibility.json`, bukan oleh suite otomatis, ini konsisten dengan desain spec dan terdokumentasi, bukan celah tersembunyi. Eksekusi `linux/amd64` memakai emulasi Docker Desktop di Mac arm64, bukan runner amd64 native, dan ini sudah didokumentasikan sebagai keterbatasan yang menunggu fitur 11 CI, sesuai aturan testing untuk melaporkan keterbatasan alih alih menyembunyikannya.

Saya tidak menjalankan `bun run test:infrastructure` penuh sendiri (build image dan pull berulang butuh waktu serta jaringan yang lebih dari yang wajar untuk review ini), tetapi saya memverifikasi langsung mekanisme keamanan paling kritis (rantai fingerprint GPG) dengan container nyata, dan membandingkan hasilnya dengan bukti evidence yang sudah direkam pengembang. Docker tersedia dan dipakai untuk verifikasi ini; tidak ada container, volume, atau network baru yang tersisa setelah review (hanya `docker run --rm` yang membersihkan diri sendiri).

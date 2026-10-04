# Review, main, 2026-10-04

**Reviewed by**: Sonnet 5.5 (author on opus)
**Scope**: 10 file, uncommitted (9 diubah dan 1 baru menurut `git diff HEAD` plus `git ls-files --others --exclude-standard`; dasar `b1ae733c5ca55cc865ef367bbe8c3d58383dc0b2`). Diff hanya memuat test, registry, bukti, dan dokumen. Karena review ini mencakup seluruh fitur 2 (AC-1 sampai AC-9 spec 0003), reviewer juga membaca kode yang tidak berubah: `scripts/doctor.ts`, `scripts/serve.ts`, `scripts/lib/`, `config/development.json`, dan `apps/backend/src/index.ts`.
**Verdict**: Approve with nits

## Summary

Perubahan ini menutup fitur 2: smoke nyata `doctor-smoke.ts` kini menjalankan alur browser READY-009 terhadap `serve` pada PostgreSQL 18 terisolasi (penjaga container fitur 10, `playwright.real.config.ts`, pemindaian credential), 12 test fixture baru mengunci langkah verifikasi yang tadinya manual, registry TOOL-007 memetakan AC-9, dan dokumen bukti ikut diperbarui. Reviewer tidak menemukan blocker maupun major. Semua yang reviewer jalankan sendiri cocok dengan laporan: `test:tooling` 41 test lulus, smoke nyata lulus dengan bersih, dan 12 mutasi pada kode `scripts/` tertangkap test. Temuan yang tersisa ada tujuh minor: daftar pemakai penjaga READY-010 belum memuat smoke, batas 60 detik tidak terkunci test, penutupan pool pada AC-8 belum punya bukti, tidak ada gerbang tipe untuk dua file test, `verify.md` masih memuat verdict FAIL, pesan peringatan port pada doctor menyesatkan, dan Ctrl+C saat preflight meninggalkan lock.

## Minor

### 🟡 Daftar pemakai penjaga READY-010 belum memuat smoke yang kini membuat dan menghapus container, `tests/integration/contract/readiness-container.test.ts:188`

**Problem**: `guardUsers` adalah daftar "setiap file yang menjalankan Docker pada container readiness" (empat file). `tests/integration/tooling-real/doctor-smoke.ts` sekarang membuat container dengan `...READINESS_RUN_LABEL_ARGS` (baris 421) dan menghapusnya dengan `docker rm -f` lewat `removeContainer()` (baris 95 sampai 104), tetapi tidak ada di daftar. Rationale spec 0006 (keputusan 46) menyebut "ketiga pemakai", jadi fitur 2 menambah pemakai keempat tanpa mendaftarkannya. Isi file itu saat ini memenuhi semua pemeriksaan READY-010 (impor modul penjaga, `...READINESS_RUN_LABEL_ARGS`, `readinessContainerMissing(`, tanpa teks `com.docker.compose.`), jadi mendaftarkannya tidak akan membuat test gagal hari ini.

**Why it matters**: Penjaga ada supaya tidak ada harness yang pernah menghapus PostgreSQL Compose bersama. READY-010 berjalan di `test:ci` dan menjaga bahwa setiap pemakai tetap lewat penjaga. File yang paling baru memanggil `docker rm -f` justru tidak dilihatnya, sedangkan `test:tooling:real` tidak ikut `test:ci`. Perubahan nanti pada `removeContainer()` (misalnya menyalin aturan label sendiri atau menghapus berdasarkan filter nama) lolos gate default.

**Suggested fix**: Tambah satu entri `{ file: 'tests/integration/tooling-real/doctor-smoke.ts', usesRunLabelArgs: true, removes: true }` pada `guardUsers`, lalu ubah kata "ketiga pemakai" pada spec 0006 lewat `/sync` atau `/document`.

### 🟡 Batas 60 detik pada AC-4 tidak terkunci oleh test mana pun, `scripts/serve.ts:125`

**Problem**: Batas startup 60 detik hanya ada sebagai literal `60000` di `scripts/serve.ts:125` dan `scripts/lib/readiness.ts:42`. Semua test TOOL-006 menyuntikkan batas kecil sendiri (misalnya 80 ms), dan jalur `main()` yang memakai nilai bawaan tidak pernah dijalankan sampai habis waktu. Reviewer mengubah kedua literal menjadi `6000000` (100 menit) pada salinan di scratchpad di luar repository: seluruh 41 test `test:tooling` tetap lulus.

**Why it matters**: Spec menyatakan batas itu "ditetapkan oleh tooling, bukan environment yang dapat melemahkan gate secara diam diam" (Configuration required) dan AC-4 menyebut 60 detik. Layanan yang macet bisa digantung ratusan kali lebih lama tanpa satu test pun gagal.

**Suggested fix**: Ekspor satu konstanta (misalnya `STARTUP_TIMEOUT_MS = 60000`) yang dipakai `supervise` dan `waitForReadiness`, lalu tambah satu test yang menyatakan nilainya 60000 dan bahwa `supervise` tanpa opsi `timeoutMs` meneruskan nilai itu ke `waitForReadiness` (misalnya lewat parameter injeksi). Test tidak perlu menunggu 60 detik sungguhan.

### 🟡 Bagian AC-8 tentang penutupan pool database belum punya bukti, `tests/integration/tooling-real/doctor-smoke.ts:313`

**Problem**: AC-8 menyebut resource backend, termasuk pool database ketika tersedia, ditutup oleh lifecycle backend. Smoke memeriksa exit 143 dan 130, kedua grup proses, port 8888 dan 8889, serta lock, tetapi tidak memeriksa bahwa sesi `foundation_backend` hilang dari PostgreSQL setelah shutdown, dan tidak memeriksa baris `Backend stopped` dari `apps/backend/src/index.ts:27`, padahal keluaran `serve` sudah ditangkap di `run.output()`. Laporan 0005 dan `verify.md` tidak mengklaim bagian ini, tetapi registry memetakan AC-8 ke TOOL-004 dan TOOL-006, dan scope menandai AC-8 selesai.

**Why it matters**: Handler SIGTERM backend (`pool.close({ timeout: 1 })` dengan batas 5 detik) adalah satu satunya penutup pool. Backend dijalankan dengan `bun --watch` di bawah `serve`, dan reviewer tidak mengamati apakah handler itu sungguh berjalan pada shutdown grup. Bila handler tidak berjalan, koneksi baru tertutup ketika proses mati dan tidak ada yang gagal.

**Suggested fix**: Setelah SIGTERM pada `serveRealApplication`, buka koneksi admin baru dan periksa `pg_stat_activity` tidak memuat sesi `foundation_backend` dari `serve` itu, lalu periksa keluaran memuat `Backend stopped` bila pengamatan manual membuktikan baris itu memang muncul. Bila tidak sempat, catat di `verify.md` bahwa bagian ini belum terbukti pada fitur 2, sesuai AC-9 yang meminta hasil yang belum terbukti dicatat.

### 🟡 Dua file test tooling belum punya gerbang tipe, `tsconfig.contract.json:11`

**Problem**: `tests/integration/tooling-real/doctor-smoke.ts` (menjalankan `docker run`, `docker rm -f`, dan mengirim SIGTERM serta SIGINT ke `serve`) dan `tests/integration/tooling/development.test.ts` tidak termasuk `typecheck:backend`, `typecheck:contract`, maupun `typecheck:e2e`. Bun dan Playwright membuang tipe tanpa memeriksanya. Laporan 0005 mencatat ini sebagai batas bukti. Reviewer menjalankan `tsc --noEmit --strict` dengan `types: ["bun"]` pada kedua file lewat tsconfig sementara di scratchpad: satu satunya kesalahan adalah `development.test.ts(499,60)`, yaitu `server.port` bertipe `number | undefined` pada test lama TOOL-006.

**Why it matters**: Review fitur 10 sudah mencatat celah yang sama untuk file readiness dan ditutup dengan `tsconfig.e2e.json`. File ini memanggil penghapus container di belakang penjaga, jadi kesalahan tipe pada argumen pemilik atau hasil `JSON.parse` tidak akan gagal di gate mana pun.

**Suggested fix**: Buat tsconfig kecil (misalnya `tsconfig.tooling.json`, `strict` tanpa `noUncheckedIndexedAccess`, `types: ["bun"]`) dengan kedua file, tambah script `typecheck:tooling` ke `test:ci`, dan perbaiki baris 499 (`server.port!` atau penjaga). Jangan menaruhnya di `tsconfig.contract.json`: laporan 0005 mencatat `scripts/doctor.ts` dan `scripts/lib/development.ts` yang diimpor sudah gagal di bawah flag itu, dan reviewer tidak mencoba file ini dengan flag tersebut.

### 🟡 `verify.md` masih memuat verdict FAIL dan status lama walaupun scope sudah mencentang Verifikasi, `docs/specs/0003-doctor-serve-aplikasi-nyata/verify.md:32`

**Problem**: Bagian atas (hasil 2026-10-03) masih menulis TOOL-007 `Parsial`, `AC-9: belum terpenuhi` (baris 30), dan `Verdict /check verify: FAIL ... kotak Verify tidak ditandai selesai` (baris 32), serta hasil runner 29 test pada baris 36 sampai 40. Bagian baru "Langkah verifikasi dari /develop" (baris 42 sampai 66) hanya berisi kotak yang dicentang, tanpa hasil yang diamati, tanpa tabel status skenario terbaru, dan tanpa verdict baru. Kalimat pembukanya malah menyatakan bagian atas "tidak diubah". Scope sudah mencentang `Verifikasi`.

**Why it matters**: Satu satunya catatan verifikasi fitur 2 menyatakan gagal, bertentangan dengan scope, dengan laporan 0005, dan dengan semua yang reviewer jalankan. Pembaca atau `/sync` yang mengandalkan file ini akan menyimpulkan fitur 2 belum lolos. Pola yang sama muncul pada review fitur 8, 9, dan 10.

**Suggested fix**: Tambahkan bagian bertanggal 2026-10-04 di `verify.md` dengan tabel status TOOL-001 sampai TOOL-008, konformansi AC-1 sampai AC-9 (AC-5 tetap fixture saja, bukti hanya macOS), hasil runner terkini (41 test dan 151 assertion, dua run smoke), dan verdict baru. Cocok dikerjakan bersama `/document`.

### 🟡 Pesan peringatan port pada doctor menjanjikan pembersihan yang tidak dilakukan `serve`, `scripts/doctor.ts:49`

**Problem**: Untuk port yang sedang dipakai doctor menulis "Sedang dipakai; serve akan membersihkannya setelah preflight lulus." AC-6 dan `development-commands.md` hanya mengizinkan `serve` mengganti proses Foundation lama dari checkout yang sama, dan listener lain membuat startup gagal. Smoke TOOL-002 membuktikan keduanya pada aplikasi nyata: doctor memberi peringatan itu untuk listener asing pada 8889, lalu `serve` menolaknya dengan `Listener port bukan proses Foundation lama dari checkout ini.` Tidak ada test yang mengunci kalimat itu.

**Why it matters**: Pengembang yang membaca keluaran doctor akan mengira `serve` menghentikan proses apa pun pada port itu, misalnya server lain di 8889, lalu bingung ketika startup gagal tanpa membersihkan apa pun.

**Suggested fix**: Ubah kalimatnya menjadi sesuai aturan, misalnya "Sedang dipakai; serve hanya menggantikan proses Foundation lama dari checkout ini dan gagal bila pemiliknya lain."

### 🟡 Ctrl+C saat preflight meninggalkan lock yang seharusnya dilepas, `scripts/serve.ts:146`

**Problem**: Handler SIGINT dan SIGTERM baru dipasang di dalam `supervise()` (baris 88 dan 89). Selama preflight (doctor dapat memakai sampai 10 detik untuk `ng version` ditambah 5 detik untuk database) dan selama `clearPorts`, sinyal mematikan proses tanpa menjalankan `finally` yang memanggil `invocation.release()`. Reviewer mereproduksi di scratchpad dengan salinan `scripts/` dan listener TCP yang diam sebagai database: `serve` keluar 130 dan `.local/serve.lock` tertinggal. `serve` berikutnya memulihkannya sebagai catatan lama tanpa pesan salah, jadi tidak ada gangguan langsung. Dari pembacaan kode (tidak direproduksi): bila sinyal datang saat `clearPorts` menunggu setelah SIGTERM ke grup lama, direktori `serve.stale.<uuid>` tidak pernah dipulihkan, sehingga grup lama yang mengabaikan SIGTERM kehilangan catatannya dan run berikutnya hanya bisa meminta penghentian manual. Hasilnya gagal aman, bukan berbahaya.

**Why it matters**: State transitions spec menyebut setiap kegagalan sebelum `services starting` melepaskan catatan invocation, dan `development-commands.md` menyebut lock dilepas setelah shutdown. AC-8 menyebut Ctrl+C. Tidak ada test yang mengirim sinyal pada fase ini, jadi perilakunya tidak terkunci.

**Suggested fix**: Pasang handler sinyal sebelum mengambil lock, atau bungkus fase preflight dan cleanup agar `invocation.release()` (yang juga memulihkan direktori lama) berjalan pada sinyal. Tambah satu test CLI di checkout sementara dengan listener diam seperti probe reviewer. Bila diterima sebagai batas, catat di `development-commands.md`.

## Nits

- ⚪ `tests/integration/tooling-real/doctor-smoke.ts:198`, jalur SIGKILL pada `stopServe` hanya mematikan `serve`. Grup yang sudah tercatat (`groups`, baris 273) tidak dihentikan, jadi bila `serve` macet, `ng serve` dan backend tertinggal di 8888 dan 8889, dan run berikutnya gagal pada "Port ... must be free" tanpa petunjuk. Kirim SIGKILL ke grup tercatat yang identitasnya masih cocok, atau cetak PID grupnya.
- ⚪ `tests/integration/tooling-real/doctor-smoke.ts:107`, `freePort()` menutup server sebelum `docker run -p` memakai port itu. Kemungkinan bentrok kecil, tetapi bila ada proses lain mengambilnya, `docker run` gagal dengan pesan generik. Satu percobaan ulang atau komentar cukup.
- ⚪ `tests/integration/tooling-real/doctor-smoke.ts:58`, `BASE_ENV_KEYS`, `parsedLabels` (baris 90), dan `freePort` kini disalin di empat file. Nit yang sama sudah ada pada review fitur 10 dan bertambah satu salinan. `parsedLabels` murni dan dapat tinggal di modul penjaga.
- ⚪ `scripts/doctor.ts:80`, syarat PostgreSQL minimal 18 pada AC-1 tidak punya kasus negatif (smoke memakai satu image versi 18). Risiko rendah karena satu perbandingan, tetapi tidak ada yang berubah bila angka `180000` diganti.
- ⚪ `scripts/serve.ts:130`, saat layanan keluar selama startup, keluaran memuat "Startup dibatalkan." sesudah "<layanan> berhenti (3); menghentikan layanan lainnya." (terlihat pada keluaran `test:tooling`). Pesan kedua berasal dari pembatalan internal dan menyesatkan.
- ⚪ `docs/rules/testing.md:167`, baris `test:tooling:real` menyebut hanya TOOL-001 dan TOOL-007, padahal registry kini memetakan smoke juga ke TOOL-002, TOOL-004, dan TOOL-005.
- ⚪ `docs/rules/development-commands.md`, akhir bagian "Kriteria verifikasi tooling" masih melarang port aplikasi nyata untuk test penghentian proses dan tidak menyebut `test:tooling:real`, yang memakai 8888 dan 8889 (hanya bila keduanya kosong, dan hanya menghentikan `serve` miliknya sendiri). Tambahkan satu kalimat pengecualian.
- ⚪ `AGENTS.md:13`, kalimat bahwa `serve` "membersihkan listener pada port layanan terpilih" belum memuat batas AC-6 (hanya proses Foundation lama dari checkout yang sama). Pengingat untuk `/sync`.
- ⚪ `docs/testing/0005-doctor-serve-real-smoke.md:17`, laporan berupa log bertanggal, tetapi judul "Bukti sementara" dan bagian "Batas bukti" di atas masih menyatakan TOOL-007 parsial tanpa ringkasan status akhir. Pembaca yang berhenti di bagian atas salah menyimpulkan. Satu paragraf ringkasan di awal cukup, cocok untuk `/document`.

## Strengths

- Smoke nyata disusun dengan hati hati. Container mengikuti penjaga READY-009 (nama, label, pemeriksaan image sebelum `docker run`, penghapusan selalu lewat nama, inspect, lalu label), credential acak per run, Docker dan Playwright hanya menerima allow list environment tanpa `DATABASE_URL`, dan artefak ditulis ke `.local/feature-2/` sehingga bukti fitur 10 tidak tersentuh (waktu ubah file di `.local/feature-10/` sama sebelum dan sesudah run reviewer). Pemindaian credential memeriksa semua keluaran langkah dan layanan, JUnit, serta setiap artefak Playwright, dan satu temuan menggagalkan run.
- Bukti bahwa doctor tidak menulis memakai kontrol positif: salinan migration yang identik lulus lebih dulu, baru file yang belum diterapkan ditambahkan, dan isi metadata serta komentar schema dibandingkan sebelum dan sesudah. Setiap perubahan hak diikuti pengembalian dan pemeriksaan bahwa doctor menerima database lagi.
- Test CLI fixture berjalan pada salinan `scripts/` di checkout sementara, sehingga tidak pernah mengambil `.local/serve.lock` milik repository dan tidak pernah memberi sinyal pada port 8888 atau 8889. Semua kasus serve yang gagal berhenti sebelum `clearPorts`.
- Test fixture baru tajam. Dari 12 mutasi pada salinan `scripts/` di scratchpad (izin file catatan dan direktori lock, pemeriksaan checkout dan pemimpin grup pada `recordGroup`, kebocoran error mentah pada doctor, pemeriksaan env worker, layanan yang keluar saat startup diabaikan, doctor sebelum lock, sinyal hanya ke grup pertama, batas waktu doctor, pemeriksaan port konfigurasi, dan worker tak dikenal diterima), seluruhnya tertangkap test. Satu mutasi yang tidak tertangkap adalah konstanta 60 detik (temuan minor kedua).
- Bukti dan angka jujur dan cocok dengan yang reviewer jalankan: SHA 256 kedua JUnit di `docs/testing/evidence/0005/` sama dengan laporan, keduanya lulus `xmllint`, tanpa atribut `hostname` dan tanpa path absolut, 41 test dan 151 assertion cocok dengan run reviewer, dan batas bukti (di luar `test:ci`, hanya macOS, bukan studi stabilitas, AC-5 hanya fixture) tertulis terang terangan.
- Registry memakai bentuk `checks` yang sudah didukung `validate-scenarios.ts`, dan TOOL-007 memetakan AC-9 ke pemeriksaan `playwright` yang sungguh ada di spec READY-009.

## Test coverage

Sinyal test **configured**. Reviewer membaca seluruh diff dan file baru, spec 0003 (`index.md`, `verify.md`, dan bagian yang relevan dari `rationale.md` serta spec 0006 yang mengatur penjaga container), `AGENTS.md`, `docs/rules/development-commands.md`, `scripts/doctor.ts`, `scripts/serve.ts`, `scripts/lib/*`, `apps/backend/src/index.ts`, `playwright.real.config.ts`, modul penjaga, dan test READY-010.

Perintah yang dijalankan reviewer dan hasilnya:

- `bun run test:scenarios`: lulus, 58 ID unik.
- `bun run test:tooling`: 41 pass, 0 fail, 151 assertion, 27,96 detik (angka laporan: 41 dan 151).
- `bun run test:tooling:real`: exit 0 dalam sekitar 23 detik. Keluaran memuat TOOL-001 (12 pemeriksaan database dan semua penolakan), TOOL-002 (listener asing), URL berurutan, TOOL-005 (catatan owner dan `serve` kedua), READY-009 `1 passed` di bawah `serve`, SIGTERM exit 143, Ctrl+C exit 130, doctor menolak database yang sudah dihapus, preflight `serve` berhenti dengan listener 8888 dan 8889 tetap menjawab, dan pemindaian credential: 6 nilai acak tidak ditemukan pada 11 keluaran dan 7 file. Sesudahnya tidak ada container `foundation-readiness-*`, port 8888 dan 8889 kosong, `.local/serve.lock` tidak ada, tidak ada proses `serve`, backend, atau `ng serve` tersisa, dan `git status --porcelain` sama dengan sebelum review.
- `tsc --noEmit --strict` (types bun) pada `doctor-smoke.ts` dan `development.test.ts` lewat tsconfig sementara di scratchpad: satu kesalahan, `development.test.ts(499,60)`.
- `doctor` tanpa `DATABASE_URL` (dengan `--no-env-file`): `[ERROR] Database backend: DATABASE_URL belum disediakan melalui environment lokal.` dan `Doctor belum lulus`. `serve` dengan `NODE_ENV=production` berhenti pada preflight tanpa menyisakan lock.

Probe tambahan di scratchpad di luar repository: 12 mutasi pada salinan `scripts/` dengan subset test `TOOL-001`, `TOOL-003`, `TOOL-005`, dan `TOOL-008` (hasil di bagian Strengths), satu mutasi konstanta 60 detik yang selamat dari seluruh 41 test (temuan minor kedua), dan satu reproduksi SIGINT saat preflight (temuan minor ketujuh). Mutasi sinyal hanya ke grup pertama sempat dilaporkan selamat pada dua dari empat run awal, karena salinan scratchpad terlihat kembali ke isi asli di tengah urutan (pada waktu yang sama ada proses `bun test` lain di repository ini yang bukan milik reviewer, dan penyebab pastinya tidak ditelusuri). Setelah diulang delapan kali dengan pemeriksaan bahwa pola terpasang, test "TOOL-003 a selected worker without a port counts as ready while it stays alive" gagal delapan dari delapan (timeout 20 detik), jadi mutasi itu dihitung tertangkap.

Tidak dijalankan reviewer: `test:ci` penuh, `build:frontend`, `check:frontend:bundle`, `test:e2e`, `test:frontend`, dan `api:check`, sehingga angka 630 integration test, 79 test frontend, 12 Playwright, dan 115 sampai 124 detik pada laporan mengandalkan laporan. Klaim 11 run smoke berturut turut dari sesi sebelumnya juga tidak diulang, hanya satu run reviewer. Tidak ada mutasi pada smoke nyata (membutuhkan salinan lengkap repository dengan `node_modules` dan identitas proses berbasis checkout), sehingga ketajaman pemeriksaan negatif di smoke dinilai dari pembacaan: setiap kasus memeriksa nama check dan status `error` yang spesifik, dan ada pemeriksaan pulih yang positif.

Cakupan fitur ini kuat: setiap AC punya skenario fixture, bukti nyata, atau keduanya. Celah yang tersisa adalah konstanta 60 detik (minor kedua), penutupan pool (minor ketiga), sinyal saat preflight (minor ketujuh), kasus negatif versi PostgreSQL (nit), gerbang tipe (minor keempat), dan pendaftaran smoke pada READY-010 (minor pertama).

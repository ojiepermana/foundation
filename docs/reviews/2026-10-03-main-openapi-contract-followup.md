# Review ulang, main, 2026-10-03

**Reviewed by**: Sonnet 5.5 (author on opus)
**Scope**: 21 file, uncommitted (8 diubah dan 13 baru menurut `git diff HEAD` plus `git ls-files --others --exclude-standard`; dasar `f5321ebd589b17ca8a4a2383df77e72715e5ba86`)
**Verdict**: Approve with nits

## Summary

Review ulang ini memeriksa perbaikan atas [review sebelumnya](2026-10-03-main-openapi-contract.md) dan atas daftar temuan di laporan perbaikan, lalu membaca ulang seluruh diff. Temuan major (ekspor yang gagal dapat mengganti `openapi.json` atau meninggalkan file sementara) sudah selesai: exporter menunggu satu giliran timer, lalu menulis dan rename secara sinkron, dan reviewer menjalankan kasus gagal 60 kali di bawah beban CPU tanpa satu pun kegagalan. Semua temuan minor sebelumnya selesai, satu di antaranya (timeout `run()`) baru selesai sebagian. Reviewer tidak menemukan blocker maupun major baru. Temuan baru berupa tiga minor: exporter tidak pernah keluar sendiri bila komposisi meninggalkan handle yang hidup, timeout `run()` tidak menghentikan proses script yang sebenarnya, dan satu butir checklist verifikasi yang belum dicentang serta sudah tidak sesuai dengan kode.

## Status temuan sebelumnya

File review sebelumnya hanya memuat tiga minor dan empat nit. Laporan perbaikan memuat daftar yang lebih panjang (satu major dan dua belas minor) dari putaran review yang tidak tersimpan di `docs/reviews/`. Reviewer memeriksa kedua daftar terhadap kode, test, dan dokumen saat ini.

### Dari file review sebelumnya

| Temuan | Status | Bukti reviewer |
| --- | --- | --- |
| Minor: laporan bukti dan JUnit masih mencatat 373 test | Selesai | Reviewer menjalankan ulang JUnit: 404 test, 1.084 assertion, 0 gagal. Bedanya dengan `docs/testing/evidence/0007/openapi-contract.xml` hanya atribut `time` dan `hostname`. Jumlah per skenario (12, 155, 143, 51, 26, 11, 6) cocok dengan tabel laporan, dan ketiga checksum SHA-256 cocok dengan file. |
| Minor: cabang pertahanan baca file, `!response.ok`, dan `uncaughtException` tanpa test | Selesai | Test preload `stat` (`openapi-contract.test.ts:395`) menguji bound baca dan file biasa sesudah open, dua kasus ekspor `/openapi/json` (baris 259 sampai 263) menguji respons bukan 200 dan bukan JSON, dan kasus timer tanpa jeda (baris 254) menguji `uncaughtException`. Keterbatasan bahwa `handle.stat()` tidak dapat dibedakan dari bound baca tercatat jujur di laporan bukti dan `rationale.md`. |
| Minor: tidak ada gate CI yang memeriksa tipe `scripts/` dan `tests/` | Selesai untuk file fitur ini | `tsconfig.contract.json` dan script `typecheck:contract` masuk `test:ci`; reviewer menjalankannya dan hasilnya exit 0. Penolakan cakupan yang lebih luas terbukti: `tsc` strict atas seluruh `scripts/` dan `tests/integration/` gagal pada file milik fitur lain (`scripts/serve.ts` 18 error, `tests/integration/tooling/development.test.ts` 14, `scripts/doctor.ts` 8, `tests/integration/infrastructure/postgres.test.ts` 7), sedangkan file fitur 8 bersih. Kewajiban itu belum ditulis di scope fitur 11 (lihat nit). |
| Nit: pola `openapi.json.*.tmp` belum ada di `.gitignore` | Selesai | Pola ditambahkan di `.gitignore:12`. |
| Nit: timeout 15.000 ms pada test kontrol negatif `Bun.sql` | Belum | Masih `15_000` di `openapi-contract.test.ts:192`. |
| Nit: `toHaveLength(16)` dan `recipe.length` bernilai 6 | Belum | Masih ada di baris 1514 dan 1552. |
| Nit: pohon `Lokasi file` belum memuat `scripts/lib/canonical-json.ts` | Belum | `docs/rules/openapi-sdk.md:28` dan `:29` tidak berubah. |

### Dari daftar laporan perbaikan

| Temuan | Status | Bukti reviewer |
| --- | --- | --- |
| Major: handler proses keluar saat tulis atau rename masih berjalan | Selesai | `scripts/export-openapi.ts:53` sampai `:58`: `exportText()`, satu `setTimeout(resolve, 0)`, lalu `writeAtomically()` yang hanya memakai `writeFileSync` dan `renameSync`, jadi tidak ada titik yield di tengah penulisan. Reviewer menjalankan 10 kasus gagal sebanyak 6 kali dengan 12 proses `yes` sebagai beban: 60 lulus, 0 gagal. Setiap kasus memeriksa inode, mtime, dan ketiadaan file sementara. Celah sisa (exception dari timer berjeda sesudah rename) tertulis di invariant 6 spec dan di batas bukti, jadi bukan temuan. |
| Minor: tidak ada test yang gagal bila exporter berhenti memakai file sementara dan rename | Selesai | OPENAPI-001 mencatat inode placeholder dan menuntut inode berbeda sesudah ekspor yang berhasil (`openapi-contract.test.ts:133` dan `:139`). |
| Minor: batas byte ekspor tidak diuji di batas dan untuk teks multibyte | Selesai | Test di baris 306 menulis tepat 8.388.608 byte, menolak 8.388.609 byte, dan menolak teks `é` yang di bawah 8 Mi karakter tetapi di atas 8 MiB. |
| Minor: byte order mark dibuang `TextDecoder` | Selesai | `validate-openapi.ts:533` memakai `{ fatal: true, ignoreBOM: true }`, dan baris input gagal untuk file ber BOM ada di test baris 447. |
| Minor: segmen titik `.` dan `..` lolos rule `path` | Selesai | `validate-openapi.ts:140`; empat path baru di matriks (baris 577) dan satu baris penerimaan untuk segmen yang hanya memuat titik di dalam nama (baris 942). |
| Minor: operasi tanpa `security` mewarisi `security: []` dokumen | Selesai | `validate-openapi.ts:479` sampai `:482`. Keputusan agent atas delegasi pemilik tercatat di `rationale.md` dengan dua opsi yang ditolak, dan spec, aturan proyek, serta matriks (baris 857 sampai 860 dan 897) konsisten. `status.routes.ts:10` sudah mendeklarasikan `security: []`. |
| Minor: `api:openapi` dan `api:validate` memuat `.env` | Selesai | `package.json:23` dan `:24` memakai `bun --no-env-file`. Test OPENAPI-007 (baris 1574) memakai `.env` bersentinel dengan kontrol negatif tanpa flag. |
| Minor: guard preload membiarkan klien Redis, S3, dan `net.Socket.prototype.connect` | Selesai sesuai batas | Semuanya kini dijaga dan diuji lewat probe. `Bun.fetch`, `Worker`, `Bun.spawn`, `node:child_process`, dan DNS tetap tidak dijaga, dan hal itu tertulis di header preload, invariant 1, dan batas bukti. |
| Minor: tidak ada typecheck untuk `scripts/` dan `tests/` | Selesai | Lihat baris tiga tabel di atas. |
| Minor: uji waktu AC-4 berjalan sinkron di proses test | Selesai | `timedCheck()` (baris 1032) menjalankan checker di subprocess yang dibunuh setelah 10 detik. Rantai `items` 200.000 tingkat masih berjalan di proses test, tetapi kegagalannya cepat (`RangeError`) dan bukan hang. |
| Minor: `run()` tanpa timeout | Selesai sebagian | Timeout 30 detik ada, tetapi tidak menghentikan proses script yang sebenarnya (lihat temuan minor 2). |
| Minor: laporan bukti, JUnit, dan paragraf scope usang | Selesai | Lihat baris pertama tabel sebelumnya. |

Angka "sebelum perbaikan" di laporan perbaikan (10 dari 10 dan 22 dari 30 ekspor gagal mengganti file) dan hasil run mutasi tidak dijalankan ulang reviewer, karena itu membutuhkan pengembalian kode lama. Reviewer hanya memeriksa bahwa mekanismenya terbukti dari kode dan bahwa test yang dimaksud ada dan lulus.

## Minor

### 🟡 Exporter tidak pernah keluar sendiri bila komposisi meninggalkan handle yang hidup, `scripts/export-openapi.ts:53`

**Problem**: Sesudah ekspor berhasil atau gagal, script hanya mengisi `process.exitCode` dan menunggu event loop kosong. Reviewer menambahkan `setInterval(() => {}, 1000)` ke `createApp()` pada salinan workspace di scratchpad. Ekspor berhasil mencetak `OpenAPI exported without listener` dan `openapi.json` sudah diganti, tetapi proses tidak berhenti sampai dibunuh pada detik ke 5 (kode 137). Dengan `operationId` bertanda hubung, stderr tepat `OpenAPI export failed` dan `rule: operation-id`, tetapi proses tetap hidup dan exit 1 tidak pernah sampai ke pemanggil. Test kontrol negatif `Bun.sql` di file test (baris 180) mencatat gejala yang sama: tanpa guard, `Bun.sql` terus mencoba terhubung, dan proses harus dibunuh.

**Why it matters**: AC-6 menjanjikan exit code 1 untuk setiap kegagalan, tetapi `api:sync` di CI tidak punya batas waktu sendiri. Backend sekarang tidak membuka resource apa pun, jadi gejalanya belum terlihat. Fitur 10 menambah route yang memakai database, dan satu pool atau timer yang dibuat saat `createApp()` mengubah kegagalan kontrak atau ekspor yang berhasil menjadi job CI yang menggantung sampai timeout platform.

**Suggested fix**: Akhiri script dengan `process.exit` yang membawa kode akhir sesudah pesan tercetak, pada jalur berhasil (0) dan jalur gagal (1), seperti handler yang sudah memanggil `process.exit(1)`. Penulisan file sudah sinkron, jadi keluar paksa sesudahnya aman. Tambah test workspace dengan handle yang hidup dan harapkan exit 0 untuk ekspor bersih serta exit 1 untuk pelanggaran kontrak sebelum batas 10 detik, dengan stdout dan stderr yang sama persis. Catat perilaku ini di invariant 6 spec.

### 🟡 Timeout `run()` tidak menghentikan proses script dan pembacaan output tetap menunggu, `tests/integration/contract/workspace.ts:27`

**Problem**: `run()` menjalankan `bun run <script>` dengan `timeout: 30_000` dan `killSignal: 'SIGKILL'`. Sinyal itu hanya mengenai pembungkus `bun run`; proses script anaknya tidak ikut mati. Reviewer membuktikannya dengan probe di scratchpad: `bun run hang` (script `bun --no-env-file hang.ts` yang tidur 60 detik) dibunuh pada 1,5 detik, pembungkus mati dengan sinyal `SIGKILL`, tetapi proses anak masih hidup (`process.kill(pid, 0)` berhasil). Anak itu juga memegang ujung pipe stdout dan stderr, sehingga `Promise.all([p.exited, new Response(p.stdout).text(), ...])` masih menunggu setelah 8 detik.

**Why it matters**: Temuan sebelumnya meminta agar script yang menggantung gagal alih alih tertahan, dan komentar di baris 22 sampai 25 menyatakan itu. Untuk `sdk:generate` dan `api:sync` di workspace, yang terjadi sebenarnya adalah test baru gagal pada timeout `bun:test` (30 atau 60 detik) tanpa output, proses anak tetap berjalan, dan direktori workspace dihapus di bawahnya.

**Suggested fix**: Jalankan script dengan process group sendiri dan bunuh seluruh group pada timeout, atau jalankan perintah script langsung lewat `runBun` seperti test lain, atau batasi pembacaan output (batalkan stream sesudah `exited` ditambah masa tenggang). Tambah satu test dengan script yang menggantung dan harapkan `run()` selesai dekat 30 detik, atau lebih kecil dengan timeout yang dapat disetel, dan tidak ada proses tersisa.

### 🟡 Butir verifikasi AC-8 belum dicentang dan menyatakan hal yang sudah tidak benar, `docs/specs/0008-ekspor-pemeriksaan-kontrak-openapi/verify.md:98`

**Problem**: Ini satu satunya butir yang masih `- [ ]` di checklist. Isinya meminta `git status` tidak menunjukkan perubahan pada `package.json`, `bun.lock`, `apps/`, atau `database/`. Sesudah perbaikan, `package.json` memang berubah: `api:openapi` dan `api:validate` memakai `--no-env-file` dan ada script `typecheck:contract` di `test:ci`. Laporan bukti (`docs/testing/0007-openapi-contract.md`, baris AC-8) sudah menulis rumusan yang benar: dependency, `bun.lock`, `apps/`, dan `database/` tidak berubah, dan `package.json` hanya berubah pada script. Reviewer memeriksa `git diff HEAD` untuk `openapi.json`, `apps`, `bun.lock`, dan `database`, dan hasilnya kosong.

**Why it matters**: Checklist ini dipakai `/check verify`. Dijalankan apa adanya, butir itu gagal, atau tetap terbuka dan dibaca sebagai AC-8 belum terverifikasi, padahal buktinya ada di test OPENAPI-007 dan laporan.

**Suggested fix**: Ubah butir itu menjadi pemeriksaan yang benar (perubahan `package.json` hanya pada bagian `scripts`, tanpa dependency, `bun.lock`, `apps/`, atau `database/` yang berubah), jalankan, lalu centang. Pekerjaan ini cocok dikerjakan bersama `/document`.

## Nits

- ⚪ `tests/integration/contract/openapi-contract.test.ts:163`, test kontrol negatif `Bun.sql` masih memakai timeout 15.000 ms (baris 192), padahal satu run ber guard boleh memakan 10 detik, `waitFor` sampai 8 detik, dan proses tanpa guard dibunuh sesudahnya. Naikkan ke 30.000 ms seperti test lain yang menjalankan beberapa subprocess. Butir ini sudah ada di review sebelumnya dan belum ditindaklanjuti.
- ⚪ `tests/integration/contract/openapi-contract.test.ts:1514` dan `:1552`, `toHaveLength(16)` dan `recipe.length` bernilai 6 menggandakan kesamaan yang sudah diperiksa tepat di bawahnya, dan akan gagal tanpa alasan bila fitur 10 menambah butir resep secara sah. Pertimbangkan menghapusnya. Butir ini juga sudah ada di review sebelumnya.
- ⚪ `docs/rules/openapi-sdk.md:28`, pohon `Lokasi file` belum memuat `scripts/lib/canonical-json.ts`, padahal exporter bergantung padanya. Butir ini juga sudah ada di review sebelumnya.
- ⚪ `docs/foundation.md:1328`, kalimat bahwa `scripts/export-openapi.ts` menulis `openapi.json` melalui `Bun.write()` sudah tidak sesuai: exporter kini menulis file sementara lalu rename, dan `docs/rules/openapi-sdk.md` sudah diperbarui. Sesuaikan lewat `/sync` atau `/document`.
- ⚪ `docs/scope/scope.md` (fitur 11), saran review sebelumnya agar kewajiban typecheck yang lebih luas dicatat di scope fitur 11 baru terpenuhi sebagian: kewajiban itu hanya ada di `docs/testing/0007-openapi-contract.md` dan `rationale.md`. Tambahkan satu kalimat di fitur 11 bahwa `scripts/serve.ts`, `scripts/doctor.ts`, `scripts/test-database-real.ts`, `tests/integration/tooling/`, dan `tests/integration/infrastructure/` belum lulus `tsc` strict dengan `noUncheckedIndexedAccess`.
- ⚪ `docs/scope/scope.md:225`, paragraf `Kode tersedia` menautkan review sebelumnya sebagai sumber "satu temuan major dan sebelas minor", padahal file itu memuat tiga minor dan empat nit, dan daftar laporan perbaikan berisi tiga belas butir (satu major dan dua belas minor). Review ulang ini mencatat daftar putaran kedua di bagian status di atas. Saat `/document` merapikan paragraf itu, tautkan kedua file review dan samakan hitungannya.

## Strengths

- Perbaikan major berbasis bukti dan sampai ke akar masalah: reproduksi di bawah beban, probe urutan event loop Bun yang menunjukkan hanya `setTimeout(resolve, 0)` yang berjalan sesudah rejection, exception immediate, dan timer tanpa jeda, lalu penulisan sinkron sehingga handler tidak dapat menyela. Setiap test kegagalan kini memeriksa inode, mtime, dan ketiadaan file sementara, bukan hanya byte file. Hasilnya stabil: 60 dari 60 lulus di bawah 12 proses beban.
- Reviewer menjalankan 150.000 mutasi acak (hapus, ganti nilai, tambah key, balik array, termasuk key `__proto__` sebagai own property seperti keluaran `JSON.parse`) pada `openapi.json` dan `subset-full.json` terhadap checker saat ini. Tidak ada exception selain `OpenApiContractError`. Perubahan baru (rule `security` per operasi, dot segment, BOM) tidak membuka jalur crash.
- Keputusan `security` wajib per operasi dicatat lengkap di `rationale.md` (alasan fail open, dua opsi yang ditolak), lalu diterapkan konsisten di checker, spec, aturan proyek, fixture, dan matriks, termasuk kasus yang tadinya diterima dan kini ditolak.
- Batas yang tidak dapat dijaga ditulis jujur: `Bun.fetch`, `Worker`, `Bun.spawn`, DNS, `handle.stat()` yang tertutup bound baca, dan timer komposisi yang meledak sesudah rename. Laporan bukti, spec, header preload, dan rationale menyebutnya sama, dan tidak ada klaim kelulusan yang melebihi bukti.
- Laporan bukti terverifikasi penuh terhadap file dan JUnit saat ini, dan `openapi.json` serta `apps/frontend/sdk/` tidak berubah dibanding `HEAD`.

## Test coverage

Sinyal test **configured**. Reviewer membaca seluruh diff dan file baru (exporter, checker, `canonicalJson`, preload guard, `workspace.ts`, seluruh `openapi-contract.test.ts` kecuali isi data matriks yang hanya dipindai, `openapi.test.ts`, `tsconfig.contract.json`, `package.json`, `.gitignore`, spec `index.md`, `rationale.md`, `verify.md`, laporan bukti, aturan OpenAPI, dan `AGENTS.md`). Perintah yang dijalankan reviewer dan hasilnya:

- `bun test ./tests/integration/contract`: 465 test lulus, 0 gagal, 1.177 assertion, 3 file.
- `bun test ./tests/integration/contract/openapi-contract.test.ts --reporter=junit --reporter-outfile=<scratchpad>/openapi-contract.xml`: 404 test lulus, 1.084 assertion, 0 gagal. XML sama dengan `docs/testing/evidence/0007/openapi-contract.xml` selain `time` dan `hostname`.
- 12 proses `yes` sebagai beban, `bun test ... -t "OPENAPI-005 export fails safely" --rerun-each 6`: 60 lulus, 0 gagal. Semua proses `yes` dihentikan dan tidak ada yang tersisa.
- `bun run typecheck:contract`: exit 0. `bun run test:scenarios`: 38 ID unik. `bun run check:dependencies`: lulus.
- `tsc` strict dengan `noUncheckedIndexedAccess` atas seluruh `scripts/` dan `tests/integration/` lewat tsconfig di scratchpad: gagal hanya pada file milik fitur lain.
- `shasum -a 256` atas `openapi.json`, `valid.json`, dan `subset-full.json`: cocok dengan laporan bukti. `git diff HEAD` untuk `openapi.json`, `apps`, `bun.lock`, dan `database` kosong, dan tidak ada file `openapi.json.*.tmp` di root.
- Probe di scratchpad dan workspace sementara: exporter dengan `setInterval` di `createApp()` (berhasil dan gagal), proses anak sesudah `SIGKILL` pada `bun run`, dan fuzz 150.000 mutasi. Fuzz awal memakai setter `__proto__` dan menimbulkan beberapa `TypeError`; itu artefak probe karena setter mengubah prototype object, sesuatu yang tidak dapat dihasilkan `JSON.parse`, sehingga bukan temuan. Fuzz diulang dengan own property dan bersih.

Reviewer tidak menjalankan `bun run api:sync` dan `bun run api:check` (keduanya menulis ulang `openapi.json` dan SDK di checkout, dan review tidak mengubah file project), `build:frontend`, dan E2E, karena fitur ini tidak mengubah backend, SDK, maupun frontend dan laporan bukti mencatat hasil kelulusannya. Perilaku `api:sync` di workspace tercakup test (e) OPENAPI-005 dan test `.env` OPENAPI-007 yang lulus di atas.

Cakupan fitur ini sangat kuat: setiap rule ID punya baris penolakan, ada kasus penerimaan, urutan evaluasi, `__proto__` dan `constructor`, batas ukuran dan kedalaman, keluaran nyata Elysia, kontrol negatif pada hampir setiap bukti, dan perbaikan putaran kedua datang bersama test regresi. Celah yang tersisa adalah perilaku exporter bila komposisi meninggalkan handle yang hidup dan efektivitas timeout `run()`, keduanya pada temuan minor di atas. Kelulusan checker tetap bukan sertifikasi penuh OpenAPI, sesuai batas yang ditulis spec.

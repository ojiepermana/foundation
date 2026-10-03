# Review, main, 2026-10-03

**Reviewed by**: Sonnet 5.5 (author on opus)
**Scope**: 17 files, uncommitted (`git diff HEAD` plus untracked files; base `f5321ebd589b17ca8a4a2383df77e72715e5ba86`)
**Verdict**: Approve with nits

## Summary

Perubahan ini mengubah exporter dan checker OpenAPI menjadi gerbang allow list menurut spec 0008: 16 rule dievaluasi menurut urutan tabel dan berhenti pada pelanggaran pertama, `canonicalJson` mengurutkan key menurut code unit, validator hanya membaca file biasa sampai 8 MiB, dan exporter menulis lewat file sementara lalu rename dengan pesan kegagalan yang tetap. Reviewer tidak menemukan blocker maupun major. Perilaku checker, exporter, dan serializer sesuai tabel spec, dan probe tambahan reviewer (mutasi acak, urutan key terbalik, dokumen ekstrem) tidak membuat checker melempar exception selain `OpenApiContractError`. Temuan yang tersisa adalah bukti yang sudah usang terhadap suite saat ini, beberapa cabang pertahanan yang belum diuji, dan gate typecheck yang belum mencakup `scripts/` dan `tests/`.

## Minor

### 🟡 Laporan bukti dan JUnit masih mencatat 373 test, `docs/testing/0007-openapi-contract.md:21`

**Problem**: Laporan, JUnit (`docs/testing/evidence/0007/openapi-contract.xml:2` berisi `tests="373" assertions="898"`), dan tabel per skenario (5, 149, 143, 48, 14, 9, 5) berasal dari langkah build. Sesudah `/test` menambah 16 test, reviewer menjalankan `bun test ./tests/integration/contract/openapi-contract.test.ts` dan mendapat 389 test, 997 assertion, 0 gagal. Jumlah per skenario sekarang 12, 150, 143, 48, 20, 11, dan 5. Baris 3 dan 66 laporan juga masih menyatakan bahwa verifikasi, pengujian, dan review belum dijalankan, dan paragraf `Kode tersedia` di `docs/scope/scope.md:225` masih menyebut review belum dijalankan.

**Why it matters**: Bukti yang ikut di-commit menggambarkan suite yang lebih kecil daripada test yang di-commit. Aturan testing meminta laporan memuat perintah dan hasil aktual, sehingga pembaca laporan dapat menyangka 16 test baru (kontrol negatif guard, sumber nilai ekspor, locale, kegagalan tulis, input validator, `HTTP_METHODS`, kontrol negatif SDK, dan `canonicalJson`) tidak pernah dijalankan.

**Suggested fix**: Jalankan ulang perintah JUnit pada baris 21 setelah review ini, salin hasilnya ke `docs/testing/evidence/0007/`, lalu perbarui jumlah test, jumlah assertion, tabel per skenario, dan bagian batas bukti. Langkah ini cocok dikerjakan bersama `/document`. Perbarui juga kalimat terakhir paragraf `Kode tersedia` di scope setelah dokumentasi selesai.

### 🟡 Cabang pertahanan pada pembacaan file dan ekspor belum punya bukti, `scripts/validate-openapi.ts:527`

**Problem**: Tiga cabang tidak dijalankan oleh test mana pun. Pertama, bound baca dan pemeriksaan ulang sesudah dibuka (`length > OPENAPI_MAX_BYTES` di baris 527 dan `handle.stat()` di baris 519). Kasus 8.388.609 byte dan file sparse 1 GiB sudah ditolak oleh `stat` di baris 516 sebelum file dibuka, sehingga janji AC-6 bahwa validator membaca paling banyak 8 MiB ditambah satu byte tidak pernah diuji. Kedua, `if (!response.ok)` di `scripts/export-openapi.ts:27` dan respons plugin yang bukan JSON. Ketiga, handler `uncaughtException` di `scripts/export-openapi.ts:18`; hanya jalur `unhandledRejection` yang diuji.

**Why it matters**: Bound baca adalah kontrol resource untuk file reguler yang ukurannya berubah atau tidak jujur, yaitu kontrol yang menurut Security model spec melindungi CI dari input besar. Bila cabang itu terhapus atau rusak pada refactor berikutnya, seluruh suite tetap hijau.

**Suggested fix**: Pisahkan pembacaan terbatas menjadi fungsi kecil yang menerima handle atau sumber byte sehingga cabang sesudah `stat` dapat diuji langsung, atau tambah test file yang membesar selama dibaca. Tambah satu test workspace yang membuat `/openapi/json` tidak menjawab 200 atau menjawab bukan JSON, dan satu test untuk exception yang dilempar dari timer saat modul route diimpor. Keduanya harus berakhir dengan stderr tetap dan `openapi.json` byte identik.

### 🟡 Tidak ada gate CI yang memeriksa tipe `scripts/` dan `tests/`, `package.json:18`

**Problem**: `typecheck:backend` memakai `apps/backend/tsconfig.json` yang hanya mencakup `src/**/*.ts`, dan tidak ada tsconfig lain untuk `scripts/` maupun `tests/`. Checker baru lebih dari 500 baris dan banyak memakai cast `as Json` yang aman hanya karena rule di atasnya sudah berjalan. Bukti build mengandalkan perintah `tsc` ad hoc (`docs/testing/0007-openapi-contract.md:20`). Reviewer menjalankan perintah itu pada tujuh file fitur ini dan hasilnya bersih, jadi tidak ada error tipe saat ini. Masalahnya adalah penegakan, bukan hasil.

**Why it matters**: Bun tidak memeriksa tipe saat runtime dan `test:ci` tidak menjalankan `tsc` untuk file ini. Fitur 10 akan menambah entri `REQUIRED_OPERATIONS` dan mungkin rule, sehingga error tipe di checker tidak akan tertangkap sebelum merge.

**Suggested fix**: Tambah tsconfig yang mencakup `scripts/` dan `tests/integration/contract/` beserta script `typecheck:scripts`, lalu masukkan ke `test:ci`. Bila gate CI memang dikerjakan di fitur 11, catat kewajiban ini secara eksplisit di scope fitur tersebut.

## Nits

- ⚪ `scripts/export-openapi.ts:36`, file sementara `openapi.json.<uuid>.tmp` bisa tertinggal di root bila proses dihentikan paksa (kill karena timeout CI atau SIGINT) di antara tulis dan rename, dan `.gitignore` tidak mengabaikan polanya sehingga dapat ikut `git add -A`. Tambahkan pola `openapi.json.*.tmp` ke `.gitignore`.
- ⚪ `tests/integration/contract/openapi-contract.test.ts:179`, test kontrol negatif Bun.sql memakai timeout 15.000 ms, padahal run ber guard boleh berjalan sampai 10 detik dan `waitFor` sampai 8 detik. Pada CI yang lambat jumlahnya dapat melewati timeout. Naikkan ke 30.000 ms seperti test lain yang menjalankan beberapa subprocess.
- ⚪ `tests/integration/contract/openapi-contract.test.ts:1385` dan `:1423`, `toHaveLength(16)` dan `recipe.length` bernilai 6 menggandakan pemeriksaan kesamaan yang sudah ada tepat di bawahnya, dan akan gagal tanpa alasan saat fitur 10 menambah rule atau butir resep secara sah. Pertimbangkan menghapusnya.
- ⚪ `docs/rules/openapi-sdk.md:28`, pohon `Lokasi file` belum memuat `scripts/lib/canonical-json.ts`, padahal exporter bergantung padanya.

## Strengths

- Checker mengikuti tabel spec dengan setia. Reviewer menjalankan 60.000 mutasi acak pada `openapi.json` dan `subset-full.json`: setiap hasil adalah diterima atau `OpenApiContractError`, tidak ada `TypeError` atau exception tak terduga. Pada 40.000 mutasi lain, rule yang dilaporkan sama persis untuk dokumen dengan urutan key terbalik, dan setiap dokumen yang diterima stabil setelah `canonicalJson` lalu `JSON.parse` lalu validasi ulang.
- Batas sumber daya terbukti dalam praktik. Dokumen 8 MiB dengan 300 ribu properti dan `required` selesai dalam sekitar 156 ms, 100 ribu parameter dalam sekitar 68 ms, dan 300 ribu nilai `enum` dalam sekitar 57 ms. Array bersarang 4 juta tingkat serta schema bersarang 250 ribu tingkat ditolak dengan rule `document` atau `schema` tanpa crash, tanpa `RangeError`, dan tanpa membocorkan isi.
- Guard preload dilengkapi kontrol yang membuktikan guard benar benar menangkap panggilan: probe memanggil setiap API yang dijaga termasuk import bernama, kontrol negatif memperlihatkan `Bun.sql` tanpa guard benar benar menyambung ke listener sentinel, dan listener sentinel dibuktikan menghitung koneksi. Reviewer juga memastikan `node:http` ikut tertangkap karena Bun menjalankannya lewat `net.createConnection`.
- Pesan kegagalan hanya berisi teks tetap dan rule ID. Penanda rahasia pada nama file, isi file, dan exception route tidak muncul di stdout maupun stderr, dan `openapi.json` tetap byte identik pada setiap kegagalan, termasuk saat rename gagal dan file sementara harus dihapus.
- Matriks mutasi memuat lebih dari 300 baris penolakan yang masing masing menyebut rule ID dan membuktikan dokumen tidak berubah, dan test OPENAPI-007 membaca tabel spec dengan cara yang dirumuskan AC-8 lengkap dengan kontrol bahwa pembacanya memang gagal bila tabel diubah. `subset-full.json` dibuktikan lewat `sdk:generate` dan `tsc --strict` beserta kontrol negatif yang membuktikan `@ts-expect-error` hidup.
- Checksum SHA-256 pada laporan bukti cocok dengan file di working tree, `openapi.json` dan `apps/frontend/sdk/` tidak berubah, serta tidak ada dependency, variable environment, atau perubahan database baru.

## Test coverage

Sinyal test **configured**. Reviewer membaca seluruh diff dan file baru, spec 0008 (`index.md` dan `rationale.md`), checklist verify, aturan OpenAPI, testing, dan keamanan, serta `AGENTS.md`. Perintah yang dijalankan reviewer: `bun test ./tests/integration/contract` (450 test lulus, 0 gagal, 3 file), `bun test ./tests/integration/contract/openapi-contract.test.ts` dengan reporter JUnit ke direktori scratchpad (389 test, 997 assertion, 0 gagal, 0 dilewati), `bun run test:scenarios` (38 ID unik), dan `tsc --noEmit --strict` pada tujuh file fitur (bersih). `shasum -a 256` memastikan checksum pada laporan bukti. Semua probe tambahan (mutasi acak, urutan key terbalik, dokumen ekstrem, guard terhadap `node:http`, dan SDK dari nama serta deskripsi yang tidak biasa) dijalankan dari direktori scratchpad di luar repository dan tidak mengubah file project.

Cakupan fitur ini sangat kuat: setiap rule ID punya baris penolakan, kasus penerimaan, urutan evaluasi, kasus `__proto__` dan `constructor`, kisi serta rantai untuk batas waktu, keluaran nyata Elysia, dan kontrol negatif pada hampir setiap bukti. Celah yang tersisa adalah cabang pertahanan pada temuan minor kedua dan bukti yang usang pada temuan minor pertama. Reviewer tidak menjalankan `api:check`, `build:frontend`, dan E2E karena fitur ini tidak mengubah backend, SDK, maupun frontend, dan bukti build mencatat hasil kelulusannya. Kelulusan checker tetap bukan sertifikasi penuh OpenAPI, sesuai batas yang ditulis spec.

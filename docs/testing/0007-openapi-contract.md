# Bukti fitur 8: ekspor dan pemeriksaan kontrak OpenAPI

Tanggal: 2026-10-03. Kriteria: [spec 0008](../specs/0008-ekspor-pemeriksaan-kontrak-openapi/index.md). Bukti ini berasal dari checkout `main` pada dasar `f5321ebd589b17ca8a4a2383df77e72715e5ba86` dengan perubahan fitur 8 yang belum di-commit. Bukti ini mula mula dibuat pada build plan langkah 5 (`/develop`), lalu dijalankan ulang sesudah perbaikan temuan [review kode](../reviews/2026-10-03-main-openapi-contract.md). Angka di bawah berasal dari run ulang itu. Gate akhir fitur dijalankan sesudah `/document` pada checkout yang sama dan tercatat di bagian *Gate akhir fitur*; JUnit di `evidence/0007/` berasal dari gate itu.

## Lingkungan

Bun 1.4.2, Node 24.21.0, TypeScript 6.0.3, Elysia 1.4.30, `@elysia/openapi` 1.4.16, dan generator `@ojiepermana/angular` 22.1.14 di macOS 27.0. Tidak ada server aplikasi, PostgreSQL, atau layanan jaringan yang dijalankan. Test ekspor memakai workspace sementara di direktori temp sistem, guard preload `tests/integration/contract/no-network-preload.ts`, dan listener TCP loopback milik test sebagai sentinel `DATABASE_URL`, `REDIS_URL`, dan `SMTP_HOST`.

## Perintah dan hasil

| Perintah | Hasil aktual |
| --- | --- |
| `bun run api:sync` | Exit 0. Ekspor mencetak `OpenAPI exported without listener`, validasi (`bun --no-env-file scripts/validate-openapi.ts`) mencetak `OpenAPI project checks passed`, dan generator menulis 9 file SDK. Checksum `openapi.json` dan seluruh file `apps/frontend/sdk/` sama sebelum dan sesudah, jadi regenerasi menghasilkan artefak identik, dan tidak ada file `openapi.json.*.tmp` tertinggal. |
| `bun run api:check` | Exit 0, `OpenAPI and SDK match stored artifacts across two runs`. |
| `bun run test:scenarios` | Exit 0, 38 ID skenario unik, termasuk `OPENAPI-001` sampai `OPENAPI-007` dari registry baru `tests/scenarios/openapi-contract.json`. |
| `bun run test:integration` | Exit 0, 485 test dan 1.256 assertion, 0 gagal, 0 dilewati. Suite ini memuat APP-003 (`openapi.test.ts`) dan seluruh test OPENAPI. |
| `bun run check:dependencies` | Exit 0, `Exact dependency pins, runtime engines and installed peers passed`. |
| `bun run build:frontend` | Exit 0. Build memberi warning anggaran initial bundle 654,09 kB terhadap 500 kB yang sudah ada sebelum fitur ini. |
| `bun run typecheck:backend` | Exit 0. |
| `bun run typecheck:contract` (`tsconfig.contract.json`: `scripts/validate-openapi.ts`, `scripts/export-openapi.ts`, `scripts/lib/canonical-json.ts`, dan file di `tests/integration/contract/`, strict dengan `noUncheckedIndexedAccess`) | Exit 0. Script ini kini dijalankan `test:ci`. Probe dengan file berisi kesalahan tipe di `tests/integration/contract/` membuatnya exit 2, lalu file probe dihapus. |
| `bun test ./tests/integration/contract/openapi-contract.test.ts --reporter=junit --reporter-outfile=.local/feature-8/openapi-contract.xml` | Exit 0, 404 test dan 1.084 assertion, 0 gagal, 0 dilewati. [JUnit OPENAPI](evidence/0007/openapi-contract.xml) disalin tanpa atribut `hostname`; file itu kini berasal dari gate akhir dengan jumlah yang sama. |
| `bun test ./tests/integration/contract/openapi-contract.test.ts -t "OPENAPI-005 export fails safely" --rerun-each 10` dengan 20 proses `yes` sebagai beban CPU | Exit 0, 100 test lulus, 0 gagal. Sebelum perbaikan, run serupa membuat ekspor gagal mengganti `openapi.json` dan meninggalkan file sementara. |

## Hasil per skenario

| Skenario | Kriteria | Jumlah test | Status |
| --- | --- | --- | --- |
| `OPENAPI-001` | AC-1, AC-2 | 12 | `passed` |
| `OPENAPI-002` | AC-3 | 155 | `passed` |
| `OPENAPI-003` | AC-4 | 143 | `passed` |
| `OPENAPI-004` | AC-5 | 51 | `passed` |
| `OPENAPI-005` | AC-6 | 26 | `passed` |
| `OPENAPI-006` | AC-7 | 11 | `passed` |
| `OPENAPI-007` | AC-8 | 6 | `passed` |

Jumlah test dihitung dari nama testcase di JUnit OPENAPI. `OPENAPI-001` juga dibuktikan oleh `api:check`, dan `OPENAPI-007` juga oleh `check:dependencies`; keduanya lulus di atas.

## Hasil per kriteria

| Kriteria | Hasil dan bukti |
| --- | --- |
| AC-1 | Terpenuhi. Ekspor dua kali di workspace dengan guard preload serta sentinel `DATABASE_URL`, `REDIS_URL`, dan `SMTP_HOST` lulus, `guard-calls.log` tidak ada, listener sentinel menerima nol koneksi, dan inode `openapi.json` berganti karena file diganti lewat rename. Test probe membuktikan guard menangkap setiap API yang dijaga, termasuk import bernama serta `Bun.redis`, `Bun.RedisClient`, `Bun.s3`, `Bun.S3Client`, dan `net.Socket`. |
| AC-2 | Terpenuhi. `canonicalJson` menghasilkan urutan key campuran yang diminta dan mereproduksi `openapi.json`; dua ekspor byte identik dengan file tersimpan, tanpa `servers`, `localhost`, atau nilai sentinel. |
| AC-3 | Terpenuhi. Matriks OPENAPI-002 menolak setiap klausa rule `document` sampai `response` dengan rule ID yang diharapkan, dokumen tetap tidak berubah, dan dokumen dengan beberapa pelanggaran melaporkan rule paling atas. |
| AC-4 | Terpenuhi. Matriks OPENAPI-003 mencakup rule `component`, `schema`, dan `reference`, keluaran nyata Elysia, batas 32 dan 33 tingkat, rantai `items` 200.000 tingkat, kisi 40 tingkat dengan dan tanpa rujukan balik di bawah satu detik, serta rantai 20.000 komponen. |
| AC-5 | Terpenuhi. Matriks OPENAPI-004 mencakup rule `security` dan `required-operation`, termasuk operasi tanpa `security` sendiri saat `security` dokumen bernilai `[]`, `REQUIRED_OPERATIONS` berisi tepat satu entri tabel, dan `GET /api/status` tanpa credential memberi 200 dengan `{"status":"ok"}`. |
| AC-6 | Terpenuhi. Validator dan exporter mencetak teks tetap dengan baris `rule:` hanya untuk pelanggaran kontrak, batas 8 MiB dan file non reguler ditolak, teks berawalan byte order mark ditolak, batas baca tetap berlaku saat `stat` melaporkan file kecil, batas ekspor dihitung dalam byte UTF-8 (tepat 8.388.608 byte diterima, 8.388.609 byte dan teks multibyte di atas 8 MiB ditolak), setiap ekspor gagal (termasuk rejection, timer tanpa jeda, dan respons plugin yang bukan 200 atau bukan JSON) meninggalkan inode dan isi `openapi.json` tanpa file sementara, dan `api:sync` berhenti sebelum `sdk:generate` dengan SDK byte identik. |
| AC-7 | Terpenuhi. `subset-full.json` diterima, `sdk:generate` dan `tsc --strict` lulus di workspace bersama file konsumen dan `@ts-expect-error`, dan route uji 204 dengan resep `detail.responses` diterima. |
| AC-8 | Terpenuhi. Rule ID yang dibaca dari tabel *Aturan checker* sama persis dengan `OPENAPI_RULE_IDS`, setiap rule ID mempunyai baris penolakan di matriks, komentar pembuka `scripts/validate-openapi.ts` dan bagian ekspor `docs/rules/openapi-sdk.md` merujuk spec 0008, menyatakan kelulusan bukan sertifikasi penuh OpenAPI atau JSON Schema, dan memuat *Bentuk route yang diekspor bersih*. File tooling fitur ini hanya mengimpor modul `node:` dan modul proyek dan tidak membaca variable environment. `api:sync` di workspace dengan `.env` berisi sentinel lulus tanpa sentinel itu masuk proses ekspor dan validasi, dan kontrol negatif tanpa `--no-env-file` membuktikan sentinel itu memang terlihat. `package.json` hanya berubah pada script `api:openapi` dan `api:validate` (ditambah `--no-env-file`) serta script baru `typecheck:contract` di `test:ci`; dependency, `bun.lock`, `apps/`, dan `database/` tidak berubah dibanding `HEAD`. |

Untuk memastikan test OPENAPI-007 benar benar mendeteksi penyimpangan, tiga mutasi sementara dicoba lalu file dipulihkan byte identik (dicek dengan `cmp`): urutan `version` dan `info` di `OPENAPI_RULE_IDS` ditukar, kalimat sertifikasi dihapus dari komentar pembuka, dan satu butir resep dihapus dari `docs/rules/openapi-sdk.md`. Setiap mutasi membuat test OPENAPI-007 yang terkait gagal.

## Identitas artefak

| Artefak | SHA-256 |
| --- | --- |
| `openapi.json` | `56b08577e64273d8bdacc7b4b9d8ec67499be00a216b7bea65af676846e92048` |
| `tests/fixtures/openapi/valid.json` | `56b08577e64273d8bdacc7b4b9d8ec67499be00a216b7bea65af676846e92048` (sama dengan ekspor saat ini) |
| `tests/fixtures/openapi/subset-full.json` | `2e5e13f2b143dadb7509bc2d96ae8f465f4dd43fce4c66d1199ae15f035ed268` |

## Gate akhir fitur

Gate ini dijalankan pada 2026-10-03 pukul 15.12 sampai 15.16 UTC, sesudah verifikasi, pengujian, review ulang, dan `/document`, di atas dasar yang sama (`f5321eb`) dengan seluruh perubahan fitur 8 yang belum di-commit. Lingkungan sama dengan bagian *Lingkungan*, ditambah Docker lokal untuk suite nyata dan Chromium Playwright untuk E2E. Port 8888 dan 8889 kosong sebelum gate dan sesudahnya.

| Perintah | Hasil aktual |
| --- | --- |
| `bun run test:ci` | Exit 0 dalam sekitar 42 detik. `check:dependencies` lulus; `test:scenarios` mencatat 38 ID unik; `api:check` menjalankan `api:sync` dua kali dan mencetak `OpenAPI and SDK match stored artifacts across two runs`; `build:frontend` berhasil dengan warning anggaran initial bundle 654,09 kB terhadap 500 kB yang sudah ada sebelum fitur ini; `check:frontend:bundle` lulus; `typecheck:backend` dan `typecheck:contract` exit 0; `build:backend` membundel 5 modul; `test:frontend` lulus 1 test; `test:integration` lulus 485 test dengan 1.256 assertion, 0 gagal, 0 dilewati (APP-003 48 test, OPENAPI 404 test, `application.test.ts` 20 test, dan `frontend-bundle.test.ts` 13 test); `test:tooling` lulus 29 test dengan 79 assertion; `test:e2e` lulus 4 test Playwright. [JUnit integration](evidence/0007/integration.xml) disalin tanpa atribut `hostname`. |
| `bun run test:database:migration` | Exit 0, 5 test dan 59 assertion pada PostgreSQL 18 terisolasi, 0 gagal. |
| `bun run test:database:real` | Exit 0. Build frontend untuk pemindaian artefak lulus, suite database lulus 17 test dengan 133 assertion, dan pemindaian mencatat `7 random values absent from 14 files`. |
| `bun run test:tooling:real` | Exit 0. TOOL-001 lulus 12 pemeriksaan database dan menolak target serta role yang salah. Bagian HTTP TOOL-007 memberi 200 `{"status":"ok"}` dari `/api/status` dan 200 `text/html` dari frontend, lalu SIGTERM menghapus listener pada 8888 dan 8889. |
| `bun run test:infrastructure` | Exit 0, 18 test dan 171 assertion dengan Docker nyata, 0 gagal. |
| `bun test ./tests/integration/contract/openapi-contract.test.ts --reporter=junit --reporter-outfile=.local/feature-8/openapi-contract.xml` | Exit 0, 404 test dan 1.084 assertion, 0 gagal, 0 dilewati. Jumlah per skenario sama dengan tabel *Hasil per skenario*. [JUnit OPENAPI](evidence/0007/openapi-contract.xml) disalin tanpa atribut `hostname`. |
| Pemeriksaan batas AC-8 dengan `grep` dan `git diff HEAD` | Exporter, checker, dan `canonicalJson` hanya mengimpor modul `node:`, path relatif, dan komposisi backend lewat `await import()`, tanpa `process.env`, `Bun.env`, atau `import.meta.env`. `package.json` hanya berubah pada bagian `scripts`; `bun.lock`, `apps/`, dan `database/` tidak berubah dibanding `HEAD`. |

Checksum `openapi.json`, kedua fixture, dan sepuluh file `apps/frontend/sdk/` sama sebelum dan sesudah gate, `git status --porcelain` juga sama sebelum dan sesudah gate, dan tidak ada file `openapi.json.*.tmp` tertinggal. Suite database, tooling nyata, dan infrastruktur tidak menyentuh kode fitur 8; hasilnya menjadi bukti regresi checkout, bukan bukti tambahan untuk AC fitur ini. JUnit frontend, tooling, dan Playwright dari gate ini hanya tersimpan di `.local/` dan tidak disalin.

## Batas bukti

- Kelulusan checker bukan sertifikasi penuh OpenAPI atau JSON Schema. Klaim bahwa generator membaca bentuk yang lolos checker dengan benar hanya berlaku untuk bentuk yang tercantum di AC-7.
- Guard AC-1 tidak menjaga `Bun.fetch` (readonly di Bun 1.4.2), `Bun.file` dengan URL `s3://`, `Worker`, `Bun.spawn`, `node:child_process`, dan lookup DNS, sesuai invariant 1 spec 0008. Koneksi dari jalur itu hanya tertangkap bila menuju alamat sentinel.
- Exception dari timer komposisi yang berjalan sesudah rename tetap membuat exit code 1 tetapi tidak dapat membatalkan file yang sudah diganti dari dokumen yang lulus checker (invariant 6).
- Pemeriksaan `handle.stat()` sesudah open dijalankan test, tetapi penghapusannya tertutup batas baca dan parser sehingga tidak dapat dibedakan dari output.
- `typecheck:contract` hanya mencakup file fitur ini. File lain di `scripts/` dan `tests/` (misalnya `scripts/serve.ts` dan `tests/integration/tooling/development.test.ts`) belum lulus `strict` dengan `noUncheckedIndexedAccess` dan tetap milik gate CI fitur 11.
- Pemeriksaan drift dan manifest SDK serta bukti request/response SDK terhadap backend nyata tetap milik fitur 9. Alur browser milik fitur 10.
- Build frontend masih memberi warning anggaran bundle yang ada sebelum fitur ini.
- Verifikasi, pengujian, review kode, dan dokumentasi perubahan sudah dijalankan; temuan review awal diperbaiki dan dibuktikan oleh run ulang di atas. [Review ulang](../reviews/2026-10-03-main-openapi-contract-followup.md) memberi Approve with nits. Tiga temuan minor dari review itu masih terbuka dan tidak dibuktikan selesai oleh gate ini: exporter tidak keluar sendiri bila komposisi meninggalkan handle yang hidup, timeout `run()` di `tests/integration/contract/workspace.ts` tidak menghentikan proses script yang sebenarnya, dan butir checklist AC-8 di `verify.md` baris 98 belum dicentang serta rumusannya sudah tidak sesuai karena `package.json` kini berubah pada script. Pemeriksaan dengan rumusan yang benar lulus di *Gate akhir fitur*, tetapi file spec itu tidak diubah oleh gate. Enam nit review ulang juga masih terbuka.
- TOOL-007 dari fitur 2 tetap parsial; `test:tooling:real` di atas tidak menjalankan alur browser melalui SDK.

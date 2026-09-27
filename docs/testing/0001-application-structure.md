# Bukti fitur 4: struktur aplikasi dan dependency

## Hasil dan identitas kandidat

**Status fitur: done.** AC-1 sampai AC-6 serta APP-001 sampai APP-004 telah dibuktikan pada kandidat lokal yang sama. Workflow GA selesai melalui develop, check verify, test, check review, dan document. Review independen GPT-6 Sol: **Approve**, tanpa temuan terbuka.

**Kesiapan production Foundation: incomplete.** Laporan ini membuktikan kerangka aplikasi sesuai spec 0001. Database, readiness lintas aplikasi, kapasitas, container dan deployment mempunyai scope tersendiri.

- Pemeriksaan: 2026-09-27T16:46:48.353852+00:00 (UTC, pencatatan setelah gate final).
- Base commit: `4daedac1d2836a68ed11509271a2f82a66dd7841`.
- Kandidat implementasi: working tree belum di-commit.
- SHA-256 source kandidat: `1d7d39409393b7b6e119507e158e7bf86f972700380bbd5e294cc5110087fc47`.
- [Manifest kandidat dan checksum 63 file sumber](evidence/0001/candidate.json) mencatat daftar file, checksum artefak build, versi, jumlah hasil JUnit, dan algoritma identitas. Dokumentasi laporan serta perubahan `.gitignore` yang sudah ada tidak masuk identitas kode.
- Gate final: `bun install --frozen-lockfile` lalu `bun run test:ci`, exit **0**. [Instalasi](evidence/0001/install.log), [log lengkap gate](evidence/0001/verification.log).
- [Spec 0001](../specs/0001-struktur-aplikasi-dependency/index.md), [checklist verify](../specs/0001-struktur-aplikasi-dependency/verify.md), [review independen](../reviews/2026-09-27-application-structure.md).

## Environment dan versi

| Bagian | Versi dan keadaan aktual |
| --- | --- |
| Host | macOS arm64, proses lokal, tanpa container aplikasi. |
| Node / Bun | 24.21.0 / 1.4.2, dipin pada manifest, file runtime, dan workflow CI. |
| Angular framework, CLI, build, compiler, CDK, Material | 22.2.0. |
| Library dan generator | `@ojiepermana/angular` 22.1.14. |
| TypeScript / RxJS | 6.0.3 / 7.8.2. |
| Elysia / plugin OpenAPI | 1.4.30 / `@elysia/openapi` 1.4.16. |
| Test runner | Bun 1.4.2, Vitest 4.1.11 melalui Angular CLI, Playwright 1.63.0. |
| Browser | Chromium 153.0.8010.12, desktop 1280 × 812 dan mobile 375 × 812. |
| Frontend / backend development | `127.0.0.1:8889` / `127.0.0.1:8888`. |
| PostgreSQL, data, migration, seed, worker | Tidak diakses atau dijalankan oleh fitur ini. Tidak ada perubahan schema/role. |
| Mock | Tidak ada pengganti frontend, backend HTTP, proxy, atau generator dalam pengujian alur utama. Test import menolak alokasi Bun.serve, Bun.SQL dan fetch sebagai assertion batas. Test penghentian pipeline memakai proses fixture gagal terisolasi. |

Matriks resmi [Angular](https://angular.dev/reference/versions) menjadi rujukan awal. Metadata npm `@angular/compiler-cli@22.2.0` menetapkan TypeScript `>=6.0 <6.1`; metadata library 22.1.14 menerima Angular `>=22.1.0 <23.0.0`. Pemeriksaan actual installed peers dan engines melalui `check:dependencies` lulus, tanpa force atau pengabaian konflik peer. Versi tepat serta dependency transitif disimpan pada satu manifest root dan `bun.lock`.

## Hasil pemeriksaan dan skenario

| Pemeriksaan final | Hasil dan bukti |
| --- | --- |
| Instalasi frozen | Exit 0, lockfile tidak berubah. |
| `check:dependencies` | Exit 0, pin tepat, runtime, Node engines, installed peers, dan ketiadaan manifest/lockfile nested. |
| `test:scenarios` | Exit 0, 8 ID unik (APP dan TOOL), referensi spec/test/script tersedia. Pemeriksaan registry tidak menggantikan hasil runner. |
| `api:check` | Exit 0, ekspor/validasi/generate dua kali, seluruh isi dan daftar file SDK identik dengan artefak tersimpan. |
| `build:frontend` | Exit 0, build production Angular, SDK di luar src ikut kompilasi. Warning ukuran bundle dicatat di bawah. |
| `typecheck:backend` / `build:backend` | Exit 0 / 0. Bundle Bun menggunakan dependency eksternal dari lockfile yang sama. |
| Server dan kontrak | **68 passed**, 0 failed, 0 errors, 0 skipped. [JUnit](evidence/0001/server.xml). |
| Frontend Vitest | **1 passed**, 0 failed, 0 errors, 0 skipped. [JUnit](evidence/0001/frontend.xml). |
| Regression tooling | **7 passed**, 0 failed, 0 errors, 0 skipped. [JUnit](evidence/0001/tooling.xml). |
| Playwright | **2 passed**, 0 failed, 0 errors, 0 skipped. [JUnit](evidence/0001/playwright.xml), [screenshot 1](evidence/0001/browser-1.png), [screenshot 2](evidence/0001/browser-2.png). |
| Total | **78 passed**, tanpa gagal atau skipped. |

| ID | Kriteria | Bukti aktual | Status |
| --- | --- | --- | --- |
| APP-001 | AC-1, AC-2, AC-3 | Instalasi frozen, engines/peer checker, manifest root, build Angular, pemeriksaan tipe backend dan bundle Bun. | passed |
| APP-002 | AC-2, AC-4 | Halaman kerangka terlihat tanpa panggilan API otomatis/error browser. Skip link keyboard memfokuskan landmark utama. Tidak ada overflow horizontal pada dua viewport. Request proxy `/api/status` mencapai backend nyata, HTTP 200 dengan JSON tepat `{"status":"ok"}`. Source dan bundle melayani HTTP lalu melepas listener. | passed |
| APP-003 | AC-3, AC-5 | Import serta exporter tanpa listener/database/network, fixtures positif/negatif checker, dua generate identik, inventory SDK sesuai manifest, drift changed/missing/new/new-unowned ditolak, pipeline berhenti ketika tiap tahap gagal, consumer TypeScript menerima `ok` dan menolak nilai lain. | passed |
| APP-004 | AC-4, AC-6 | Komposisi serta listener production bundle memberi 404 pada status/OpenAPI. PORT/HOST/NODE_ENV salah dan listener terpakai menghasilkan exit 1 dengan pesan generik. Error 500 tanpa stack/secret. SIGTERM/SIGINT source dan bundle exit 0, port dapat dipakai ulang. | passed |
| TOOL-001 sampai TOOL-004 | Regression aturan development | Doctor tanpa mutasi, cleanup port fixture terisolasi, pilihan/isolasi worker, supervisor beserta descendant. | passed |

Skenario terdaftar pada [registry application](../../tests/scenarios/application.json). JUnit mencatat nama test aktual, sehingga ID serta eksekusi dapat dicocokkan dengan source test. Baris APP dapat berbagi test lifecycle, jumlah per skenario tidak dijumlahkan sebagai jumlah test unik.

## OpenAPI, SDK, dan keamanan

- OpenAPI 3.1.0 diekspor oleh plugin resmi dari komposisi development yang sama, melalui `app.handle()` tanpa membuka port.
- SHA-256 `openapi.json`: `56b08577e64273d8bdacc7b4b9d8ec67499be00a216b7bea65af676846e92048`.
- SDK standalone di `apps/frontend/sdk/` dihasilkan oleh schematic library 22.1.14. Seluruh 9 file kode dan manifest dikelola generator. Schema status memakai const serta enum singleton agar runtime dan tipe generated sama sama menerima hanya `ok`. Respons 500 juga memiliki schema.
- Regenerasi final berlangsung melalui gate `api:check`, sebanyak dua run identik setelah semua perubahan backend. Pemeriksaan drift meliputi isi, file hilang, file baru, serta file tambahan yang tidak tercatat dalam manifest.
- Checker meliputi versi/info/paths, operasi, operationId unik, tag, schema input/response, security, endpoint wajib, serta reference lokal. Reference eksternal dan target lokal rusak ditolak. Checker adalah pemeriksaan kontrak project, bukan sertifikasi penuh seluruh standar OpenAPI.
- Development bind hanya ke localhost dan route tidak mengakses data. Production tidak memasang status maupun dokumentasi development. Konfigurasi invalid tidak dicetak; error HTTP tidak membawa stack atau nilai sensitif. Listener membatasi body 1024 byte, idle timeout 10 detik, dan batas shutdown 5 detik. Angka ini konfigurasi kerangka, bukan hasil pengukuran kapasitas.
- Inspeksi import langsung pada source frontend dan SDK tidak menemukan import backend, worker, libs/server, Bun, Node, atau Elysia. Halaman statis tidak memanggil SDK.
- Pemeriksaan nilai secret yang terkonfigurasi melalui environment pada artefak browser production tidak menemukan nilai tersebut. [Bukti](evidence/0001/secret-scan.log). Cakupannya bukan scanner vulnerability atau deteksi seluruh pola secret.

## Riwayat kegagalan dan perbaikan

1. Instalasi awal gagal karena pin jsdom 30.2.0 tidak tersedia. Pin diganti ke rilis tersedia 30.0.1, lalu instalasi frozen final lulus.
2. Build awal menolak argumen object pada `provideApiConfiguration`; public API generated menerima string. Pemanggilan diperbaiki pada source, build final lulus.
3. Ekspor awal memakai default OpenAPI 3.1.2 sementara checker hanya menerima versi yang ditetapkan. Plugin dikonfigurasi eksplisit ke 3.1.0; exporter/validator/generator final lulus.
4. Test checker menangkap celah const dan enum yang bertentangan. Checker kini memeriksa seluruh constraint literal yang ada, test negatif tetap dipertahankan dan lulus.
5. Test reproduksi awal gagal karena workspace fixture tidak menyalin `.prettierrc`, sehingga formatting generator berbeda. Fixture diperbaiki dan formatter dipin; generate final identik.
6. Unit frontend awal mencari elemen HTML main, sementara public layout memakai landmark role main. Assertion diperbaiki untuk semantik landmark; runtime browser sudah menunjukkan konten benar. Test final lulus.
7. Review independen mereproduksi file SDK ekstra di luar manifest yang diterima api:check. Inventory actual kini wajib identik dengan manifest. Regression `new-unowned` lulus pada implementer dan reviewer.
8. Review menemukan tipe SDK terlalu luas untuk literal response. Schema sumber diberi enum singleton dan diregenerasi. Test compiler consumer menolak nilai selain ok. Reviewer memeriksa perbaikan dan memberi Approve.

Kegagalan awal merupakan instalasi, API, fixture, assertion, dan celah checker yang telah diperbaiki. Gate final menggunakan retry 0 pada Playwright; tidak ada skenario wajib gagal yang disembunyikan atau dilonggarkan.

## Batas bukti dan pekerjaan berikutnya

- `bun run doctor` telah dijalankan. Prasyarat aplikasi dan kontrak tersedia, tetapi pemeriksaan PostgreSQL gagal. Spec AC-6 menetapkan startup langsung untuk fitur 4; doctor/serve lengkap tetap fitur 2 sesudah provisioning serta migration. Tidak ada perubahan untuk melewati preflight.
- Bundle initial 675.12 kB melampaui warning bawaan scaffold 500 kB, tetapi berada di bawah batas build gagal 1 MB. Budget tidak dinaikkan untuk menyembunyikan warning. Evaluasi layout/bundle berikutnya berada pada fitur UI terkait.
- Workflow CI memiliki Node/Bun dan action SHA yang dipin, tetapi run remote belum dilakukan (`not_run`). Bukti final berasal dari host macOS lokal; Ubuntu CI belum dibuktikan.
- k6 `not_applicable` untuk fitur ini: tidak ada alur bisnis/database atau target kapasitas pada spec 0001. Tidak ada klaim throughput, latency, maupun kapasitas produksi.
- Migration, seed, PostgreSQL, worker, auth/session, header dokumen deployment, scanner vulnerability kandidat, backup/restore, konsumsi SDK oleh fitur, serta container/deployment tidak dibuktikan pada slice ini. Scope masing masing tetap planned atau in-progress sesuai keadaan sebelumnya.
- Source telah dibekukan sebelum laporan/checklist/status dokumentasi ditulis. Tidak ada perubahan perilaku setelah gate final. Identitas kode dan checksum artefak memungkinkan perbandingan terhadap working tree yang akan di-commit.
- Tidak ada commit, push, publikasi, atau deploy pada tugas ini. Perubahan `.gitignore` yang sudah ada dipertahankan.

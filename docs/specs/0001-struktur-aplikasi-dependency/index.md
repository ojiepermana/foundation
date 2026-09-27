# 0001. Struktur aplikasi dan dependency yang kompatibel

**Date**: 2026-09-27
**Status**: Accepted

## Summary

Anda mendapat frontend Angular dan backend Elysia yang dapat dibuild dan dijalankan secara terpisah. Satu manifest dan lockfile root menjaga versi yang terpasang tetap sama. Route lokal membuktikan backend hidup, sedangkan ekspor OpenAPI dan SDK tetap dapat dibuat tanpa database. Alur database dan halaman kesiapan menunggu fitur berikutnya.

## Requirements

**User stories**: Sebagai pengembang, Anda dapat memasang dependency sekali dari root, membuka frontend dasar, dan menjalankan backend tanpa menyiapkan data bisnis. Sebagai pengelola kontrak, Anda dapat menghasilkan SDK dari route backend yang sama tanpa membuka port atau database.

**Acceptance criteria**:

1. **AC-1**: Satu `package.json` dan `bun.lock` di root mengunci dependency yang kompatibel. Angular 22.2 dan `@ojiepermana/angular` 22.1.14 terpasang tanpa memaksa peer dependency. Versi tepat Node, Bun, TypeScript, Elysia, dan plugin OpenAPI dicatat serta dipin setelah pemeriksaan kompatibilitas dan build.
2. **AC-2**: Frontend di `apps/frontend/` lulus build Angular dan menampilkan halaman kerangka sederhana di browser development. Halaman tidak memanggil backend, tidak memuat credential, dan tidak mendahului navigasi fitur 7.
3. **AC-3**: Backend di `apps/backend/` lulus pemeriksaan tipe dan bundle Bun. Komposisi aplikasi dapat diimpor tanpa listen, koneksi database, migration, seed, atau layanan luar. Entry proses membaca `HOST` dan `PORT` dari lingkungan, lalu membuka dan menutup listener secara tertib.
4. **AC-4**: `GET /api/status` pada komposisi development mengembalikan HTTP 200 dengan JSON tepat `{ "status": "ok" }` tanpa membaca database. Route tidak dipasang pada komposisi production, sehingga permintaan yang sama menghasilkan 404. Frontend meneruskan `/api` ke backend melalui proxy lokal.
5. **AC-5**: `api:sync` mengekspor komposisi development yang sama ke `openapi.json`, memeriksa aturan kontrak wajib, lalu menghasilkan SDK standalone nyata di `apps/frontend/sdk/`. Semua tahap berjalan tanpa listen atau database aktif. Ekspor dan SDK yang diulang dengan sumber sama menghasilkan isi identik; kegagalan salah satu tahap menghentikan perintah dengan status gagal. Tidak ada artefak kontrak yang ditulis manual.
6. **AC-6**: Konfigurasi backend yang tidak sah gagal sebelum listen dengan pesan aman dan status gagal. Dependency yang tidak kompatibel, build yang gagal, serta proses yang keluar tidak dinyatakan lulus. Bukti fitur ini memakai build dan startup langsung; `doctor` dan `serve` lengkap menunggu prasyarat database serta migration.

## Decision

**Chosen option**: Kerangka aplikasi nyata dengan kontrak minimum yang ikut dibangun sekarang. (basis: `docs/scope/scope.md` fitur 4, `docs/rules/development-workflow.md`, `docs/rules/openapi-sdk.md`)

Gunakan satu manifest root, Angular CLI lokal untuk membuat workspace CSR (render di browser), dan Elysia dengan komposisi terpisah dari entry proses. Pakai pasangan Angular 22.2 dan `@ojiepermana/angular` 22.1.14 yang dipilih Anda. Periksa matriks Angular, peer dependency package, dan versi stabil runtime sebelum mempin seluruh versi tepat di manifest, lockfile, serta konfigurasi CI. Tolak konflik peer dependency. Pilihan kedua adalah menunda status selesai fitur 4 sampai fitur 8 dan 9 siap, tetapi itu menunda bukti backend nyata. (basis: `docs/rules/angular.md`, `docs/rules/elysia.md`, pasangan rilis package pada References)

**Implementation skills**: `angular-developer` (`google/angular`, `/Users/ojiepermana/.agents/skills/angular-developer/`) dan `elysiajs` (`elysiajs/elysia`, `/Users/ojiepermana/.agents/skills/elysiajs/`).

## Feature design

**Data model sketch**: Tidak ada entitas persisten, migration, seed, atau pilihan schema baru. Fitur ini tidak mengakses tabel. Metadata `common` baru dibaca pada fitur yang memerlukannya, sesuai `docs/scope/scope.md` fitur 5 dan 10.

**API surface**:

| Endpoint | Method | Input | Output | Akses | Kesalahan penting |
| --- | --- | --- | --- | --- | --- |
| `/api/status` | GET | Tidak ada body atau parameter | 200 JSON `{ "status": "ok" }` | Tanpa login, hanya komposisi development yang bind ke `127.0.0.1` | 404 bila route tidak dipasang di production; 500 tanpa detail sensitif pada kesalahan tak terduga |

Schema response HTTP 200 dideklarasikan pada route Elysia. Catat `operationId` tetap `getDevelopmentStatus`, tag `development`, dan security tanpa autentikasi pada OpenAPI development. Checker memakai route ini sebagai endpoint wajib awal dan juga memeriksa versi dokumen, `info`, seluruh operasi, `operationId` unik, tag, schema input dan response, security, serta reference lokal. Reference eksternal ditolak. Uji checker dengan fixture yang valid dan yang melanggar setiap aturan wajib; perluasan cakupan dan kontrak fitur lain tetap milik fitur 8. SDK dibuat dengan schematic `@ojiepermana/angular:sdk` dari workspace frontend dan hasilnya tidak diimpor oleh halaman kerangka. Alur konsumsi SDK oleh fitur menunggu fitur 9 dan 10. (basis: `docs/rules/openapi-sdk.md`)

**Value sourcing**:

| Aksi | Nilai yang dihasilkan atau ditampilkan | Sumber |
| --- | --- | --- |
| Membuka halaman kerangka | Judul dan isi statis | Template frontend dalam fitur ini |
| Memanggil `/api/status` | `status` bernilai `ok` | Konstanta route development, bukan hasil database atau environment |
| Menentukan akses route | Mode development atau production | Parameter komposisi aplikasi yang eksplisit; entry proses mengambilnya dari `NODE_ENV`; exporter selalu memilih development |
| Membuka listener | Host dan port | `HOST` dan `PORT` dari environment entry proses, divalidasi sebelum listen; supervisor mengisi keduanya dari `config/development.json` |
| Membuat SDK | Path, method, schema, dan security | Route dan schema pada komposisi Elysia yang diekspor ke `openapi.json` |

**Key invariants**: `app.ts` tidak membuka listener dan tidak membuat resource eksternal saat diimpor. `index.ts` hanya mengurus startup dan shutdown, tanpa migration atau seed. Halaman browser tidak mengimpor modul server dan tidak menyimpan secret. Jangan membuat folder contoh kosong, DTO HTTP manual, atau SDK buatan tangan. Production tidak memasang route status development atau plugin dokumentasi development.

**Security model**: Route development tidak memerlukan login karena hanya diaktifkan pada komposisi development dan listener lokal. Mode production tidak boleh mengaktifkannya melalui proxy yang salah konfigurasi. Tidak ada data pribadi, credential, atau query database dalam respons, bundle, maupun log. Batasi request dan body sesuai fasilitas backend; respons error tidak membocorkan stack. Endpoint diagnostik production memerlukan keputusan terpisah pada fitur 10 dan 13. (basis: `docs/rules/security.md`)

**Configuration required**: `HOST`, `PORT`, dan `NODE_ENV` untuk entry backend. Development menggunakan `127.0.0.1:8888` dari `config/development.json`; frontend memakai `127.0.0.1:8889` dan proxy `/api`. Tidak ada secret atau variable database baru untuk fitur ini. Runtime dan versi build dipin pada lingkungan CI yang sama dengan pemeriksaan lokal. (basis: `docs/rules/development-commands.md`)

**Critical test scenarios**:

1. `APP-001`: instalasi dari root, pemeriksaan peer dependency, build Angular, pemeriksaan tipe dan bundle backend lulus, membuktikan **AC-1**, **AC-2**, dan **AC-3**.
2. `APP-002`: frontend memuat halaman kerangka, route development memberi 200 dengan JSON tetap tanpa database, dan proxy mencapai backend lokal, membuktikan **AC-2** dan **AC-4**.
3. `APP-003`: import komposisi serta ekspor kontrak tanpa port atau database; dua run `api:sync` identik dan fixture checker menolak pelanggaran wajib, membuktikan **AC-3** dan **AC-5**.
4. `APP-004`: mode production memberi 404 pada route development; konfigurasi salah gagal sebelum listen dan tidak mengungkap secret, membuktikan **AC-4** dan **AC-6**.

## Build plan

Urutan ini mengikuti Tracer Bullet pada `docs/scope/scope.md`: buktikan jalur kecil dari frontend dan backend sampai kontrak generated, lalu kuatkan batas versi, kegagalan, dan verifikasi. Tidak ada migration pada fitur ini.

1. Scaffold Angular CSR lewat CLI lokal ke `apps/frontend/` tanpa manifest kedua; pasang frontend dasar dan proxy. Komposisikan backend Elysia tanpa efek saat import, buat entry proses dan route development dengan schema. Pasang versi tepat yang sudah diperiksa di manifest serta lockfile root. Memenuhi **AC-1**, **AC-2**, **AC-3**, dan **AC-4**.
2. Tambahkan ekspor OpenAPI dari komposisi development, checker Bun dengan fixture wajib, konfigurasi schematic SDK standalone dan `api:sync`. Pin versi generator dan jalankan dua kali untuk membuktikan hasil identik. Memenuhi **AC-1**, **AC-3**, dan **AC-5**.
3. Uji build, startup langsung, shutdown, proxy, route production yang tidak tersedia, konfigurasi salah, serta kebocoran secret. Daftarkan `APP-001` sampai `APP-004` di registry dengan bukti aktual dan hasil yang belum tersedia dibedakan dari hasil lulus. Memenuhi **AC-1** sampai **AC-6**.

## Consequences

**Positive**: Struktur aplikasi nyata dapat diverifikasi tanpa menunggu database, dan perubahan backend sejak awal menghasilkan artefak kontrak yang sesuai aturan.

**Negative**: Fitur ini perlu membangun sebagian tooling kontrak lebih awal daripada urutan scope. SDK sudah dihasilkan tetapi belum dipakai halaman. Perubahan versi framework atau generator memerlukan pemeriksaan kompatibilitas dan regenerasi.

**Neutral**: Build production bukan bukti readiness atau izin release. Kriteria `doctor` dan `serve` pada aplikasi dengan database tetap diselesaikan pada fitur 2 setelah fitur 5 dan 6.

## Follow-up

1. Fitur 7 memutuskan layout dan navigasi akhir. Fitur 8 memperluas checker terhadap kontrak fitur berikutnya. Fitur 9 membuktikan konsumsi SDK dan pemeriksaan drift lengkap. Fitur 10 menetapkan kebijakan diagnostik dan alur database nyata.
2. Konvensi skill `angular-developer` dan `elysiajs` belum tercantum di `AGENTS.md`; pertimbangkan pointer yang relevan saat konteks agent diperbarui, tanpa mengganti aturan repo yang sudah ada.
3. Setelah implementasi, catat versi tepat yang terpasang serta hasil pemeriksaan peer dependency, build, dan dua kali regenerasi. Jangan menyebut kandidat siap release sebelum gate kandidat terpenuhi.

## Rationale

Alasan dan perbandingan pilihan ada di [rationale.md](rationale.md).

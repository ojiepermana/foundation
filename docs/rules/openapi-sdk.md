# OpenAPI backend dan SDK Angular

Backend menghasilkan `openapi.json` pada root monorepo. Frontend menghasilkan SDK dari file tersebut ke `apps/frontend/sdk/`, pada root workspace Angular. Aturan ini berlaku bersama [workflow development](development-workflow.md), [aturan backend](elysia.md), [aturan Angular](angular.md), dan [aturan testing](testing.md).

Setiap perubahan backend wajib diikuti ekspor ulang OpenAPI, validasi, dan regenerasi SDK sebelum pekerjaan dinyatakan selesai. Kewajiban ini tetap berlaku untuk perubahan internal backend yang tidak mengubah kontrak; hasil regenerasi boleh identik dengan file sebelumnya.

Pemilik tunggal artefak, cara kerja `api:check`, pin locale generator, batas impor SDK, kontrak adapter fitur, dan harness backend nyata untuk test SDK ditetapkan [spec 0009](../specs/0009-sdk-sesuai-kontrak-backend/index.md). Bagian di bawah merangkum keputusan tersebut; bila ada perbedaan, spec itu yang berlaku sampai aturan ini diperbarui.

## Sumber kontrak dan pilihan generator

Specs fitur menjelaskan kontrak yang disepakati. Route dan schema request/response Elysia menjadi sumber kontrak HTTP yang diekspor. `openapi.json` dan SDK adalah hasil generate, bukan kontrak kedua yang dipelihara manual.

- Gunakan plugin OpenAPI resmi Elysia, `@elysia/openapi`, sesuai versi Elysia yang dipilih. Plugin ini merupakan dependency terpisah dari core Elysia. Dokumentasi resminya menyediakan raw spec pada `/openapi/json` secara default.
- Gunakan generator SDK dari package `@ojiepermana/angular`. Entry point `@ojiepermana/angular/sdk` menyediakan permukaan konfigurasi SDK; schematic dijalankan melalui collection package root dengan `@ojiepermana/angular:sdk`.
- Gunakan mode `standalone`. Hasilnya merupakan folder kode Angular dalam workspace yang sama, tanpa `package.json` atau package SDK tersendiri. Dependency dan script tetap berada dalam satu `package.json` root.
- Gunakan versi rilis yang kompatibel, pin versi tooling pembentuk artefak, dan simpan `bun.lock`. Jangan memakai generator global atau mengambil versi `latest` saat setiap run CI.

Pilihan generator mengikuti kemampuan SDK dari library yang telah disepakati. OpenAPI Generator dengan target `typescript-angular` adalah tool berbeda yang didokumentasikan berstatus `STABLE`; status tersebut tidak berarti generator milik `@ojiepermana/angular` mendapat sertifikasi yang sama. Jangan mengganti generator atau menjalankan dua generator untuk kontrak yang sama secara otomatis.

Stabilitas alur project dibuktikan melalui hasil generate yang dapat diulang, build Angular, dan pengujian request/response nyata untuk kemampuan kontrak yang digunakan. Jika generator belum mendukung suatu bentuk kontrak, catat batasnya dan selesaikan pilihan implementasi dalam specs sebelum menyatakan integrasi selesai.

## Lokasi file

```text
foundation/
├── package.json
├── bun.lock
├── openapi.json                    # Hasil ekspor backend
├── scripts/
│   ├── export-openapi.ts            # Ekspor melalui Bun
│   ├── validate-openapi.ts          # Pemeriksaan kontrak melalui Bun
│   └── check-api.ts                 # Pemeriksaan drift api:check
└── apps/
    ├── backend/src/
    │   ├── app.ts
    │   ├── plugins/openapi.ts
    │   └── features/<fitur>/
    │       ├── <fitur>.routes.ts
    │       └── <fitur>.schema.ts
    └── frontend/
        ├── angular.json
        ├── sdk.config.json
        ├── vitest-backend.setup.ts  # Harness backend nyata untuk test SDK
        ├── sdk/                    # Seluruh isinya dikelola generator
        │   ├── .ojiepermana-sdk-manifest.json
        │   ├── public-api.ts
        │   ├── models/
        │   ├── fn/
        │   └── services/
        └── src/app/features/<fitur>/
            └── <fitur>-api.ts       # Adapter fitur yang memakai SDK
```

Struktur ini menetapkan lokasi saat tooling dan aplikasi diimplementasikan. Nama file hasil SDK mengikuti versi generator; daftar di atas bukan kewajiban membuat file kosong. Jangan membuat `openapi.json` atau SDK contoh yang diklaim berasal dari backend sebelum ekspor nyata tersedia.

## Schema dan metadata backend

- Deklarasikan schema untuk parameter path/query, header atau cookie yang relevan, body, serta response setiap status yang digunakan, termasuk respons kesalahan. Inferensi TypeScript saja tidak menggantikan kontrak runtime yang lengkap.
- Berikan `operationId` eksplisit, unik, dan stabil serta tag berdasarkan area fitur. Nama tersebut memengaruhi operasi dan service SDK; perubahan nama harus diperlakukan sebagai perubahan antarmuka frontend.
- Gunakan nama schema publik yang stabil ketika model digunakan ulang. Jangan mengekspos row database sebagai response secara otomatis.
- Deklarasikan security scheme dan kebutuhan autentikasi endpoint sesuai perilaku nyata. Metadata OpenAPI tidak menjalankan autentikasi; pengujian tetap membuktikan akses yang diizinkan dan ditolak.
- Representasi nullable, enum, tanggal, angka, pagination, upload, dan serialisasi query harus sesuai perilaku HTTP nyata dan didukung generator. Periksa dukungan `style`/`explode` sebelum memakai serialisasi parameter yang kompleks.
- Dokumen yang dihasilkan mencakup seluruh endpoint kontrak yang digunakan frontend. Jangan menyembunyikan endpoint tersebut untuk menghindari kegagalan generator.

`libs/contracts/` tetap dapat memuat kontrak pesan worker atau definisi bersama yang relevan. Frontend mengambil tipe request/response HTTP dari SDK hasil generate; jangan memelihara salinan DTO HTTP manual di `libs/contracts/` atau fitur frontend. Model khusus tampilan tetap dimiliki fitur frontend.

## Ekspor dan validasi OpenAPI

`scripts/export-openapi.ts` menggunakan Bun untuk memuat komposisi route yang sama dengan backend melalui `await import()` di dalam blok penanganan kegagalan, membuat `createApp('development')`, lalu membaca raw spec `/openapi/json` melalui `app.handle()` tanpa membuka port server; pastikan lifecycle plugin versi yang dipakai sudah siap sebelum membaca hasil. Exporter memeriksa dokumen dengan checker yang sama, menulis teks kanonik dari `canonicalJson` (`scripts/lib/canonical-json.ts`) ke file sementara di direktori root, lalu memindahkannya ke `openapi.json` dengan rename. Dengan begitu kegagalan di tengah tidak meninggalkan file terpotong, dan setiap kegagalan hanya mencetak `OpenAPI export failed`, ditambah `rule: <ID>` untuk pelanggaran kontrak. Root script `api:openapi` dan `api:validate` menjalankan kedua script dengan `bun --no-env-file`, sehingga `.env` checkout yang memuat secret aplikasi tidak masuk proses yang memuat komposisi backend.

Komposisi `app.ts` tidak menjalankan `listen()` saat diimpor. Pisahkan pembuatan resource dari startup agar ekspor tidak memerlukan database aktif, migration, seed, worker, atau pemanggilan layanan eksternal. Jangan mengganti route dengan endpoint mock untuk keperluan ekspor. Middleware autentikasi aplikasi tidak boleh menghalangi pembacaan spec oleh script ekspor.

Ekspor harus gagal bila respons plugin bukan JSON OpenAPI yang valid, route yang wajib hilang, atau referensi schema tidak terselesaikan. File root harus dapat dikonsumsi generator dari checkout yang sama tanpa mengunduh spec backend yang sedang berjalan di environment lain.

Gunakan `scripts/validate-openapi.ts` melalui Bun untuk pemeriksaan kontrak project tanpa dependency validator/linter tambahan. Root script `api:validate` menjalankan pemeriksaan tersebut. Saat diimplementasikan, pemeriksaan wajib mencakup:

- JSON dapat diparse sebagai object dokumen, versi OpenAPI yang didukung generator, metadata `info` wajib, dan struktur `paths`/operasi yang digunakan project.
- Kelengkapan dan keunikan `operationId`, tag fitur, serta schema input dan response yang diwajibkan kontrak fitur.
- Seluruh `$ref` lokal dapat diselesaikan dalam dokumen yang sama; reference eksternal ditolak agar artefak tidak memerlukan unduhan tambahan.
- Endpoint kontrak wajib tersedia dan deklarasi security scheme/referensinya sesuai keputusan specs.

Pelanggaran pemeriksaan wajib menghasilkan exit code bukan nol dan menghentikan `api:sync`/`api:check`. Uji checker dengan fixture valid serta fixture yang melanggar setiap aturan wajib ketika tooling dibuat.

Pemeriksaan Bun ini terbatas pada aturan kontrak dan bentuk OpenAPI yang digunakan project, bukan validator seluruh standar OpenAPI atau pengganti validasi request/response di server. Catat cakupan dan keterbatasannya; jangan melaporkan kelulusan sebagai sertifikasi kepatuhan penuh. Keberhasilan generate SDK, build Angular, dan test integrasi request/response nyata tetap diperlukan. Bentuk kontrak baru memerlukan pembaruan pemeriksaan dan bukti dukungan generator sebelum digunakan.

Hasil ekspor harus deterministik untuk kode dan konfigurasi kontrak yang sama. Gunakan formatting tetap dan urutan key object yang konsisten tanpa mengubah urutan array yang bermakna; `canonicalJson` mengurutkan key menurut code unit, sehingga hasilnya tidak bergantung pada locale mesin. Jangan memasukkan waktu generate, URL environment sementara, atau data runtime yang berubah ke artefak. Simpan seluruh schema yang dirujuk dalam dokumen yang dapat dikonsumsi lokal.

### Batas checker

Batas resmi checker adalah tabel *Aturan checker* pada [spec 0008](../specs/0008-ekspor-pemeriksaan-kontrak-openapi/index.md). Checker berupa allow list (daftar bentuk yang diizinkan): bentuk yang tidak tercantum di tabel ditolak. Rule diperiksa satu per satu menurut urutan baris tabel, yang sama dengan `OPENAPI_RULE_IDS` di `scripts/validate-openapi.ts`, dan checker berhenti pada pelanggaran pertama. Karena itu satu dokumen selalu menghasilkan rule ID yang sama. Kegagalan hanya mencetak teks tetap `OpenAPI validation failed` atau `OpenAPI export failed`, ditambah baris `rule: <ID>` untuk pelanggaran kontrak, tanpa isi dokumen, path file, pesan parser, atau stack. Cari ID itu di tabel untuk mengetahui bentuk yang diizinkan. Setiap operasi wajib mendeklarasikan `security` sendiri, termasuk `security: []` untuk route publik; `security` dokumen tidak diwarisi.

Kelulusan checker bukan sertifikasi penuh OpenAPI atau JSON Schema. Kelulusan hanya membuktikan subset proyek. Klaim bahwa bentuk yang lolos checker dibaca generator dengan benar hanya berlaku untuk bentuk yang tercantum di AC-7 spec 0008 dan dibuktikan oleh `tests/fixtures/openapi/subset-full.json`. Bentuk baru, misalnya nullable, union, schema rekursif, `oauth2`, parameter cookie atau array, parameter tingkat path item, response `default`, atau header response, memerlukan pembaruan tabel aturan, fixture, dan bukti generator SDK pada spec fitur yang membutuhkannya sebelum dipakai route. Entri `REQUIRED_OPERATIONS` hanya bertambah melalui spec fitur pemilik route, bersama test yang membuktikan entri barunya.

### Bentuk route yang diekspor bersih

Resep berikut terbukti dengan Elysia 1.4.30 dan `@elysia/openapi` 1.4.16 pada spec 0008. Route yang mengikutinya diekspor dalam bentuk yang diterima checker:

- Model body dan response 2xx didaftarkan dengan `.model({ Nama: schema })` lalu dirujuk dengan string nama pada `body` atau `response`, sehingga diekspor sebagai `#/components/schemas/Nama`.
- Bilangan bulat memakai `Type.Integer` dari `@sinclair/typebox` yang sudah dipin, bukan `t.Integer` atau `t.Numeric`.
- Route tidak memakai `t.Nullable`, union campuran tipe, `t.Ref` di dalam model, `t.Array(t.Ref(...))`, atau `t.Array` berisi schema ber `$id`, karena keluarannya `anyOf`, nullable, nama telanjang, atau `$id` bersarang.
- Response 204 dideklarasikan dengan `detail.responses` berisi `{ 204: { description } }` tanpa schema `response[204]`. `t.Void`, `t.Undefined`, `t.Null`, `t.Object({})`, dan `t.Never` mengekspor bentuk yang ditolak.
- Parameter `path`, `query`, dan `header` hanya skalar. Header response seperti `Cache-Control` tidak dideklarasikan di OpenAPI sampai rule `response` diperluas.
- `operationId`, `tags` berisi satu tag, dan `security` dinyatakan pada `detail` setiap route.

Route sesi [spec 0014](../specs/0014-akses-pengguna-lifecycle-sesi/index.md) menambah dua bentuk yang terbukti dengan versi yang sama:

- Route 204 yang juga mendeklarasikan galat tidak memakai map response ([spec 0014](../specs/0014-akses-pengguna-lifecycle-sesi/index.md), resep *Ekspor route 204 dengan galat*): bila route mempunyai map `response`, entri 204 di `detail.responses` hilang dan operasi tanpa 2xx ditolak rule `response`. Semua status ditulis di `detail.responses`, yaitu 204 sebagai `{ description }` dan setiap galat sebagai `{ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthError' } } } }`. Route seperti itu (`signOut` dan `revokeAuthSession`) tidak mempunyai validasi response saat runtime, jadi body galatnya dibentuk satu fungsi bersama.
- Cookie sesi dideklarasikan sebagai security scheme `sessionCookie` (`apiKey` di `cookie`) lewat `documentation.components` plugin OpenAPI, dan route yang membutuhkannya memakai `security: [{ sessionCookie: [] }]`. Route tidak mendeklarasikan schema `cookie` Elysia, karena plugin mengekspornya sebagai parameter `in: cookie` yang ditolak rule `parameter`; cookie dibaca dari header `cookie` request. Header CSRF `x-csrf-token` dideklarasikan sebagai schema `headers` skalar.

## Konfigurasi dan perintah SDK

Contoh konfigurasi `apps/frontend/sdk.config.json` untuk satu backend:

```json
{
  "targets": [
    {
      "input": "../../openapi.json",
      "output": "./sdk",
      "mode": "standalone",
      "clientName": "FoundationApi",
      "rootUrl": "",
      "splitByDomain": false,
      "features": {
        "models": true,
        "operations": true,
        "services": true,
        "client": true,
        "metadata": false,
        "navigation": false,
        "resources": false
      }
    }
  ]
}
```

Jalankan schematic dari working directory `apps/frontend/`, tempat `angular.json` berada:

```sh
ng generate @ojiepermana/angular:sdk --config sdk.config.json
```

`ng` berasal dari Angular CLI lokal yang dependency-nya ada di root monorepo. Root script `sdk:generate` menetapkan working directory tersebut sebelum menjalankan CLI. Input/output relatif pada contoh mengikuti working directory workspace ini; jangan menjalankan command yang sama dari root monorepo dengan asumsi path tetap benar.

Root script `sdk:generate` bernilai `cd apps/frontend && LC_ALL=en_US.UTF-8 node ../../node_modules/@angular/cli/bin/ng.js generate @ojiepermana/angular:sdk --config sdk.config.json`. Generator mengurutkan operasi pada `public-api.ts` dan service menurut locale proses, sehingga tanpa pin urutan di mesin dengan locale `cs_CZ` berbeda dari `en_US` dan SDK berubah walau kontraknya sama. Pin `LC_ALL=en_US.UTF-8` berada di dalam script, bukan pengaturan pengguna, dan terbukti menghasilkan byte yang sama di macOS dan Linux (skenario `SDK-007`). Jangan menghapus pin tersebut. Artefak yang disimpan dibuat melalui `api:sync` atau `sdk:generate`, bukan perintah `ng` langsung.

Konfigurasi dan command telah diperiksa terhadap artefak npm `@ojiepermana/angular` versi `22.1.14`. Ini adalah rujukan pemeriksaan, bukan perintah untuk memasang versi tersebut tanpa memeriksa kompatibilitas Angular, TypeScript, dan peer dependency project. Saat versi library berubah, periksa kembali schema konfigurasi dan public API versi yang dipasang.

SDK yang dihasilkan dipakai melalui barrel `sdk/public-api.ts`, dengan alias TypeScript seperti `@sdk` yang dikonfigurasi dalam workspace frontend. Pastikan file SDK di luar `src/` masuk kompilasi dan build Angular; jangan hanya memeriksa bahwa generator berhasil menulis file.

Frontend menyediakan `provideHttpClient()` dan mengatur backend URL melalui `provideApiConfiguration(...)` dari barrel SDK hasil generate pada konfigurasi aplikasi. `rootUrl: ""` menggunakan origin yang sama; environment dengan backend terpisah mengatur URL saat bootstrap tanpa generate SDK berbeda untuk setiap environment. Autentikasi dan kebijakan HTTP aplikasi diintegrasikan melalui fasilitas Angular yang relevan.

`<fitur>-api.ts` mengadaptasi service/operasi SDK untuk kebutuhan fitur. Component dan store memanggil adapter tersebut. Jangan menulis ulang endpoint dan DTO backend dengan `HttpClient` manual ketika SDK telah menyediakan operasinya.

### Batas impor SDK

`bun run check:frontend:bundle` memeriksa setiap file `.ts` dan `.tsx` di bawah `apps/frontend/src`, kecuali `*.spec.ts`, `*.spec.tsx`, `*.test.ts`, dan `*.test.tsx`, dalam urutan code unit path relatif. Specifier `@sdk` hanya diterima pada `src/app/app.config.ts` dan adapter `src/app/features/<fitur>/<fitur>-api.ts`, dengan dua nama `<fitur>` yang sama dan cocok dengan `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, dan hanya dalam bentuk yang diterima tabel *Bentuk impor SDK* berikut.

| Bentuk di file yang diperiksa | Adapter | `src/app/app.config.ts` | File lain di `apps/frontend/src` |
| --- | --- | --- | --- |
| `import { A, type B } from '@sdk'` | Diterima | Diterima | Ditolak |
| `import type { A } from '@sdk'` | Diterima | Diterima | Ditolak |
| `export type { A } from '@sdk'` | Diterima | Ditolak | Ditolak |
| `import '@sdk'`, `import * as ns from '@sdk'`, import default dari `@sdk` | Ditolak | Ditolak | Ditolak |
| `export { A } from '@sdk'`, `export { type A } from '@sdk'`, `export * from '@sdk'`, `export * as ns from '@sdk'`, `export type * from '@sdk'`, `export type * as ns from '@sdk'` | Ditolak | Ditolak | Ditolak |
| `import('@sdk')`, tipe `import('@sdk')`, `require('@sdk')`, `import x = require('@sdk')` | Ditolak | Ditolak | Ditolak |
| Ekspor lokal binding yang diimpor dari `@sdk`: `export { A }`, `export { A as B }`, `export type { A }`, `export default A`, `export = A` | Ditolak | Ditolak | Tidak berlaku |
| Specifier `@sdk/...` atau specifier relatif ke dalam `apps/frontend/sdk` | Ditolak | Ditolak | Ditolak |

Specifier relatif dihitung dengan `resolve(dirname(file), specifier)` terhadap folder `resolve(applicationSource, '../sdk')`, yaitu `apps/frontend/sdk`. Pada pelanggaran pertama, checker menulis ke stderr tepat `Browser application imports the SDK outside a feature adapter from <path>.` dan keluar dengan exit code 1; pesan tetap lain dan `Frontend bundle check failed.` keluar dengan bentuk yang sama tanpa stack atau potongan source. `<path>` di luar `^[A-Za-z0-9._@+/-]+$` ditulis sebagai literal berkutip ganda dengan escape `\uXXXX`, seperti baris laporan `api:check`, sehingga pesan tetap satu baris. Checker tidak mengikuti symlink, sedangkan build Angular mengikutinya; karena itu symlink di bawah `apps/frontend/src` atau `apps/frontend/dist` membuat checker gagal dengan `Frontend bundle check does not follow the symlink <path>.` untuk symlink pertama menurut urutan code unit, sebelum aturan impor atau pemindaian aset. Ganti symlink itu dengan file atau folder biasa. Checker hanya membaca deklarasi impor dan ekspor. Nilai SDK yang keluar lewat konstanta (`export const X = DevelopmentService`) atau nilai kembali method tidak tertangkap; kontrak adapter di bawah melarangnya, dan review fitur pemilik memeriksanya.

### Kontrak adapter fitur

Fitur yang memakai SDK mengikuti pola berikut. Batas impor ditegakkan `check:frontend:bundle`; butir lain diperiksa `/check verify` dan review fitur pemilik.

1. Satu adapter per area fitur pada `apps/frontend/src/app/features/<fitur>/<fitur>-api.ts`, berupa class `<Fitur>Api` dengan `@Service()` dari `@angular/core`.
2. Adapter memanggil operasi SDK melalui service tag hasil generate, misalnya `inject(DevelopmentService)`. Adapter tidak memakai `HttpClient`, string URL, atau `RequestBuilder` secara langsung, tidak mengubah `rootUrl`, dan tidak mengeluarkan nilai SDK (service, fungsi operasi, atau `FoundationApi`) kepada pemanggil.
3. Method adapter mengembalikan `Observable` dingin dari operasi SDK. Adapter tidak subscribe dan tidak menyimpan state; state dimiliki component atau store fitur.
4. Tipe sukses memakai model SDK yang diekspor ulang dengan `export type { ... } from '@sdk'`, atau model tampilan milik fitur. Interface yang menyalin model SDK tidak dibuat.
5. Adapter memetakan `HttpErrorResponse` ke tipe hasil atau error milik fitur. Status 0 berarti kegagalan jaringan. Status yang dideklarasikan backend dengan body bermodel bernama memakai tipe SDK hasil generate, yang dipersempit dengan memeriksa field pembeda (misalnya `status`) sebelum dipakai. Status lain menjadi kegagalan umum. Component tidak menerima `HttpErrorResponse` atau body error mentah, dan teks untuk pengguna berasal dari fitur.
6. Body error yang dibutuhkan UI dideklarasikan backend sebagai model bernama (`.model({ Nama: schema })` lalu dirujuk dengan nama pada status itu), sehingga generator mengeluarkan tipenya beserta ekspor tipenya di `public-api.ts`.
7. Test adapter memakai `sdkContractBackendUrl` untuk hasil yang dapat dihasilkan backend tanpa database, `sdkContractClosedUrl` untuk kegagalan jaringan, `HttpTestingController` untuk bentuk request, dan Playwright untuk alur browser melalui proxy `/api` (lihat *Harness backend nyata untuk test SDK*).

## Kepemilikan dan sinkronisasi artefak

Seluruh isi `apps/frontend/sdk/` dikelola generator. Jangan mengedit generated code atau menaruh adapter, state, UI, dan kode manual di dalamnya. Perbaikan dilakukan pada schema backend, konfigurasi generator, atau adapter fitur sesuai sumber masalahnya.

Pertahankan `.ojiepermana-sdk-manifest.json` yang dibuat schematic. Generator memakai manifest untuk menghapus file hasil generate yang sudah tidak diperlukan ketika endpoint/model berubah. Jangan menghapus seluruh folder secara paksa untuk menutupi konflik atau kehilangan kepemilikan file.

Simpan `openapi.json`, konfigurasi SDK, hasil SDK, dan manifest dalam version control bersama perubahan sumbernya. File yang bertambah, berubah, maupun dihapus harus ikut diperiksa. Tetapkan satu penanggung jawab regenerasi ketika beberapa subagent bekerja pada backend agar tidak saling menimpa artefak bersama.

Pemilik tunggal artefak bersama (`openapi.json`, `apps/frontend/sdk.config.json`, dan `apps/frontend/sdk/`) adalah agent utama selama pekerjaan paralel, atau pengembang yang mengintegrasikan perubahan bila bekerja sendiri. Artefak tersebut hanya ditulis oleh `api:sync` yang dijalankan pemilik tunggal. Subagent tidak menjalankan `api:sync` pada checkout bersama; mereka menyerahkan perubahan route, lalu agent utama menjalankan `api:sync` sekali sesudah integrasi dan memberi tahu subagent frontend bahwa SDK siap. `api:check` di CI menangkap sisa yang terlewat.

File di `apps/frontend/sdk/` yang tidak dibuat generator, yaitu file yang tidak tercantum di manifest seperti file tulisan tangan atau `.DS_Store` dari Finder macOS, tidak dihapus generator. `api:check` melaporkannya sebagai baris `removed`, dan file seperti itu pada path yang akan ditulis generator membuat `sdk:generate` gagal tanpa mengubah folder SDK. Pemilik artefak menghapus file tersebut secara manual; itu perbaikan yang sah karena file tersebut bukan hasil generate. File hasil generate tetap tidak diedit manual dan tidak dihapus paksa untuk menutupi konflik.

## Script root dan urutan wajib

Saat tooling diimplementasikan, gunakan script pada `package.json` root berikut:

| Script | Tanggung jawab |
| --- | --- |
| `api:openapi` | Ekspor route/schema backend ke `openapi.json`. |
| `api:validate` | Pemeriksaan kontrak OpenAPI root melalui script Bun tanpa validator tambahan. |
| `sdk:generate` | Generate `apps/frontend/sdk/` dengan schematic package pilihan. |
| `api:sync` | Jalankan ekspor, validasi, lalu generate SDK secara berurutan; berhenti saat satu tahap gagal. |
| `api:check` | Regenerasi `openapi.json` dan SDK dua kali di direktori sementara, lalu buktikan artefak yang disimpan sesuai sumber serta dapat direproduksi, tanpa mengubah checkout. |

Setiap perubahan backend, dependency/schema bersama yang memengaruhi backend, konfigurasi OpenAPI, maupun versi/config generator wajib menjalankan `api:sync`. Setelah itu jalankan build frontend dan test yang relevan dengan dampak perubahan. Hasil identik tetap dilaporkan sebagai regenerasi berhasil, bukan alasan melewati proses.

CI menjalankan `api:check` sebelum verifikasi integrasi frontend yang bergantung pada SDK. Pemeriksaan gagal ketika ada perbedaan artefak, validasi gagal, atau SDK tidak dapat digenerate. Bandingkan terhadap artefak kandidat yang disimpan, dengan output terisolasi atau checkout CI bersih. Pemeriksaan harus mencakup file baru yang belum tracked dan file lama yang dihapus; `git diff` saja tidak mendeteksi seluruh file baru.

Buktikan pula dua run dengan sumber dan versi tool sama menghasilkan artefak identik. Build Angular dan test integrasi membuktikan pemakaian SDK, sedangkan pemeriksaan drift membuktikan SDK berasal dari kontrak terbaru. Keduanya diperlukan; generate berhasil saja tidak membuktikan perilaku backend.

### Cara kerja `api:check`

`bun run api:check` menjalankan `bun --no-env-file scripts/check-api.ts`, CLI tipis yang memanggil `runApiCheck` dari `scripts/lib/api-check.ts` dengan batas 120.000 ms per `api:sync`. Langkahnya:

1. Membuat direktori sementara `foundation-api-check-*` di bawah direktori temp sistem (`TMPDIR`), menyalin `API_INPUTS` (`package.json`, `scripts/`, `apps/backend/`, `libs/`, `apps/frontend/angular.json`, `apps/frontend/sdk.config.json`, `apps/frontend/.prettierrc`, dan `apps/frontend/.editorconfig`) ke subdirektori `workspace/`, lalu menautkan `node_modules` checkout. File bernama `.env` atau `.env.*`, `node_modules`, `dist`, dan `.angular` tidak disalin di level mana pun. Symlink disalin apa adanya. Hanya target relatif kanonik yang diterima: `..` hanya sebagai urutan di awal yang tetap di dalam root checkout, lalu nama biasa tanpa `..` dan tanpa `node_modules`, misalnya `../.env` atau `../../scripts/tool.ts`. Target absolut, target yang keluar dari root, `../node_modules/../.env`, `../node_modules`, dan `up/../..` di samping `up -> ..` membuat pemeriksaan berhenti dengan `API check failed`, begitu pula input yang segmen induknya bukan direktori nyata, misalnya `apps` yang berupa symlink. Dengan aturan ini symlink yang tersalin hanya dapat menjangkau salinan di workspace, yang tidak pernah memuat `.env`.
2. Menjalankan `bun --no-env-file run api:sync` di workspace itu dua kali, setiap kali tanpa `openapi.json` dan tanpa `apps/frontend/sdk/`, dengan environment yang hanya berisi `PATH` dan `HOME`. Setiap run berjalan dalam process group sendiri. Hasil run pertama dipindahkan ke `run1/` sebelum run kedua.
3. Membandingkan run pertama dengan run kedua. Bila berbeda, baris laporan dicetak lalu `OpenAPI or SDK generation is not repeatable`, tanpa membandingkan checkout.
4. Bila kedua run sama, membandingkan `openapi.json` dan setiap entry di bawah `apps/frontend/sdk/` pada checkout dengan run pertama, termasuk manifest, file di luar manifest, dan symlink yang tidak diikuti. Bila berbeda, baris laporan dicetak lalu `OpenAPI or SDK drift detected`.

Checkout hanya dibaca. Tidak ada cache, git, atau deteksi perubahan yang melewati tahap: setiap `api:check` menjalankan ekspor, validasi, dan generate dua kali, juga ketika hasilnya identik. Kesamaan berarti jenis entry dan byte yang sama, tanpa normalisasi dan tanpa daftar abaikan; direktori kosong diabaikan karena git tidak menyimpannya.

Baris laporan ditulis ke stderr dengan path relatif root memakai `/`, dalam kelompok `added`, `changed`, lalu `removed`. Setiap kelompok berurutan code unit dan paling banyak 200 baris, disusul `... and <n> more <jenis>` bila lebih. Nama di luar `^[A-Za-z0-9._@+/-]+$` ditulis sebagai literal berkutip ganda dengan escape `\uXXXX`. Isi file tidak pernah dicetak.

| Baris | Arti pada pemeriksaan drift | Perbaikan |
| --- | --- | --- |
| `added <path>` | Dibuat regenerasi, tidak ada di checkout. | Jalankan `api:sync` dan sertakan file itu dalam perubahan. |
| `changed <path>` | Ada di checkout dan hasil regenerasi dengan jenis entry atau isi berbeda. | Jalankan `api:sync`; jangan mengedit file hasil generate. |
| `removed <path>` | Ada di checkout, tidak dibuat regenerasi: file hasil generate yang sudah usang, file tanpa pemilik, symlink, atau `.DS_Store`. | File usang yang tercantum di manifest dihapus `api:sync`; file yang tidak dibuat generator dihapus manual oleh pemilik artefak. |

Pada pemeriksaan pengulangan, sisi sebelum adalah run pertama dan sisi sesudah run kedua; perbedaan di sana berarti generator atau konfigurasinya tidak deterministik, bukan checkout yang tertinggal.

Hasil akhir: stdout `OpenAPI and SDK match stored artifacts across two runs` dan exit 0 hanya bila kedua run sama dan checkout sama dengan run pertama. Perbedaan, `API synchronization failed` (tahap gagal atau melewati batas waktu), dan `API check failed` (kegagalan lain, termasuk symlink input yang ditolak) memberi exit 1. Saat batas waktu, SIGINT, atau SIGTERM, seluruh process group tahap menerima SIGTERM, lalu SIGKILL bila masih hidup sesudah 5 detik; SIGINT dan SIGTERM memberi exit 130 dan 143 tanpa baris laporan. Direktori sementara selalu dihapus sesudah group habis.

Pembandingan memakai filesystem, bukan git. File lokal yang diabaikan git di folder SDK, misalnya `.DS_Store`, membuat `api:check` lokal gagal walau CI lulus; hapus file itu secara manual. `API_INPUTS` adalah daftar yang dirawat: route yang kelak mengimpor path di luar daftar menambahkan path tersebut bersama spec fiturnya.

Laporan pekerjaan mencatat perintah, versi tool, hasil ekspor/validasi/generate, hasil build, dan test kontrak yang relevan. Laporan release menyertakan identitas atau checksum OpenAPI serta bukti SDK berasal dari kontrak kandidat release. Regenerasi yang belum dijalankan atau gagal tidak boleh dilaporkan sebagai sinkronisasi selesai.

## Harness backend nyata untuk test SDK

`bun run test:frontend` memulai tepat satu backend nyata untuk seluruh run Vitest melalui `globalSetup` di `apps/frontend/vitest-backend.setup.ts`, yang dipasang lewat `runnerConfig` `vitest-base.config.ts` pada target `test` di `apps/frontend/angular.json`. Backend dijalankan dengan `bun --no-env-file apps/backend/src/index.ts` dari root, dengan environment yang hanya berisi `PATH`, `HOME`, `NODE_ENV=development`, `HOST=127.0.0.1`, dan `PORT` loopback pilihan sistem operasi, tanpa `.env` dan tanpa `DATABASE_URL`, serta stdio child yang dibuang. Harness mencetak satu baris `SDK contract backend listening on 127.0.0.1:<port>`, mencetak `SDK contract backend stopped` sesudah semua test, dan gagal dengan `SDK contract backend did not start` sesudah tiga percobaan. Start yang gagal tidak meninggalkan state bersama, sehingga setup berikutnya di proses yang sama mencoba lagi, dan `stop()` tidak menahan proses Vitest sesudah backend berhenti. Karena itu `test:frontend` membutuhkan `bun` di `PATH`.

Test membaca dua nilai dengan `inject` dari `vitest`: `sdkContractBackendUrl` untuk backend nyata, dan `sdkContractClosedUrl`, URL port loopback yang sudah ditutup, untuk kegagalan jaringan berstatus 0. Tipe keduanya berada di `apps/frontend/vitest-provided-context.d.ts`. Contohnya ada di `apps/frontend/src/app/sdk-contract.integration.spec.ts`:

- Bentuk request memakai `appConfig`, `provideHttpClientTesting()`, dan `HttpTestingController`.
- Respons nyata memakai `appConfig` ditambah `provideApiConfiguration(sdkContractBackendUrl)`, lalu operasi SDK melalui `HttpClient` nyata.
- Kegagalan jaringan memakai `provideApiConfiguration(sdkContractClosedUrl)`.
- Alur browser melalui proxy `/api` dibuktikan Playwright.

Backend harness tidak memakai database, sehingga hanya hasil yang dapat dihasilkan backend tanpa database yang dibuktikan di sini. Kelulusan `api:check`, build, dan test kesesuaian membuktikan operasi yang diuji saja; operasi baru membawa test kesesuaiannya sendiri pada spec fitur pemilik route.

## Referensi

- [Plugin OpenAPI resmi Elysia](https://elysiajs.com/plugins/openapi).
- [Package `@ojiepermana/angular` di npm](https://www.npmjs.com/package/@ojiepermana/angular); konfigurasi dan schematic diverifikasi dari `sdk/README.md`, schema, dan implementasi dalam artefak npm versi `22.1.14`.
- [Metadata dan artefak publik package](https://registry.npmjs.org/@ojiepermana%2fangular/22.1.14).
- [Target `typescript-angular` dari OpenAPI Generator](https://openapi-generator.tech/docs/generators/typescript-angular/).

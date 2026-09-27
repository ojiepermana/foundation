# OpenAPI backend dan SDK Angular

Backend menghasilkan `openapi.json` pada root monorepo. Frontend menghasilkan SDK dari file tersebut ke `apps/frontend/sdk/`, pada root workspace Angular. Aturan ini berlaku bersama [workflow development](development-workflow.md), [aturan backend](elysia.md), [aturan Angular](angular.md), dan [aturan testing](testing.md).

Setiap perubahan backend wajib diikuti ekspor ulang OpenAPI, validasi, dan regenerasi SDK sebelum pekerjaan dinyatakan selesai. Kewajiban ini tetap berlaku untuk perubahan internal backend yang tidak mengubah kontrak; hasil regenerasi boleh identik dengan file sebelumnya.

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
│   └── validate-openapi.ts          # Pemeriksaan kontrak melalui Bun
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

`scripts/export-openapi.ts` menggunakan Bun untuk merangkai komposisi route yang sama dengan backend, memperoleh JSON dari plugin, dan menulis `openapi.json` melalui `Bun.write()`. Script dapat menggunakan `app.handle()` untuk raw spec tanpa membuka port server; pastikan lifecycle plugin versi yang dipakai sudah siap sebelum membaca hasil.

Komposisi `app.ts` tidak menjalankan `listen()` saat diimpor. Pisahkan pembuatan resource dari startup agar ekspor tidak memerlukan database aktif, migration, seed, worker, atau pemanggilan layanan eksternal. Jangan mengganti route dengan endpoint mock untuk keperluan ekspor. Middleware autentikasi aplikasi tidak boleh menghalangi pembacaan spec oleh script ekspor.

Ekspor harus gagal bila respons plugin bukan JSON OpenAPI yang valid, route yang wajib hilang, atau referensi schema tidak terselesaikan. File root harus dapat dikonsumsi generator dari checkout yang sama tanpa mengunduh spec backend yang sedang berjalan di environment lain.

Gunakan `scripts/validate-openapi.ts` melalui Bun untuk pemeriksaan kontrak project tanpa dependency validator/linter tambahan. Root script `api:validate` menjalankan pemeriksaan tersebut. Saat diimplementasikan, pemeriksaan wajib mencakup:

- JSON dapat diparse sebagai object dokumen, versi OpenAPI yang didukung generator, metadata `info` wajib, dan struktur `paths`/operasi yang digunakan project.
- Kelengkapan dan keunikan `operationId`, tag fitur, serta schema input dan response yang diwajibkan kontrak fitur.
- Seluruh `$ref` lokal dapat diselesaikan dalam dokumen yang sama; reference eksternal ditolak agar artefak tidak memerlukan unduhan tambahan.
- Endpoint kontrak wajib tersedia dan deklarasi security scheme/referensinya sesuai keputusan specs.

Pelanggaran pemeriksaan wajib menghasilkan exit code bukan nol dan menghentikan `api:sync`/`api:check`. Uji checker dengan fixture valid serta fixture yang melanggar setiap aturan wajib ketika tooling dibuat.

Pemeriksaan Bun ini terbatas pada aturan kontrak dan bentuk OpenAPI yang digunakan project, bukan validator seluruh standar OpenAPI atau pengganti validasi request/response di server. Catat cakupan dan keterbatasannya; jangan melaporkan kelulusan sebagai sertifikasi kepatuhan penuh. Keberhasilan generate SDK, build Angular, dan test integrasi request/response nyata tetap diperlukan. Bentuk kontrak baru memerlukan pembaruan pemeriksaan dan bukti dukungan generator sebelum digunakan.

Hasil ekspor harus deterministik untuk kode dan konfigurasi kontrak yang sama. Gunakan formatting tetap dan urutan key object yang konsisten tanpa mengubah urutan array yang bermakna. Jangan memasukkan waktu generate, URL environment sementara, atau data runtime yang berubah ke artefak. Simpan seluruh schema yang dirujuk dalam dokumen yang dapat dikonsumsi lokal.

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

Konfigurasi dan command telah diperiksa terhadap artefak npm `@ojiepermana/angular` versi `22.1.14`. Ini adalah rujukan pemeriksaan, bukan perintah untuk memasang versi tersebut tanpa memeriksa kompatibilitas Angular, TypeScript, dan peer dependency project. Saat versi library berubah, periksa kembali schema konfigurasi dan public API versi yang dipasang.

SDK yang dihasilkan dipakai melalui barrel `sdk/public-api.ts`, dengan alias TypeScript seperti `@sdk` yang dikonfigurasi dalam workspace frontend. Pastikan file SDK di luar `src/` masuk kompilasi dan build Angular; jangan hanya memeriksa bahwa generator berhasil menulis file.

Frontend menyediakan `provideHttpClient()` dan mengatur backend URL melalui `provideApiConfiguration(...)` dari barrel SDK hasil generate pada konfigurasi aplikasi. `rootUrl: ""` menggunakan origin yang sama; environment dengan backend terpisah mengatur URL saat bootstrap tanpa generate SDK berbeda untuk setiap environment. Autentikasi dan kebijakan HTTP aplikasi diintegrasikan melalui fasilitas Angular yang relevan.

`<fitur>-api.ts` mengadaptasi service/operasi SDK untuk kebutuhan fitur. Component dan store memanggil adapter tersebut. Jangan menulis ulang endpoint dan DTO backend dengan `HttpClient` manual ketika SDK telah menyediakan operasinya.

## Kepemilikan dan sinkronisasi artefak

Seluruh isi `apps/frontend/sdk/` dikelola generator. Jangan mengedit generated code atau menaruh adapter, state, UI, dan kode manual di dalamnya. Perbaikan dilakukan pada schema backend, konfigurasi generator, atau adapter fitur sesuai sumber masalahnya.

Pertahankan `.ojiepermana-sdk-manifest.json` yang dibuat schematic. Generator memakai manifest untuk menghapus file hasil generate yang sudah tidak diperlukan ketika endpoint/model berubah. Jangan menghapus seluruh folder secara paksa untuk menutupi konflik atau kehilangan kepemilikan file.

Simpan `openapi.json`, konfigurasi SDK, hasil SDK, dan manifest dalam version control bersama perubahan sumbernya. File yang bertambah, berubah, maupun dihapus harus ikut diperiksa. Tetapkan satu penanggung jawab regenerasi ketika beberapa subagent bekerja pada backend agar tidak saling menimpa artefak bersama.

## Script root dan urutan wajib

Saat tooling diimplementasikan, gunakan script pada `package.json` root berikut:

| Script | Tanggung jawab |
| --- | --- |
| `api:openapi` | Ekspor route/schema backend ke `openapi.json`. |
| `api:validate` | Pemeriksaan kontrak OpenAPI root melalui script Bun tanpa validator tambahan. |
| `sdk:generate` | Generate `apps/frontend/sdk/` dengan schematic package pilihan. |
| `api:sync` | Jalankan ekspor, validasi, lalu generate SDK secara berurutan; berhenti saat satu tahap gagal. |
| `api:check` | Jalankan ulang alur dan buktikan artefak yang disimpan sesuai sumber serta dapat direproduksi. |

Setiap perubahan backend, dependency/schema bersama yang memengaruhi backend, konfigurasi OpenAPI, maupun versi/config generator wajib menjalankan `api:sync`. Setelah itu jalankan build frontend dan test yang relevan dengan dampak perubahan. Hasil identik tetap dilaporkan sebagai regenerasi berhasil, bukan alasan melewati proses.

CI menjalankan `api:check` sebelum verifikasi integrasi frontend yang bergantung pada SDK. Pemeriksaan gagal ketika ada perbedaan artefak, validasi gagal, atau SDK tidak dapat digenerate. Bandingkan terhadap artefak kandidat yang disimpan, dengan output terisolasi atau checkout CI bersih. Pemeriksaan harus mencakup file baru yang belum tracked dan file lama yang dihapus; `git diff` saja tidak mendeteksi seluruh file baru.

Buktikan pula dua run dengan sumber dan versi tool sama menghasilkan artefak identik. Build Angular dan test integrasi membuktikan pemakaian SDK, sedangkan pemeriksaan drift membuktikan SDK berasal dari kontrak terbaru. Keduanya diperlukan; generate berhasil saja tidak membuktikan perilaku backend.

Laporan pekerjaan mencatat perintah, versi tool, hasil ekspor/validasi/generate, hasil build, dan test kontrak yang relevan. Laporan release menyertakan identitas atau checksum OpenAPI serta bukti SDK berasal dari kontrak kandidat release. Regenerasi yang belum dijalankan atau gagal tidak boleh dilaporkan sebagai sinkronisasi selesai.

## Referensi

- [Plugin OpenAPI resmi Elysia](https://elysiajs.com/plugins/openapi).
- [Package `@ojiepermana/angular` di npm](https://www.npmjs.com/package/@ojiepermana/angular); konfigurasi dan schematic diverifikasi dari `sdk/README.md`, schema, dan implementasi dalam artefak npm versi `22.1.14`.
- [Metadata dan artefak publik package](https://registry.npmjs.org/@ojiepermana%2fangular/22.1.14).
- [Target `typescript-angular` dari OpenAPI Generator](https://openapi-generator.tech/docs/generators/typescript-angular/).

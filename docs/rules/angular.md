# Struktur frontend Angular

Frontend berada di `apps/frontend/`. Kode dikelompokkan berdasarkan area fitur agar mudah ditemukan, dikembangkan, dan dibagi kepada subagent.

Struktur ini merupakan aturan untuk implementasi frontend, bukan hanya contoh organisasi. Semua pekerjaan frontend juga mengikuti [aturan UI dan UX](ui-ux.md), dengan seluruh komponen library UI menggunakan package `@ojiepermana/angular` melalui entry point publik yang sesuai.

Ikuti [aturan keamanan](security.md): guard UI bukan otorisasi backend, credential tidak disimpan dalam browser storage atau bundle, dan integrasi library tetap mengikuti sanitization serta CSP aplikasi. Development menggunakan port `8889` melalui [doctor dan serve](development-commands.md), dengan proxy API ke backend port `8888`.

## Struktur dasar

```text
apps/frontend/
├── angular.json
├── tsconfig.json
├── tsconfig.app.json
├── sdk.config.json
├── sdk/                       # Hasil generate OpenAPI, di luar src/
│   └── public-api.ts
├── Dockerfile
├── public/
└── src/
    ├── main.ts
    ├── index.html
    ├── styles.css
    └── app/
        ├── app.ts
        ├── app.html
        ├── app.config.ts
        ├── app.routes.ts
        ├── core/
        │   ├── session/
        │   └── http/
        ├── shell/
        ├── shared/
        └── features/
            ├── authentication/
            │   ├── authentication.routes.ts
            │   ├── authentication-api.ts
            │   ├── login/
            │   └── register/
            ├── products/
            │   ├── products.routes.ts
            │   ├── products-api.ts
            │   ├── products-store.ts
            │   ├── product-list/
            │   ├── product-detail/
            │   └── product-card/
            └── reports/
                ├── reports.routes.ts
                ├── reports-api.ts
                └── report-list/
```

Nama fitur merupakan contoh. Buat folder dan file ketika dibutuhkan oleh fitur yang dikerjakan, bukan sebagai struktur kosong yang wajib dilengkapi.

`angular.json` dan konfigurasi khusus frontend berada di `apps/frontend/`. Dependency dan script dikelola melalui satu `package.json` di root monorepo. Tidak ada `package.json` tersendiri di frontend.

## Tanggung jawab folder

| Bagian | Tanggung jawab |
| --- | --- |
| `sdk/` pada root frontend | Model, operasi, dan service HTTP hasil generate dari `openapi.json` root monorepo; dikelola generator. |
| `core/` | Infrastruktur seluruh aplikasi, seperti session dan konfigurasi HTTP. |
| `shell/` | Integrasi dan konfigurasi default layout wrapper dari `@ojiepermana/angular/theme`. |
| `shared/` | Komposisi UI dari library pilihan project atau perilaku umum yang digunakan beberapa fitur dalam frontend ini. |
| `features/` | Halaman, komunikasi API, state, dan aturan khusus setiap area fitur. |

Service khusus produk tetap berada di fitur produk walaupun digunakan beberapa halaman produk. Jangan memindahkan semua service ke `core/`.

## Layout dari theme

Package yang digunakan adalah `@ojiepermana/angular`. `theme` merupakan salah satu bagian yang dapat digunakan melalui entry point `@ojiepermana/angular/theme`. Untuk layout aplikasi, gunakan default layout wrapper dari bagian tersebut sesuai pilihan yang telah disepakati.

`shell/` hanya menampung integrasi dan konfigurasi aplikasi terhadap wrapper tersebut jika diperlukan. Jangan membuat ulang default layout, header, atau sidebar yang sudah ditangani wrapper, atau membuat `main-layout` dan `public-layout` custom secara otomatis.

Jika integrasi cukup dilakukan di komponen root dan konfigurasi aplikasi, folder `shell/` tidak wajib dibuat. Jangan menambahkan wrapper lokal yang tidak memiliki tanggung jawab tambahan.

Saat implementasi, periksa API publik versi library yang digunakan untuk mengetahui export, selector, dan konfigurasi yang tersedia. Jangan menebak nama komponen atau menyalin implementasi internal library.

## Organisasi fitur dan file

- Tempatkan file yang berkaitan berdekatan. Komponen, template, style, dan unit test menggunakan nama dasar yang sama dan berada dalam satu folder, seperti `login.ts`, `login.html`, `login.css`, dan `login.spec.ts`.
- Gunakan nama file yang menjelaskan tanggung jawab, seperti `products-api.ts` dan `products-store.ts`.
- Fitur kecil cukup beberapa file. Tambahkan subfolder berdasarkan bagian fitur ketika kompleksitasnya meningkat.
- Jangan mengumpulkan seluruh komponen, service, atau model dari berbagai fitur dalam folder global berdasarkan jenis file.
- Folder fitur mengikuti area aplikasi. Scope tetap berupa fitur kecil, sehingga scope login dan registrasi dapat berada dalam area `authentication` yang sama.

## Batas ketergantungan dan state

- Fitur boleh menggunakan `core/`, `shared/`, dan library bersama yang sesuai untuk browser.
- `core/` dan `shared/` tidak mengimpor implementasi dari `features/`.
- Jangan mengimpor file internal fitur lain secara langsung. Kebutuhan antarfitur menggunakan antarmuka publik atau kontrak yang disepakati.
- State halaman tetap lokal. State yang digunakan beberapa bagian dari satu fitur dimiliki fitur tersebut. State session aplikasi berada di `core/session/`.
- `shared/` melayani frontend ini. Pindahkan komposisi UI ke `libs/ui/` ketika memang diperlukan oleh beberapa aplikasi Angular. Keduanya menggunakan komponen dari package `@ojiepermana/angular` melalui entry point publik yang sesuai, bukan membuat ulang komponen dasar library.
- Tipe request/response HTTP dan operasi backend berasal dari SDK di `apps/frontend/sdk/`. `libs/contracts/` memuat kontrak bersama lain yang diperlukan, seperti pesan worker; jangan menduplikasi DTO HTTP secara manual. Model khusus tampilan tetap dekat dengan fitur yang menggunakannya.
- Frontend tidak mengimpor kode backend, worker, atau `libs/server/`.

## Komunikasi backend melalui SDK

Ikuti [aturan OpenAPI dan SDK](openapi-sdk.md). Gunakan generator dari package `@ojiepermana/angular` melalui schematic `@ojiepermana/angular:sdk`; entry point `@ojiepermana/angular/sdk` merupakan permukaan konfigurasi SDK. Output memakai mode `standalone` di `apps/frontend/sdk/`, tanpa membuat package baru.

Import tipe dan service melalui barrel SDK yang dihasilkan. Konfigurasikan alias TypeScript serta cakupan kompilasi untuk folder SDK di luar `src/`, dan buktikan dengan build Angular. Konfigurasi aplikasi menyediakan `provideHttpClient()` serta `provideApiConfiguration(...)` dari barrel SDK sesuai URL backend environment.

File `<fitur>-api.ts` di fitur mengadaptasi service/operasi SDK; component dan store menggunakannya. Jangan mengedit SDK atau menulis ulang endpoint serta DTO yang sudah tersedia dari hasil generate. Setiap perubahan backend wajib diikuti regenerasi dan verifikasi pemakaian SDK sebelum integrasi dinyatakan selesai.

Batas impor `@sdk` yang ditegakkan `check:frontend:bundle`, kontrak adapter fitur, dan harness backend nyata untuk test SDK mengikuti [spec 0009](../specs/0009-sdk-sesuai-kontrak-backend/index.md) yang dirangkum pada [aturan OpenAPI dan SDK](openapi-sdk.md): hanya `src/app/app.config.ts` dan adapter `src/app/features/<fitur>/<fitur>-api.ts` yang boleh mengimpor `@sdk`.

## Routing

`app.routes.ts` menghubungkan route utama. Setiap area fitur memiliki konfigurasi route sendiri ketika diperlukan.

Gunakan lazy loading pada batas fitur yang sesuai untuk mengurangi JavaScript awal. Halaman utama dapat dimuat langsung. Hindari menambahkan tingkatan lazy loading tanpa kebutuhan.

## Koordinasi subagent

Unit dan integration komponen menggunakan Vitest melalui Angular CLI sesuai versi project. Alur pengguna lintas aplikasi menggunakan Playwright; pengukuran performance menggunakan k6 ketika diperlukan. Penempatan test dan bukti kesiapan mengikuti [aturan testing](testing.md).

Bagikan pekerjaan berdasarkan fitur atau bagian fitur dengan kepemilikan file yang jelas, mengikuti [workflow development](development-workflow.md).

Agent utama dan setiap subagent frontend wajib membaca aturan struktur ini serta aturan UI/UX sebelum implementasi. Tugas subagent mencantumkan path area fitur yang menjadi tanggung jawabnya dan specs yang relevan.

Perubahan `app.routes.ts`, `app.config.ts`, komponen root, integrasi layout, konfigurasi SDK, dan kode bersama dikoordinasikan oleh agent utama. Tetapkan satu penanggung jawab saat file tersebut perlu diubah; regenerasi SDK mengikuti kepemilikan artefak OpenAPI/SDK bersama dalam workflow.

## Referensi

- [Panduan struktur dan penamaan Angular](https://angular.dev/style-guide).
- [Strategi pemuatan route Angular](https://angular.dev/guide/routing/loading-strategies).

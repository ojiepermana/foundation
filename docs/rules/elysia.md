# Struktur backend Bun dan ElysiaJS

Backend berada di `apps/backend/`, menggunakan TypeScript, Bun sebagai runtime, dan ElysiaJS untuk HTTP. Struktur kode mengikuti area fitur sesuai [workflow development](development-workflow.md).

Utamakan fasilitas native Bun yang memenuhi kebutuhan fitur. Akses PostgreSQL menggunakan `Bun.SQL` tanpa ORM. Pengelolaan migration dan seed mengikuti [aturan database](database.md) dan berada di luar `apps/`.

Ikuti [aturan keamanan](security.md) untuk validasi, permission pada setiap request, sesi/CSRF, limit, dan batas resource. Role runtime mengakses schema `common`, `users`, dan `auth` sesuai privilege yang disepakati; query memakai identifier berkualifikasi schema. Database migration tetap dijalankan terpisah.

Development backend memakai `HOST` dan `PORT` yang diberikan root supervisor, dengan default `127.0.0.1:8888`. Jalankan bersama frontend melalui [doctor dan serve](development-commands.md), bukan dengan angka port berbeda yang tersebar di script fitur.

## Health dan log production

Kedua komposisi `createApp` memasang `GET /health/live` dan `GET /health/ready` di `apps/backend/src/features/health/` (spec 0012), di luar `/api/` sehingga edge deployment tidak pernah meneruskannya. `/health/live` menjawab 200 tanpa menyentuh pool. `/health/ready` menjalankan paling banyak satu pemeriksaan per proses atas `common.schema_migrations` dengan `REQUIRED_MIGRATION` sebagai parameter, dan menjawab 503 bila database tidak siap. Kedua route memakai penjaga GET bersama `plugins/request-guard.ts` dan `Cache-Control: no-store`, tanpa waktu, versi, atau pesan error di jawaban. Setiap migration baru memperbarui `REQUIRED_MIGRATION` di `health.queries.ts` pada commit yang sama.

Komposisi production hanya memasang route health; route development, plugin OpenAPI, admin, metrics, dan debug tidak ada. Pada `NODE_ENV=production`, `index.ts` memberi `log` ke `createApp`, sehingga plugin `plugins/request-log.ts` menulis satu baris JSON per request (tanpa query, header, cookie, body, atau IP) serta baris lifecycle JSON, dengan level `info` ke stdout dan `error` ke stderr. Teks lifecycle development tidak berubah. Kebijakan endpoint dan retensi log ada di [aturan deployment](deployment.md).

## Struktur backend

```text
apps/backend/
├── Dockerfile
├── tsconfig.json
└── src/
    ├── index.ts
    ├── app.ts
    ├── config/
    │   └── env.ts
    ├── plugins/
    │   ├── database.ts
    │   ├── openapi.ts
    │   └── error-handler.ts
    └── features/
        ├── authentication/
        │   ├── authentication.routes.ts
        │   ├── authentication.schema.ts
        │   ├── authentication.service.ts
        │   └── authentication.queries.ts
        └── users/
            ├── users.routes.ts
            ├── users.schema.ts
            ├── users.service.ts
            ├── users.queries.ts
            └── users.test.ts
```

Nama fitur dan file merupakan contoh. Buat bagian yang diperlukan oleh fitur, tanpa membuat folder kosong atau lapisan tambahan yang belum memiliki tanggung jawab.

Backend tidak memiliki `package.json` sendiri. Dependency dan script berada dalam satu `package.json` di root monorepo, dengan satu `bun.lock`. Dockerfile backend dibangun dengan root monorepo sebagai build context.

## Tanggung jawab file

| File atau area | Tanggung jawab |
| --- | --- |
| `index.ts` | Menjalankan server dan mengoordinasikan shutdown serta penutupan resource. |
| `app.ts` | Merangkai aplikasi Elysia, plugin, dan route fitur tanpa menjalankan server saat diimpor. |
| `config/env.ts` | Membaca dan memvalidasi konfigurasi backend. |
| `plugins/database.ts` | Menghubungkan client database bersama dengan aplikasi Elysia, bukan menjalankan migration atau seed. |
| `plugins/openapi.ts` | Konfigurasi plugin resmi OpenAPI untuk menghasilkan kontrak dari route/schema aplikasi. |
| `plugins/error-handler.ts` | Memetakan kesalahan menjadi respons HTTP yang konsisten. |
| `*.routes.ts` | Endpoint, status HTTP, dan penghubung schema dengan service. |
| `*.schema.ts` | Validasi request dan response melalui fasilitas Elysia. Schema ini bukan model ORM. |
| `*.service.ts` | Aturan bisnis dan koordinasi transaksi fitur. |
| `*.queries.ts` | SQL langsung dan pemetaan hasil database untuk fitur. |

Untuk fitur sederhana, file tidak harus langsung dipisah menjadi semua peran tersebut. Pisahkan ketika tanggung jawab atau kompleksitasnya membutuhkan batas yang jelas.

## Penggunaan fasilitas native Bun

| Kebutuhan | Pilihan utama |
| --- | --- |
| Akses PostgreSQL | `Bun.SQL`, termasuk parameter query, pool, dan transaksi. |
| Environment variable | `Bun.env`, dengan validasi eksplisit pada konfigurasi aplikasi. |
| Hash dan verifikasi password | API async `Bun.password.hash()` dan `Bun.password.verify()`. |
| Membaca atau menulis file | `Bun.file()` dan `Bun.write()` ketika sesuai kebutuhan. |
| Pengujian | `bun:test` melalui `bun test`. |

Jangan menambahkan dependency untuk menggantikan kemampuan native yang sudah memenuhi kebutuhan. Jika ada kebutuhan yang belum dipenuhi Bun atau Elysia, catat kebutuhan dan alasan penggunaan library tambahan dalam specs fitur. ORM tetap tidak digunakan.

Periksa API versi Bun dan Elysia yang digunakan saat implementasi. Gunakan pola chaining Elysia dan deklarasikan plugin yang dibutuhkan secara eksplisit agar tipe dan dependensi tetap jelas.

## Batas aplikasi dan kode bersama

- Aplikasi menjalankan endpoint dan logika bisnis, termasuk query operasional fitur. Pengelolaan skema dan data awal tidak menjadi bagian startup aplikasi.
- Query khusus fitur tetap dekat dengan fitur di `*.queries.ts`.
- Factory client database berada di `libs/server/database/` dan tidak bergantung pada backend atau worker tertentu.
- Backend dan worker tidak mengimpor implementasi aplikasi satu sama lain. Pindahkan kode bisnis yang benar-benar dibutuhkan keduanya ke `libs/server/`.
- Route/schema Elysia menghasilkan kontrak HTTP `openapi.json` di root, yang menjadi input SDK frontend. `libs/contracts/` dapat memuat kontrak pesan antarbagian dan definisi bersama yang diperlukan; frontend memakai DTO HTTP dari SDK hasil generate. Jangan mengekspos hasil row database secara otomatis sebagai kontrak API.
- Backend dan worker tidak mengimpor frontend. Frontend tidak mengimpor kode server atau runtime Bun.

## OpenAPI dan sinkronisasi SDK frontend

Ikuti [aturan OpenAPI dan SDK](openapi-sdk.md). Gunakan plugin resmi `@elysia/openapi` dengan versi yang kompatibel, dikelola melalui dependency root. Route mendeklarasikan schema request/response, status kesalahan, `operationId` yang unik dan stabil, tag, serta security sesuai perilaku aktual.

Ekspor kontrak ke `openapi.json` root melalui script Bun `scripts/export-openapi.ts`, menggunakan komposisi route nyata tanpa startup server, migration, atau seed. Pembuatan resource runtime tidak boleh membuat ekspor bergantung pada database aktif atau layanan eksternal.

Setiap perubahan backend wajib menjalankan ekspor ulang, validasi, dan regenerasi SDK melalui `api:sync`, termasuk perubahan internal yang menghasilkan artefak identik. SDK menggunakan generator `@ojiepermana/angular` dan berada di `apps/frontend/sdk/`. Verifikasi build frontend dan test yang terdampak sebelum menyatakan pekerjaan selesai.

## Verifikasi dan koordinasi agent

Unit test berada dekat dengan kode yang diverifikasi. Integration test database menggunakan PostgreSQL 18 sebagai baseline, sesuai aturan database.

Unit dan integration server menggunakan `bun:test`. E2E lintas aplikasi menggunakan Playwright dan performance menggunakan k6. Cakupan runner, registry skenario, serta bukti hasil mengikuti [aturan testing](testing.md).

Agent utama dan subagent backend membaca aturan ini, aturan database, serta aturan OpenAPI/SDK sebelum implementasi. Pembagian tugas mengikuti fitur dan kepemilikan file. Agent utama menetapkan satu penanggung jawab ekspor OpenAPI dan regenerasi SDK setelah perubahan backend dari para subagent digabungkan.

Perubahan komposisi aplikasi, konfigurasi, plugin bersama, client database, kontrak, dan migration dikoordinasikan oleh agent utama dengan satu penanggung jawab untuk setiap file bersama.

## Referensi

- [Struktur dan praktik ElysiaJS](https://elysiajs.com/essential/best-practice).
- [API SQL Bun](https://bun.com/docs/runtime/sql).
- [Environment variable Bun](https://bun.com/docs/runtime/environment-variables).
- [Hashing password Bun](https://bun.com/docs/runtime/hashing).
- [File I/O Bun](https://bun.com/docs/runtime/file-io).
- [Test runner Bun](https://bun.com/docs/test).

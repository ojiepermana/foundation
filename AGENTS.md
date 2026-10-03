# Panduan agent

Aturan project berlaku untuk agent utama dan setiap subagent yang bekerja di repository ini.

## Build approach

Tracer Bullet: membuktikan satu alur nyata lintas aplikasi terlebih dahulu, lalu memperluasnya. (sumber: `docs/scope/scope.md`)

## Sumber aturan

- Baca [aturan infrastruktur pendukung](docs/rules/infrastructure.md) saat menyiapkan atau mengubah layanan pendukung. `docker-compose.yml` root hanya untuk infrastruktur di luar runtime aplikasi; frontend, backend, dan worker tetap dijalankan melalui `bun run serve`. Credential administrator Compose terpisah dari credential runtime.
- Baca [aturan keamanan](docs/rules/security.md) saat merencanakan, mengimplementasikan, atau memverifikasi fitur. Tetapkan permission backend, batas input/resource, keamanan sesi, privilege database, dan skenario serangan sesuai dampaknya.
- Baca [perintah doctor dan serve](docs/rules/development-commands.md) saat menyiapkan atau menjalankan development. Gunakan `bun run doctor` dan `bun run serve`; frontend port `8889`, backend `8888`, worker opsional. `serve` menjalankan preflight lalu membersihkan listener pada port layanan terpilih sebelum startup.
- Baca [workflow development](docs/rules/development-workflow.md) sebelum merencanakan, mengerjakan fitur, atau melakukan commit. Scope dan specs mengikuti fitur kecil; pekerjaan dapat berjalan paralel setelah kontrak yang diperlukan disepakati. Kelompokkan commit berdasarkan tujuan perubahan; satu commit diperbolehkan untuk perubahan kecil atau satu kelompok yang koheren, tanpa memaksakan pemecahan. Setiap commit wajib diikuti pembaruan knowledge graph melalui `graphify update .`; `graphify-out/` bersifat lokal dan tidak di-commit.
- Baca [aturan testing dan kesiapan release](docs/rules/testing.md) untuk setiap pekerjaan. Tentukan skenario dan pemeriksaan sesuai dampak perubahan, gunakan unit/integration, Playwright, dan k6 sesuai kebutuhan, serta laporkan bukti dan keterbatasan sebelum menyatakan selesai atau siap production.
- Baca [aturan OpenAPI dan SDK](docs/rules/openapi-sdk.md) saat pekerjaan melibatkan backend atau komunikasi frontend ke backend. Backend mengekspor `openapi.json` root; SDK dihasilkan dengan `@ojiepermana/angular` ke `apps/frontend/sdk/`. Setiap perubahan backend wajib ekspor ulang, validasi, dan regenerasi SDK, termasuk ketika hasilnya identik.
- Baca [struktur frontend Angular](docs/rules/angular.md) saat pekerjaan melibatkan frontend. Package yang digunakan adalah `@ojiepermana/angular`; layout aplikasi menggunakan default layout wrapper melalui entry point `@ojiepermana/angular/theme`.
- Baca [aturan UI dan UX](docs/rules/ui-ux.md) saat merancang, mengimplementasikan, atau memverifikasi frontend. Seluruh komponen library UI menggunakan package `@ojiepermana/angular` melalui entry point publik yang sesuai. `theme` adalah salah satu bagian yang dapat digunakan, bukan sumber seluruh komponen.
- Baca [struktur backend Bun dan ElysiaJS](docs/rules/elysia.md) saat pekerjaan melibatkan backend. Utamakan fasilitas native Bun dan gunakan SQL langsung tanpa ORM.
- Baca [aturan database](docs/rules/database.md) saat pekerjaan melibatkan koneksi, query, skema, migration, seed, atau deployment database. PostgreSQL minimal 18, client `Bun.SQL`, schema `common` untuk metadata migration, `users` untuk domain pengguna, dan `auth` untuk autentikasi. Migration serta seed berada di `database/` root, di luar `apps/`.
- Baca [konsep worker](docs/rules/worker.md) saat pekerjaan melibatkan worker atau container worker.

## Saat menjalankan /scope atau /architect

Untuk fitur yang membuat atau mengubah data persisten, tanyakan kepada pengguna: "Data fitur ini ditempatkan di schema mana: common, users, auth, atau schema domain lain?" Jelaskan rekomendasi berdasarkan domain. Jika fitur mencakup beberapa schema, tanyakan pembagian entitasnya dalam satu pertanyaan yang ringkas. Jangan menetapkan schema baru secara diam-diam.

Jika keputusan fitur tersebut sudah dinyatakan dalam percakapan atau specs yang berlaku, gunakan keputusan itu dan sebutkan sumbernya; tidak perlu meminta konfirmasi ulang. Fitur tanpa perubahan database dicatat tidak membutuhkan schema. Scope mencatat pilihan/keputusan yang masih diperlukan; specs menetapkan schema per entitas, relasi, migration, role, dan batas akses sebelum implementasi bagian yang bergantung padanya.

Pertanyaan ini berlaku juga ketika pengguna menulis variasi `/architects` atau `/architecs` dengan maksud menjalankan `/architect`. Aturan project ini melengkapi workflow skill; skill global tidak diubah.

## Koordinasi subagent

Saat mendelegasikan pekerjaan, agent utama menyertakan rujukan rules dan specs yang relevan, kontrak, batas tanggung jawab, kepemilikan file, dan kriteria penerimaan.

Sertakan aturan keamanan dan keputusan schema/role yang relevan. Subagent tidak boleh memilih schema baru, memperluas privilege, atau mengurangi pemeriksaan keamanan lintas fitur secara sepihak.

Setiap tugas menyertakan aturan testing, ID skenario yang perlu dibuktikan, batas file test, dan cara verifikasi yang relevan. Subagent melaporkan perintah serta hasil aktual; agent utama menggabungkan bukti integrasi dan kesiapan release. Skenario wajib yang gagal, dilewati, atau belum memiliki bukti tidak boleh dilaporkan sebagai lulus.

Untuk setiap tugas frontend, sertakan aturan struktur Angular dan UI/UX di atas, serta aturan OpenAPI/SDK jika berkomunikasi dengan backend. Setiap subagent frontend wajib membaca rujukan yang relevan sebelum implementasi.

Untuk setiap tugas backend, sertakan aturan Bun/ElysiaJS, database, dan OpenAPI/SDK. Tetapkan satu penanggung jawab artefak OpenAPI/SDK bersama; subagent frontend diberi tahu ketika SDK terbaru siap digunakan. Untuk tugas worker atau runner database, sertakan aturan yang relevan dengan runtime dan akses database. Setiap subagent wajib membaca rujukan tugasnya sebelum implementasi.

Setiap subagent membaca rujukan tersebut, bekerja mandiri dalam batas tugasnya, dan mengomunikasikan perubahan atau hambatan yang memengaruhi agent lain. Perubahan kontrak dan file bersama dikoordinasikan melalui agent utama sesuai workflow development.

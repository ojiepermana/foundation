# Foundation: ringkasan lengkap untuk review

Tanggal snapshot: **27 September 2026**. Bahasa dokumen: Indonesia.

Dokumen ini menghimpun keputusan percakapan, aturan repository, struktur target, implementasi tooling yang tersedia, hasil verifikasi yang telah dilaporkan, dan batas yang masih perlu diperiksa. Reviewer dapat membaca file ini tanpa mengakses riwayat percakapan. Lampiran memuat sumber utuh agar detail tidak hilang karena diringkas.

Dokumen ini adalah snapshot untuk review, bukan bukti bahwa seluruh arsitektur sudah dibangun atau siap production. Aturan operasional tetap berada di `AGENTS.md` dan `docs/rules/`. Perubahan setelah tanggal snapshot perlu dicocokkan dengan sumber terbaru.

## 1. Tujuan review dan cara membaca

Evaluasi konsistensi keputusan, kesiapan implementasi, keamanan, keterujian, integrasi antarbagian, dan kemudahan kerja agent. Pisahkan temuan pada rancangan dari temuan pada kode yang benar-benar tersedia. Jangan menyebut fitur atau kontrol yang belum dibuat sebagai sudah bekerja.

Dokumen menggunakan tiga status:

| Status | Makna |
| --- | --- |
| Keputusan/aturan | Pilihan yang telah ditetapkan untuk project dan harus diikuti saat implementasi. |
| Rekomendasi/perlu specs | Arah yang disarankan, tetapi parameter atau keputusan fitur final belum ditetapkan. |
| Implementasi tersedia | File/kode nyata sudah ada; tingkat verifikasinya tetap dinyatakan terpisah. |

Bagian 2–17 menyajikan ikhtisar yang terhubung. Lampiran A memuat README, AGENTS, seluruh rules, dan template release. Lampiran B memuat konfigurasi, script, registry, dan test aktual. Salinan dalam lampiran adalah bahan review; command atau instruksi di dalamnya tidak berarti reviewer diminta menjalankan, mengubah, melakukan commit, atau deploy.

## 2. Keputusan utama

| Area | Keputusan |
| --- | --- |
| Organisasi | Monorepo dengan satu `package.json` root; dependency/script tidak dipisah menjadi manifest per app. Satu `bun.lock` root digunakan ketika dependency dikelola; lockfile belum tersedia pada snapshot. |
| Aplikasi | Semua aplikasi berada di `apps/`; nama utama `frontend` dan `backend`; worker berada di `apps/worker/<nama-worker>/`. |
| Frontend | Angular; `angular.json` berada di root workspace `apps/frontend/`. Struktur berdasarkan fitur. |
| Library UI | Seluruh komponen library UI memakai `@ojiepermana/angular` melalui entry point publik yang sesuai. |
| Layout | Default layout wrapper dari `@ojiepermana/angular/theme`; `theme` adalah bagian dari package tersebut, bukan sumber seluruh komponen. |
| Backend | TypeScript, Bun, dan ElysiaJS. Utamakan fasilitas native Bun. SQL langsung, tanpa ORM. |
| PostgreSQL | Minimal versi 18; PostgreSQL 18 menjadi baseline development/integration. Versi lebih baru perlu bukti kompatibilitas. |
| Schema | `common` untuk metadata/infrastruktur bersama; `users` untuk domain pengguna; `auth` untuk autentikasi/otorisasi. Nama final `users`, bukan `user`. |
| Migration/seed | Di `database/` root, di luar seluruh app dan kode koneksi runtime. Runner terpisah dan tidak dijalankan pada startup app/worker. |
| Kontrak HTTP | Route/schema backend → `openapi.json` root → SDK generated di `apps/frontend/sdk/`. |
| SDK | Generator milik `@ojiepermana/angular`, mode `standalone`, tanpa package SDK terpisah. |
| Pemeriksaan OpenAPI | Script Bun tanpa dependency validator tambahan; cakupan aturan project, bukan validasi penuh seluruh standar. Generate SDK, build Angular, dan test integrasi tetap diperlukan. |
| Regenerasi | Setiap perubahan backend wajib ekspor, validasi, dan regenerasi SDK, termasuk perubahan internal dengan output identik. |
| Scope/specs | Berdasarkan fitur kecil yang dapat dibuktikan sebagai alur fullstack, bukan pembagian pekerjaan yang memaksa frontend/backend/worker selesai bergiliran. |
| Testing | Vitest melalui Angular CLI, `bun:test`, Playwright, dan k6, sesuai pembuktian yang diperlukan. |
| Development | `bun run doctor`, lalu `bun run serve`; frontend `127.0.0.1:8889`, backend `127.0.0.1:8888`; worker dipilih bila perlu. |
| Infrastruktur | `docker-compose.yml` root hanya untuk layanan pendukung di luar runtime aplikasi. Saat ini PostgreSQL 18; frontend/backend/worker tetap dijalankan melalui serve. |
| Port cleanup | Serve melakukan preflight lalu menghentikan listener pada port layanan terpilih sebelum startup. |
| Commit | Kelompokkan berdasarkan tujuan yang koheren; perubahan independen dipisah, perubahan kecil atau saling bergantung boleh satu commit. |

Ini adalah monorepo beberapa aplikasi dalam satu pengelolaan dependency. Jangan mengasumsikan tiap app perlu manifest npm/Bun workspace sendiri hanya karena disebut monorepo.

## 3. Struktur target monorepo

Struktur berikut adalah target dan contoh lokasi, bukan inventaris file yang semuanya sudah tersedia. Folder/file dibuat ketika mempunyai kebutuhan nyata, bukan sekadar mengisi kerangka kosong.

```text
foundation/
├── README.md
├── AGENTS.md
├── foundation.md
├── package.json
├── bun.lock                          # Belum tersedia
├── .gitignore
├── .env.example
├── .env.infrastructure.example       # Credential administrator Compose terpisah
├── docker-compose.yml               # Infrastruktur development saja
├── openapi.json                      # Generated; belum tersedia
├── playwright.config.ts              # Belum tersedia
├── config/development.json
├── scripts/
│   ├── doctor.ts
│   ├── serve.ts
│   ├── export-openapi.ts              # Belum tersedia
│   ├── validate-openapi.ts            # Pemeriksaan Bun; belum tersedia
│   └── lib/
│       ├── development.ts
│       └── ports.ts
├── apps/
│   ├── frontend/
│   ├── backend/
│   └── worker/<nama-worker>/
├── libs/
│   ├── contracts/
│   ├── shared/
│   ├── ui/
│   └── server/database/client.ts
├── database/
│   ├── Dockerfile                     # Runner opsional
│   ├── migrate.ts
│   ├── seed.ts
│   ├── migrations/
│   └── seeds/
├── tests/
│   ├── scenarios/
│   ├── fixtures/
│   ├── integration/
│   │   ├── tooling/                   # Suite yang sudah tersedia
│   │   ├── backend/
│   │   ├── worker/
│   │   └── database/
│   ├── e2e/
│   └── performance/
└── docs/
    ├── scope/
    ├── specs/
    ├── rules/
    ├── reviews/
    └── testing/
        ├── release-report-template.md
        └── releases/
```

`libs/contracts/` berisi kontrak bersama yang relevan, misalnya pesan/job worker; jangan menduplikasi DTO HTTP yang telah dihasilkan SDK. `libs/shared/` merupakan lokasi konseptual kode bersama tanpa ketergantungan framework ketika diperlukan. `libs/ui/` digunakan untuk komposisi UI yang memang diperlukan beberapa aplikasi Angular. `libs/server/` digunakan untuk kode server yang benar-benar dibutuhkan beberapa proses, termasuk factory koneksi database. Library internal ini tetap tidak memerlukan `package.json` tersendiri.

Konsep `libs/shared/` berasal dari perencanaan monorepo dalam percakapan; belum ada kode atau rule terpisah yang merinci API-nya. Jangan menganggap semua lokasi target di atas telah mempunyai implementasi.

## 4. Asal workflow dan dokumentasi

Workflow memakai [Engineering Workflow Skills dari JS Mastery](https://github.com/jsmastery-pro/skills). README mencantumkan sumber tersebut. Skill digunakan sesuai kebutuhan perubahan; tidak setiap pekerjaan harus menjalankan seluruh fase.

| Skill | Peran dalam workflow |
| --- | --- |
| `/scope` | Menetapkan apa yang dibangun, batas fitur, dan rencana yang terus diperbarui. |
| `/audit` | Menyusun konteks repository yang dibaca agent. |
| `/architect` | Merinci keputusan teknis dan build spec. |
| `/develop` | Membangun berdasarkan keputusan/specs yang telah tersedia. |
| `/check verify` | Membuktikan perilaku aplikasi terhadap kriteria. |
| `/check review` | Review kode secara independen sesuai workflow. |
| `/test` | Menulis suite pembuktian perilaku perubahan. |
| `/debug` | Menemukan dan memperbaiki akar penyebab kegagalan. |
| `/document` | Menulis dokumentasi perubahan yang relevan. |
| `/sync` | Menjaga pengetahuan project tetap sesuai keadaan repository. |

Rules Foundation dan keputusan pengguna melengkapi workflow skill dengan pilihan khusus project. Skill global tidak dimodifikasi oleh perubahan ini. Referensi README bukan bukti bahwa skill telah divendor, versinya dipin, atau diperbarui otomatis di repository ini.

Scope menjelaskan hasil, batas, dan kriteria penerimaan. Specs menjelaskan rancangan fitur yang sama pada frontend, backend, dan worker yang terlibat. Fitur tidak wajib melibatkan ketiganya. Jika specs dipecah, semua bagian tetap merujuk fitur dan kontrak bersama yang sama.

Pengelompokan docs mengikuti fitur kecil. Subbagian dalam dokumen digunakan untuk menjelaskan aspek berbeda dari fitur, bukan memaksa satu lapisan aplikasi dituntaskan sebelum lapisan lain mulai.

## 5. Workflow fitur dan koordinasi agent

1. Baca AGENTS dan rules yang relevan, termasuk testing dan keamanan.
2. Tentukan scope, kriteria penerimaan, data sensitif, domain/schema, permission, dan kebutuhan keputusan.
3. Sepakati kontrak minimum: endpoint, input/output, error, job/message, serta payload contoh.
4. Tetapkan rencana pembuktian: ID skenario, runner, fixture, target performance, dan bukti yang diperlukan.
5. Bagi tugas jika ada bagian independen; tentukan kepemilikan file dan dependensi.
6. Implementasikan bagian independen secara paralel sesuai kontrak. Respons/job contoh dapat digunakan untuk memulai.
7. Gabungkan perubahan yang saling bergantung; setelah setiap perubahan backend, sinkronkan OpenAPI dan SDK.
8. Verifikasi bagian masing-masing dan integrasi nyata lintas aplikasi.
9. Laporkan perintah, hasil aktual, skenario yang dibuktikan, kegagalan/skip, dan batas bukti.
10. Kelompokkan commit secara koheren jika pekerjaan memang mencakup commit, dan siapkan bukti release ketika diperlukan.

Contoh registrasi: frontend membangun form dari kontrak respons; backend membangun endpoint dan menghasilkan job; worker menguji job contoh. Pekerjaan dapat berjalan bersama, tetapi respons contoh tidak menggantikan verifikasi integrasi dengan backend/database/worker nyata.

Agent utama menetapkan tujuan tugas, rules/specs, kontrak, area/file yang boleh diubah, kriteria penerimaan, ID skenario, test yang dimiliki, dan cara pelaporan. Subagent membaca rujukan, bekerja mandiri dalam batasnya, dan melaporkan perubahan atau hambatan yang berdampak ke bagian lain. Keputusan lokal yang sesuai kontrak tidak memerlukan konfirmasi ulang.

Tetapkan satu pemilik untuk kontrak, konfigurasi root, dependency, migration/penomoran, client database, OpenAPI/SDK, route/config aplikasi utama, fixture, registry, runner, serta orchestration CI yang perlu diubah bersama. Subagent tidak boleh mengubah kontrak, memilih schema baru, memperluas privilege, atau mengurangi kontrol lintas fitur secara sepihak.

Komunikasi menjelaskan konteks, dampak, dan tindakan yang diperlukan. Gunakan koordinasi agent dalam tugas yang sama; bila komunikasi langsung tidak tersedia, agent utama meneruskan informasi. Saat terhambat, sampaikan kebutuhan lalu lanjutkan pekerjaan independen yang tersedia. Fitur belum selesai hanya karena seluruh tugas subagent selesai; alur nyata dan kriteria penerimaan harus terpenuhi.

## 6. Pertanyaan schema pada scope dan architect

Untuk fitur yang membuat atau mengubah data persisten, agent menanyakan:

> Data fitur ini ditempatkan di schema mana: common, users, auth, atau schema domain lain?

Agent menjelaskan rekomendasi berdasarkan domain. Fitur lintas schema memerlukan pembagian entitas dalam pertanyaan yang ringkas. Jika keputusan fitur sudah tersedia dalam percakapan/specs, gunakan keputusan dan sebutkan sumbernya tanpa meminta ulang. Fitur tanpa perubahan database dicatat tidak membutuhkan schema.

Scope mencatat pilihan atau keputusan yang masih diperlukan; specs merinci schema per entitas, relasi, migration, role, dan batas akses. Migration/query yang bergantung pada keputusan menunggu jawaban; pekerjaan independen tetap dapat berjalan. Variasi penulisan `/architects` atau `/architecs` dipahami sebagai maksud `/architect` dalam konteks tersebut.

## 7. Frontend Angular, UI, dan UX

Struktur dasar frontend berada di `apps/frontend/`, dengan `angular.json`, konfigurasi TypeScript, `sdk.config.json`, SDK generated pada `sdk/`, Dockerfile, `public/`, serta `src/`. Contoh tree lengkap tersedia di lampiran rule Angular.

`src/app/` memuat root aplikasi (`app.ts`, `app.html`, `app.config.ts`, `app.routes.ts`), `core/`, `shell/` bila diperlukan, `shared/`, dan `features/`. Contoh area fitur: authentication, products, reports. Nama area dan halaman adalah contoh, bukan scope produk yang sudah diputuskan.

| Bagian | Tanggung jawab dan batas |
| --- | --- |
| `core/session/`, `core/http/` | Infrastruktur lintas aplikasi frontend. Bukan tempat semua service fitur. |
| `shell/` | Konfigurasi/integrasi default layout wrapper theme jika memang memerlukan file lokal. |
| `shared/` | Komposisi/perilaku umum yang digunakan beberapa fitur frontend ini. |
| `features/<fitur>/` | Halaman, adapter API, state, route, komponen, dan logika area tersebut. |
| `sdk/` | Model, operasi, dan service HTTP generated; di luar `src/`, dikelola generator. |

Colocate komponen/template/style/unit test menggunakan nama dasar sama, misalnya `login.ts`, `login.html`, `login.css`, `login.spec.ts`. Gunakan nama tanggung jawab seperti `products-api.ts`, `products-store.ts`. Tambah subfolder ketika kompleksitas membutuhkannya; jangan membuat folder global berisi seluruh service, model, atau komponen berbagai fitur.

State halaman tetap lokal; state bersama dalam satu fitur dimiliki fitur tersebut; state session lintas aplikasi berada di core. Core/shared tidak mengimpor implementasi features. Fitur lain diakses melalui antarmuka publik/kontrak, bukan file internalnya. Frontend tidak mengimpor backend, worker, `libs/server/`, atau modul runtime Bun.

Root routes menghubungkan route utama. Area fitur memiliki route sendiri bila diperlukan. Lazy loading digunakan pada batas yang masuk akal untuk mengurangi JavaScript awal tanpa menambah tingkat yang tidak diperlukan.

Seluruh komponen library UI menggunakan `@ojiepermana/angular`. Theme digunakan lewat `@ojiepermana/angular/theme` untuk default layout wrapper. Jangan menebak export, selector, input/output, provider, atau token style; periksa public API dan tipe versi terpasang. Jangan mengimpor internal library, menyalin implementasi, menargetkan DOM internal untuk style, atau menambahkan component library pengganti secara sepihak.

Komponen aplikasi boleh mengomposisikan primitive library menjadi halaman/fitur. Wrapper lokal perlu tanggung jawab tambahan nyata. Jangan membuat ulang header/sidebar/layout yang sudah disediakan wrapper default; `shell/` tidak wajib ada jika integrasi cukup dilakukan di root/config. Kebutuhan yang belum didukung library dilaporkan dan keputusan dikoordinasikan, sambil melanjutkan bagian independen.

UX menangani tujuan/tindakan utama, label yang jelas, loading/empty/success/error, feedback proses, pencegahan submit berulang, error yang dapat ditindaklanjuti, retry yang sesuai, validasi form, pemeliharaan input saat gagal, istilah konsisten, responsivitas, serta konten panjang/data kosong.

Aksesibilitas mencakup nama kontrol, label, operasi keyboard, focus terlihat dan terkelola, serta informasi yang tidak hanya dibedakan lewat warna. Integrasi tidak merusak perilaku aksesibilitas library. Verifikasi UI membuktikan alur, state, layar target, dan keyboard; build saja tidak cukup.

## 8. Backend Bun dan Elysia

Backend berada di `apps/backend/`, dengan kode fitur pada `src/features/<fitur>/`. Contoh struktur lengkap ada di lampiran rule Elysia.

| File/area | Tanggung jawab |
| --- | --- |
| `src/index.ts` | Listen, lifecycle runtime, shutdown, penutupan resource; membaca HOST/PORT dari supervisor saat development. |
| `src/app.ts` | Merangkai Elysia/plugin/route tanpa listen pada import. |
| `src/config/env.ts` | Validasi environment backend. |
| `src/plugins/database.ts` | Wiring client/pool, tidak menjalankan migration/seed. |
| `src/plugins/openapi.ts` | Konfigurasi plugin resmi pembentuk kontrak HTTP. |
| `src/plugins/error-handler.ts` | Error HTTP konsisten tanpa kebocoran detail sensitif. |
| `<fitur>.routes.ts` | Endpoint, status, wiring schema/service. |
| `<fitur>.schema.ts` | Validasi request/response Elysia, bukan model ORM. |
| `<fitur>.service.ts` | Aturan bisnis dan koordinasi transaksi. |
| `<fitur>.queries.ts` | SQL langsung dan pemetaan hasil untuk fitur. |

Fitur sederhana tidak harus langsung memiliki seluruh lapisan. Gunakan chaining Elysia dan dependency plugin eksplisit. Periksa API versi yang dipakai saat implementasi.

Pilihan native: SQL/pool/transaksi melalui Bun.SQL; environment melalui Bun.env dengan validasi; password lewat API async Bun.password; file melalui Bun.file/Bun.write; unit/integration server melalui bun:test. Jangan menambah dependency pengganti tanpa kebutuhan yang belum dipenuhi runtime/framework dan alasan dalam specs. Larangan ORM tetap berlaku.

Backend/worker tidak saling mengimpor implementasi app. Kode bisnis yang benar-benar dibutuhkan keduanya dapat dipindah ke libs/server. Query operasional bisnis boleh berada di app; yang dikeluarkan dari app adalah pengelolaan skema, migration, dan seed.

## 9. Database, schema, role, migration, dan seed

Database tunggal dapat mempunyai banyak schema domain. `users` tidak berarti schema dibuat per individu; pemisahan schema juga bukan isolasi tenant atau database terpisah.

Gunakan identifier berkualifikasi pada query/DDL/FK/view/seed, misalnya `users.users`, `auth.sessions`, `common.schema_migrations`. Relasi lintas schema diperbolehkan dan dicatat dalam specs. Jangan memakai input client sebagai schema/table atau bergantung pada `public` secara implisit.

Search path hanya memuat schema tepercaya; pg_catalog eksplisit, objek aplikasi berkualifikasi. Runtime tidak dapat CREATE pada schema yang digunakan. Privilege public perlu diperiksa, terutama database upgrade.

Factory client di `libs/server/database/client.ts` menerima konfigurasi dari pemanggil; tidak mengimpor app tertentu. Tiap proses memiliki dan memakai kembali pool sendiri. Kapasitas pool memperhitungkan jumlah container, ditutup saat berhenti. Nilai dinamis diparameterkan; identifier dinamis memakai helper/allowlist. Transaksi menggunakan client transaksi yang sama dan kegagalan tidak ditelan.

Role pemilik/migrator terpisah dari runtime backend dan masing-masing worker. Runtime bukan superuser, tidak membuat database/role, tidak memiliki DDL atau menjadi pemilik objek. USAGE schema ditambah privilege tabel/sequence hanya sesuai kebutuhan. Worker tidak mendapat akses auth otomatis. Backend dapat membaca metadata migration untuk doctor; runner sendiri yang menulisnya. Default privilege harus sesuai role pembuat objek, bukan grant semua untuk menghilangkan error.

Migration berupa SQL di `database/migrations/` dengan satu urutan global antarschema. Contoh penamaan: `0001-create-schemas.sql`, `0002-users-create-users.sql`, `0003-auth-create-sessions.sql`. File terapan tidak diedit; perubahan memakai migration baru.

Runner Bun/Bun.SQL `database/migrate.ts` melakukan bootstrap common/history, validasi target dan PostgreSQL minimum, lock database, penerapan berurutan, dan pencatatan. Riwayat `common.schema_migrations` mempunyai nama file lengkap unik, checksum SHA-256 byte file, dan waktu penerapan. Bootstrap/penerapan memakai role migration serta koordinasi lock yang sama. SQL dan pencatatan dijalankan dalam transaksi ketika perintah mendukungnya; operasi yang tidak dapat transactional ditangani eksplisit.

`database/seed.ts` dijalankan eksplisit, terpisah dari migration. Target environment dan perilaku pengulangan ditentukan; seed tidak diam-diam menghapus/menimpa data bisnis. Runner bukan worker yang hidup terus dan bukan startup backend/worker.

Deployment menjalankan migration sebagai langkah tersendiri sebelum app yang membutuhkannya. Dockerfile runner bila diperlukan ada di root database/; build context tetap monorepo. Container runner Bun dan container server PostgreSQL adalah proses/image berbeda.

## 10. Worker dan container

Compose root hanya mengelola infrastruktur pendukung; container runtime aplikasi/worker dan runner migration/seed tidak dimasukkan ke dalamnya. Deployment mandiri dapat memakai Dockerfile masing-masing melalui konfigurasi deployment terpisah.

Worker mewakili tanggung jawab bisnis yang jelas. Beberapa jenis job boleh digabung jika kebutuhan deployment/resource/scaling/failure mendukungnya. Contoh: notification, file-processing, report, integration, maintenance. Tidak semua contoh harus dibuat.

Worker memakai Bun; Elysia/HTTP hanya ditambah ketika dibutuhkan. Tanpa HTTP, tidak perlu port. Akses database menggunakan SQL native, pool per proses, role sendiri, dan grant sesuai domain/tugas. Job memerlukan validasi, identitas sumber, timeout, retry terbatas, concurrency, serta idempotensi sesuai fitur. URL/file dari job tetap merupakan input yang perlu dibatasi.

Setiap worker yang dideploy mandiri mempunyai Dockerfile di `apps/worker/<nama>/`, dapat menjadi image/container terpisah, dan mempunyai pengaturan resource, replica, restart, serta environment sendiri. Frontend/backend juga memiliki Dockerfile pada app masing-masing ketika diimplementasikan.

Seluruh Docker build memakai root monorepo sebagai context karena dependency root dan libs bersama. Contoh command: `docker build -f apps/worker/notification/Dockerfile -t foundation-notification .`. Migration/seed tidak menjadi startup worker atau jenis worker maintenance secara otomatis.

Transport antrean, scheduler, broker, dan protokol job konkret belum dipilih. Kebutuhan tersebut ditetapkan pada specs fitur, bukan disimpulkan dari contoh nama worker.

## 11. OpenAPI dan SDK: sumber, generate, konsumsi, dan gate

```text
Specs kontrak fitur
  → route/schema request-response Elysia
  → ekspor openapi.json di root
  → validasi/lint
  → generator SDK @ojiepermana/angular
  → apps/frontend/sdk/
  → adapter API fitur Angular
  → build dan test integrasi
```

Backend memakai plugin resmi `@elysia/openapi`, dependency terpisah dari core. Raw endpoint default yang menjadi rujukan adalah `/openapi/json`. Route/schema runtime menjadi sumber HTTP, bukan file OpenAPI manual atau salinan DTO yang dipelihara terpisah.

Metadata/schema harus meliputi parameter, body, response status sukses/error, operationId unik/stabil, tag area fitur, schema publik stabil, dan security sesuai perilaku. Inferensi TypeScript saja tidak menggantikan kontrak runtime. Perubahan operationId/tag/nama model dapat memengaruhi antarmuka SDK. Nullable, enum, tanggal, angka, pagination, upload, dan serialisasi query harus kompatibel dengan generator serta HTTP nyata.

Script rencana `scripts/export-openapi.ts` menggunakan Bun, komposisi route nyata, pembacaan raw spec yang sudah siap melalui app.handle bila sesuai versi, dan Bun.write ke root. Ekspor tidak menjalankan server dan tidak bergantung pada database aktif. Ekspor juga tidak menjalankan migration/seed atau memanggil layanan eksternal. Startup resource dipisahkan. Jangan mengganti route dengan mock atau menyembunyikan endpoint kontrak untuk menghindari kegagalan generator.

Hasil lokal mencakup schema/referensi yang diperlukan, tanpa mengunduh kontrak dari deployment lingkungan lain. Ekspor gagal untuk JSON/struktur tidak valid, route wajib hilang, atau reference tidak terselesaikan. Formatting/urutan key object konsisten, tanpa timestamp/URL sementara; urutan array yang bermakna dipertahankan.

Pemeriksaan kontrak direncanakan melalui `scripts/validate-openapi.ts` dengan Bun tanpa dependency validator/linter tambahan. Cakupan wajib mencakup JSON object, versi OpenAPI yang didukung generator, metadata info, struktur paths/operasi, operationId lengkap dan unik, tag fitur, schema input/response yang diwajibkan, resolusi seluruh reference lokal, endpoint kontrak wajib, dan deklarasi/referensi security scheme sesuai specs. Reference eksternal ditolak. Pelanggaran menghasilkan exit code bukan nol; saat tooling dibuat, fixture valid dan pelanggaran tiap aturan wajib harus diuji.

Checker tersebut memeriksa aturan dan bentuk kontrak yang dipakai project, bukan seluruh standar OpenAPI dan bukan validasi request/response server. Cakupan serta keterbatasan dilaporkan; bentuk kontrak baru memerlukan pembaruan pemeriksaan dan bukti dukungan generator. Generate SDK, build Angular, dan test integrasi nyata tetap diperlukan. Runtime/tooling yang dipilih harus kompatibel dan dipin; CI tidak mengambil latest/global generator setiap run.

SDK memakai `@ojiepermana/angular:sdk`, sementara `@ojiepermana/angular/sdk` menyediakan API konfigurasi. Command dari working directory **apps/frontend/**:

```sh
ng generate @ojiepermana/angular:sdk --config sdk.config.json
```

Konfigurasi lengkap ada pada lampiran rule OpenAPI. Input `../../openapi.json`, output `./sdk`, mode standalone, clientName FoundationApi, rootUrl kosong, splitByDomain false. Models/operations/services/client aktif; metadata/navigation/resources tidak otomatis diaktifkan.

Konfigurasi/command telah diperiksa pada artefak npm **22.1.14** dalam pekerjaan sebelumnya. Ini bukan versi dependency yang sudah dipasang atau pin Angular project. Periksa peer dependency, Angular/TypeScript, public API, dan schema generator saat memilih versi implementasi. Target `typescript-angular` milik OpenAPI Generator adalah tool berbeda berlabel STABLE; label itu tidak boleh dipindahkan menjadi sertifikasi generator library pilihan project. Penggantian generator memerlukan keputusan, bukan fallback diam-diam.

Konsumsi SDK melalui barrel public-api.ts dengan alias yang sesuai, misalnya @sdk. SDK di luar src harus masuk kompilasi dan build. Bootstrap Angular menyediakan provideHttpClient dan provideApiConfiguration dari generated barrel; runtime URL diatur sesuai environment, bukan generate berbeda per environment. Adapter `<fitur>-api.ts` tetap kode manual di fitur; component/store memakainya. Jangan mengedit SDK atau menulis ulang endpoint/DTO yang sudah tersedia.

Seluruh output SDK dan `.ojiepermana-sdk-manifest.json` milik generator. Manifest memungkinkan stale generated files dihapus ketika kontrak berubah. Jangan menaruh kode manual pada SDK atau menghapus seluruh folder paksa untuk mengatasi konflik. OpenAPI, config, SDK, dan manifest disimpan bersama perubahan sumbernya.

| Script yang direncanakan | Peran |
| --- | --- |
| `api:openapi` | Ekspor root OpenAPI. |
| `api:validate` | Pemeriksaan kontrak OpenAPI melalui Bun tanpa validator tambahan. |
| `sdk:generate` | Generate SDK dengan cwd frontend. |
| `api:sync` | Ekspor → validasi → generate berurutan; berhenti saat gagal. |
| `api:check` | Buktikan artefak sesuai sumber kandidat dan hasil dapat direproduksi. |

Setiap perubahan backend, shared schema/dependency yang memengaruhi backend, dan generator/config menjalankan sync, sekalipun output identik. Setelah penggabungan paralel, satu pemilik meregenerasi; perubahan backend berikutnya memerlukan run lagi. Selanjutnya build frontend dan test pemakaian yang terdampak.

CI memeriksa drift sebelum frontend yang bergantung SDK; mencakup file baru/untracked, berubah, dan dihapus. Git diff saja tidak mencakup seluruh file baru. Dua run dengan sumber/versi sama harus identik. Build dan test runtime juga diperlukan karena generate/drift tidak membuktikan perilaku. Release menyertakan identitas/checksum OpenAPI, versi generator, run generate, build, dan test kontrak kandidat yang sama.

Seluruh script API di tabel ini **belum tersedia** pada package.json saat snapshot.

## 12. Keamanan aplikasi

Keamanan dirancang berlapis dan dibuktikan, bukan dijamin oleh framework atau pemisahan schema. OWASP ASVS menjadi rujukan kontrol yang dapat diuji. Specs memuat data sensitif, batas kepercayaan, endpoint publik, autentikasi, permission, role database, kebijakan data, serta kemungkinan penyalahgunaan.

Kontrol wajib yang dirinci penuh di lampiran security meliputi:

- Deny by default pada backend; pemeriksaan permission, owner, dan tenant bila relevan pada setiap operasi. Role/owner bukan nilai yang dipercaya dari payload. Guard frontend hanya navigasi.
- SQL parameter, identifier allowlist, schema input, field allowlist untuk mencegah mass assignment, dan response eksplisit yang tidak membocorkan row/secret.
- Lifecycle sesi: sumber acak kriptografis, expiry, revocation, rotasi saat login/perubahan hak, logout/reset efektif di server.
- CSRF dan pemeriksaan origin pada operasi cookie yang mengubah data; GET tidak mengubah state. SameSite bukan satu-satunya kontrol.
- Sanitization/binding Angular, CSP dan pembatasan frame pada server yang mengirim dokumen frontend; Trusted Types bila sesuai integrasi. Bypass sanitization/internal HTML memerlukan keputusan dan bukti.
- Limit login/reset/operasi mahal, body/upload, pagination, request/query timeout, concurrency, antrean, dan retry. Limit antarkontainer perlu koordinasi; header IP tidak dipercaya tanpa proxy tepercaya.
- Upload/path/URL outbound dibatasi; periksa jenis/ukuran, penyimpanan tanpa eksekusi, nama dari server, allowlist, redirect/DNS sesuai fitur untuk membatasi SSRF/path traversal.
- HTTPS production, HSTS setelah topologi siap, CORS origin eksplisit, tanpa wildcard credential. CORS bukan pengganti autentikasi atau penghalang nonbrowser.
- Hook/plugin Elysia benar-benar melindungi route; SDK/type/security metadata tidak menggantikan validasi/otorisasi runtime.
- Policy akses untuk debug/metrics/admin/UI OpenAPI production. Ekspor lokal tidak membuka route bisnis sebagai publik.
- Role minimum per layanan, isolasi jaringan database/antrean, container tanpa privilege berlebih, resource limit, secret terpisah/rotasi, dan tanpa secret di image/bundle/log/artefak.
- Logging yang disaring untuk kegagalan login, penolakan akses, perubahan hak, aksi sensitif, dan correlation ID; alert, retensi, backup/restore, serta penanganan insiden sesuai cakupan.

Default autentikasi browser yang **disarankan**, belum menjadi specs auth final, adalah sesi opaque server-side melalui cookie HttpOnly, Secure di production, SameSite eksplisit, serta prefix __Host- bila topologi mendukung. Expiry, rotasi, MFA, pemulihan, dan integrasi ditetapkan saat merancang fitur. JWT tidak dipilih otomatis; bila diperlukan, validasi dan revocation juga dirinci.

Password memakai Argon2id melalui Bun.password async dengan parameter keamanan yang diuji terhadap kapasitas. Hash sesi/reset berada di auth, bukan token mentah. Reset sekali pakai dengan timeout; respons tidak membocorkan keberadaan akun. Credential/token tidak disimpan di localStorage/sessionStorage. Konfigurasi cookie HTTP lokal khusus development tidak diam-diam menurunkan Secure production.

CI perlu secret/dependency scanning dan pemeriksaan kontrol relevan dengan versi scanner dipin. Scanner tanpa temuan bukan bukti semua kontrol benar. Temuan dan keputusan risiko ditulis tanpa memalsukan status test. Semua kontrol aplikasi ini masih merupakan aturan target; auth, middleware, scanner, serta deployment belum tersedia.

## 13. Strategi testing dan pembuktian skenario

| Jenis | Runner | Lokasi/tujuan |
| --- | --- | --- |
| Unit frontend | Vitest melalui Angular CLI | Colocated; komponen, state, validasi, adapter terisolasi. |
| Integration frontend | Vitest melalui Angular CLI | Colocated `*.integration.spec.ts`; komponen/service/routing/komposisi. |
| Unit server/worker/libs server | bun:test | Dekat kode; aturan bisnis/fungsi terisolasi. |
| Integration server/database/worker | bun:test + PostgreSQL 18 | Root tests/integration; route/query/constraint/transaksi/migration/job nyata. |
| E2E | Playwright Test | Root tests/e2e; UI/backend/PG/worker sesuai alur. |
| Performance/ketahanan | k6 | Root tests/performance; latency, kapasitas, hasil bisnis, kestabilan, pemulihan. |
| Tooling development | bun:test | tests/integration/tooling; doctor, cleanup port, seleksi/env worker, supervisor. |

Runner memiliki discovery eksplisit. Jangan bare bun test dari root yang ikut menemukan Angular/Playwright. Playwright/k6 tidak mengimpor modul khusus Bun; Angular SDK HttpClient bukan runner k6. Setup khusus runtime tetap pada area runner; fixture bersama tanpa ketergantungan runner dapat berada di tests/fixtures.

Specs fitur adalah sumber kriteria/target. Registry `tests/scenarios/<fitur>.json` memetakan ID stabil ke specs, kriteria, file/test tag, runner, dan profile yang wajib. Registry bukan salinan requirement penuh atau tabel hasil lulus manual. Tooling repository dapat memakai rule dengan kriteria eksplisit sebagai source; registry tooling nyata memakai empat ID TOOL-001 sampai TOOL-004.

Setiap skenario menjelaskan prasyarat, data, tindakan, expected result, assertion, dan kondisi lulus. Pilih runner yang sesuai; tidak semua skenario memerlukan semua suite. Cakup happy path, kegagalan penting, otorisasi, concurrency, retry, dan perubahan data yang relevan. CI memvalidasi ID unik dan rujukan/implementasi nyata; file reference saja tidak membuktikan eksekusi/assertion.

Status skenario: passed, failed, skipped dengan alasan, not_run, missing_test, not_applicable dengan alasan/cakupan. Coverage kode bukan coverage kriteria. Tidak boleh menganggap skip/belum berjalan sebagai lulus.

Unit memeriksa perilaku, bukan sekadar mock dipanggil. Integration memakai bagian nyata yang dibuktikan; SQL memakai PostgreSQL, bukan mock/database pengganti. Migration test berasal dari root tests/integration/database dan menjalankan runner root. Database test disiapkan terpisah dari startup; data diisolasi per test/proses; credential/database production tidak dipakai untuk test rutin.

Playwright menggunakan backend/database/worker nyata sesuai alur, dengan mock hanya pada boundary yang dinyatakan seperti penyedia eksternal. Locator berdasarkan role/label/text/test ID, assertion menunggu kondisi, timeout terbatas; tanpa jeda tetap atau ketergantungan DOM internal library. WebServer dapat mengorkestrasi frontend/backend; database/migration/data/worker ditangani orchestration terpisah. Setup Bun dijalankan sebagai proses Bun, bukan diimpor ke fixture runner lain. Pengujian membuktikan integrasi library pada fitur, bukan mengulang seluruh implementasi internalnya.

## 14. k6 dan seluruh skenario performance

Pisahkan journeys bisnis, profiles beban, helpers, dan browser. Journey yang sama dipakai pada beberapa profil bila sesuai.

| Profil | Yang dibuktikan |
| --- | --- |
| Smoke | Script/perilaku dasar pada beban ringan. |
| Load | Target pada beban normal yang ditentukan. |
| Stress | Perilaku di atas beban normal. |
| Spike | Lonjakan mendadak dan pemulihan. |
| Soak | Kestabilan dalam durasi panjang. |
| Breakpoint, opsional | Batas kapasitas. |

Tentukan model pengguna virtual/arrival rate, durasi, data, campuran aktivitas, environment, dan thresholds di specs. Bedakan iterasi dan request per detik untuk journey dengan beberapa request. Catat beban aktual/dropped iterations agar kapasitas yang tidak tercapai tidak dianggap terbukti.

Checks memeriksa response dan hasil bisnis; thresholds per skenario menentukan gagal/lulus pipeline. Checks gagal saja tidak selalu membuat run exit gagal. Expected rejection dibedakan dari error tak terduga. Jangan mengarang target p95/throughput universal atau melonggarkan threshold supaya test hijau.

Async worker dibuktikan sampai hasil akhir, efek bisnis, latency penyelesaian, serta efek duplikat/retry yang relevan. Accepted response bukan job selesai. Amati CPU/memory, pool/query database, backlog, dan metrik yang sesuai. k6 browser dapat mengukur pengalaman browser saat sistem dibebani; Playwright tetap menguji fungsi alur pengguna.

Mulai smoke sebelum profil lebih tinggi. Suite panjang tidak wajib tiap edit; jalankan pada environment yang tidak terganggu suite lain. Binary/container k6 menjalankan scriptnya sendiri, dengan root script sebagai orchestration, bukan bun:test.

## 15. CI, laporan pekerjaan, dan release

CI target menjalankan build/type checks, registry validation, test area berubah, regression/E2E alur kritis, OpenAPI/SDK check, keamanan relevan, serta smoke/performance sesuai dampak. Suite independen dapat paralel dengan data terisolasi; performance dibedakan dari pekerjaan yang mengganggu hasil.

Script test yang direncanakan: test:frontend, test:unit:server, test:integration, test:e2e, test:e2e:ui, test:performance:smoke/load/stress/spike/soak, test:ci. Hanya test:tooling yang sudah tersedia sekarang, selain doctor dan serve. Tidak ada pipeline CI aplikasi yang sudah mengimplementasikan daftar target tersebut.

Kegagalan dicari penyebabnya dan diperbaiki sebelum rerun terkait. Riwayat kegagalan/retry/flaky dicatat; lulus setelah retry tidak menghapus bukti ketidakstabilan. Perubahan dokumentasi/low impact tidak harus menjalankan semua suite atau membuat test yang menyalin implementasi.

Template release lengkap berada dalam lampiran. Laporan nyata nantinya di docs/testing/releases/<identitas-release>.md, memuat identitas kandidat/commit/build/run/waktu/owner/specs, environment dan perbedaannya dengan production, runtime/dependency/PG/migration, container/resource/pool/worker/data/browser/mock, identitas OpenAPI/generator/SDK/build/test, role/schema/security/temuan, tabel skenario, tabel performance, masalah, retry, perubahan setelah test, dan penilaian kesiapan.

Seluruh skenario wajib harus valid untuk kandidat yang sama. Perubahan kandidat setelah pengujian membutuhkan pemeriksaan ulang sesuai dampak. Status ready berarti bukti wajib lengkap dan memenuhi kriteria; blocked bila wajib gagal; incomplete bila bukti belum tersedia. Pengecualian ditulis dengan ID/alasan/dampak/penanggung jawab/keputusan tanpa mengganti status hasil sebenarnya. Bukti ready bukan izin deploy.

## 16. Doctor dan serve: implementasi aktual

Root package.json saat snapshot hanya mendefinisikan doctor, serve, dan test:tooling. Tidak ada dependency app atau engine/package-manager version yang sudah dipin di manifest tersebut. Isi manifest, config, environment example, ignore, dan source lengkap tersedia pada Lampiran B.

Konfigurasi aktual: host 127.0.0.1; frontend workspace apps/frontend, port 8889, proxy.conf.json; backend entry apps/backend/src/index.ts, port 8888; schemas common/users/auth; migrationSchema common; registry workers kosong.

`scripts/lib/development.ts` menentukan root dari lokasi script, membaca JSON, memvalidasi host dan port utama, schema identifier/migrationSchema, path leksikal dalam project, registry worker, port worker unik 1024–65535, env URL database worker terpisah dan schema yang diperlukan, serta nama env tambahan yang diizinkan. Pilihan `--worker <nama>` atau `--worker=<nama>` dapat diulang, dideduplikasi, dan menolak nama/argumen tak dikenal. Helper menyediakan port terpilih serta timeout promise.

Doctor memakai Bun untuk runtime/SQL/subprocess dan memeriksa platform macOS/Linux, lsof, Node, Angular CLI lokal, workspace/entry/config OpenAPI/SDK/proxy, entry worker, dan env yang diminta. CLI lokal diperiksa melalui `node .../ng.js version` bila file/workspace ada, tanpa mengunduh dependency. Koneksi PostgreSQL memakai pool satu koneksi; database URL hanya protocol postgres/postgresql, tidak dicetak. Metadata query membaca versi, schema usage/create, role superuser/createdb/createrole, dan history migration.

Backend preflight membandingkan semua file SQL lokal terhadap history termasuk checksum SHA-256 dan menolak history ekstra yang tidak ada di checkout. Worker dengan database diperiksa memakai URL khusus dan schema yang dinyatakan, tanpa akses history migration diwajibkan otomatis. Doctor tidak menjalankan migration/seed atau menghentikan listener. Port sibuk adalah warning; error lain menggagalkan serve. Exit doctor 0 untuk tanpa error, 1 bila error.

Timeout implementasi: pemeriksaan Angular CLI maksimal 10 detik; connectionTimeout SQL 3 detik; kumpulan pemeriksaan database tiap layanan maksimal 5 detik, lalu pool ditutup. Ini adalah parameter tooling lokal, bukan target performance atau SLA aplikasi yang disepakati.

`scripts/lib/ports.ts` membaca listener TCP melalui lsof dengan PID/UID/nama command. Cleanup hanya port frontend/backend dan port HTTP worker terpilih. Proses user lain atau PID controller/parent menyebabkan penolakan cleanup. Semua kandidat listener awal diberi SIGTERM; masa tunggu default 3 detik. Jika masih terikat, identitas dibandingkan kandidat awal sebelum SIGKILL; proses baru menyebabkan startup gagal. Port bebas diperiksa lagi dengan batas tambahan 1,5 detik. Tidak menggunakan pkill global atau menghentikan PostgreSQL otomatis.

Serve menolak NODE_ENV production melalui doctor, lalu cleanup sebelum memulai layanan. Backend/worker memakai executable Bun proses saat ini dengan --watch; frontend memakai Node dan Angular CLI lokal dengan cwd frontend, host/port/proxy config. Nilai credential worker diambil dari env khusus, bukan DATABASE_URL backend. Frontend hanya menerima environment dasar proses; worker menerima environment dasar dan nama env yang dinyatakan. Kode persis mapping environment ada pada lampiran, sehingga reviewer dapat memeriksa isolasinya.

Supervisor berjalan di Bun dengan modul built-in node:child_process untuk grup proses POSIX yang terpisah; ini tidak menambah package runtime eksternal. Log stdout/stderr layanan diwariskan. Jika layanan gagal spawn atau exit, layanan lain dihentikan. Ctrl+C memberi exit 130, SIGTERM 143; kegagalan layanan meneruskan code positif atau memakai 1. Shutdown memberi grup SIGTERM, tunggu 1,5 detik, lalu SIGKILL dan menunggu close terbatas 2 detik. Semua turunan watcher/build di grup tersebut termasuk cakupan.

Worker didaftarkan dahulu, lalu dipilih, misalnya bun run serve --worker notification --worker report. Entry, port bila HTTP, databaseUrlEnv/schema bila DB, dan nama env secret aplikasi dapat dikonfigurasi. Tidak ada worker nyata terdaftar saat ini. Proxy frontend yang direncanakan meneruskan /api/** ke backend 8888; prefix API dan config aktual perlu disepakati saat aplikasi dibuat.

## 17. Commit, status implementasi, bukti, dan fokus review

### Infrastruktur development yang tersedia

`docker-compose.yml` root saat ini hanya memuat service PostgreSQL dengan image `postgres:18`, database `foundation`, administrator provisioning `foundation_admin`, password wajib melalui `.env.infrastructure`, serta autentikasi host SCRAM. Port host default 5432 hanya terikat pada 127.0.0.1 dan dapat diganti melalui FOUNDATION_POSTGRES_PORT. Named volume postgres_data dimount pada /var/lib/postgresql sesuai PostgreSQL 18. Batas development: memory 1 GiB, CPU 2, shared memory 128 MiB; bukan bukti kapasitas production. Untuk pembuktian CI/release, pin patch/digest dan catat identitas image.

Healthcheck pg_isready memakai user/database container, interval 5 detik, timeout 3 detik, retries 10, dan start period 10 detik. Healthcheck tidak membuktikan schema, grants, migration atau kesiapan aplikasi. Restart policy unless-stopped dan named volume mempertahankan data; penghentian Compose tidak menghapus volume secara otomatis.

`.env.infrastructure.example` tidak berisi password nyata; salin ke file lokal yang diabaikan Git dan isi password sendiri. Compose menerima file melalui --env-file, terpisah dari .env runtime Bun. Jangan gunakan admin provisioning sebagai DATABASE_URL backend/worker atau mengekspor secret admin ke environment aplikasi. Compose tidak menyiapkan role runtime, schema common/users/auth, grants, migration, atau seed; provisioning tersebut tetap langkah terpisah dan belum diimplementasikan. Jangan memasang migration ke initdb sebagai pengganti runner versioned.

Perintah dari root: `docker compose --env-file .env.infrastructure config --quiet`, kemudian `docker compose --env-file .env.infrastructure up -d --wait postgres`. Gunakan Compose v2 yang mendukung --wait. Status melalui ps; penghentian melalui down dengan argumen env-file yang sama. Jangan mencetak konfigurasi hasil interpolasi secret. Doctor/serve tidak mengelola Compose atau port infrastrukturnya; layanan PostgreSQL eksternal tetap diperbolehkan. Cache/broker/storage hanya ditambah setelah kebutuhan specs jelas. Runtime aplikasi, SDK generator, test, migration, dan seed tidak menjadi service Compose root.

YAML diperiksa menggunakan parser native Bun dan pemeriksaan struktur; Docker CLI tidak tersedia pada lingkungan penyuntingan ini. Validasi melalui Compose, startup, healthcheck, koneksi PostgreSQL, dan persistensi container belum dijalankan. Lampiran memuat konfigurasi dan rules infrastruktur lengkap.

### 17.1 Pengelompokan commit

Kelompok commit mengikuti tujuan yang mudah direview, bukan jumlah file/baris atau sesi kerja. Perubahan independen dipisah. Perubahan kecil tunggal atau satu kelompok saling bergantung boleh satu commit. Kode, test, config/docs yang diperlukan dapat bersama; backend/kontrak/OpenAPI/SDK tetap bersama bila dibutuhkan untuk konsistensi. Jangan memecah buatan hingga commit tidak dapat digunakan.

Periksa diff, kelompokkan, stage hanya file/hunk yang sesuai, lalu tinjau staged diff. Jangan memasukkan pekerjaan pengguna/perubahan lain yang tak terkait. Pesan konkret dan verifikasi relevan diperlukan. Tidak ada commit baru dibuat sebagai bagian penyusunan snapshot ini.

### 17.2 Yang tersedia dan belum tersedia

| Area | Status snapshot |
| --- | --- |
| README, AGENTS, 11 file rules, template release | Tersedia. |
| Root package/config/env example/ignore | Tersedia; app dependency belum dipasang/dinyatakan di manifest. |
| Doctor, serve, helper konfigurasi/port | Tersedia; preflight gagal secara benar karena app/database belum tersedia. |
| Test tooling dan registry empat skenario | Tersedia. |
| Angular/backend/worker aplikasi nyata | Belum tersedia. |
| libs runtime dan factory database | Belum tersedia. |
| Compose PostgreSQL 18 development | Konfigurasi tersedia; belum diuji menggunakan Docker/container nyata. |
| Schema, grants, migration/seed/runner | Belum tersedia/diverifikasi terhadap database nyata. |
| OpenAPI root, script ekspor/pemeriksaan Bun, SDK generated | Belum tersedia; contoh config/generator masih di rules. |
| Vitest app, integration PostgreSQL, Playwright, k6, CI/security scanner | Belum tersedia. |
| Dockerfile/deployment/proxy server production | Belum tersedia. |
| Scope/specs fitur dan release report aktual | Belum tersedia; rules dan template bukan bukti fitur shipped. |

### 17.3 Bukti yang telah dilaporkan sebelum snapshot

Pada implementasi tooling, `bun run test:tooling` lulus **7 test**, 0 gagal, 27 assertion pada run terakhir yang dilaporkan, menggunakan Bun 1.4.2 di lingkungan developer. Test tersebut membuktikan:

1. TOOL-001: doctor mendeteksi prasyarat hilang, mempertahankan listener fixture, dan tidak mencetak credential pada findings.
2. TOOL-002: cleanup menghentikan port fixture target sambil mempertahankan port lain.
3. TOOL-002: fixture yang mengabaikan SIGTERM mendapat eskalasi SIGKILL.
4. TOOL-003: worker dipilih eksplisit, deduplikasi, menolak worker tidak terdaftar/prototype name.
5. TOOL-003: port 8888/8889 serta mapping/isolation env backend/frontend/worker sesuai konfigurasi yang diuji.
6. TOOL-003: port worker tumpang tindih dan path keluar repository ditolak.
7. TOOL-004: satu layanan gagal menghentikan layanan lain serta descendant yang mengabaikan SIGTERM dan menghasilkan code gagal.

Fixture listener memakai port sementara; test tidak memakai port aplikasi untuk penghentian. Registry memetakan empat ID ke rule development commands, file test, tag, runner bun:test, dan script test:tooling. Test process/mapping ini bukan pengujian autentikasi atau privilege pada PostgreSQL nyata.

Doctor/serve telah dijalankan dan mengembalikan code 1 dengan error prasyarat yang memang hilang; serve berhenti sebelum cleanup/startup. Build bundling script untuk target Bun pernah berhasil, tetapi bukan typecheck lengkap atau build Angular. Dokumen/tautan/JSON/registry telah diperiksa pada pekerjaan terdahulu. Penyusunan snapshot dokumentasi tidak mengklaim run ulang seluruh suite aplikasi yang belum ada.

### 17.4 Hal yang perlu dirinci atau diuji selanjutnya

Poin berikut adalah konteks review, bukan keputusan baru untuk mengganti aturan yang sudah disepakati:

- Pilih versi Bun/Node/Angular/TypeScript/Elysia/plugin/library yang kompatibel, pin tooling, dan buktikan CLI workspace frontend dengan dependency root tunggal.
- Validasi Compose dengan Docker, buktikan startup/healthcheck dan persistensi PostgreSQL, lalu provision role/schema melalui langkah terpisah sebelum doctor. Konfigurasi tersedia tidak berarti database aplikasi sudah siap.
- Buktikan API layout/komponen/generator pada versi library yang benar-benar dipasang, SDK di luar src masuk build, dan kontrak yang dipakai didukung termasuk query style/explode.
- Rinci auth/session/CSRF/MFA, permission/tenant, grant/default privilege/RLS yang diperlukan, TTL, rate limit, payload/query/concurrency limit, serta target performance sesuai fitur. Angka tersebut belum disepakati.
- Implementasikan dan uji runner migration, bootstrap common/history, SQL urutan global, lock, transaksi/nontransactional, checksum, grants, serta seed yang aman terhadap pengulangan. Bootstrap harus konsisten dengan migration pertama.
- Verifikasi cabang query doctor dan role/history pada PostgreSQL 18 nyata. Doctor saat ini tidak membuktikan seluruh privilege tabel, ownership, search_path/public, atau kebijakan security; rules lebih luas daripada pemeriksaan preflight yang sudah ditulis.
- Implementasikan api:sync/api:check, validasi OpenAPI, stale file/manifest handling, reproducibility, dan build/test kontrak. Doctor sekarang hanya memeriksa keberadaan file SDK/OpenAPI, bukan kesesuaiannya dengan kode terbaru.
- Buktikan startup frontend/backend/worker nyata, proxy dan cookie/CSRF, readiness aplikasi, restart watcher, dan shutdown job/resource. Supervisor sekarang memulai proses tetapi belum menunggu readiness HTTP/hasil bisnis.
- Review perilaku dua serve bersamaan, pergantian PID/listener, proses lama yang menutup port tetapi masih hidup, dan batas waktu shutdown. Cleanup listener dan penghentian grup proses adalah mekanisme berbeda; kode lengkap disertakan untuk menilai kasus tersebut.
- Pilih antrean/scheduler dan observability worker, credential/service env, serta schema domain baru hanya melalui keputusan fitur, bukan dari contoh folder.
- Bangun registry/test/report CI yang membuktikan kriteria, keamanan, workload aktual, serta kandidat release, bukan sekadar hitungan test hijau atau percentage coverage.
- Buktikan assembly image dengan satu manifest root dan libs bersama, jaringan/TLS/secret/resource, backup/restore, serta langkah migration/deployment terpisah.

### 17.5 Format temuan yang disarankan untuk reviewer

Laporkan area/file, temuan dan bukti, dampak, prioritas, rekomendasi, serta apakah hal itu konflik aturan, kekurangan implementasi, atau keputusan fitur yang belum tersedia. Bedakan kepastian dari asumsi. Jangan otomatis mengusulkan ORM, mengganti library UI/SDK, memindahkan migration ke app, memecah manifest per app, atau mengubah scope menjadi kerja berurutan antarlapisan karena pilihan itu sudah ditetapkan pengguna.

Bagian lampiran setelah ini mempertahankan seluruh detail sumber. Path pada sumber adalah path repository, bukan bukti semua file contoh pada tree sudah dibuat. Link relatif di dalam salinan Markdown tetap mengikuti lokasi source aslinya.

## Manifest sumber snapshot

Seluruh file berikut disalin utuh pada lampiran. SHA-256 mengidentifikasi byte file sumber saat snapshot dibuat, sehingga reviewer dapat membandingkan dengan repository jika tersedia. Dokumen foundation ini tidak dimasukkan dalam manifestnya sendiri.

| Lampiran | Sumber | SHA-256 sumber |
| --- | --- | --- |
| A01 | [README.md](README.md) | `eed97bc7d8fb230783a99b8eb3a42351e417ffb6d6d845f22b6775707e7648a4` |
| A02 | [AGENTS.md](AGENTS.md) | `f48d3096443476933eadb90b1ffdfcd8c04c57c4f09e25193ece0977b182397c` |
| A03 | [docs/rules/development-workflow.md](docs/rules/development-workflow.md) | `5339f3f00302ac91f3429165aeb2760fa9474f0d83debf26ed1ea2ae956741b6` |
| A04 | [docs/rules/angular.md](docs/rules/angular.md) | `36d2adbc35827844dbb8be4e9e892a11619a677c4304b5133d99a1f1fddf75ff` |
| A05 | [docs/rules/ui-ux.md](docs/rules/ui-ux.md) | `944f0558a092c90a1de6dedc446b7a108c71f4ed4ab3d7a00e3580b714c4b2bd` |
| A06 | [docs/rules/elysia.md](docs/rules/elysia.md) | `b1966c64632066163787018dfd651db1dbe3b89e292c6930ff802b7fb5a9113c` |
| A07 | [docs/rules/database.md](docs/rules/database.md) | `9ff138c846e85bdf7ef114c7d04780dfdc276f46475bb082de7798f3f28eee34` |
| A08 | [docs/rules/worker.md](docs/rules/worker.md) | `23b1cb477610f0a17e344fb7e8cabeb1fab9c2952ad466e227d937c078919e07` |
| A09 | [docs/rules/openapi-sdk.md](docs/rules/openapi-sdk.md) | `c9fec052853e795dfa63bdcae58428876b6a748fa541993c4576e0582396696c` |
| A10 | [docs/rules/security.md](docs/rules/security.md) | `f4e0d25c41a4c9680e59e8518b8c16de25908097c6a696e1357ce39cdddd633b` |
| A11 | [docs/rules/testing.md](docs/rules/testing.md) | `351ba6bb1f8b83b989f5f4b45277c393629a1713ba4fa8e1f8e55d646f2e1a77` |
| A12 | [docs/rules/development-commands.md](docs/rules/development-commands.md) | `7862dfac098dcd2b5889a1daf99e377f350e4d0b874eef8fa5d405ec6e1ee6ae` |
| A13 | [docs/testing/release-report-template.md](docs/testing/release-report-template.md) | `bff6dc1fcd55338330ec21a0fb92ea37fd657d9b580b238543fa7bb080503ae6` |
| A14 | [docs/rules/infrastructure.md](docs/rules/infrastructure.md) | `c207bffb6318a1b1317b1e0af00f67d4d452358e931528ab85ab51fcd9f32aa8` |
| B01 | [package.json](package.json) | `bc598bb9f9569e4adc0e4e2d07217e42408e05460abb30c10d48d75c330511a9` |
| B02 | [config/development.json](config/development.json) | `df53c1e0c21a061fc0100f49d122eb2e3bb74f171c0d0367812f13ff4c3e3ebe` |
| B03 | [.env.example](.env.example) | `d0150cd52b9153665b6b5600778da1ded05bfb58c4fd5f15ba54c4645d13d117` |
| B04 | [.gitignore](.gitignore) | `3f9f21f0606698176d0f2e01061c23d5e950c4bb4c7c0733e1b0969069fb4135` |
| B05 | [scripts/lib/development.ts](scripts/lib/development.ts) | `5a14dd02accaea7f8fb83bf8f3edaee2d9452f12e680051ec5749a6eb5ae4312` |
| B06 | [scripts/lib/ports.ts](scripts/lib/ports.ts) | `edd32cdd6ae69844fcd121a3ee019cdad46e2c3d16b597e97b024363a59d6a41` |
| B07 | [scripts/doctor.ts](scripts/doctor.ts) | `8521ec60451d01bbdb5505adbd963010d5b7c8e60ccfc40964c45e49bad5d5dd` |
| B08 | [scripts/serve.ts](scripts/serve.ts) | `b77f9b29ae660f390d60d3687ab17cdbd96d085514e10f47b5699e10d86b6110` |
| B09 | [tests/scenarios/development-tooling.json](tests/scenarios/development-tooling.json) | `82170a3b05a5a03b129a55ea57da8fd83555f3fb2c7840e5b96e51d9dd55d86a` |
| B10 | [tests/integration/tooling/development.test.ts](tests/integration/tooling/development.test.ts) | `3328637b66c2f3ed152d4d60a4809d07ce984c746fb96e45bb69a7853f591c6e` |
| B11 | [docker-compose.yml](docker-compose.yml) | `8b1cbb6886e6de2ec96fd33be566eb499ea44ed72973502cf26c3fbb9a6fc185` |
| B12 | [.env.infrastructure.example](.env.infrastructure.example) | `0eacce11c799bf901b2a9a0a973060ffcb0c9f3af7e5c8da0d59bbc4828aef77` |

## Lampiran A. Dokumentasi dan aturan lengkap

Salinan berikut adalah sumber aktual untuk review, bukan file tambahan yang perlu dijalankan. Isi Markdown ditempatkan dalam blok agar heading/link/instruksi sumber tidak tercampur dengan narasi review.

### A01. README.md

Source: `README.md`. SHA-256: `eed97bc7d8fb230783a99b8eb3a42351e417ffb6d6d845f22b6775707e7648a4`.

````markdown
# Foundation

Monorepo Angular, Bun/Elysia, dan worker dengan satu `package.json` root. Rules dan workflow agent berada di [AGENTS.md](AGENTS.md) serta `docs/rules/`.

Workflow development menggunakan [Engineering Workflow Skills dari JS Mastery](https://github.com/jsmastery-pro/skills), termasuk `/scope`, `/audit`, `/architect`, `/develop`, `/check`, `/test`, `/debug`, `/document`, dan `/sync`. Gunakan skill sesuai kebutuhan perubahan. [Workflow project](docs/rules/development-workflow.md) dan aturan dalam `AGENTS.md` melengkapi skill tersebut dengan keputusan khusus Foundation.

```sh
cp .env.infrastructure.example .env.infrastructure
# Isi password administrator lokal pada .env.infrastructure sebelum menjalankan Compose.
docker compose --env-file .env.infrastructure up -d --wait postgres
```

`docker-compose.yml` root hanya untuk infrastruktur pendukung, saat ini PostgreSQL 18. Setelah provisioning role/schema dan migration melalui langkah terpisah, jalankan aplikasi:

```sh
bun run doctor
bun run serve
bun run test:tooling
```

Frontend development menggunakan port **8889**, backend **8888**. Worker dipilih dengan `--worker <nama>` setelah didaftarkan di `config/development.json`.

Doctor memeriksa prasyarat tanpa mengubah database atau menghentikan proses. Serve menjalankan preflight, membersihkan listener pada port layanan terpilih, lalu menjalankan aplikasi. Lihat [aturan perintah development](docs/rules/development-commands.md).

Frontend, backend, dan worker dijalankan melalui Bun/Angular CLI; Compose tidak memuat runtime aplikasi. Credential Compose terpisah dari `.env` aplikasi. Lihat [aturan infrastruktur](docs/rules/infrastructure.md) untuk port, volume, healthcheck, dan batas provisioning.

Aplikasi Angular/backend/worker, tooling OpenAPI/SDK, dan runner database belum diimplementasikan. Saat ini doctor melaporkan prasyarat tersebut sebagai error dan serve berhenti sebelum cleanup/startup. Perintah tidak membuat aplikasi atau data contoh secara otomatis.
````

### A02. AGENTS.md

Source: `AGENTS.md`. SHA-256: `f48d3096443476933eadb90b1ffdfcd8c04c57c4f09e25193ece0977b182397c`.

```markdown
# Panduan agent

Aturan project berlaku untuk agent utama dan setiap subagent yang bekerja di repository ini.

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
```

### A03. docs/rules/development-workflow.md

Source: `docs/rules/development-workflow.md`. SHA-256: `5339f3f00302ac91f3429165aeb2760fa9474f0d83debf26ed1ea2ae956741b6`.

```markdown
# Workflow development

## Scope dan specs berdasarkan fitur

Scope disusun berdasarkan fitur kecil yang dapat diselesaikan dan diverifikasi sebagai satu alur. Hindari scope besar yang menggabungkan banyak kemampuan sekaligus.

Scope menjelaskan hasil yang diinginkan, batas pekerjaan, dan kriteria penerimaan. Specs menjelaskan rancangan implementasi fitur yang sama, termasuk bagian frontend, backend, dan worker yang terlibat.

Satu fitur dapat mencakup beberapa aplikasi. Pengelompokan dokumentasi tidak menentukan urutan pengerjaan. Tidak semua fitur membutuhkan worker.

Jika specs perlu dipecah karena kompleksitasnya, setiap bagian tetap merujuk fitur dan kontrak bersama yang sama.

## Keputusan schema dan keamanan

Saat `/scope` atau `/architect` merencanakan fitur dengan data persisten, tanyakan schema yang digunakan: `common`, `users`, `auth`, atau schema domain lain. Gunakan keputusan yang sudah dinyatakan untuk fitur tersebut tanpa meminta ulang. Fitur lintas schema memerlukan pembagian entitas yang jelas; fitur tanpa perubahan database dicatat tidak memerlukan keputusan schema.

Scope mencatat domain data dan keputusan yang belum tersedia. Specs menetapkan schema per entitas, relasi lintas schema, migration, role/privilege, serta kontrak sebelum bagian implementasi yang bergantung padanya dimulai, sesuai [aturan database](database.md).

Ikuti [aturan keamanan](security.md) sejak perencanaan. Tentukan data sensitif, model autentikasi, permission backend, batas resource, dan skenario penyalahgunaan yang relevan. Subagent menerima keputusan schema dan keamanan bersama kontrak tugasnya; perubahan privilege atau batas akses dikoordinasikan oleh agent utama.

## Menjalankan development

Siapkan layanan pendukung melalui `docker-compose.yml` root sesuai [aturan infrastruktur](infrastructure.md), lalu provision role/schema dan jalankan migration melalui langkah terpisah. Compose hanya untuk infrastruktur, bukan frontend/backend/worker, migration/seed, atau test runner. Doctor dan serve tidak otomatis mengelola Compose.

Jalankan `bun run doctor` untuk memeriksa prasyarat, lalu `bun run serve` untuk frontend port `8889`, backend port `8888`, dan worker yang dipilih melalui `--worker <nama>`. Kedua perintah mengikuti [aturan doctor/serve](development-commands.md).

`serve` otomatis melakukan preflight, kemudian menghentikan listener pada port layanan yang digunakan sebelum startup. Doctor tidak menghentikan proses dan tidak menjalankan migration/seed; ketidaksiapan database diselesaikan melalui runner terpisah. Bila startup atau salah satu layanan gagal, supervisor menghentikan seluruh grup proses invocation tersebut.

## Rencana pembuktian setiap pekerjaan

Setiap pekerjaan mengikuti [aturan testing](testing.md). Sebelum implementasi, tentukan dampak perubahan, kriteria penerimaan yang terkait, ID skenario, jenis test, dan bukti yang dibutuhkan. Target performance dan profil k6 yang diperlukan ditentukan dalam specs, bukan ditebak saat pengujian.

Pilih unit, integration, Playwright, dan k6 sesuai hal yang perlu dibuktikan. Perubahan kecil atau dokumentasi tidak memerlukan seluruh suite; catat pemeriksaan yang relevan dan alasan test lain tidak berlaku.

Ketika test diimplementasikan, hubungkan skenario ke kriteria dalam specs melalui registry `tests/scenarios/`. Kriteria tetap bersumber dari specs; registry memetakan test dan laporan mengumpulkan hasil eksekusinya.

## Kontrak sebelum pekerjaan paralel

Sepakati kontrak yang diperlukan antarbagian sebelum subagent mengerjakan bagian yang bergantung pada kontrak tersebut. Kontrak cukup rinci untuk memulai pekerjaan, tanpa harus menyelesaikan seluruh desain aplikasi.

Kontrak memuat hal yang relevan untuk fitur, seperti:

- Endpoint, input, output, dan respons kesalahan.
- Bentuk pesan atau job yang diterima worker.
- Perilaku yang diharapkan frontend dari backend.
- Contoh payload untuk implementasi dan verifikasi mandiri.

Catat kontrak di specs fitur. Jika tersedia, kode bersama di `libs/contracts/` harus mengikuti kontrak tersebut. Untuk HTTP, route/schema Elysia menghasilkan `openapi.json` root dan SDK Angular; frontend menggunakan tipe dan operasi SDK sesuai [aturan OpenAPI/SDK](openapi-sdk.md), bukan salinan DTO HTTP manual.

## Sinkronisasi backend, OpenAPI, dan SDK

Setiap perubahan backend wajib menjalankan urutan berikut sebelum pekerjaan selesai:

1. Ekspor ulang route/schema backend ke `openapi.json` pada root melalui `api:openapi`.
2. Periksa kontrak dokumen melalui `api:validate` menggunakan script Bun tanpa dependency validator tambahan; cakupan pemeriksaan mengikuti aturan OpenAPI/SDK.
3. Generate ulang SDK dengan schematic `@ojiepermana/angular:sdk` ke `apps/frontend/sdk/` melalui `sdk:generate` dalam mode `standalone`.
4. Sesuaikan pemakaian SDK dalam adapter fitur yang terdampak, lalu jalankan build frontend dan test sesuai perubahan.
5. Periksa artefak yang bertambah, berubah, atau dihapus dan sertakan hasilnya bersama perubahan backend.

Root script `api:sync` menjalankan tiga tahap awal secara berurutan dan berhenti saat gagal. Perubahan internal backend tetap wajib melakukan regenerasi walaupun hasil OpenAPI dan SDK identik. Perubahan schema/dependency bersama yang memengaruhi backend dan perubahan generator/config juga mengikuti alur ini.

Tetapkan satu penanggung jawab `openapi.json` dan `apps/frontend/sdk/` ketika pekerjaan backend berjalan paralel. Regenerasi dilakukan setelah perubahan sumber digabungkan; perubahan backend berikutnya memerlukan regenerasi lagi. Subagent frontend memakai SDK terbaru yang telah divalidasi dan mengomunikasikan dampak kontrak kepada agent utama. Frontend dapat mulai dari kontrak dan respons contoh, tetapi integrasi akhir wajib memakai hasil generate dari backend nyata.

Jangan mengedit OpenAPI atau generated SDK manual. CI menjalankan `api:check` untuk mendeteksi artefak yang tertinggal atau tidak dapat direproduksi sebelum verifikasi frontend yang bergantung pada SDK. Generate, validasi, build, atau test kontrak yang gagal berarti sinkronisasi belum selesai.

## Pembagian tugas subagent

Untuk fitur dengan beberapa bagian yang dapat dikerjakan secara independen, bagi pekerjaan kepada subagent sesuai bagian dan dependensinya. Pekerjaan kecil yang tidak membutuhkan pembagian dapat diselesaikan oleh agent utama.

Agent utama mengoordinasikan pekerjaan. Sebelum delegasi, tentukan untuk setiap subagent:

- Tujuan dan bagian fitur yang menjadi tanggung jawabnya.
- File atau area yang boleh diubah.
- Kontrak, dependensi, dan kriteria penerimaan yang berlaku.
- Cara memverifikasi hasil dan kepada siapa hasil dilaporkan.

Sertakan aturan testing, ID skenario yang menjadi tanggung jawab subagent, batas file test, dan profil performance yang relevan. Tetapkan penanggung jawab untuk integration lintas aplikasi, registry, konfigurasi runner, fixture bersama, dan orchestration test.

Subagent menjalankan tugasnya secara mandiri dalam batas tersebut. Keputusan implementasi lokal tidak memerlukan konfirmasi ulang selama sesuai specs, rules, dan kontrak yang disepakati.

Tetapkan satu penanggung jawab untuk file bersama, termasuk kontrak, konfigurasi root, dan dependency. Koordinasikan kebutuhan perubahan pada file tersebut agar beberapa subagent tidak mengubahnya secara bersamaan atau menimpa pekerjaan lain.

## Pengerjaan mengikuti dependensi

Bagian yang kontraknya sudah jelas dapat dikerjakan secara bersamaan. Jangan menunggu seluruh aplikasi lain selesai jika bagian yang dibutuhkan dapat diwakili dengan respons atau job contoh.

Contoh untuk registrasi pengguna:

| Bagian | Pekerjaan mandiri |
| --- | --- |
| Frontend | Membuat form dengan respons contoh sesuai kontrak. |
| Backend | Membuat endpoint dan menghasilkan job sesuai kontrak. |
| Worker | Memproses job contoh dan menjalankan pengiriman email. |

Tunggu hanya dependensi yang benar-benar diperlukan untuk langkah berikutnya. Respons atau job contoh membantu development, tetapi penyelesaian fitur tetap membutuhkan integrasi nyata.

## Komunikasi antaragent

Subagent berkomunikasi melalui fasilitas koordinasi agent dalam tugas yang sama. Bila komunikasi langsung tidak tersedia, agent utama meneruskan informasi yang diperlukan.

Sampaikan kepada agent utama dan subagent terkait ketika ada perubahan kontrak yang diusulkan, dependensi yang siap dipakai, hambatan, konflik kepemilikan file, atau hasil yang siap diintegrasikan.

Pesan harus menjelaskan konteks, dampak, dan tindakan yang diperlukan. Jangan mengubah kontrak bersama secara sepihak. Agent utama mengoordinasikan perubahan, memperbarui specs, dan menyampaikan kontrak terbaru kepada semua bagian yang terdampak.

Jika terhambat, laporkan kebutuhan yang belum tersedia dan lanjutkan pekerjaan independen yang masih dapat dilakukan.

## Integrasi dan penyelesaian

Setiap subagent memverifikasi bagiannya dan melaporkan perubahan, hasil verifikasi, serta keterbatasan yang masih ada.

Laporan subagent menyertakan perintah yang dijalankan, hasil aktual, ID skenario yang dibuktikan, dan test yang gagal, dilewati, atau belum dijalankan. Jangan menganggap build berhasil atau seluruh tugas agent selesai sebagai bukti seluruh skenario lulus.

Agent utama memastikan seluruh bagian mengikuti kontrak yang sama, mengintegrasikan hasil, dan memverifikasi alur fitur terhadap kriteria penerimaan.

Fitur selesai ketika alur yang diperlukan bekerja bersama dan kriteria penerimaan terpenuhi. Selesainya tugas setiap subagent saja belum cukup untuk menyatakan fitur selesai.

## Pengelompokan commit

Ketika melakukan commit, agent mengelompokkan perubahan berdasarkan tujuan yang koheren dan mudah direview. Perubahan dengan tujuan berbeda dipisahkan menjadi beberapa commit, bukan digabung menjadi satu commit besar hanya karena dikerjakan dalam sesi yang sama.

Aturan ini menggunakan pertimbangan, bukan jumlah file, batas baris, atau kewajiban selalu membuat banyak commit. Satu perubahan kecil atau satu kelompok perubahan yang saling bergantung boleh menjadi satu commit. Jangan memecah perubahan secara buatan hingga tiap commit kehilangan konteks atau tidak dapat digunakan.

Kode, test yang membuktikannya, serta konfigurasi atau dokumentasi yang diperlukan untuk perubahan tersebut dapat berada dalam commit yang sama. Perubahan kontrak backend beserta OpenAPI dan SDK hasil regenerasinya tetap dikelompokkan bersama bila diperlukan untuk menjaga konsistensi. Perubahan independen, seperti perbaikan bug terpisah atau cleanup yang tidak terkait, menjadi kelompok commit lain.

Sebelum commit, periksa diff, tentukan kelompok perubahan, stage hanya file atau bagian yang sesuai, dan tinjau staged diff. Jangan menyertakan pekerjaan pengguna atau perubahan lain yang tidak termasuk kelompok tersebut. Pesan commit menjelaskan perubahan utamanya secara konkret; verifikasi yang relevan tetap mengikuti aturan testing.

## Pembaruan knowledge graph saat commit

Setiap kali melakukan commit, agent memperbarui knowledge graph graphify agar sesuai dengan perubahan yang di-commit. Jalankan `graphify update .` dari root repository setelah staged diff ditinjau. Perintah ini mengekstrak ulang kode melalui AST tanpa API key atau biaya LLM.

Jika perintah menolak menulis karena graph baru lebih kecil, pastikan pengurangan tersebut berasal dari kode yang memang dihapus dalam perubahan, lalu jalankan ulang dengan `--force`. Perubahan dokumen, gambar, atau file non-kode lain tidak ikut diperbarui oleh perintah tersebut; periksa melalui `graphify check-update .`. Bila graph lokal memuat ekstraksi semantik, jalankan `/graphify . --update` untuk perubahan itu atau laporkan bahwa pembaruan semantik masih tertunda.

`graphify-out/` adalah artefak lokal dan tercantum di `.gitignore`; jangan men-stage atau meng-commit isinya. Pembaruan graph yang gagal dilaporkan bersama output perintahnya dan tidak boleh dinyatakan berhasil.

## Pemeriksaan sebelum production release

Agent utama menggabungkan bukti seluruh bagian dan menyiapkan laporan kesiapan menggunakan [template laporan release](../testing/release-report-template.md). Laporan mencatat kandidat build, environment, hasil per skenario, hasil performance, kegagalan, test yang tidak stabil, serta batas bukti.

Sebelum release, seluruh skenario wajib untuk kandidat tersebut harus dijalankan dan memenuhi kriteria. Gunakan unit dan integration yang relevan, regression Playwright untuk alur kritis, serta profil k6 yang ditetapkan. Verifikasi migration dan hasil akhir worker ketika termasuk cakupan perubahan. Pastikan OpenAPI dan SDK sesuai sumber kandidat release melalui `api:check`, build Angular, dan pengujian kontrak yang relevan; sertakan identitas artefak dan bukti generate pada laporan.

Jika bukti wajib belum lengkap, laporkan `incomplete`. Jika skenario wajib gagal, laporkan `blocked`. Laporkan `ready` hanya ketika bukti wajib lengkap dan memenuhi kriteria. Catat pengecualian yang diputuskan tanpa mengubah status hasil test.

Pemeriksaan setiap pekerjaan menjadi bukti awal; pemeriksaan kandidat release memastikan gabungan perubahan bekerja pada build dan environment yang akan digunakan. Perubahan setelah pengujian harus dinilai dampaknya dan diverifikasi ulang pada area terkait.
```

### A04. docs/rules/angular.md

Source: `docs/rules/angular.md`. SHA-256: `36d2adbc35827844dbb8be4e9e892a11619a677c4304b5133d99a1f1fddf75ff`.

````markdown
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
````

### A05. docs/rules/ui-ux.md

Source: `docs/rules/ui-ux.md`. SHA-256: `944f0558a092c90a1de6dedc446b7a108c71f4ed4ab3d7a00e3580b714c4b2bd`.

```markdown
# Aturan UI dan UX frontend

Aturan ini berlaku untuk semua halaman dan fitur frontend, termasuk pekerjaan agent utama dan subagent. Struktur kode mengikuti [aturan frontend Angular](angular.md).

## Sumber komponen UI

Seluruh komponen library UI menggunakan package `@ojiepermana/angular`, sesuai pilihan project. `theme` adalah salah satu bagian yang dapat digunakan melalui entry point `@ojiepermana/angular/theme`, bukan nama package terpisah atau sumber seluruh komponen UI.

Gunakan entry point publik yang sesuai dengan komponen yang dibutuhkan, berdasarkan API versi package yang digunakan. Untuk layout aplikasi, pilihan yang telah disepakati tetap menggunakan default layout wrapper dari bagian `theme`.

- Gunakan komponen library yang tersedia untuk kebutuhan UI, seperti tombol, input, pilihan, dialog, dan tampilan data. Periksa ketersediaan setiap komponen sebelum implementasi.
- Jangan menambahkan component library lain atau membuat ulang komponen dasar yang sudah tersedia.
- Komponen aplikasi boleh dibuat untuk menyusun komponen library menjadi halaman atau tampilan khusus fitur. Komponen aplikasi tidak menjadi pengganti component library.
- Wrapper lokal hanya dibuat jika memiliki tanggung jawab tambahan yang jelas, bukan sekadar meneruskan seluruh API komponen library.
- Jika kebutuhan UI belum didukung library, laporkan kebutuhan dan dampaknya kepada agent utama. Agent utama mengoordinasikan keputusan dengan pengguna; jangan mengganti library atau membuat pengganti secara sepihak. Lanjutkan bagian pekerjaan independen yang masih dapat dilakukan.

## Penggunaan API library

Sebelum menggunakan komponen, periksa dokumentasi, entry point, export publik, dan tipe pada versi `@ojiepermana/angular` yang digunakan project. Jangan menganggap semua komponen diekspor melalui `@ojiepermana/angular/theme`.

Jangan menebak selector, nama export, input, output, provider, atau token style. Jangan mengimpor dari file internal library atau menyalin implementasinya.

Aturan ini menetapkan pilihan library, bukan daftar API yang sudah diverifikasi. Detail integrasi ditentukan dari API publik saat implementasi.

## Konsistensi tampilan

- Ikuti theme, varian, dan token tampilan yang tersedia melalui API publik library.
- Gunakan pola spacing, warna, tipografi, ukuran, dan state yang konsisten antarhalaman.
- Style lokal menangani komposisi dan kebutuhan khusus fitur. Jangan mengubah tampilan komponen library dengan menargetkan struktur DOM internalnya.
- Gunakan default layout wrapper. Konfigurasi atau integrasi tambahan mengikuti batas `shell/` dalam aturan frontend Angular.

## Perilaku UX

- Setiap halaman memiliki tujuan dan tindakan utama yang jelas. Label menjelaskan tindakan atau isi, bukan detail implementasi.
- Untuk proses mengambil atau mengubah data, tangani state yang relevan: loading, kosong, berhasil, dan gagal.
- Saat proses berjalan, tampilkan feedback dan cegah pengiriman berulang yang tidak disengaja.
- Pesan kesalahan menjelaskan masalah dan tindakan yang dapat dilakukan pengguna. Sediakan retry jika sesuai dengan alur fitur.
- Form memiliki label yang jelas, validasi yang dapat dipahami, dan mempertahankan input pengguna saat pengiriman gagal jika sesuai dengan alur.
- Gunakan istilah dan pola interaksi yang konsisten untuk tindakan yang sama di seluruh aplikasi.
- Tampilan tetap dapat digunakan pada ukuran layar yang menjadi target fitur, termasuk konten panjang dan data kosong.

## Aksesibilitas

Gunakan kemampuan aksesibilitas komponen library dan lengkapi integrasinya di aplikasi.

- Kontrol interaktif memiliki nama atau label yang dapat dipahami.
- Alur dapat dioperasikan dengan keyboard, dengan indikator focus yang terlihat.
- Focus dikelola dengan benar pada interaksi seperti dialog dan perubahan konteks.
- Informasi penting tidak disampaikan melalui warna saja.
- Perubahan konten atau style tidak menghilangkan perilaku aksesibilitas bawaan komponen.

## Penempatan komponen aplikasi

- Komponen khusus satu fitur berada di `features/<nama-fitur>/`.
- Komposisi UI yang digunakan beberapa fitur frontend ini dapat berada di `shared/`.
- Komposisi UI yang benar-benar diperlukan beberapa aplikasi Angular dapat berada di `libs/ui/`.
- `shared/` dan `libs/ui/` tetap menyusun komponen dari library pilihan project, bukan membuat component library dasar baru.

## Tanggung jawab agent

Agent utama menyertakan aturan UI/UX dan struktur frontend saat mendelegasikan pekerjaan frontend. Setiap subagent membacanya sebelum implementasi.

Subagent melaporkan kekurangan API atau komponen, perubahan pola UX yang berdampak pada fitur lain, serta kebutuhan perubahan file bersama.

Verifikasi mencakup alur pengguna, state yang relevan, ukuran layar target, dan interaksi keyboard. Build yang berhasil saja belum membuktikan UI/UX fitur selesai.
```

### A06. docs/rules/elysia.md

Source: `docs/rules/elysia.md`. SHA-256: `b1966c64632066163787018dfd651db1dbe3b89e292c6930ff802b7fb5a9113c`.

````markdown
# Struktur backend Bun dan ElysiaJS

Backend berada di `apps/backend/`, menggunakan TypeScript, Bun sebagai runtime, dan ElysiaJS untuk HTTP. Struktur kode mengikuti area fitur sesuai [workflow development](development-workflow.md).

Utamakan fasilitas native Bun yang memenuhi kebutuhan fitur. Akses PostgreSQL menggunakan `Bun.SQL` tanpa ORM. Pengelolaan migration dan seed mengikuti [aturan database](database.md) dan berada di luar `apps/`.

Ikuti [aturan keamanan](security.md) untuk validasi, permission pada setiap request, sesi/CSRF, limit, dan batas resource. Role runtime mengakses schema `common`, `users`, dan `auth` sesuai privilege yang disepakati; query memakai identifier berkualifikasi schema. Database migration tetap dijalankan terpisah.

Development backend memakai `HOST` dan `PORT` yang diberikan root supervisor, dengan default `127.0.0.1:8888`. Jalankan bersama frontend melalui [doctor dan serve](development-commands.md), bukan dengan angka port berbeda yang tersebar di script fitur.

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
````

### A07. docs/rules/database.md

Source: `docs/rules/database.md`. SHA-256: `9ff138c846e85bdf7ef114c7d04780dfdc276f46475bb082de7798f3f28eee34`.

````markdown
# Aturan database

Foundation menggunakan PostgreSQL minimal versi 18. PostgreSQL 18 menjadi baseline development dan integration test. Kompatibilitas versi yang lebih baru harus diverifikasi sebelum dinyatakan didukung.

Akses database menggunakan client native `Bun.SQL` dan SQL langsung tanpa ORM.

Server PostgreSQL development dapat dijalankan melalui `docker-compose.yml` root sesuai [aturan infrastruktur](infrastructure.md). Compose mengelola server database saja; credential administrator provisioning dipisahkan dari role migration/backend/worker. Schema, grants, migration, dan seed tetap melalui langkah terpisah, bukan startup Compose atau aplikasi.

## Schema berdasarkan domain

Satu database menggunakan beberapa schema berdasarkan domain:

| Schema | Isi |
| --- | --- |
| `common` | Metadata/infrastruktur bersama, termasuk `common.schema_migrations`. Bukan tempat seluruh tabel bisnis secara otomatis. |
| `users` | Identitas bisnis pengguna, profil, dan data domain pengguna sesuai specs. |
| `auth` | Credential/hash password, sesi, reset/verifikasi token, serta data autentikasi/otorisasi sesuai specs. |
| Schema domain lain | Ditambahkan ketika domain fitur membutuhkan batas sendiri dan telah diputuskan dalam scope/specs. |

Nama yang disepakati adalah `common`, `users`, dan `auth`. `users` merupakan schema domain pengguna, bukan schema baru untuk setiap pengguna aplikasi. Schema bukan database terpisah dan bukan isolasi tenant dengan sendirinya; privilege dan pemeriksaan akses tetap diperlukan sesuai [aturan keamanan](security.md).

Seluruh query, DDL, FK, view, dan operasi seed memakai identifier berkualifikasi, seperti `users.users`, `auth.sessions`, dan `common.schema_migrations`. Jangan bergantung pada default `public` atau nama tabel yang dipilih melalui input client. Relasi lintas schema dalam database yang sama diperbolehkan dan dicatat eksplisit dalam specs, misalnya sesi `auth` merujuk pengguna `users`.

Gunakan `search_path` runtime yang hanya mencakup schema tepercaya, dengan `pg_catalog` eksplisit dan objek aplikasi selalu berkualifikasi. Role runtime tidak dapat membuat objek pada schema di search path. Periksa dan batasi privilege `CREATE` pada schema `public`, terutama pada database hasil upgrade; jangan menganggap default seluruh instalasi sama.

Saat menjalankan `/scope` atau `/architect`, agent menanyakan schema data fitur dan pembagian entitas lintas schema jika keputusan belum tersedia. Catat pilihan pada scope dan rincian per entitas pada specs. Keputusan schema baru tidak dibuat diam-diam oleh agent/subagent; pekerjaan independen dapat berjalan sambil menunggu keputusan, tetapi migration/query yang bergantung padanya menunggu jawaban.

## Role dan privilege

- Pisahkan role pemilik/migration dari role runtime backend dan masing-masing worker. Runtime bukan superuser, tidak memiliki hak membuat role/database atau DDL, dan tidak menjadi pemilik objek bisnis.
- Berikan `USAGE` pada schema dan privilege tabel/sequence yang diperlukan saja. `USAGE` tidak dengan sendirinya memberi akses tabel. Worker tidak otomatis mempunyai akses credential/sesi di `auth`.
- Role backend mendapat akses baca metadata migration untuk preflight; hanya runner migration yang menulis metadata dan mengubah struktur. Seed menggunakan role serta operasi yang diputuskan eksplisit.
- Atur default privilege untuk objek baru sesuai role yang benar-benar membuatnya, lalu verifikasi permission setelah migration. Hindari grant semua privilege pada semua schema untuk mengatasi error akses.
- Uji keberhasilan akses yang diizinkan dan kegagalan akses lintas domain yang dilarang. Detail role, grants, dan bila perlu RLS untuk tenant dicatat dalam specs; pemisahan schema tidak menggantikan otorisasi backend.

## Struktur dan batas tanggung jawab

```text
foundation/
├── package.json
├── bun.lock
├── docker-compose.yml
├── apps/
│   ├── frontend/
│   ├── backend/
│   └── worker/
├── libs/
│   ├── contracts/
│   └── server/
│       └── database/
│           └── client.ts
└── database/
    ├── Dockerfile
    ├── migrate.ts
    ├── seed.ts
    ├── migrations/
    │   ├── 0001-create-schemas.sql
    │   ├── 0002-users-create-users.sql
    │   └── 0003-auth-create-sessions.sql
    └── seeds/
        └── initial-data.sql
```

Nama migration dan seed merupakan contoh. Dockerfile pada `database/` diperlukan jika runner dijalankan melalui container. Struktur ini tidak mewajibkan pembuatan file contoh sebelum ada kebutuhan.

| Lokasi | Tanggung jawab |
| --- | --- |
| `apps/backend/` | Endpoint, aturan bisnis, dan query operasional fitur. |
| `apps/worker/` | Pekerjaan bisnis di latar belakang dan query yang dibutuhkan pekerjaan tersebut. |
| `libs/server/database/` | Infrastruktur koneksi PostgreSQL yang dapat digunakan backend, worker, dan runner database. |
| `database/` | Migration, seed, dan runner pengelolaan skema atau data awal. |

Migration dan seed tidak berada di `apps/`. Backend dan worker tidak menjalankannya saat startup. File tersebut juga tidak ditempatkan di `libs/server/database/`, yang hanya berisi infrastruktur runtime bersama.

## Client dan query operasional

- `client.ts` menyediakan factory client. Aplikasi atau runner memasok konfigurasi; library tidak mengimpor konfigurasi aplikasi tertentu.
- Setiap proses memiliki pool sendiri dan menggunakan kembali client tersebut. Jangan membuat client baru untuk setiap request atau query.
- Atur kapasitas pool dengan memperhitungkan jumlah container backend dan worker. Tutup pool ketika proses berhenti.
- Gunakan tagged template dan parameter query untuk nilai dinamis. Jangan menggabungkan input pengguna ke string SQL.
- Jika identifier SQL perlu dinamis, gunakan fasilitas identifier yang sesuai dan batasi pilihan yang diizinkan.
- Untuk perubahan yang harus atomik, gunakan transaksi Bun.SQL. Semua query dalam transaksi memakai client transaksi yang sama, bukan client pool di luar transaksi.
- Jangan menelan kesalahan lalu menganggap transaksi berhasil. Pastikan kegagalan membatalkan transaksi sesuai alur fitur.
- Simpan query khusus fitur dekat dengan logika bisnisnya. Infrastruktur koneksi bersama tidak menjadi kumpulan seluruh query aplikasi.

## Migration dan seed

- Migration berupa file SQL berurutan di `database/migrations/`.
- Gunakan satu urutan global untuk seluruh schema agar FK dan dependensi lintas schema dapat diterapkan konsisten. Nama file menyebut domain; jangan membuat penomoran independen yang mengabaikan dependensi antarschema.
- `migrate.ts` merupakan runner project menggunakan Bun dan Bun.SQL, bukan fitur migration otomatis dari ORM.
- Bootstrap runner menyiapkan schema `common` dan tabel `common.schema_migrations` sebelum membaca riwayat. Metadata mempunyai `name` unik untuk nama file lengkap, `checksum` SHA-256 dari byte file SQL, dan waktu penerapan; migration berikutnya menyiapkan schema serta objek domain sesuai urutan. Bootstrap dan perubahan tetap menggunakan role migration serta lock yang sama.
- Runner memvalidasi target database dan minimum versi PostgreSQL sebelum menjalankan perubahan.
- Catat migration yang berhasil beserta checksum. Jangan mengubah migration yang sudah diterapkan; buat migration baru untuk perubahan berikutnya.
- Koordinasikan eksekusi dengan lock database agar beberapa runner tidak menerapkan migration bersamaan.
- Terapkan perubahan dan pencatatan migration dalam transaksi ketika jenis perintah SQL mendukungnya. Perintah yang tidak dapat berjalan dalam transaksi harus ditangani secara eksplisit.
- Jalankan seed secara eksplisit melalui `seed.ts`, terpisah dari migration. Tentukan target environment dan perilaku pengulangan seed, tanpa menghapus atau menimpa data bisnis secara diam-diam.

## Eksekusi dan container

Runner database berjalan sekali lalu selesai. Runner bukan aplikasi worker yang terus hidup.

Jalankan migration sebagai langkah deployment tersendiri sebelum aplikasi yang memerlukan skema baru dijalankan. Koordinasikan perubahan skema dengan kebutuhan backend dan worker dalam specs fitur.

Script dikelola melalui `package.json` root. Jika menggunakan container, Dockerfile berada di `database/Dockerfile` dan build context tetap root monorepo. Runner tidak memiliki `package.json` terpisah.

Image PostgreSQL yang dipakai untuk environment project harus memenuhi minimum versi 18. Dockerfile runner menjalankan proses Bun dan tidak menjadi container server PostgreSQL.

## Koordinasi agent

Agent utama dan setiap subagent yang mengubah koneksi, query, skema, migration, seed, atau deployment database wajib membaca aturan ini.

Tetapkan satu penanggung jawab untuk migration, penomoran file, dan infrastruktur database bersama. Subagent fitur menyampaikan kebutuhan perubahan skema serta dependensinya sebelum implementasi yang bergantung pada perubahan tersebut.

## Referensi

- [Schema dan privilege PostgreSQL 18](https://www.postgresql.org/docs/18/ddl-schemas.html).
- [Dokumentasi PostgreSQL 18](https://www.postgresql.org/docs/18/index.html).
- [Client SQL native Bun](https://bun.com/docs/runtime/sql).
````

### A08. docs/rules/worker.md

Source: `docs/rules/worker.md`. SHA-256: `23b1cb477610f0a17e344fb7e8cabeb1fab9c2952ad466e227d937c078919e07`.

````markdown
# Konsep worker

Worker adalah aplikasi untuk menjalankan pekerjaan di latar belakang. Semua aplikasi worker berada di `apps/worker/<nama-worker>/`.

## Batas aplikasi

Setiap worker mewakili tanggung jawab yang jelas. Beberapa jenis pekerjaan dapat ditangani oleh satu worker. Pemisahan menjadi aplikasi berbeda mengikuti kebutuhan deployment, resource, scaling, dan penanganan kegagalan.

Worker dapat berupa proses TypeScript tanpa server HTTP. Penggunaan ElysiaJS tidak wajib untuk worker yang hanya mengambil dan menjalankan job.

Worker menggunakan Bun sebagai runtime dan mengutamakan fasilitas native yang sesuai, mengikuti [aturan Bun dan ElysiaJS](elysia.md) untuk runtime serta kode server yang relevan. Worker tidak perlu menambahkan server Elysia jika tidak membutuhkan HTTP.

Worker yang mengakses PostgreSQL mengikuti [aturan database](database.md): minimal PostgreSQL 18, client native `Bun.SQL`, dan SQL langsung tanpa ORM. Factory koneksi dapat digunakan dari `libs/server/database/`, dengan pool milik proses worker sendiri.

Migration dan seed berada di `database/` pada root, di luar `apps/`, dan tidak dijalankan saat worker startup. Runner migration atau seed adalah proses terpisah yang berjalan sekali lalu selesai, bukan worker bisnis.

Worker mengikuti [aturan keamanan](security.md) untuk validasi job, identitas sumber, timeout, retry, idempotensi, serta akses resource. Worker menggunakan role database sendiri dengan privilege schema/tabel sesuai tugas; akses `auth` tidak diberikan otomatis.

Pada development, worker didaftarkan dan dipilih melalui [doctor dan serve](development-commands.md). Worker tanpa HTTP tidak memerlukan port. URL database berasal dari variable khusus worker, bukan mewarisi credential backend secara otomatis.

## Container dan Dockerfile

Setiap worker yang dideploy secara mandiri memiliki Dockerfile di folder aplikasinya, seperti frontend dan backend.

Contoh lokasi:

```text
apps/worker/notification/Dockerfile
apps/worker/report/Dockerfile
```

Setiap worker dapat dibangun menjadi image dan dijalankan sebagai container terpisah. Deployment, restart, environment variable, batas resource, dan jumlah container dapat diatur secara mandiri.

Seluruh image dibangun dengan root monorepo sebagai build context karena project memiliki satu `package.json` di root dan aplikasi dapat menggunakan kode bersama dari `libs/`.

Contoh perintah dari root project:

```bash
docker build -f apps/worker/notification/Dockerfile -t foundation-notification .
```

Dockerfile menentukan kode dan dependency yang diperlukan untuk image aplikasi tersebut.

## Contoh tanggung jawab

Nama berikut merupakan contoh, bukan daftar aplikasi yang wajib dibuat:

| Worker | Tanggung jawab |
| --- | --- |
| `notification` | Mengirim email, push notification, atau pesan. |
| `file-processing` | Memproses unggahan, membuat thumbnail, atau membaca CSV. |
| `report` | Membuat laporan atau mengekspor data. |
| `integration` | Menyinkronkan data dengan layanan lain. |
| `maintenance` | Membersihkan file sementara atau data kedaluwarsa secara berkala. |
````

### A09. docs/rules/openapi-sdk.md

Source: `docs/rules/openapi-sdk.md`. SHA-256: `c9fec052853e795dfa63bdcae58428876b6a748fa541993c4576e0582396696c`.

````markdown
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
````

### A10. docs/rules/security.md

Source: `docs/rules/security.md`. SHA-256: `f4e0d25c41a4c9680e59e8518b8c16de25908097c6a696e1357ce39cdddd633b`.

```markdown
# Keamanan aplikasi

Keamanan menjadi bagian desain, implementasi, testing, dan operasi. Gunakan pertahanan berlapis untuk mengurangi peluang serangan dan membatasi dampaknya; tidak ada konfigurasi tunggal yang menjamin aplikasi kebal. Aturan ini berlaku bagi frontend, backend, worker, database, dan tooling bersama [workflow development](development-workflow.md).

## Desain fitur dan batas kepercayaan

Saat `/scope` dan `/architect`, identifikasi data sensitif, siapa yang boleh mengaksesnya, endpoint publik, batas antarproses, dan kemungkinan penyalahgunaan fitur. Specs mencatat model autentikasi, aturan otorisasi, schema/role database, kebijakan data, serta skenario serangan yang perlu dibuktikan.

Gunakan OWASP ASVS sebagai rujukan kontrol yang dapat diuji. Pilih kontrol sesuai fitur dan catat bukti; sekadar menggunakan framework, SDK, HTTPS, atau memisahkan schema belum membuktikan bahwa kontrol diterapkan.

## Kontrol minimum dan pembuktiannya

| Risiko | Aturan implementasi | Bukti yang diperlukan |
| --- | --- | --- |
| Akses data pengguna lain atau eskalasi hak | Backend menolak akses secara default dan memeriksa permission, kepemilikan objek, serta tenant bila ada pada setiap operasi. Role/owner tidak diambil dari payload yang tidak dipercaya. | Pengguna A tidak dapat membaca/mengubah data B; pengguna biasa tidak dapat menjalankan operasi admin. |
| SQL injection dan mass assignment | SQL memakai parameter Bun.SQL; identifier dinamis memakai allowlist. Request memakai schema dan field yang diizinkan, kemudian response dipetakan eksplisit. | Input berbahaya menjadi nilai data atau ditolak; field tambahan tidak mengubah role/owner/status yang dilindungi. |
| Pencurian atau penyalahgunaan sesi | Token sesi dibuat dengan sumber acak kriptografis, mempunyai expiry, dapat dicabut, dan diganti saat login atau perubahan hak. | Sesi kedaluwarsa, dicabut, dan sebelum rotasi ditolak; logout dan reset password berlaku di backend. |
| CSRF dan origin palsu | Operasi yang mengubah data dengan autentikasi cookie memakai perlindungan CSRF serta validasi origin yang sesuai. GET tidak mengubah data. | Request perubahan data tanpa bukti CSRF atau dari origin yang tidak diizinkan ditolak. |
| XSS dan clickjacking | Gunakan binding/sanitization Angular, hindari HTML tidak dipercaya dan bypass sanitization; terapkan CSP serta pembatasan frame pada respons dokumen frontend. | Payload HTML tidak dieksekusi; CSP tetap mendukung theme/UI dan deployment yang digunakan. |
| Brute force dan konsumsi resource berlebihan | Batasi percobaan login/reset serta endpoint mahal, ukuran body/upload, pagination, durasi query/request, concurrency, dan antrean worker. | Kelebihan batas ditolak secara terkontrol; k6 mengukur kapasitas dan pemulihan sesuai specs. |
| File berbahaya, path traversal, dan SSRF | Upload memakai batas ukuran/jenis, nama penyimpanan dari server, dan lokasi yang tidak dapat mengeksekusi kode. Akses URL keluar memakai allowlist serta pemeriksaan redirect/DNS ketika fitur menggunakannya. | File/path/URL terlarang ditolak dan tidak menjangkau filesystem atau jaringan internal yang dilarang. |
| Kebocoran data dan kesalahan konfigurasi | Response error tidak menampilkan stack, SQL, atau secret; log disaring. TLS, role minimum, secret terpisah, dan dependency terkunci diterapkan. | Tidak ada kredensial pada bundle, response, log, laporan, atau artefak; role tidak dapat mengakses area yang dilarang. |

Auth guard frontend hanya membantu navigasi. Guard tersebut tidak menggantikan pemeriksaan izin backend. Pengujian mencakup akses langsung ke API melalui SDK maupun request HTTP di luar frontend.

## Autentikasi dan sesi browser

Untuk aplikasi Angular ini, default yang disarankan adalah sesi opaque yang disimpan di server, dikirim melalui cookie `HttpOnly`, `Secure` di production, dan `SameSite` eksplisit sesuai alur. Model final, expiry, rotasi, logout, pemulihan akun, serta kebutuhan MFA ditetapkan dalam specs autentikasi sebelum implementasi. Jangan memilih JWT hanya untuk menghindari penyimpanan sesi; jika diperlukan oleh integrasi, desain validasi dan pencabutannya juga harus jelas.

Simpan hash token sesi/reset di `auth`, bukan token mentah. Jangan menyimpan session ID, access/refresh token, atau password dalam `localStorage`/`sessionStorage`. Penggunaan cookie aman tetap memerlukan perlindungan CSRF; `SameSite` saja bukan pengganti semua pemeriksaan CSRF.

Password memakai hash Argon2id melalui API native async `Bun.password`, dengan parameter yang memenuhi rujukan keamanan dan diuji terhadap kapasitas runtime. Jangan mengenkripsi password untuk dapat dibaca kembali. Token reset sekali pakai, dibatasi waktu, dan respons login/pemulihan tidak membocorkan keberadaan akun. Perubahan credential atau hak akses mempertimbangkan pencabutan sesi.

Untuk production, prefer cookie dengan prefix `__Host-` jika topologi memungkinkan: `Secure`, `Path=/`, tanpa `Domain`. Development HTTP lokal memakai konfigurasi cookie yang dinyatakan khusus development; konfigurasi production tidak boleh diam-diam menonaktifkan `Secure`.

## HTTP, Angular, dan Elysia

- Gunakan HTTPS pada akses production; terapkan HSTS setelah topologi TLS siap. Header keamanan dokumen frontend ditangani oleh server/reverse proxy yang mengirim dokumen tersebut, bukan hanya middleware backend API.
- CORS hanya mengizinkan origin yang dinyatakan; jangan memakai wildcard untuk request credential. CORS bukan kontrol autentikasi atau penghalang client nonbrowser.
- Rate limit login dan operasi mahal mempertimbangkan identitas akun serta sumber request. Pada beberapa container, koordinasikan limit dengan penyimpanan/edge bersama. Jangan mempercayai header IP forwarding dari client tanpa proxy yang dipercaya.
- Gunakan schema Elysia untuk request dan response, batas ukuran dan timeout eksplisit, serta error yang konsisten. Periksa cakupan dan urutan hook/plugin agar route sensitif benar-benar terlindungi.
- SDK generated tidak dianggap validasi keamanan di server. Security scheme OpenAPI harus sesuai perilaku nyata, dan alur SDK harus membawa cookie/token sesuai model yang dipilih.
- Gunakan CSP dan Trusted Types ketika sesuai integrasi Angular/library. Hindari `bypassSecurityTrust*`, eval, atau HTML dari input tanpa keputusan dan verifikasi yang jelas dalam specs.
- Endpoint debug, metrics, administrasi, dan UI OpenAPI di production mempunyai kebijakan akses eksplisit. Ekspor spec lokal tetap bekerja tanpa membuka route bisnis sebagai publik.

## Database, worker, dan deployment

Ikuti [aturan database](database.md): schema `common`, `users`, dan `auth`, identifier berkualifikasi schema, serta role migration terpisah dari role runtime. Schema adalah pengelompokan domain; privilege SQL yang menentukan siapa dapat mengaksesnya. Jangan menganggap pemisahan schema sebagai isolasi tenant.

Backend dan setiap worker menggunakan credential serta privilege minimum sesuai tugas. Runtime tidak memakai superuser, tidak mempunyai DDL, dan tidak menjadi pemilik schema/tabel. Migration hanya dijalankan oleh runner terpisah. Uji pula penolakan akses database, bukan hanya keberhasilan query yang diizinkan.

Job worker mempunyai schema tervalidasi, identitas/otorisasi sumber yang sesuai, batas retry, timeout, concurrency, dan perilaku idempotensi. File/URL pada job tetap dianggap input yang perlu diperiksa. Jangan memasukkan password/token mentah ke antrean atau log job.

Container berjalan sebagai user yang diperlukan tanpa privilege berlebih, memakai batas resource, dan tidak memuat secret di image. Production memisahkan akses database/antrean dari jaringan publik. Reverse proxy atau layanan edge dapat membatasi trafik masuk; mitigasi beban jaringan besar juga memerlukan kontrol infrastruktur.

Secret berasal dari environment/secret manager, terpisah per layanan dan environment, dengan rencana rotasi. `.env` tidak masuk Git; `.env.example` hanya nama variable dan contoh tanpa secret. Konfigurasi yang dikompilasi ke Angular tidak memuat URL berkredensial, password database, atau kunci privat.

## Verifikasi dan operasi

Masukkan skenario keamanan relevan ke registry test sesuai [aturan testing](testing.md): otorisasi negatif, validasi input, lifecycle sesi, CSRF, akses role database, limit, dan batas worker/upload bila fitur memakainya. Playwright membuktikan alur browser; integration membuktikan backend serta privilege PostgreSQL; k6 membuktikan perilaku pada batas beban yang disepakati.

CI memeriksa secret yang tidak sengaja disimpan, dependency berisiko, dan kontrol kode yang relevan. Gunakan scanner yang versinya dipin dan laporkan temuan serta cakupannya; tidak ditemukannya masalah oleh scanner bukan bukti seluruh aplikasi aman. Temuan yang memengaruhi kandidat release diselesaikan atau dicatat dengan keputusan risiko yang jelas, tanpa memalsukan status test.

Log keamanan mencatat kegagalan login, penolakan akses, perubahan hak, dan aksi sensitif menggunakan identitas serta correlation ID yang sesuai. Jangan merekam body/password/cookie/token mentah. Tentukan alert untuk lonjakan kegagalan atau penyalahgunaan, retensi data, backup yang dapat dipulihkan, dan langkah pencabutan secret/sesi ketika insiden terjadi.

Laporan release mencatat kontrol yang diuji, temuan yang belum selesai, batas pengujian, dan hasil pemulihan jika masuk cakupan. Jangan menyatakan tahan serangan hanya karena unit test atau build lulus.

## Referensi

- [OWASP ASVS](https://owasp.org/projects/asvs).
- [Otorisasi OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).
- [Sesi OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
- [Perlindungan CSRF OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
- [Penyimpanan password OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
- [SQL injection OWASP](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html).
- [Keamanan REST OWASP](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html).
- [Upload file OWASP](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).
- [Keamanan Angular](https://angular.dev/best-practices/security).
```

### A11. docs/rules/testing.md

Source: `docs/rules/testing.md`. SHA-256: `351ba6bb1f8b83b989f5f4b45277c393629a1713ba4fa8e1f8e55d646f2e1a77`.

````markdown
# Aturan testing dan kesiapan production release

Setiap pekerjaan menilai dampak perubahan, menentukan skenario yang perlu dibuktikan, menjalankan pemeriksaan yang relevan, dan melaporkan bukti serta keterbatasannya. Aturan ini berlaku untuk agent utama dan subagent bersama [workflow development](development-workflow.md).

Tidak setiap perubahan memerlukan semua jenis test. Perubahan dokumentasi atau perubahan kecil tanpa dampak perilaku cukup diverifikasi sesuai dampaknya, dengan alasan yang jelas. Jangan membuat test yang hanya menyalin implementasi atau menguji detail internal tanpa manfaat.

## Jenis test dan runner

| Jenis | Runner | Bukti yang dicari |
| --- | --- | --- |
| Unit frontend | Vitest melalui Angular CLI. | Perilaku komponen, validasi, state, dan service secara terisolasi. |
| Integration frontend | Vitest melalui Angular CLI. | Interaksi komponen, service, routing, dan komposisi UI. |
| Unit backend, worker, dan kode server bersama | `bun:test`. | Aturan bisnis dan fungsi tanpa database atau layanan eksternal nyata. |
| Integration backend, worker, dan database | `bun:test` dengan PostgreSQL 18 sebagai baseline. | Route, service, query, constraint, transaksi, migration, dan pemrosesan job bekerja bersama. |
| E2E | Playwright Test. | Alur pengguna melalui frontend, backend, database, dan worker yang relevan. |
| Performance dan ketahanan | k6. | Hasil bisnis, latency, kapasitas, kestabilan, serta pemulihan pada pola beban yang ditentukan. |

Seluruh dependency dan script tetap dikelola melalui `package.json` root. Angular memakai integrasi test Angular CLI sesuai versi project. Backend dan worker memakai runner native Bun. Playwright dan k6 menggunakan runner masing-masing; jangan mengimpor modul khusus runtime Bun ke script yang dijalankan runner lain.

## Struktur test

```text
foundation/
├── package.json
├── playwright.config.ts
├── apps/
│   ├── frontend/src/app/features/<fitur>/
│   │   ├── <komponen>.spec.ts
│   │   └── <komponen>.integration.spec.ts
│   ├── backend/src/features/<fitur>/
│   │   └── <service>.test.ts
│   └── worker/<worker>/src/
│       └── <handler>.test.ts
├── tests/
│   ├── scenarios/
│   │   └── <fitur>.json
│   ├── fixtures/
│   ├── integration/
│   │   ├── backend/
│   │   ├── worker/
│   │   └── database/
│   ├── e2e/
│   │   ├── fixtures.ts
│   │   └── <fitur>/
│   │       └── <alur>.e2e.spec.ts
│   └── performance/
│       ├── journeys/
│       ├── profiles/
│       │   ├── smoke.ts
│       │   ├── load.ts
│       │   ├── stress.ts
│       │   ├── spike.ts
│       │   └── soak.ts
│       ├── browser/
│       └── helpers/
└── docs/testing/
    └── release-report-template.md
```

Struktur menunjukkan lokasi ketika file diperlukan, bukan kewajiban membuat seluruh file contoh. Unit test library bersama berada dekat kode library tersebut dan menggunakan runner yang sesuai.

Unit test berada dekat kode yang diuji. Integration komponen Angular juga berada dekat fitur. Integration server serta E2E dan performance lintas aplikasi berada di `tests/` root.

Setiap runner mempunyai cakupan file eksplisit. Jangan menjalankan `bun test` tanpa filter dari root sehingga file Angular dan Playwright ikut ditemukan. Konfigurasi Playwright hanya menemukan suite E2E; konfigurasi Angular hanya menemukan suite frontend.

`tests/fixtures/` berisi data atau factory yang tidak bergantung pada runner. Setup khusus Bun, Angular, Playwright, atau k6 tetap berada di area masing-masing.

## Pemetaan skenario

Specs fitur menjadi sumber kriteria penerimaan dan target performance. Beri setiap skenario ID stabil, seperti `AUTH-001`, dan hubungkan ke kriteria yang dibuktikan.

Registry `tests/scenarios/<fitur>.json` memetakan ID skenario ke rujukan specs, kriteria penerimaan, file dan nama atau tag test, runner, serta profil yang wajib dijalankan. Registry tidak menyalin seluruh requirements dan tidak menyimpan hasil lulus secara manual.

Untuk tooling repository yang kriterianya ditetapkan langsung dalam rules, registry boleh merujuk kriteria pada rule tersebut sebagai sumber. Tooling doctor/serve memakai `tests/integration/tooling/` dan root script `test:tooling`; test cleanup menggunakan proses fixture pada port sementara, bukan menghentikan layanan aplikasi nyata.

Untuk setiap skenario, tentukan prasyarat, data awal, tindakan, hasil yang diharapkan, pemeriksaan, dan kondisi lulus. Performance juga menentukan model beban, durasi, campuran aktivitas, environment, serta thresholds.

Pilih jenis test yang mampu membuktikan skenario; tidak semua skenario harus dijalankan oleh semua runner. Cakup alur utama, kegagalan penting, otorisasi, concurrency, retry, dan perubahan data yang relevan dengan fitur.

Validasi registry dalam CI: ID unik, rujukan specs dan test valid, serta seluruh skenario wajib mempunyai implementasi test. Rujukan file saja belum membuktikan bahwa test tersebut dijalankan atau mempunyai assertion yang sesuai.

Laporan menghubungkan hasil runner dengan ID skenario dan membedakan:

- `passed`: pemeriksaan wajib dijalankan dan memenuhi kriteria.
- `failed`: pemeriksaan berjalan tetapi hasil tidak memenuhi kriteria.
- `skipped`: test tersedia tetapi tidak dijalankan, dengan alasan.
- `not_run`: belum ada eksekusi atau bukti yang sesuai.
- `missing_test`: skenario belum mempunyai implementasi test.
- `not_applicable`: tidak berlaku untuk perubahan atau release ini, dengan alasan dan rujukan cakupan.

Coverage skenario berbeda dari coverage kode. Persentase coverage kode tidak menggantikan bukti kriteria penerimaan. Test yang dilewati atau belum dijalankan tidak boleh dilaporkan sebagai lulus.

## Unit dan integration

Unit test memeriksa perilaku, bukan sekadar pemanggilan fungsi mock. Mock digunakan pada batas dependensi agar logika dapat diuji secara terisolasi.

Integration memakai implementasi nyata untuk bagian yang sedang dibuktikan. Test query atau transaksi menggunakan PostgreSQL nyata, bukan database pengganti atau mock SQL. Gunakan PostgreSQL 18 sebagai baseline dan ikuti [aturan database](database.md).

Siapkan database test melalui runner migration di `database/`, terpisah dari startup aplikasi. Data test disiapkan secara eksplisit dan diisolasi antar test atau proses paralel. Jangan memakai database atau kredensial production untuk eksekusi test rutin.

Gunakan unit test untuk aturan bisnis, integration untuk constraint dan transaksi, serta pemeriksaan migration untuk perubahan skema yang relevan. Pengujian migration berasal dari `tests/integration/database/` dan menjalankan runner atau file di `database/`.

## E2E dengan Playwright

Uji perilaku pengguna menggunakan frontend dan backend nyata, dengan database dan worker nyata ketika termasuk dalam alur yang dibuktikan. Mock hanya batas yang dinyatakan, seperti layanan eksternal yang tidak dikendalikan project; catat batas tersebut dalam bukti.

Gunakan locator berdasarkan role, label, teks, atau test ID yang disepakati. Hindari ketergantungan pada DOM internal `@ojiepermana/angular` dan jeda waktu tetap. Gunakan assertion yang menunggu kondisi serta timeout yang terbatas.

Test frontend membuktikan integrasi dan penggunaan komponen library dalam fitur, bukan mengulang pengujian seluruh implementasi internal library. Cakup state UI, keyboard, dan ukuran layar yang relevan sesuai [aturan UI/UX](ui-ux.md).

Playwright dapat menyalakan frontend dan backend melalui `webServer`. Infrastruktur database, migration, data awal, dan kesiapan worker ditangani orchestration test. Setup yang membutuhkan Bun dijalankan sebagai proses Bun terpisah; fixture Playwright dapat memakai API yang sesuai.

## Performance dengan k6

Alur bisnis berada di `journeys/`, pola beban berada di `profiles/`, dan helper k6 berada di `helpers/`. Gunakan alur yang sama untuk beberapa profil bila memungkinkan.

| Profil | Tujuan |
| --- | --- |
| Smoke | Memvalidasi script dan perilaku dasar pada beban ringan. |
| Load | Memenuhi target pada beban normal yang ditentukan. |
| Stress | Memeriksa perilaku di atas beban normal. |
| Spike | Memeriksa lonjakan mendadak dan pemulihan. |
| Soak | Memeriksa kestabilan dalam durasi panjang. |
| Breakpoint, jika diperlukan | Mencari batas kapasitas. |

Mulai dengan smoke sebelum pengujian beban lebih tinggi. Tentukan profil wajib berdasarkan dampak dan risiko perubahan. Stress, spike, soak, dan breakpoint tidak wajib dijalankan untuk setiap pekerjaan kecil.

Definisikan target pengguna virtual atau laju kedatangan, durasi, data, dan campuran aktivitas. Bedakan laju iterasi dari request per detik jika satu alur melakukan beberapa request. Catat beban aktual dan iterasi yang tidak berhasil dimulai agar target yang tidak tercapai tidak dianggap terbukti.

Tetapkan checks untuk respons dan hasil bisnis, serta thresholds per skenario untuk menentukan kelulusan CI. Check yang gagal sendiri tidak cukup untuk membuat run gagal. Penolakan yang diharapkan, seperti akses tanpa izin, dinilai sesuai skenarionya dan dibedakan dari kegagalan tak terduga.

Target latency, throughput, tingkat kegagalan, dan waktu penyelesaian job ditentukan dalam specs. Jangan mengarang target universal atau melonggarkan threshold hanya agar test lulus. Angka contoh dalam percakapan bukan target project yang telah disepakati.

Untuk pekerjaan asynchronous, buktikan status akhir, waktu penyelesaian, dan efek bisnisnya. Respons bahwa job diterima saja belum membuktikan keberhasilan worker. Periksa efek duplikat ketika retry relevan. Gunakan status job, metrik khusus, atau pemeriksaan hasil melalui proses Bun yang terpisah sesuai skenario.

Amati resource aplikasi, pool dan query database, serta backlog worker bersama hasil k6 untuk menjelaskan bottleneck. k6 browser digunakan ketika perlu mengukur pengalaman browser saat sistem menerima beban; Playwright tetap menguji alur pengguna.

k6 berjalan melalui binary atau container k6. Root script mengorkestrasinya, bukan menjalankannya melalui `bun:test`. Eksekusi beban dilakukan pada environment test yang ditetapkan dengan data terkontrol.

## Workflow pemeriksaan dan CI

Sinkronisasi kontrak mengikuti [aturan OpenAPI/SDK](openapi-sdk.md). Setiap perubahan backend wajib ekspor OpenAPI, validasi, dan generate SDK, meskipun perubahan internal menghasilkan file yang sama. Jalankan build Angular sesudah regenerasi dan uji pemakaian SDK yang terdampak terhadap backend nyata sesuai skenario.

Pengujian kontrak membuktikan bahwa path, parameter, body, status, response, dan autentikasi SDK sesuai perilaku backend untuk operasi yang digunakan. Tambahkan skenario serialisasi array/query, nullable, enum, tanggal, atau upload ketika kontrak menggunakannya. Generated types dan build yang berhasil tidak menggantikan bukti perilaku runtime.

CI menjalankan `api:check` sebelum pemeriksaan frontend yang bergantung pada SDK. Pemeriksaan memvalidasi OpenAPI, meregenerasi SDK, membuktikan hasil yang dapat diulang, dan mendeteksi perbedaan terhadap artefak kandidat, termasuk file baru atau dihapus. OpenAPI atau SDK yang tertinggal membuat pemeriksaan gagal. Suite independen dapat berjalan paralel setelah artefak yang diperlukan tersedia.

Validasi kontrak OpenAPI menggunakan script Bun sesuai [aturan OpenAPI/SDK](openapi-sdk.md), tanpa dependency validator tambahan. Saat checker diimplementasikan, buktikan fixture valid diterima dan pelanggaran aturan wajib ditolak. Hasil checker hanya membuktikan cakupan pemeriksaan project; kelulusan seluruh standar OpenAPI tidak boleh diasumsikan. Build Angular dan pengujian integrasi SDK terhadap backend nyata tetap wajib sesuai dampak perubahan.

Nama script root yang digunakan saat suite diimplementasikan:

| Script | Cakupan |
| --- | --- |
| `test:tooling` | Integration tooling doctor, cleanup port, seleksi worker, dan supervisor proses melalui Bun. |
| `api:sync` | Ekspor backend ke `openapi.json`, validasi, lalu generate SDK Angular secara berurutan. |
| `api:check` | Validasi, reproduksibilitas, dan kesesuaian OpenAPI/SDK dengan sumber kandidat. |
| `test:frontend` | Unit dan integration komponen Angular. |
| `test:unit:server` | Unit backend, worker, dan library server. |
| `test:integration` | Integration server dan database melalui Bun. |
| `test:e2e` | E2E melalui Playwright. |
| `test:e2e:ui` | Playwright dalam mode UI untuk debugging. |
| `test:performance:smoke` | Smoke k6. |
| `test:performance:load` | Load k6. |
| `test:performance:stress` | Stress k6. |
| `test:performance:spike` | Spike k6. |
| `test:performance:soak` | Soak k6. |
| `test:ci` | Orchestration pemeriksaan yang diwajibkan pipeline. |

Setiap pekerjaan menjalankan pemeriksaan yang relevan dengan dampaknya. CI perubahan kode menjalankan build atau pemeriksaan tipe yang diperlukan, validasi registry, test area yang berubah, regression terkait, serta E2E alur kritis yang terdampak. Jalankan smoke k6 bila perubahan menyentuh perilaku atau performance yang diukur.

Suite independen dapat berjalan paralel dengan data terisolasi. Jalankan pengujian performance pada environment yang tidak terganggu suite lain agar hasil dapat dibandingkan. Pengujian berdurasi panjang menjadi pipeline tersendiri yang dijalankan sesuai rencana verifikasi, bukan otomatis dipicu untuk setiap edit.

Ketika skenario gagal, cari dan perbaiki penyebabnya sebelum menjalankan ulang pemeriksaan yang terdampak. Catat kegagalan awal dan retry; hasil yang lulus setelah retry tidak boleh menyembunyikan test yang tidak stabil.

## Bukti sebelum production release

Ikuti [aturan keamanan](security.md). Perubahan terkait data persisten membuktikan schema dan privilege sesuai specs, termasuk penolakan query oleh role yang tidak diberi akses. Perubahan autentikasi/otorisasi mencakup skenario negatif lintas pengguna atau role, lifecycle sesi, dan CSRF sesuai model. Input berbahaya, rate limit, upload, serta batas worker diuji ketika masuk cakupan. Catat kontrol yang diuji dan temuan yang belum terselesaikan pada laporan release.

Sebelum production release, jalankan seluruh skenario wajib untuk kandidat release, termasuk regression alur kritis, perubahan migration, dan profil performance yang ditetapkan. Gunakan build dan konfigurasi yang mewakili deployment production. Perbedaan environment harus dicatat, bukan dianggap setara tanpa bukti.

Gunakan [template laporan release](../testing/release-report-template.md) untuk menghasilkan `docs/testing/releases/<identitas-release>.md`. Laporan menghubungkan bukti runner dan artefak CI, tanpa menyimpan token, password, atau data sensitif.

Catat commit atau identitas build, waktu dan run CI, versi runtime serta database, jumlah container, batas resource, pool database, volume data, model beban, target dan hasil aktual, cakupan browser, serta batas mock yang digunakan jika relevan. Sertakan checksum atau identitas OpenAPI, versi generator, bukti regenerasi SDK dari kontrak kandidat, hasil `api:check`, build Angular, dan test kontrak yang relevan.

Seluruh skenario wajib harus memiliki bukti yang valid untuk kandidat release. Perubahan setelah pengujian memerlukan verifikasi ulang area yang terdampak; agent utama menentukan dan mencatat cakupan pengujian ulang berdasarkan dampaknya.

Status kesiapan adalah `ready` ketika bukti wajib lengkap dan memenuhi kriteria, `blocked` ketika skenario wajib gagal atau hasil menunjukkan masalah, dan `incomplete` ketika bukti wajib belum tersedia. Jangan menyatakan siap production dengan skenario wajib yang dilewati, belum dijalankan, atau belum memiliki test.

Jika ada keputusan untuk menerima pengecualian, catat skenario, alasan, dampak, penanggung jawab, dan keputusan pengguna atau pemilik release secara terpisah. Status test tetap mencerminkan hasil sebenarnya. Bukti kesiapan tidak dengan sendirinya memberi izin untuk deploy.

## Tanggung jawab agent

Agent utama menetapkan cakupan verifikasi, ID skenario, batas file test, dan penanggung jawab integrasi sebelum delegasi. Setiap subagent menyertakan test yang relevan untuk bagiannya serta laporan perintah, hasil, skenario yang dibuktikan, dan keterbatasan.

Agent utama menggabungkan hasil, memverifikasi alur lintas aplikasi, dan memastikan laporan tidak menganggap mock development sebagai bukti integrasi nyata. Perubahan registry, konfigurasi runner, fixture bersama, dan orchestration CI memiliki satu penanggung jawab yang ditetapkan.

## Referensi

- [Testing Angular](https://angular.dev/guide/testing).
- [Test runner Bun](https://bun.com/docs/test).
- [Praktik Playwright](https://playwright.dev/docs/best-practices).
- [Web server Playwright](https://playwright.dev/docs/test-webserver).
- [Scenarios k6](https://grafana.com/docs/k6/latest/using-k6/scenarios/).
- [Checks k6](https://grafana.com/docs/k6/latest/using-k6/checks/).
- [Thresholds k6](https://grafana.com/docs/k6/latest/using-k6/thresholds/).
- [Jenis load test k6](https://grafana.com/docs/k6/latest/testing-guides/test-types/).
- [k6 browser](https://grafana.com/docs/k6/latest/using-k6-browser/).
````

### A12. docs/rules/development-commands.md

Source: `docs/rules/development-commands.md`. SHA-256: `7862dfac098dcd2b5889a1daf99e377f350e4d0b874eef8fa5d405ec6e1ee6ae`.

````markdown
# Doctor dan serve development

Perintah dijalankan dari root monorepo melalui satu `package.json`. Script menggunakan Bun; Angular CLI lokal berjalan melalui Node.js yang kompatibel. Tooling cleanup port saat ini mendukung macOS/Linux dan memerlukan `lsof`.

```sh
bun run doctor
bun run serve
```

`doctor` memeriksa prasyarat tanpa menyalakan aplikasi, mengubah database, menjalankan migration/seed, atau menghentikan listener. `serve` otomatis menjalankan pemeriksaan yang sama sebelum startup. Aplikasi hanya dijalankan ketika tidak ada error pemeriksaan.

## Layanan dan konfigurasi

Siapkan PostgreSQL atau layanan pendukung lain melalui [Compose root untuk infrastruktur](infrastructure.md) atau layanan eksternal yang memenuhi aturan. Compose tidak memuat runtime frontend/backend/worker. Doctor dan serve tidak otomatis mengelola container, tidak memakai credential administrator Compose, dan tidak membersihkan port PostgreSQL. Provisioning role/schema serta migration tetap merupakan langkah terpisah.

| Layanan | Host development | Port |
| --- | --- | --- |
| Frontend Angular | `127.0.0.1` | `8889` |
| Backend Bun/Elysia | `127.0.0.1` | `8888` |
| Worker yang dipilih | `127.0.0.1` jika mempunyai HTTP | Dideklarasikan ketika diperlukan; worker tanpa HTTP tidak memerlukan port. |

`config/development.json` adalah konfigurasi bersama untuk kedua perintah. Backend menerima `HOST=127.0.0.1` dan `PORT=8888`; `index.ts` wajib menggunakan nilai tersebut. Angular CLI mendapat host/port melalui argumen. Jangan menyebarkan angka port lain ke script yang berbeda.

Frontend memakai `apps/frontend/proxy.conf.json` untuk meneruskan API ke backend, agar SDK dapat memakai URL relatif pada development. Saat aplikasi dibuat, sepakati prefix API `/api` dan konfigurasi proxy yang sesuai, misalnya `/api/**` menuju `http://127.0.0.1:8888`. Konfigurasi ini tidak memindahkan backend ke port frontend.

Dependency Angular/Elysia tetap dipasang melalui package root. Tooling ini tidak mengunduh dependency otomatis dan tidak membuat aplikasi contoh untuk menutupi prasyarat yang belum ada.

## Worker opsional

Worker tidak otomatis dijalankan karena foldernya ada. Daftarkan worker yang diperlukan pada `workers` di konfigurasi, kemudian pilih secara eksplisit:

```sh
bun run doctor --worker notification
bun run serve --worker notification --worker report
```

Contoh satu entri registry ketika worker nyata tersedia:

```json
{
  "notification": {
    "entry": "apps/worker/notification/src/index.ts",
    "databaseUrlEnv": "NOTIFICATION_DATABASE_URL",
    "schemas": ["users"]
  }
}
```

Gunakan daftar schema sesuai query worker yang benar-benar diperlukan. Jika worker tidak mengakses database, hilangkan `databaseUrlEnv` dan `schemas`; credential backend tidak diteruskan sebagai `DATABASE_URL` worker. Jika worker membutuhkan HTTP, deklarasikan `port` yang unik. URL database worker berasal dari variable berbeda dengan role minimum layanan tersebut; jangan menyalin credential migrator atau backend secara otomatis.

Variable aplikasi worker lain, seperti API key penyedia email, didaftarkan sebagai nama variable pada array `env` entri worker. Nilai berasal dari environment lokal dan tidak disimpan pada JSON. Worker hanya menerima environment dasar proses serta variable yang dinyatakan untuknya; frontend tidak menerima secret backend/worker.

## Pemeriksaan doctor

- Runtime Bun, platform, `lsof`, dan Node.js/Angular CLI lokal tersedia.
- Workspace Angular, entry backend, entry worker yang dipilih, serta konfigurasi proxy tersedia.
- Dokumen OpenAPI, konfigurasi SDK, dan barrel SDK frontend tersedia. Kesesuaian isi serta reproduksibilitas tetap dibuktikan oleh `api:check` saat tooling OpenAPI diimplementasikan.
- `DATABASE_URL` backend dan URL database worker yang memerlukannya tersedia tanpa dicetak.
- PostgreSQL minimal 18, schema yang dibutuhkan tersedia, dan role runtime mempunyai `USAGE` tanpa `CREATE` pada schema aplikasi; role bukan superuser serta tidak dapat membuat database/role.
- Metadata `common.schema_migrations` dengan kolom `name` dan checksum SHA-256 sesuai file `database/migrations/*.sql`. Metadata migration milik runner; role backend hanya memerlukan akses baca untuk preflight.
- Listener port frontend/backend serta worker terpilih dapat diperiksa. Port terpakai adalah warning karena dibersihkan oleh `serve`.

Doctor mengembalikan exit code `0` jika pemeriksaan wajib lulus dan `1` bila ada error. Koneksi/query mempunyai batas waktu. Temuan ditampilkan tanpa DSN, password, atau error database mentah.

Pemeriksaan ini merupakan preflight development. Pemeriksaan privilege tabel, kebijakan keamanan, build, test, dan readiness aplikasi setelah startup tetap mempunyai pembuktian sendiri; doctor tidak menggantikan seluruh pemeriksaan release.

## Startup, cleanup port, dan shutdown

Urutan `serve`:

1. Muat konfigurasi dan pilihan worker, kemudian jalankan doctor. Jika prasyarat gagal, berhenti sebelum menghentikan proses yang sedang berjalan.
2. Bersihkan seluruh listener TCP pada port `8888`, `8889`, dan port HTTP worker yang dipilih.
3. Kirim `SIGTERM` kepada PID listener milik user lokal, tunggu terbatas, kemudian `SIGKILL` jika proses yang sama masih menahan port.
4. Pastikan port bebas. Jika listener dimiliki user lain, tidak dapat dihentikan, atau digantikan proses baru saat cleanup, hentikan startup dengan pesan error.
5. Jalankan backend dan frontend dalam mode development/watch, lalu worker yang dipilih. Tampilkan URL layanan dan log proses.
6. Saat Ctrl+C/termination, hentikan seluruh grup proses yang dibuat invocation ini, termasuk turunan watcher/build. Jika satu layanan keluar atau gagal dimulai, hentikan layanan lain dan kembalikan exit code gagal.

Cleanup mencakup listener pada port yang dikonfigurasi, termasuk proses lama dari invocation lain. Tidak memakai `pkill bun/node`, tidak membersihkan seluruh port komputer, dan tidak menghentikan PostgreSQL/layanan lain yang portnya tidak tercantum.

`serve` khusus development dan menolak `NODE_ENV=production`. Production menggunakan image/container serta langkah migration/deployment tersendiri sesuai rules, tanpa cleanup port development.

## Kriteria verifikasi tooling

- `TOOL-001`: doctor melaporkan prasyarat yang hilang dan mengembalikan status gagal, tanpa mutasi atau cleanup port.
- `TOOL-002`: cleanup membebaskan port target dan mempertahankan listener pada port lain; listener yang mengabaikan `SIGTERM` dihentikan secara terbatas.
- `TOOL-003`: worker hanya berjalan ketika terdaftar dan dipilih; URL database backend tidak diwariskan otomatis ke worker tanpa konfigurasi database.
- `TOOL-004`: kegagalan satu layanan menghentikan grup layanan lain beserta turunannya dan mengembalikan status gagal.

Tooling diuji melalui `bun run test:tooling` dengan fixture proses lokal pada port sementara. Jangan memakai port aplikasi nyata untuk test penghentian proses. Ketika aplikasi belum tersedia, doctor/serve harus melaporkan kondisi tersebut, bukan mengklaim semua aplikasi sudah berjalan.
````

### A13. docs/testing/release-report-template.md

Source: `docs/testing/release-report-template.md`. SHA-256: `bff6dc1fcd55338330ec21a0fb92ea37fd657d9b580b238543fa7bb080503ae6`.

```markdown
# Template laporan kesiapan release

Salin ke `docs/testing/releases/<identitas-release>.md` untuk kandidat release yang diperiksa. Isi berdasarkan hasil eksekusi, mengikuti [aturan testing](../rules/testing.md). Jangan mengisi hasil lulus tanpa bukti. Template ini bukan laporan pengujian yang sudah dilakukan.

## Identitas kandidat

- Release:
- Commit atau identitas build:
- Run CI dan waktu pemeriksaan:
- Penanggung jawab:
- Cakupan perubahan dan rujukan specs:
- Status kesiapan (`ready`, `blocked`, atau `incomplete`):

## Environment dan data

| Aspek | Konfigurasi aktual dan perbedaan dari production |
| --- | --- |
| Runtime dan versi dependency penting | |
| PostgreSQL dan migration yang diterapkan | |
| Build serta konfigurasi aplikasi | |
| Jumlah container dan batas CPU/memory | |
| Pool database dan konfigurasi worker | |
| Volume serta kondisi data awal | |
| Browser dan ukuran layar | |
| Mock atau layanan eksternal yang diganti | |

## Kontrak OpenAPI dan SDK

- Identitas atau checksum `openapi.json` untuk kandidat ini:
- Versi plugin OpenAPI Elysia dan generator `@ojiepermana/angular`:
- Run dan hasil ekspor, validasi, serta regenerasi SDK:
- Hasil `api:check`, termasuk reproduksibilitas dan pemeriksaan artefak baru/dihapus:
- Hasil build Angular dengan SDK kandidat:
- ID skenario test kontrak SDK/backend dan tautan bukti:
- Perubahan kontrak atau keterbatasan generator yang belum terselesaikan:

SDK wajib berasal dari OpenAPI kandidat yang sama. Jelaskan hasil identik setelah regenerasi bila kontrak tidak berubah; hasil identik bukan bukti bahwa regenerasi telah dijalankan.

## Keamanan dan schema database

- Schema per domain dan role runtime/migration kandidat:
- Bukti penolakan akses pengguna/role yang tidak berhak:
- Bukti validasi input, sesi/CSRF, limit, serta batas worker/upload yang relevan:
- Hasil pemeriksaan secret/dependency dan temuan yang belum diselesaikan:
- Batas pengujian keamanan dan keputusan risiko yang dinyatakan:
- Bukti backup/restore atau respons insiden bila termasuk cakupan:

## Hasil per skenario

| ID | Kriteria dan rujukan specs | Test dan profil | Wajib untuk release | Status | Hasil aktual dan tautan bukti |
| --- | --- | --- | --- | --- | --- |

Status skenario menggunakan `passed`, `failed`, `skipped`, `not_run`, `missing_test`, atau `not_applicable`. Jelaskan alasan untuk skenario yang tidak dijalankan atau tidak berlaku.

## Hasil performance

| Skenario dan profil | Model beban, durasi, dan beban aktual | Target dari specs | Hasil aktual | Status dan bukti |
| --- | --- | --- | --- | --- |

Catat latency, throughput, tingkat kegagalan, iterasi yang tidak berhasil dimulai, waktu penyelesaian job, dan resource yang relevan. Jika performance tidak termasuk cakupan release, jelaskan alasannya.

## Masalah dan batas bukti

- Skenario wajib yang gagal atau belum mempunyai bukti:
- Test tidak stabil dan riwayat retry:
- Perbedaan environment yang membatasi kesimpulan:
- Perubahan kandidat setelah pengujian dan pemeriksaan ulangnya:
- Tindak lanjut dan penanggung jawab:

## Penilaian kesiapan

Jelaskan status kesiapan dengan merujuk bukti di atas. Kesiapan belum lengkap jika ada skenario wajib tanpa bukti valid. Kegagalan wajib menghalangi status `ready`.

Jika ada pengecualian yang diputuskan, catat ID skenario, alasan, dampak, penanggung jawab, dan keputusan pengguna atau pemilik release. Jangan mengubah status test menjadi lulus untuk menyamarkan pengecualian.
```

### A14. docs/rules/infrastructure.md

Source: `docs/rules/infrastructure.md`. SHA-256: `c207bffb6318a1b1317b1e0af00f67d4d452358e931528ab85ab51fcd9f32aa8`.

````markdown
# Infrastruktur pendukung development

`docker-compose.yml` berada di root monorepo dan hanya mengelola layanan pendukung di luar runtime aplikasi. Saat ini layanan yang didefinisikan adalah PostgreSQL 18. Frontend Angular, backend Bun/Elysia, dan worker tidak dimasukkan sebagai service Compose; jalankan melalui `bun run serve` sesuai [aturan development](development-commands.md).

Cache, broker antrean, object storage, atau layanan pendukung lain dapat ditambahkan jika kebutuhan fitur telah diputuskan dalam specs. Jangan menambahkan layanan contoh tanpa kebutuhan atau menjadikan Compose root tempat build SDK, test runner, migration, seed, maupun orchestration aplikasi. Dockerfile aplikasi/worker tetap dapat digunakan untuk deployment mandiri; file deployment runtime diatur terpisah ketika diperlukan.

## Konfigurasi dan pengoperasian

Docker Engine dan Docker Compose v2 diperlukan untuk menjalankan infrastruktur lokal. Compose tidak menambah dependency pada `package.json`.

1. Salin `.env.infrastructure.example` ke `.env.infrastructure` dan isi `FOUNDATION_POSTGRES_PASSWORD` dengan password lokal yang kuat. File asli diabaikan Git; contoh tidak berisi secret.
2. Jalankan perintah dari root:

```sh
docker compose --env-file .env.infrastructure config --quiet
docker compose --env-file .env.infrastructure up -d --wait postgres
docker compose --env-file .env.infrastructure ps
```

Gunakan Compose v2 yang mendukung `up --wait`. Gunakan `config --quiet` untuk validasi tanpa mencetak konfigurasi yang telah memuat secret.

PostgreSQL tersedia pada `127.0.0.1:5432`; `FOUNDATION_POSTGRES_PORT` dapat mengubah port host jika ada layanan lokal lain. Port infrastruktur bukan target cleanup `serve`. Data disimpan pada named volume `postgres_data`; PostgreSQL 18 menggunakan mount `/var/lib/postgresql` sesuai image resmi. Healthcheck membuktikan server menerima koneksi, bukan schema, grants, migration, atau kesiapan aplikasi.

Port infrastruktur tidak boleh tumpang tindih dengan frontend `8889`, backend `8888`, atau port HTTP worker. Jangan mendaftarkan port PostgreSQL sebagai port layanan runtime pada `config/development.json`; seleksi dan cleanup worker hanya memakai port worker itu sendiri.

Image memakai major `postgres:18` untuk baseline development. Untuk environment pembuktian release/CI yang membutuhkan hasil dapat diulang, pin tag patch atau digest dan catat identitas image. Jangan mengganti major PostgreSQL pada volume lama tanpa prosedur upgrade. Batas development saat ini adalah 1 GiB memory, 2 CPU, dan 128 MiB shared memory; sesuaikan dengan kebutuhan yang terukur dan jangan menganggapnya bukti kapasitas production.

Hentikan layanan dengan:

```sh
docker compose --env-file .env.infrastructure down
```

Perintah tersebut mempertahankan named volume. Penghapusan volume merupakan reset data yang terpisah dan tidak dijalankan otomatis oleh agent, doctor, atau serve.

## Provisioning database dan batas credential

`foundation_admin` dibuat oleh image resmi sebagai administrator untuk provisioning awal. Jangan gunakan credential tersebut sebagai `DATABASE_URL` backend atau worker. Simpan credential Compose pada `.env.infrastructure`, yang diberikan eksplisit melalui `--env-file`, agar tidak dimuat otomatis sebagai `.env` runtime Bun. Jangan mengekspor credential administrator ke environment aplikasi.

Compose hanya membuat database dasar `foundation`. Provisioning role migration/runtime, schema `common`, `users`, `auth`, grants, migration, dan seed mengikuti [aturan database](database.md) melalui langkah/runner terpisah. Jangan mount migration/seed ke `/docker-entrypoint-initdb.d` sebagai pengganti runner versioned. Setelah provisioning selesai, `.env` aplikasi berisi DSN role backend dengan host/port yang sesuai; setiap worker memakai credential sendiri.

`bun run doctor` dan `bun run serve` tidak otomatis menjalankan atau menghentikan Compose. Siapkan infrastruktur serta database terlebih dahulu, lalu jalankan doctor/serve. Docker tidak menjadi prasyarat runtime jika memakai PostgreSQL eksternal yang memenuhi aturan project.

## Tanggung jawab agent dan verifikasi

Agent utama dan subagent yang mengubah infrastruktur wajib membaca aturan ini serta aturan database/keamanan yang relevan. Tetapkan satu pemilik Compose, port, volume, dan konfigurasi bersama. Perubahan layanan pendukung harus menyebut kebutuhan specs dan dampaknya pada credential, resource, kesiapan, serta persistensi data.

Periksa konfigurasi melalui Compose tanpa mencetak secret. Ketika Docker tersedia, buktikan startup/healthcheck, koneksi dengan role yang sesuai, dan persistensi setelah restart tanpa menghapus volume. Laporkan pemeriksaan yang belum dapat dijalankan; YAML yang dapat diparse saja bukan bukti container bekerja.

## Referensi

- [Image PostgreSQL resmi: environment, administrator, dan lokasi volume versi 18](https://github.com/docker-library/docs/blob/master/postgres/README.md).
- [Konfigurasi service Docker Compose](https://docs.docker.com/reference/compose-file/services/).
````

## Lampiran B. Konfigurasi, kode, registry, dan test aktual

Salinan berikut adalah sumber aktual untuk review, bukan file tambahan yang perlu dijalankan. Isi Markdown ditempatkan dalam blok agar heading/link/instruksi sumber tidak tercampur dengan narasi review.

### B01. package.json

Source: `package.json`. SHA-256: `bc598bb9f9569e4adc0e4e2d07217e42408e05460abb30c10d48d75c330511a9`.

```json
{
  "name": "foundation",
  "private": true,
  "type": "module",
  "scripts": {
    "doctor": "bun scripts/doctor.ts",
    "serve": "bun scripts/serve.ts",
    "test:tooling": "bun test ./tests/integration/tooling"
  }
}
```

### B02. config/development.json

Source: `config/development.json`. SHA-256: `df53c1e0c21a061fc0100f49d122eb2e3bb74f171c0d0367812f13ff4c3e3ebe`.

```json
{
  "host": "127.0.0.1",
  "frontend": {
    "port": 8889,
    "workspace": "apps/frontend",
    "proxyConfig": "proxy.conf.json"
  },
  "backend": {
    "port": 8888,
    "entry": "apps/backend/src/index.ts"
  },
  "database": {
    "schemas": ["common", "users", "auth"],
    "migrationSchema": "common"
  },
  "workers": {}
}
```

### B03. .env.example

Source: `.env.example`. SHA-256: `d0150cd52b9153665b6b5600778da1ded05bfb58c4fd5f15ba54c4645d13d117`.

```text
# Credential role backend development dengan privilege minimum, bukan migrator.
DATABASE_URL=
NODE_ENV=development
# Tambahkan URL role worker sesuai registry ketika worker diperlukan.
```

### B04. .gitignore

Source: `.gitignore`. SHA-256: `3f9f21f0606698176d0f2e01061c23d5e950c4bb4c7c0733e1b0969069fb4135`.

```text
node_modules/
.cache/
.env
.env.*
!.env.example
!.env.infrastructure.example
graphify-out/
```

### B05. scripts/lib/development.ts

Source: `scripts/lib/development.ts`. SHA-256: `5a14dd02accaea7f8fb83bf8f3edaee2d9452f12e680051ec5749a6eb5ae4312`.

```typescript
import { isAbsolute, relative, resolve } from "node:path";

export const projectRoot = resolve(import.meta.dir, "../..");

export interface DevelopmentConfig {
  host: string;
  frontend: { port: number; workspace: string; proxyConfig: string };
  backend: { port: number; entry: string };
  database: { schemas: string[]; migrationSchema: string };
  workers: Record<string, { entry: string; port?: number; databaseUrlEnv?: string; schemas?: string[]; env?: string[] }>;
}

export function insideRoot(root: string, path: string): string {
  const result = resolve(root, path);
  const rel = relative(root, result);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Path development harus berada di dalam root project.");
  }
  return result;
}

export async function loadConfig(root = projectRoot): Promise<DevelopmentConfig> {
  const config = await Bun.file(resolve(root, "config/development.json")).json();
  if (config.host !== "127.0.0.1") throw new Error("Serve development harus memakai host 127.0.0.1.");
  if (config.frontend?.port !== 8889 || config.backend?.port !== 8888) {
    throw new Error("Port frontend harus 8889 dan backend harus 8888.");
  }
  if (!Array.isArray(config.database?.schemas) || !config.database.schemas.length ||
      config.database.schemas.some((schema: unknown) => typeof schema !== "string" || !/^[a-z][a-z0-9_]*$/.test(schema)) ||
      !config.database.schemas.includes(config.database.migrationSchema)) {
    throw new Error("Daftar schema dan migrationSchema development tidak valid.");
  }
  if (!config.workers || typeof config.workers !== "object" || Array.isArray(config.workers)) {
    throw new Error("workers harus berupa registry object.");
  }
  insideRoot(root, config.frontend.workspace);
  insideRoot(resolve(root, config.frontend.workspace), config.frontend.proxyConfig);
  insideRoot(root, config.backend.entry);
  const ports = new Set([8888, 8889]);
  for (const [name, worker] of Object.entries(config.workers) as [string, DevelopmentConfig["workers"][string]][]) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("Nama worker tidak valid.");
    insideRoot(root, worker.entry);
    if (worker.env !== undefined && (!Array.isArray(worker.env) || worker.env.some((key) =>
      !/^[A-Z][A-Z0-9_]*$/.test(key) || ["DATABASE_URL", "NODE_ENV", "HOST", "PORT", "PATH", "HOME", "BUN_OPTIONS", "NODE_OPTIONS"].includes(key)))) {
      throw new Error("Variable environment worker harus eksplisit dan tidak boleh menimpa konfigurasi proses.");
    }
    if (worker.databaseUrlEnv !== undefined &&
        (!/^[A-Z][A-Z0-9_]*$/.test(worker.databaseUrlEnv) || worker.databaseUrlEnv === "DATABASE_URL" ||
         !Array.isArray(worker.schemas) || !worker.schemas.length ||
         worker.schemas.some((schema) => !config.database.schemas.includes(schema)))) {
      throw new Error("Worker database memerlukan env URL terpisah dan daftar schema yang diperlukan.");
    }
    if (worker.port !== undefined) {
      if (!Number.isInteger(worker.port) || worker.port < 1024 || worker.port > 65535 || ports.has(worker.port)) {
        throw new Error("Port worker harus valid dan tidak tumpang tindih.");
      }
      ports.add(worker.port);
    }
  }
  return config;
}

export function selectWorkers(args: string[], config: DevelopmentConfig): string[] {
  const result = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") continue;
    let name: string | undefined;
    if (args[i] === "--worker") name = args[++i];
    else if (args[i].startsWith("--worker=")) name = args[i].slice(9);
    else throw new Error("Argumen tidak dikenal. Gunakan --worker <nama>, dapat diulang.");
    if (!name || !Object.hasOwn(config.workers, name)) {
      throw new Error("Worker belum terdaftar di config/development.json.");
    }
    result.add(name);
  }
  return [...result];
}

export function servicePorts(config: DevelopmentConfig, workers: string[]): number[] {
  return [config.backend.port, config.frontend.port,
    ...workers.flatMap((name) => config.workers[name].port === undefined ? [] : [config.workers[name].port!])];
}

export async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Pemeriksaan melewati batas waktu.")), ms);
    })]);
  } finally {
    clearTimeout(timer!);
  }
}
```

### B06. scripts/lib/ports.ts

Source: `scripts/lib/ports.ts`. SHA-256: `edd32cdd6ae69844fcd121a3ee019cdad46e2c3d16b597e97b024363a59d6a41`.

```typescript
export interface Listener { pid: number; uid: number; command: string }

export async function listeners(port: number): Promise<Listener[]> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port tidak valid.");
  const child = Bun.spawn(["lsof", "-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpcu"], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code === 1 && !stdout && !stderr.trim()) return [];
  if (code !== 0 || stderr.trim()) throw new Error(`Gagal memeriksa listener port ${port}.`);
  const result: Listener[] = [];
  let current: Partial<Listener> | undefined;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      if (current) result.push(current as Listener);
      current = { pid: Number(line.slice(1)) };
    } else if (current && line.startsWith("u")) current.uid = Number(line.slice(1));
    else if (current && line.startsWith("c")) current.command = line.slice(1);
  }
  if (current) result.push(current as Listener);
  if (result.some((item) => !Number.isInteger(item.pid) || item.pid <= 1 || !Number.isInteger(item.uid))) {
    throw new Error(`Identitas listener port ${port} tidak lengkap.`);
  }
  return result;
}

export async function clearPorts(ports: number[], log: (message: string) => void = console.log, graceMs = 3000): Promise<void> {
  const initial = new Map<number, Listener>();
  for (const port of ports) {
    for (const listener of await listeners(port)) initial.set(listener.pid, listener);
  }
  const uid = process.getuid?.();
  if ([...initial.values()].some((item) => item.uid !== uid || item.pid === process.pid || item.pid === process.ppid)) {
    throw new Error("Listener dimiliki user lain atau proses pengendali; port tidak dapat dibersihkan.");
  }
  for (const item of initial.values()) {
    log(`Menghentikan listener ${item.command} (PID ${item.pid}) pada port project.`);
    signal(item.pid, "SIGTERM");
  }
  const deadline = Date.now() + graceMs;
  let remaining = await occupied(ports);
  while (remaining.length && Date.now() < deadline) {
    await Bun.sleep(100);
    remaining = await occupied(ports);
  }
  for (const item of remaining) {
    const captured = initial.get(item.pid);
    if (!captured || captured.uid !== item.uid || captured.command !== item.command) {
      throw new Error("Port ditempati proses baru saat cleanup; startup dihentikan.");
    }
    log(`Listener PID ${item.pid} belum berhenti; mengirim SIGKILL.`);
    signal(item.pid, "SIGKILL");
  }
  const finalDeadline = Date.now() + 1500;
  while ((await occupied(ports)).length) {
    if (Date.now() >= finalDeadline) throw new Error("Port project masih dipakai setelah cleanup.");
    await Bun.sleep(100);
  }
}

async function occupied(ports: number[]): Promise<Listener[]> {
  const found = await Promise.all(ports.map(listeners));
  return [...new Map(found.flat().map((item) => [item.pid, item])).values()];
}

function signal(pid: number, name: NodeJS.Signals): void {
  try { process.kill(pid, name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
```

### B07. scripts/doctor.ts

Source: `scripts/doctor.ts`. SHA-256: `8521ec60451d01bbdb5505adbd963010d5b7c8e60ccfc40964c45e49bad5d5dd`.

```typescript
import { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { insideRoot, loadConfig, projectRoot, selectWorkers, servicePorts, withTimeout, type DevelopmentConfig } from "./lib/development";
import { listeners } from "./lib/ports";

export interface Check { name: string; status: "ok" | "warning" | "error"; message: string }

export async function runDoctor(config: DevelopmentConfig, workers: string[], root = projectRoot): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: Check["status"], message: string) => checks.push({ name, status, message });
  add("Environment", process.env.NODE_ENV === "production" ? "error" : "ok", "Perintah ini khusus development.");
  add("Runtime Bun", "ok", Bun.version);
  add("Platform", ["darwin", "linux"].includes(process.platform) ? "ok" : "error", "Cleanup port mendukung macOS/Linux.");
  add("lsof", Bun.which("lsof") ? "ok" : "error", "Diperlukan untuk memeriksa listener TCP.");
  const node = Bun.which("node");
  add("Node.js", node ? "ok" : "error", "Angular CLI memakai runtime Node.js yang kompatibel.");
  const files = [
    ["Workspace Angular", resolve(root, config.frontend.workspace, "angular.json")],
    ["Entry backend", insideRoot(root, config.backend.entry)],
    ["Angular CLI lokal", resolve(root, "node_modules/@angular/cli/bin/ng.js")],
    ["Konfigurasi SDK", resolve(root, config.frontend.workspace, "sdk.config.json")],
    ["OpenAPI backend", resolve(root, "openapi.json")],
    ["SDK Angular", resolve(root, config.frontend.workspace, "sdk/public-api.ts")],
    ["Proxy development", resolve(root, config.frontend.workspace, config.frontend.proxyConfig)],
    ...workers.map((name) => [`Entry worker ${name}`, insideRoot(root, config.workers[name].entry)]),
  ];
  for (const [name, path] of files) {
    add(name, await Bun.file(path).exists() ? "ok" : "error", relativeLabel(root, path));
  }
  for (const name of workers) {
    for (const key of config.workers[name].env ?? []) {
      add(`Environment worker ${name}`, process.env[key] ? "ok" : "error", `${key} harus disediakan; nilainya tidak dicetak.`);
    }
  }
  const cli = resolve(root, "node_modules/@angular/cli/bin/ng.js");
  if (node && await Bun.file(cli).exists() && await Bun.file(resolve(root, config.frontend.workspace, "angular.json")).exists()) {
    const child = Bun.spawn([node, cli, "version"], {
      cwd: resolve(root, config.frontend.workspace), stdout: "ignore", stderr: "ignore",
      env: { ...process.env, NG_CLI_ANALYTICS: "false" },
    });
    try { add("Kompatibilitas Angular CLI", await withTimeout(child.exited, 10000) === 0 ? "ok" : "error", "Angular CLI lokal harus dapat dijalankan."); }
    catch { child.kill(); await child.exited; add("Kompatibilitas Angular CLI", "error", "Pemeriksaan CLI melewati batas waktu."); }
  }
  if (Bun.which("lsof") && ["darwin", "linux"].includes(process.platform)) {
    for (const port of servicePorts(config, workers)) {
      try {
        const found = await listeners(port);
        add(`Port ${port}`, found.length ? "warning" : "ok", found.length ? "Sedang dipakai; serve akan membersihkannya setelah preflight lulus." : "Tersedia.");
      } catch { add(`Port ${port}`, "error", "Listener tidak dapat diperiksa."); }
    }
  }
  const databases = [
    { label: "Database backend", env: "DATABASE_URL", schemas: config.database.schemas, migrations: true },
    ...workers.filter((name) => config.workers[name].databaseUrlEnv).map((name) => ({
      label: `Database worker ${name}`, env: config.workers[name].databaseUrlEnv!, schemas: config.workers[name].schemas!, migrations: false,
    })),
  ];
  for (const database of databases) {
    const url = process.env[database.env];
    if (!url) { add(database.label, "error", `${database.env} belum disediakan melalui environment lokal.`); continue; }
    let sql: SQL | undefined;
    try {
      const parsed = new URL(url);
      if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("Invalid database adapter");
      sql = new SQL({ url, max: 1, connectionTimeout: 3 });
      const pool = sql;
      const findings = await withTimeout(checkDatabase(pool, config, root, database.schemas, database.migrations), 5000);
      checks.push(...findings.map((finding) => ({ ...finding, name: `${database.label}: ${finding.name}` })));
    } catch {
      add(database.label, "error", "PostgreSQL tidak dapat diverifikasi. Periksa koneksi, role, schema, dan metadata migration; kredensial tidak dicetak.");
    } finally { await sql?.close({ timeout: 0 }); }
  }
  return checks;
}

async function checkDatabase(sql: SQL, config: DevelopmentConfig, root: string, expectedSchemas: string[], migrations: boolean): Promise<Check[]> {
  const result: Check[] = [];
  const [version] = await sql`SELECT pg_catalog.current_setting('server_version_num') AS version`;
  result.push({ name: "PostgreSQL", status: Number(version.version) >= 180000 ? "ok" : "error", message: "Minimum versi 18." });
  const namespaces = await sql`SELECT nspname, pg_catalog.has_schema_privilege(current_user, oid, 'USAGE') AS usable,
    pg_catalog.has_schema_privilege(current_user, oid, 'CREATE') AS creatable FROM pg_catalog.pg_namespace`;
  for (const name of expectedSchemas) {
    const schema = namespaces.find((item: { nspname: string }) => item.nspname === name);
    result.push({ name: `Schema ${name}`, status: schema?.usable ? "ok" : "error", message: "Schema harus tersedia dan role backend mempunyai USAGE." });
    result.push({ name: `Privilege schema ${name}`, status: schema && !schema.creatable ? "ok" : "error", message: "Role runtime tidak boleh mempunyai CREATE pada schema aplikasi." });
  }
  const [role] = await sql`SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = current_user`;
  result.push({ name: "Role database", status: role.rolsuper || role.rolcreatedb || role.rolcreaterole ? "error" : "ok", message: "Role runtime tidak boleh menjadi superuser atau dapat membuat database/role." });
  if (!migrations) return result;
  const applied = await sql`SELECT name, checksum FROM ${sql(config.database.migrationSchema)}.${sql("schema_migrations")}`;
  const path = resolve(root, "database/migrations");
  const files = (await readdir(path)).filter((name) => name.endsWith(".sql")).sort();
  const local = new Set(files);
  let matched = files.length > 0 && !applied.some((item: { name: string }) => !local.has(item.name));
  for (const name of files) {
    const checksum = new Bun.CryptoHasher("sha256").update(await Bun.file(resolve(path, name)).arrayBuffer()).digest("hex");
    if (!applied.some((item: { name: string; checksum: string }) => item.name === name && item.checksum === checksum)) matched = false;
  }
  result.push({ name: "Migration", status: matched ? "ok" : "error", message: "File SQL dan checksum harus sesuai metadata migration; doctor tidak menerapkan perubahan." });
  return result;
}

function relativeLabel(root: string, path: string): string { return path.slice(root.length + 1); }

export function printChecks(checks: Check[]): boolean {
  for (const check of checks) console.log(`[${check.status.toUpperCase()}] ${check.name}: ${check.message}`);
  const passed = checks.every((item) => item.status !== "error");
  console.log(passed ? "Doctor lulus." : "Doctor belum lulus; lengkapi prasyarat sebelum serve.");
  return passed;
}

if (import.meta.main) {
  try {
    const config = await loadConfig();
    const workers = selectWorkers(process.argv.slice(2), config);
    process.exitCode = printChecks(await runDoctor(config, workers)) ? 0 : 1;
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
```

### B08. scripts/serve.ts

Source: `scripts/serve.ts`. SHA-256: `b77f9b29ae660f390d60d3687ab17cdbd96d085514e10f47b5699e10d86b6110`.

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { runDoctor, printChecks } from "./doctor";
import { clearPorts } from "./lib/ports";
import { insideRoot, loadConfig, projectRoot, selectWorkers, servicePorts, withTimeout, type DevelopmentConfig } from "./lib/development";

export interface Service { name: string; command: string[]; cwd: string; env: NodeJS.ProcessEnv }

export function services(config: DevelopmentConfig, workers: string[], root = projectRoot): Service[] {
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development", HOST: config.host };
  for (const worker of Object.values(config.workers)) {
    if (worker.databaseUrlEnv) delete environment[worker.databaseUrlEnv];
    for (const key of worker.env ?? []) delete environment[key];
  }
  const frontendEnvironment: NodeJS.ProcessEnv = { NODE_ENV: "development", NG_CLI_ANALYTICS: "false" };
  for (const key of ["PATH", "HOME", "USER", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SHELL", "SystemRoot"]) {
    if (process.env[key]) frontendEnvironment[key] = process.env[key];
  }
  return [
    { name: "backend", command: [process.execPath, "--watch", insideRoot(root, config.backend.entry)], cwd: root,
      env: { ...environment, PORT: String(config.backend.port) } },
    { name: "frontend", command: [Bun.which("node")!, resolve(root, "node_modules/@angular/cli/bin/ng.js"), "serve", "--host", config.host,
        "--port", String(config.frontend.port), "--proxy-config", config.frontend.proxyConfig],
      cwd: resolve(root, config.frontend.workspace), env: frontendEnvironment },
    ...workers.map((name) => ({ name: `worker:${name}`, command: [process.execPath, "--watch", insideRoot(root, config.workers[name].entry)], cwd: root,
      env: { ...frontendEnvironment, HOST: config.host,
        ...Object.fromEntries((config.workers[name].env ?? []).map((key) => [key, process.env[key]])),
        ...(config.workers[name].databaseUrlEnv === undefined ? {} : { DATABASE_URL: process.env[config.workers[name].databaseUrlEnv!] }),
        ...(config.workers[name].port === undefined ? {} : { PORT: String(config.workers[name].port) }) } })),
  ];
}

// Independent process groups let Ctrl+C also stop child build/watch processes.
export async function supervise(definitions: Service[]): Promise<number> {
  if (!definitions.length) throw new Error("Tidak ada layanan development yang dipilih.");
  const children: ChildProcess[] = [];
  const closed: Promise<void>[] = [];
  let stopping = false;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => { resolveDone = resolve; });
  const signalGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error("Grup proses development tidak dapat dihentikan."); }
  };
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    children.forEach((child) => signalGroup(child, "SIGTERM"));
    await Bun.sleep(1500);
    children.forEach((child) => signalGroup(child, "SIGKILL"));
    try { await withTimeout(Promise.all(closed), 2000); }
    catch { code = 1; console.error("Sebagian proses development belum terkonfirmasi berhenti."); }
    resolveDone(code);
  };
  const onInterrupt = () => { void stop(130); };
  const onTerminate = () => { void stop(143); };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    for (const service of definitions) {
      if (stopping) break;
      console.log(`Menjalankan ${service.name}.`);
      const child = spawn(service.command[0], service.command.slice(1), {
        cwd: service.cwd, env: service.env, stdio: "inherit", detached: true,
      });
      children.push(child);
      closed.push(new Promise<void>((resolve) => child.once("close", () => resolve())));
      child.once("error", () => {
        console.error(`${service.name} gagal dimulai.`);
        void stop(1);
      });
      child.once("exit", (code, signal) => {
        if (!stopping) {
          console.error(`${service.name} berhenti (${signal ?? code}); menghentikan layanan lainnya.`);
          void stop(code && code > 0 ? code : 1);
        }
      });
    }
    return await done;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

if (import.meta.main) {
  try {
    const config = await loadConfig();
    const workers = selectWorkers(process.argv.slice(2), config);
    if (!printChecks(await runDoctor(config, workers))) process.exitCode = 1;
    else {
      await clearPorts(servicePorts(config, workers));
      console.log(`Frontend: http://${config.host}:${config.frontend.port}`);
      console.log(`Backend: http://${config.host}:${config.backend.port}`);
      process.exitCode = await supervise(services(config, workers));
    }
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
```

### B09. tests/scenarios/development-tooling.json

Source: `tests/scenarios/development-tooling.json`. SHA-256: `82170a3b05a5a03b129a55ea57da8fd83555f3fb2c7840e5b96e51d9dd55d86a`.

```json
{
  "source": "docs/rules/development-commands.md",
  "scenarios": [
    { "id": "TOOL-001", "criterion": "Kriteria verifikasi tooling: doctor", "runner": "bun:test", "file": "tests/integration/tooling/development.test.ts", "testTag": "TOOL-001", "script": "test:tooling" },
    { "id": "TOOL-002", "criterion": "Kriteria verifikasi tooling: cleanup port", "runner": "bun:test", "file": "tests/integration/tooling/development.test.ts", "testTag": "TOOL-002", "script": "test:tooling" },
    { "id": "TOOL-003", "criterion": "Kriteria verifikasi tooling: pilihan worker", "runner": "bun:test", "file": "tests/integration/tooling/development.test.ts", "testTag": "TOOL-003", "script": "test:tooling" },
    { "id": "TOOL-004", "criterion": "Kriteria verifikasi tooling: supervisor", "runner": "bun:test", "file": "tests/integration/tooling/development.test.ts", "testTag": "TOOL-004", "script": "test:tooling" }
  ]
}
```

### B10. tests/integration/tooling/development.test.ts

Source: `tests/integration/tooling/development.test.ts`. SHA-256: `3328637b66c2f3ed152d4d60a4809d07ce984c746fb96e45bb69a7853f591c6e`.

```typescript
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runDoctor } from "../../../scripts/doctor";
import { services, supervise } from "../../../scripts/serve";
import { insideRoot, loadConfig, selectWorkers, type DevelopmentConfig } from "../../../scripts/lib/development";
import { clearPorts, listeners } from "../../../scripts/lib/ports";

const temporaryDirectories: string[] = [];
const fixtureProcesses: ReturnType<typeof Bun.spawn>[] = [];
const descendantPids: number[] = [];
const environment = { ...process.env };

afterEach(async () => {
  for (const child of fixtureProcesses.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  for (const pid of descendantPids.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  for (const path of temporaryDirectories.splice(0)) await rm(path, { recursive: true, force: true });
  for (const key of ["DATABASE_URL", "NOTIFICATION_DATABASE_URL", "NODE_ENV", "SESSION_SECRET"]) {
    if (environment[key] === undefined) delete process.env[key];
    else process.env[key] = environment[key];
  }
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "foundation-tooling-"));
  temporaryDirectories.push(root);
  return root;
}

function config(): DevelopmentConfig {
  return {
    host: "127.0.0.1", frontend: { port: 8889, workspace: "apps/frontend", proxyConfig: "proxy.conf.json" },
    backend: { port: 8888, entry: "apps/backend/src/index.ts" },
    database: { schemas: ["common", "users", "auth"], migrationSchema: "common" }, workers: {},
  };
}

async function fixtureListener(ignoreTerm = false): Promise<{ port: number; child: ReturnType<typeof Bun.spawn> }> {
  const child = Bun.spawn([process.execPath, "-e", `
    ${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ''}
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture") });
    console.log(server.port);
  `], { stdout: "pipe", stderr: "ignore" });
  fixtureProcesses.push(child);
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await reader.read();
  reader.releaseLock();
  const port = Number(new TextDecoder().decode(first.value).trim());
  if (!port) throw new Error("Fixture listener tidak siap.");
  return { port, child };
}

test("TOOL-001 doctor reports missing prerequisites without stopping a listener or leaking credentials", async () => {
  const root = await temporaryRoot();
  const listener = await fixtureListener();
  const selected = config();
  selected.backend.port = listener.port;
  process.env.DATABASE_URL = "invalid-url-with-private-secret";
  process.env.NODE_ENV = "development";
  const checks = await runDoctor(selected, [], root);
  expect(checks.some((item) => item.name === "Entry backend" && item.status === "error")).toBe(true);
  expect(checks.some((item) => item.name === `Port ${listener.port}` && item.status === "warning")).toBe(true);
  expect(JSON.stringify(checks)).not.toContain("private-secret");
  expect((await listeners(listener.port)).some((item) => item.pid === listener.child.pid)).toBe(true);
});

test("TOOL-002 cleanup only stops the configured fixture listener", async () => {
  const target = await fixtureListener();
  const other = await fixtureListener();
  await clearPorts([target.port], () => {});
  expect(await listeners(target.port)).toEqual([]);
  expect((await listeners(other.port)).some((item) => item.pid === other.child.pid)).toBe(true);
  expect(await fetch(`http://127.0.0.1:${other.port}`).then((response) => response.text())).toBe("fixture");
});

test("TOOL-002 cleanup escalates when the fixture ignores SIGTERM", async () => {
  const target = await fixtureListener(true);
  const messages: string[] = [];
  await clearPorts([target.port], (message) => messages.push(message), 50);
  expect(messages.some((message) => message.includes("SIGKILL"))).toBe(true);
  expect(await listeners(target.port)).toEqual([]);
});

test("TOOL-003 worker selection is explicit, deduplicated, and rejects unknown workers", () => {
  const selected = config();
  selected.workers.notification = { entry: "apps/worker/notification/src/index.ts" };
  expect(selectWorkers([], selected)).toEqual([]);
  expect(selectWorkers(["--worker", "notification", "--worker=notification"], selected)).toEqual(["notification"]);
  expect(() => selectWorkers(["--worker", "missing"], selected)).toThrow("belum terdaftar");
  expect(() => selectWorkers(["--worker", "__proto__"], selected)).toThrow("belum terdaftar");
});

test("TOOL-003 service configuration isolates database credentials and uses the requested ports", () => {
  const selected = config();
  selected.workers.notification = { entry: "apps/worker/notification/src/index.ts", databaseUrlEnv: "NOTIFICATION_DATABASE_URL", schemas: ["users"] };
  selected.workers.report = { entry: "apps/worker/report/src/index.ts" };
  process.env.DATABASE_URL = "backend-private-url";
  process.env.NOTIFICATION_DATABASE_URL = "notification-private-url";
  process.env.SESSION_SECRET = "private-session-key";
  const definitions = services(selected, ["notification", "report"]);
  expect(definitions[0].env.PORT).toBe("8888");
  expect(definitions[0].env.DATABASE_URL).toBe("backend-private-url");
  expect(definitions[1].command).toContain("8889");
  expect(definitions[1].env.DATABASE_URL).toBeUndefined();
  expect(definitions[1].env.SESSION_SECRET).toBeUndefined();
  expect(definitions[2].env.DATABASE_URL).toBe("notification-private-url");
  expect(definitions[3].env.DATABASE_URL).toBeUndefined();
  expect(definitions[2].env.SESSION_SECRET).toBeUndefined();
  expect(definitions[3].env.SESSION_SECRET).toBeUndefined();
  expect(definitions.every((item) => item.env.NOTIFICATION_DATABASE_URL === undefined)).toBe(true);
});

test("TOOL-003 configuration rejects overlapping worker ports and paths outside the repository", async () => {
  const root = await temporaryRoot();
  const selected = config();
  selected.workers.notification = { entry: "apps/worker/notification/src/index.ts", port: 8888 };
  await Bun.write(resolve(root, "config/development.json"), JSON.stringify(selected));
  await expect(loadConfig(root)).rejects.toThrow("tumpang tindih");
  expect(() => insideRoot(root, "../outside.ts")).toThrow("di dalam root");
});

test("TOOL-004 service failure stops the other service and its stubborn descendant", async () => {
  const root = await temporaryRoot();
  const identityFile = resolve(root, "listener.json");
  const descendant = `
    process.on("SIGTERM", () => {});
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture") });
    console.log(JSON.stringify({ port: server.port, pid: process.pid }));
  `;
  const parent = `
    process.on("SIGTERM", () => {});
    const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(descendant)}], { stdout: "pipe", stderr: "ignore" });
    const first = await child.stdout.getReader().read();
    await Bun.write(${JSON.stringify(identityFile)}, first.value);
    await child.exited;
  `;
  const failing = `
    const deadline = Date.now() + 2000;
    while (!(await Bun.file(${JSON.stringify(identityFile)}).exists())) {
      if (Date.now() > deadline) process.exit(8);
      await Bun.sleep(20);
    }
    process.exit(7);
  `;
  const result = await supervise([
    { name: "fixture-parent", command: [process.execPath, "-e", parent], cwd: root, env: {} },
    { name: "fixture-failure", command: [process.execPath, "-e", failing], cwd: root, env: {} },
  ]);
  const identity = await Bun.file(identityFile).json();
  descendantPids.push(identity.pid);
  expect(result).toBe(7);
  expect(await listeners(identity.port)).toEqual([]);
}, 10000);
```

### B11. docker-compose.yml

Source: `docker-compose.yml`. SHA-256: `8b1cbb6886e6de2ec96fd33be566eb499ea44ed72973502cf26c3fbb9a6fc185`.

```yaml
# Infrastruktur development saja; aplikasi dijalankan melalui bun run serve.
services:
  postgres:
    image: postgres:18
    restart: unless-stopped
    environment:
      POSTGRES_DB: foundation
      POSTGRES_USER: foundation_admin
      POSTGRES_PASSWORD: ${FOUNDATION_POSTGRES_PASSWORD:?Isi FOUNDATION_POSTGRES_PASSWORD pada .env.infrastructure}
      POSTGRES_HOST_AUTH_METHOD: scram-sha-256
    ports:
      - "127.0.0.1:${FOUNDATION_POSTGRES_PORT:-5432}:5432"
    volumes:
      - postgres_data:/var/lib/postgresql
    shm_size: 128mb
    mem_limit: 1g
    cpus: 2
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U \"$$POSTGRES_USER\" -d \"$$POSTGRES_DB\""]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s

volumes:
  postgres_data:
```

### B12. .env.infrastructure.example

Source: `.env.infrastructure.example`. SHA-256: `0eacce11c799bf901b2a9a0a973060ffcb0c9f3af7e5c8da0d59bbc4828aef77`.

```dotenv
# Khusus Compose; salin ke .env.infrastructure dan isi password lokal.
# Credential ini milik administrator provisioning, bukan role runtime aplikasi.
FOUNDATION_POSTGRES_PASSWORD=
FOUNDATION_POSTGRES_PORT=5432
```

# Scope: Foundation

Foundation adalah fondasi aplikasi untuk pengembang yang membutuhkan frontend, backend, database, dan worker bila diperlukan. Scope ini mengubah isi `foundation.md` menjadi fitur kecil dengan hasil yang dapat dibuktikan.

**Build approach:** Tracer Bullet (membuktikan satu alur nyata lintas aplikasi terlebih dahulu, lalu memperluasnya).
**Workflow:** GA (sesudah `/develop`, verifikasi melalui `/check verify`, pengujian melalui `/test`, review independen melalui `/check review`, dan dokumentasi perubahan melalui `/document`).

Pendekatan, workflow, penundaan autentikasi serta worker bisnis, dan penulisan tanpa bagian referensi mengikuti pilihan Anda saat penyusunan scope. Anda dapat menyesuaikan rencana ketika kebutuhan berubah. Kriteria keamanan dan bukti wajib proyek tetap berlaku.

## Batas dan keputusan

Cakupan awal adalah fondasi yang dapat dijalankan, diintegrasikan, diuji, dan disiapkan untuk release. Sasaran keberhasilan adalah satu alur frontend, SDK, backend, dan PostgreSQL nyata, disertai bukti sesuai kandidat build. Tidak ada target pendapatan, tenggat, kapasitas, atau produk bisnis yang ditetapkan dalam dokumen sumber.

Pilihan teknologi pada `foundation.md` bagian 2 dan aturan proyek tetap berlaku. Scope ini tidak memilih teknologi baru atau menetapkan versi dependency. Satu manifest dan lockfile root mengelola seluruh aplikasi. Fitur tetap disusun lintas aplikasi sesuai kebutuhan, bukan sebagai antrean pekerjaan per lapisan.

Keputusan schema menggunakan `foundation.md` bagian 6 dan 9 serta aturan database: `common` untuk metadata bersama, `users` untuk domain pengguna, dan `auth` untuk autentikasi serta otorisasi. Nama tabel contoh tidak menjadi kewajiban implementasi. Schema domain lain menunggu keputusan pengguna. Specs menetapkan entitas, relasi, role, dan privilege sebelum implementasi yang bergantung padanya.

Autentikasi, registrasi, pemulihan akun, dan worker bisnis menunggu kebutuhan produk yang jelas. Contoh products, reports, notification, upload, pembayaran, serta tenant tidak otomatis menjadi fitur Foundation. SEO, analitik pemasaran, monetisasi, bahasa aplikasi, dan kebutuhan hukum ditentukan saat produk yang memakai fondasi ini mempunyai audiens serta alur nyata.

Versi dependency, kebijakan akses endpoint diagnostik, target layar dan aksesibilitas, angka batas resource, kapasitas beban, topologi deployment, retensi, serta sasaran pemulihan masih membutuhkan keputusan dalam specs terkait. Tidak ada angka performance atau tingkat kepatuhan yang diasumsikan.

## Ringkasan

| # | Fitur | Fase | Status |
| --- | --- | --- | --- |
| 1 | Panduan dan aturan proyek | Konteks tersedia | existing |
| 2 | Doctor dan serve pada aplikasi nyata | Fondasi | in-progress |
| 3 | Infrastruktur PostgreSQL development | Fondasi | done |
| 4 | Struktur aplikasi dan dependency yang kompatibel | Fondasi | done |
| 5 | Model data dan batas akses database | Fondasi | done |
| 6 | Migration dan seed terpisah | Fondasi | done |
| 7 | Kerangka UI dan navigasi | Fondasi | done |
| 8 | Ekspor dan pemeriksaan kontrak OpenAPI | Alur awal | planned |
| 9 | SDK yang sesuai kontrak backend | Alur awal | planned |
| 10 | Alur pemeriksaan kesiapan lintas aplikasi | Alur awal | planned |
| 11 | Pengujian skenario dan gate CI | Pembuktian | planned |
| 12 | Kapasitas dan pemulihan saat beban meningkat | Pembuktian | planned |
| 13 | Build container dan deployment terpisah | Operasi | planned |
| 14 | Backup dan pemulihan data | Operasi | planned |
| 15 | Akses pengguna dan lifecycle sesi | Ditunda | planned |
| 16 | Alur pekerjaan latar belakang pertama | Ditunda | planned |

## Konteks tersedia

### 1. Panduan dan aturan proyek · existing

Panduan development, keamanan, frontend, backend, database, worker, testing, dan release sudah tersedia untuk menyelaraskan pekerjaan Anda.

**Selesai ketika:** panduan dan template tersedia sebagai konteks proyek. Status ini hanya menyatakan keberadaan dokumentasi, bukan penerapan seluruh kontrol pada aplikasi.

Kode dan dokumen: `AGENTS.md`, `README.md`, `docs/rules/`, dan `docs/testing/release-report-template.md`.

## Fondasi

### 2. Doctor dan serve pada aplikasi nyata · in-progress

Lengkapi pembuktian tooling yang sudah ada ketika frontend, backend, dan database nyata tersedia. Pekerjaan ini dimulai dari alur awal fitur 10, tanpa membuat ulang supervisor yang sudah ada.

**Selesai ketika:** doctor memeriksa role dan riwayat migration pada PostgreSQL nyata tanpa membocorkan secret; serve menjalankan frontend 8889 dan backend 8888 setelah preflight; kegagalan dan shutdown membersihkan proses serta resource; batas readiness, pergantian listener, dan dua invocation bersamaan diputuskan serta diuji.

Data: membaca metadata `common`; tidak menambah entitas bisnis. Akses tulis metadata tetap milik runner migration.

- [x] Rinci penyelesaian dan pembuktian (spec): `/architect doctor dan serve pada aplikasi nyata`

Spec: [0003](../specs/0003-doctor-serve-aplikasi-nyata/index.md).

- [ ] Bangun: `/develop doctor dan serve pada aplikasi nyata`
  - [ ] Selaraskan doctor dengan database, role runtime, dan migration nyata dari fitur 5 dan 6; buktikan preflight serta respons HTTP awal (AC-1 sampai AC-4).
  - [x] Lindungi invocation dan cleanup berdasarkan identitas proses, grup, serta checkout; buktikan pergantian listener dan race (AC-3, AC-6, AC-7).
  - [x] Lengkapi readiness 60 detik, worker terpilih, dan shutdown seluruh grup proses (AC-4, AC-5, AC-8).
  - [ ] Selaraskan aturan dan registry, lalu kumpulkan bukti fixture serta aplikasi nyata melalui alur fitur 10 (AC-1 sampai AC-9).
- [ ] Verifikasi: `/check verify doctor dan serve pada aplikasi nyata`
- [ ] Uji: `/test doctor dan serve pada aplikasi nyata`
- [ ] Review mandiri: `/check review doctor dan serve pada aplikasi nyata`
- [ ] Dokumentasikan perubahan: `/document doctor dan serve pada aplikasi nyata`

Kode tersedia: `scripts/doctor.ts`, `scripts/serve.ts`, `scripts/lib/`, `config/development.json`, dan `tests/integration/tooling/development.test.ts`. Registry memuat TOOL-001 sampai TOOL-006 serta TOOL-008. Suite tooling lulus 20 test pada 2026-10-02. [Smoke test PostgreSQL dan aplikasi nyata](../testing/0005-doctor-serve-real-smoke.md) membuktikan doctor, preflight, HTTP, dan shutdown terhadap provisioning serta migration fitur 5 dan 6. TOOL-007 tetap parsial sampai alur browser fitur 10 tersedia.

### 3. Infrastruktur PostgreSQL development · done

Buktikan konfigurasi layanan pendukung yang sudah tersedia agar Anda dapat memakai database development secara konsisten.

**Selesai ketika:** validasi Compose, startup, healthcheck, koneksi, dan persistensi setelah restart terbukti; credential administrator terpisah dari runtime; image untuk CI dapat direproduksi; Compose root hanya mengelola infrastruktur dan tidak menjalankan aplikasi, migration, atau seed.

Data: volume database development. Struktur schema dan grant disiapkan terpisah melalui fitur 5 dan 6. Tidak menambah entitas bisnis.

- [x] Rinci verifikasi infrastruktur (spec): `/architect infrastruktur PostgreSQL development`

Spec: [0002](../specs/0002-infrastruktur-postgresql-development/index.md).

- [x] Bangun: `/develop infrastruktur PostgreSQL development`
  - [x] Amankan batas secret, lalu bangun jalur tipis image Oracle Linux 10 dengan PGDG, Compose, dan suite terisolasi pertama (AC-1, AC-3, AC-4, AC-7, AC-8).
  - [x] Kunci build untuk test dan CI lewat `pins.json` serta catat identitas image (AC-1, AC-2).
  - [x] Buktikan persistensi, shutdown tertib, dan inisialisasi yang terputus (AC-3, AC-5).
  - [x] Periksa batas Compose dan secret, perbarui aturan serta README, lalu kumpulkan bukti (AC-4, AC-6, AC-7, AC-9).
- [x] Verifikasi: `/check verify infrastruktur PostgreSQL development`
- [x] Uji: `/test infrastruktur PostgreSQL development`
- [x] Review ulang: `/check review infrastruktur PostgreSQL development` ([review final](../reviews/2026-10-03-main-final4.md) approve with nits; dua temuan minor diperbaiki dan suite akhir lulus 18 test, 168 assertion)
- [x] Dokumentasikan perubahan: `/document infrastruktur PostgreSQL development`

Kode tersedia: `infrastructure/postgres/` (Dockerfile, helper verifikasi signature dan isi key, entrypoint, `pins.json`), `docker-compose.yml`, `.env.infrastructure.example`, dan `tests/integration/infrastructure/` (registry `tests/scenarios/infrastructure.json`, script `test:infrastructure`). Suite INFRA-001 sampai INFRA-006 lulus 18/18 dengan Docker nyata pada 2026-10-03, 168 assertion; [laporan bukti](../testing/0002-postgresql-development-infrastructure.md) dan JUnit bersih ada di repo. Probe membuktikan key bundle ditolak sebelum import global, signer tambahan tidak dipercaya, dan signature unsigned/rusak atau signer berbeda tidak memasang payload atau menjalankan scriptlet. Build arm64 dan Buildx amd64 terbaru memakai key PGDG yang diharapkan, sementara paket GnuPG sementara dan dependency-nya tidak tertinggal pada image. Review independen menyetujui dengan nits; kedua temuan minor sudah diperbaiki dan diverifikasi ulang.

### 4. Struktur aplikasi dan dependency yang kompatibel · done

Siapkan struktur minimum yang benar untuk alur awal. Gunakan pilihan runtime dan framework yang sudah disepakati tanpa membuat seluruh folder contoh.

**Selesai ketika:** versi yang kompatibel dicatat dan dikunci; dependency serta script memakai satu manifest root; frontend dan backend dapat dibuild; backend memisahkan komposisi route dari listen serta startup resource; browser tidak mengimpor kode server; startup tidak menjalankan migration atau seed.

Data: tidak membutuhkan perubahan database.

- [x] Rinci struktur dan kompatibilitas (spec): `/architect struktur aplikasi dan dependency yang kompatibel`

Spec: [0001](../specs/0001-struktur-aplikasi-dependency/index.md).

- [x] Bangun: `/develop struktur aplikasi dan dependency yang kompatibel`
  - [x] Pasang versi kompatibel dan jalankan kerangka Angular serta backend lokal (AC-1, AC-2, AC-3, AC-4).
  - [x] Ekspor kontrak awal, validasi, dan generate SDK yang dapat diulang (AC-1, AC-3, AC-5).
  - [x] Buktikan build, startup, kegagalan aman, dan skenario APP-001 sampai APP-004 (AC-1 sampai AC-6).
- [x] Verifikasi: `/check verify struktur aplikasi dan dependency yang kompatibel`
- [x] Uji: `/test struktur aplikasi dan dependency yang kompatibel`
- [x] Review mandiri: `/check review struktur aplikasi dan dependency yang kompatibel`
- [x] Dokumentasikan perubahan: `/document struktur aplikasi dan dependency yang kompatibel`

Bukti: [laporan fitur 4](../testing/0001-application-structure.md), [manifest kandidat dan checksum](../testing/evidence/0001/candidate.json), [checklist verify](../specs/0001-struktur-aplikasi-dependency/verify.md), dan [review independen GPT-6 Sol](../reviews/2026-09-27-application-structure.md). Gate lokal final: 78 passed, 0 failed/skipped. Review: Approve, tanpa temuan terbuka. Dokumentasi: [CHANGELOG](../../CHANGELOG.md). Status done berlaku untuk AC-1 sampai AC-6 spec 0001; readiness production dan alur database mengikuti scope berikutnya.

Kode: `apps/frontend/`, `apps/backend/`, `scripts/export-openapi.ts`, `scripts/validate-openapi.ts`, `scripts/check-api.ts`, `openapi.json`, dan `tests/scenarios/application.json`.

### 5. Model data dan batas akses database · done

Tetapkan model minimum yang diperlukan alur awal, koneksi bersama, dan pembagian akses antarpelaku. Entitas produk dibahas ketika kebutuhannya nyata.

**Selesai ketika:** specs menetapkan `common.schema_migrations`, schema `users` dan `auth`, relasi yang diperlukan, serta role pemilik, migrator, backend, dan worker bila ada; pool dimiliki tiap proses dan ditutup saat shutdown; runtime tanpa DDL atau superuser; query berkualifikasi dan berparameter; akses yang diizinkan berhasil dan akses terlarang ditolak pada PostgreSQL 18.

Data: metadata di `common`; data pengguna kelak di `users`; credential dan sesi kelak di `auth`. Alur awal tidak membuat tabel pengguna atau sesi tanpa kebutuhan fitur 15. Search path dan privilege `public` termasuk batas akses yang diperiksa.

- [x] Rinci model dan privilege (spec): `/architect model data dan batas akses database`

Spec: [0004](../specs/0004-model-data-akses-database/index.md).

- [x] Bangun: `/develop model data dan batas akses database`
  - [x] Provision role, schema, metadata, dan privilege pada PostgreSQL 18 terisolasi (AC-1 sampai AC-5).
  - [x] Hubungkan pool bersama ke lifecycle backend dan sinkronkan kontrak OpenAPI serta SDK (AC-6, AC-7).
  - [x] Buktikan penolakan akses, drift, rerun, persaingan provisioning, dan perlindungan credential (AC-1 sampai AC-7).
- [x] Verifikasi: `/check verify model data dan batas akses database`
- [x] Uji: `/test model data dan batas akses database`
- [x] Review mandiri: `/check review model data dan batas akses database`
- [x] Dokumentasikan perubahan: `/document model data dan batas akses database`

Kode tersedia: `database/provision.ts`, `libs/server/database/client.ts`, dan lifecycle di `apps/backend/src/index.ts`. Skenario DATA-001 sampai DATA-005 terdaftar pada `tests/scenarios/database.json`; dua belas test DATA lulus dengan 74 assertion pada PostgreSQL 18 terisolasi. [Laporan bukti](../testing/0003-database-access.md) memuat hasil runtime serta CI. [Review awal](../reviews/2026-10-02-database-access.md) menemukan tiga celah; [review ulang](../reviews/2026-10-02-database-access-followup.md) menyetujui perbaikannya. Perubahan tercatat pada [CHANGELOG](../../CHANGELOG.md). Status done berlaku untuk AC-1 sampai AC-7 spec 0004; alur UI fitur 10 dan kesiapan production mengikuti fitur terkait.

### 6. Migration dan seed terpisah · done

Sediakan runner sekali jalan untuk perubahan schema serta data awal, terpisah dari startup aplikasi dan worker.

**Selesai ketika:** runner di `database/` memvalidasi target dan versi PostgreSQL; bootstrap metadata serta urutan global konsisten; lock mencegah eksekusi bersamaan; checksum mendeteksi perubahan migration terapan; perubahan serta pencatatan atomik ketika didukung; SQL di luar transaksi ditangani eksplisit; pengulangan seed tidak merusak data dan memakai role yang disepakati.

Data: riwayat migration di `common`; objek domain dan seed mengikuti keputusan fitur 5 atau specs fitur pemiliknya. Hanya runner yang menulis metadata dan mengubah struktur.

- [x] Rinci runner dan keamanan pengulangan (spec): `/architect migration dan seed terpisah`

Spec: [0005](../specs/0005-migration-seed-terpisah/index.md).

- [x] Bangun: `/develop migration dan seed terpisah`
  - [x] Buat baseline, discovery file, pemeriksaan metadata, checksum, transaksi, dan lock; buktikan penerapan serta rerun (AC-1 sampai AC-4, AC-7).
  - [x] Batasi satu statement dan buktikan penolakan drift, rollback, persaingan runner, serta keluaran aman (AC-2 sampai AC-4, AC-6, AC-7).
  - [x] Tambah seed terpisah, fixture pengulangan, registry, panduan, serta bukti doctor terhadap riwayat nyata (AC-1, AC-5 sampai AC-7).
- [x] Verifikasi: `/check verify migration dan seed terpisah`
- [x] Uji: `/test migration dan seed terpisah`
- [x] Review mandiri: `/check review migration dan seed terpisah`
- [x] Dokumentasikan perubahan: `/document migration dan seed terpisah`

Kode tersedia: `database/runner.ts`, `database/migrate.ts`, `database/seed.ts`, dan `database/migrations/0001-common-metadata-comment.sql`. Skenario MIG-001 sampai MIG-005 terdaftar di `tests/scenarios/migration.json`. [Laporan bukti](../testing/0004-migration-seed.md) mencatat 15 test database lulus, termasuk 5 test MIG, serta gate proyek. [Review awal](../reviews/2026-10-02-migration-seed.md) menemukan satu celah pemeriksaan SQL; [review ulang](../reviews/2026-10-02-migration-seed-followup.md) menyetujui perbaikannya. Perubahan tercatat pada [CHANGELOG](../../CHANGELOG.md). Status done hanya untuk AC-1 sampai AC-7 spec 0005; CI database dan kesiapan production mengikuti scope berikutnya.

### 7. Kerangka UI dan navigasi · done

Siapkan tampilan minimum bagi alur awal menggunakan komponen dan default layout yang telah disepakati. Halaman mengikuti fitur, bukan kumpulan komponen global.

**Selesai ketika:** API publik library versi terpasang terbukti dapat dipakai; default layout wrapper terintegrasi; navigasi minimum bekerja; keyboard, focus, label, ukuran layar sasaran, dan state tampilan dapat digunakan; tidak ada credential di bundle atau akses internal library.

Data: tidak membutuhkan perubahan database. Sasaran layar dan aksesibilitas dirinci sebelum verifikasi UI.

- [x] Rinci kerangka UI (spec): `/architect kerangka UI dan navigasi`

Spec: [0007](../specs/0007-kerangka-ui-navigasi/index.md).

- [x] Bangun: `/develop kerangka UI dan navigasi`
  - [x] Integrasikan wrapper layout publik, router outlet, item Kesiapan, dan halaman root statis (AC-1, AC-2).
  - [x] Atur fallback route, skip link, focus perpindahan route, serta label dan perilaku drawer mobile (AC-3, AC-6).
  - [x] Buktikan layout pada viewport target dan pastikan bundle serta halaman tidak mengandung akses server atau credential (AC-4, AC-5).
- [x] Verifikasi: `/check verify kerangka UI dan navigasi`
- [x] Uji: `/test kerangka UI dan navigasi`
- [x] Review mandiri: `/check review kerangka UI dan navigasi` ([review final GPT-6 Astra](../reviews/2026-10-03-main-ui-shell-followup.md), Approve; tidak ada temuan terbuka)
- [x] Dokumentasikan perubahan: `/document kerangka UI dan navigasi`

Kode: `apps/frontend/src/app/`, `scripts/lib/frontend-bundle.ts`, dan `tests/e2e/ui-shell/`. Gate akhir: 30 ID skenario terdaftar; 1 frontend test, 81 integration test dengan 172 assertion, 26 tooling test dengan 75 assertion, dan 4 E2E pass. [Laporan bukti](../testing/0006-ui-navigation.md) memuat screenshot, JUnit, batas verifikasi, dan warning bundle awal 654,09 kB terhadap anggaran 500 kB. [Review awal](../reviews/2026-10-03-main-ui-shell.md) menemukan satu major pada checker; [review final](../reviews/2026-10-03-main-ui-shell-followup.md) menyetujui perbaikannya tanpa temuan terbuka. Status done berlaku untuk AC-1 sampai AC-6 spec 0007.

## Alur awal

Fitur 8 sampai 10 membentuk satu alur nyata untuk memeriksa kesiapan fondasi. Kontrak minimum disepakati sebelum bagian frontend dan backend yang bergantung padanya dikerjakan. Alur ini memakai metadata yang telah diperlukan, sehingga tidak menciptakan domain bisnis contoh. Fitur 2 dituntaskan terhadap alur tersebut.

### 8. Ekspor dan pemeriksaan kontrak OpenAPI · planned · perlu keputusan

Jadikan route serta schema backend sebagai sumber kontrak yang dapat diekspor tanpa menjalankan layanan eksternal.

**Selesai ketika:** ekspor menghasilkan `openapi.json` root tanpa listen atau database aktif; checker Bun menerima fixture valid dan menolak pelanggaran aturan wajib, termasuk reference eksternal, reference lokal rusak, endpoint wajib hilang, operationId, schema, dan security; hasil deterministik; kegagalan menghasilkan exit code bukan nol; batas checker dinyatakan.

Data: tidak membutuhkan perubahan database. Security kontrak mencerminkan akses route nyata, termasuk kebijakan diagnostik fitur 10.

- [ ] Rinci kontrak dan checker (spec): `/architect ekspor dan pemeriksaan kontrak OpenAPI`

### 9. SDK yang sesuai kontrak backend · planned · perlu keputusan

Hubungkan hasil ekspor backend dengan adapter fitur Angular melalui SDK generated. Tetapkan satu pemilik artefak bersama ketika implementasi berjalan paralel.

**Selesai ketika:** `api:sync` menjalankan ekspor, validasi, dan generate berurutan; SDK standalone di luar `src/` masuk build Angular; manifest mengelola file usang; `api:check` mendeteksi file baru, berubah, dan dihapus; dua run identik; request dan response SDK cocok dengan backend nyata; setiap perubahan backend menjalankan regenerasi meskipun output identik.

Data: tidak membutuhkan perubahan database. SDK tidak memuat secret dan tidak dipelihara manual.

- [ ] Rinci sinkronisasi serta konsumsi SDK (spec): `/architect SDK yang sesuai kontrak backend`

### 10. Alur pemeriksaan kesiapan lintas aplikasi · planned · perlu keputusan

Sediakan satu halaman development yang membaca kesiapan melalui SDK, backend, dan PostgreSQL nyata. Ini adalah alur pertama untuk membuktikan sambungan fondasi.

**Selesai ketika:** halaman menampilkan hasil pemeriksaan nyata serta loading, berhasil, dan gagal; backend memakai role runtime untuk membaca metadata yang diizinkan; database tidak siap menghasilkan respons terkontrol; UI tidak menerima DSN, SQL, stack, atau detail sensitif; proxy dan URL runtime bekerja; Playwright membuktikan alur serta kondisi gagal tanpa mock database.

Data: membaca metadata `common`, tanpa penulisan data bisnis. Specs menetapkan apakah endpoint hanya tersedia di development atau memiliki akses terbatas pada deployment lain, berikut timeout dan batas request. GET tidak mengubah data. Login tidak disimulasikan sebagai kontrol akses.

- [ ] Rinci alur dan kebijakan diagnostik (spec): `/architect alur pemeriksaan kesiapan lintas aplikasi`

## Pembuktian

### 11. Pengujian skenario dan gate CI · planned · perlu keputusan

Hubungkan kriteria fitur dengan test serta bukti kandidat yang benar. Suite relevan ditambahkan bersama implementasi fitur sejak awal; fitur ini menyatukan discovery, registry, dan gate otomatis.

**Selesai ketika:** runner hanya menemukan suite miliknya; registry mempunyai ID unik serta rujukan test yang valid; CI menjalankan pemeriksaan tipe, build, kontrak, test terkait, dan regression alur kritis; integration database serta E2E memakai komponen nyata; scanner dipin dan temuan dilaporkan; test gagal, dilewati, belum berjalan, dan belum tersedia dibedakan; laporan mengikat hasil pada kandidat yang sama.

Data: database test terisolasi dengan schema dan role mengikuti fitur yang diuji. Credential production tidak dipakai. Specs menetapkan ID skenario; TOOL-001 sampai TOOL-004 yang sudah ada dipertahankan.

- [ ] Rinci registry dan gate CI (spec): `/architect pengujian skenario dan gate CI`

### 12. Kapasitas dan pemulihan saat beban meningkat · planned · perlu keputusan

Buktikan kapasitas alur nyata pada beban yang disepakati, termasuk penolakan terkontrol dan pemulihan layanan.

**Selesai ketika:** specs menetapkan model beban, durasi, data, limit, dan target; profil smoke, load, stress, spike, serta soak yang diwajibkan memiliki checks hasil bisnis dan thresholds yang menggagalkan pipeline; beban aktual serta dropped iterations tercatat; resource dan pool diamati; batas bukti environment dinyatakan tanpa melonggarkan target agar lulus.

Data: data test terkontrol sesuai schema fitur yang diukur. Pengujian panjang memakai environment yang tidak terganggu suite lain. Breakpoint dan k6 browser hanya ditambahkan bila dibutuhkan.

- [ ] Rinci target kapasitas dan profil wajib (spec): `/architect kapasitas dan pemulihan saat beban meningkat`

## Operasi

### 13. Build container dan deployment terpisah · planned · perlu keputusan

Siapkan artefak frontend serta backend untuk deployment dengan konfigurasi dan kontrol operasi yang dapat dibuktikan. Worker memperoleh image sendiri ketika fitur 16 dibangun.

**Selesai ketika:** image memakai root monorepo sebagai build context; secret tidak masuk image atau bundle; migration berjalan sebagai langkah deployment tersendiri; konfigurasi TLS, header frontend, CORS, jaringan, resource, health/readiness, serta shutdown sesuai topologi; log dan correlation ID tidak membocorkan data; kandidat release memiliki bukti dan status `ready`, `blocked`, atau `incomplete` yang benar.

Data: memakai schema dan role hasil specs, tanpa privilege tambahan. Retensi log serta kebijakan endpoint admin, metrics, dan OpenAPI diputuskan sebelum deployment. Bukti kesiapan tidak otomatis memberi izin deploy.

- [ ] Rinci build dan operasi deployment (spec): `/architect build container dan deployment terpisah`

### 14. Backup dan pemulihan data · planned · perlu keputusan

Pastikan data dapat dikembalikan ketika terjadi kegagalan atau insiden. Backup yang terbentuk saja belum membuktikan pemulihan.

**Selesai ketika:** sasaran kehilangan data dan waktu pemulihan, retensi, akses, serta penyimpanan diputuskan; restore ke target terisolasi membuktikan data dan migration konsisten; secret disaring; prosedur insiden mencakup rotasi credential serta pencabutan sesi ketika auth tersedia; bukti restore dicatat pada kandidat dan environment terkait.

Data: schema yang benar benar digunakan, awalnya `common` serta domain yang sudah dibangun. Metadata backup baru memerlukan keputusan schema sebelum implementasi.

- [ ] Rinci backup dan pemulihan (spec): `/architect backup dan pemulihan data`

## Ditunda

Fitur berikut dicatat agar kebutuhan keputusan terlihat. Fitur ini belum masuk urutan implementasi awal dan tidak menyatakan bahwa seluruh contoh kapabilitas pada dokumen sumber sudah dipilih.

### 15. Akses pengguna dan lifecycle sesi · planned · perlu keputusan

Tambahkan alur akses pengguna ketika produk membutuhkan identitas. Sebelum implementasi, pecah menjadi fitur kecil seperti login/logout, registrasi bila diperlukan, profil, dan pemulihan akun sesuai batas produk yang dipilih.

**Selesai ketika:** batas tiap alur, permission, dan model sesi disepakati; akses lintas pengguna ditolak backend; expiry, revocation, rotasi, logout, CSRF, validasi input, serta batas percobaan dibuktikan sesuai cakupan; UI tidak menyimpan token di browser storage; credential tidak bocor pada response atau log.

Data: identitas bisnis dan profil di `users`; credential, hash token, sesi, serta otorisasi di `auth`. Keputusan domain sudah tersedia, tetapi entitas, TTL, role, kebutuhan MFA, dan batas alur belum menjadi specs final.

- [ ] Saat fitur dibutuhkan, tentukan alur pertama (spec): `/architect akses pengguna dan lifecycle sesi`

### 16. Alur pekerjaan latar belakang pertama · planned · perlu keputusan

Tambahkan satu hasil bisnis yang benar benar membutuhkan proses latar belakang. Nama worker contoh tidak menjadi daftar aplikasi wajib.

**Selesai ketika:** sumber job dan permission jelas; kontrak tervalidasi; timeout, retry terbatas, concurrency, idempotensi, serta shutdown dibuktikan; hasil akhir dan efek bisnis dapat diamati; worker terpilih melalui serve memakai environment serta role sendiri; image mandiri tersedia jika dideploy terpisah.

Data: belum dipilih karena domain pekerjaan belum tersedia. Pengguna menentukan schema per entitas sebelum migration atau query dibuat. Akses `auth` tidak diberikan otomatis. Transport, scheduler, dan angka resource ditetapkan dalam specs.

- [ ] Saat hasil bisnis dipilih, rancang alurnya (spec): `/architect alur pekerjaan latar belakang pertama`

## Arti status dan langkah berikutnya

`planned` berarti direncanakan. `in-progress` berarti sebagian implementasi ada tetapi bukti penyelesaian belum lengkap. `existing` berarti telah tersedia sebelum scope ini, hanya pada batas yang dinyatakan. `done` memerlukan hasil serta bukti kriteria fitur. `dropped` menyimpan fitur yang dikeluarkan tanpa menghapus sejarah.

Kotak pertama yang belum dicentang adalah langkah berikutnya. Label `(spec)` menandai perancangan. Setelah specs tersedia, bagian fitur memperoleh tautan specs, langkah `/develop` dengan 2 sampai 5 milestone, serta langkah verifikasi, test, review, dan dokumentasi sesuai workflow. Tugas implementasi rinci berada dalam specs.

Anda dapat mulai dengan `/architect struktur aplikasi dan dependency yang kompatibel`. Fitur 3 dapat dirinci bersama persiapan tersebut. Fitur 5 dan 6 menyediakan database yang diperlukan alur awal. Fitur 2 dituntaskan setelah aplikasi nyata tersedia. Keamanan dan test relevan dibangun bersama setiap fitur, tanpa menunggu fase pembuktian.

Scope ini memeriksa cakupan dokumen dan keberadaan artefak lokal. Tidak ada suite aplikasi, container, performance, atau kandidat release yang dijalankan atau dinyatakan lulus dalam penyusunan scope.

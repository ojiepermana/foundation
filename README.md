# Foundation

Monorepo Angular, Bun/Elysia, dan worker dengan satu `package.json` root. Rules dan workflow agent berada di [AGENTS.md](AGENTS.md) serta `docs/rules/`.

Workflow development menggunakan [Engineering Workflow Skills dari JS Mastery](https://github.com/jsmastery-pro/skills), termasuk `/scope`, `/audit`, `/architect`, `/develop`, `/check`, `/test`, `/debug`, `/document`, dan `/sync`. Gunakan skill sesuai kebutuhan perubahan. [Workflow project](docs/rules/development-workflow.md) dan aturan dalam `AGENTS.md` melengkapi skill tersebut dengan keputusan khusus Foundation.

```sh
cp .env.infrastructure.example .env.infrastructure
# Isi FOUNDATION_POSTGRES_PASSWORD dengan hasil: openssl rand -hex 32
docker compose --env-file .env.infrastructure up -d --wait postgres
```

`docker-compose.yml` root hanya untuk infrastruktur pendukung, saat ini PostgreSQL 18 dari image buatan proyek di `infrastructure/postgres/` (Oracle Linux 10 slim dengan paket PGDG), bukan image resmi `postgres:18`. Build pertama membutuhkan internet. Data tersimpan pada volume `foundation_pgsql_data` di `/var/lib/pgsql` dan tetap ada setelah `down` tanpa `-v`. Perbarui patch dev secara berkala dengan `docker compose --env-file .env.infrastructure build --pull --no-cache postgres` agar instalasi paket PGDG berjalan ulang.

```sh
bun run test:infrastructure
```

Suite infrastruktur membangun image terkunci dari `infrastructure/postgres/pins.json` dan membuktikan startup, koneksi, persistensi, serta batas secret pada project Compose uji yang terisolasi, tanpa menyentuh data dev Anda. Cara memperbarui pin ada di [aturan infrastruktur](docs/rules/infrastructure.md).

## Provisioning database (spec 0004)

Siapkan `FOUNDATION_ADMIN_DATABASE_URL` untuk login `foundation_admin` ke database `foundation`, serta `FOUNDATION_MIGRATOR_PASSWORD` dan `FOUNDATION_BACKEND_PASSWORD` untuk role baru. Ketiganya berasal dari environment lokal atau secret manager. Jangan menaruhnya di `config/development.json`, `.env.infrastructure`, argumen perintah, atau Git. Password role baru minimal 16 karakter. Jalankan dari root:

```sh
bun run db:provision --apply
bun run test:database:real
```

Provisioning membuat role `foundation_owner`, `foundation_migrator`, `foundation_backend`, schema `common`, `users`, `auth`, dan `common.schema_migrations`. Pengulangan tidak mengganti password role yang sudah ada. Test database memakai container PostgreSQL 18 dan credential acak tersendiri, tanpa mengubah database development.

## Migration dan seed (spec 0005)

Setelah provisioning, sediakan `FOUNDATION_MIGRATOR_DATABASE_URL` untuk login `foundation_migrator` ke database `foundation` lewat environment lokal hanya saat menjalankan runner. Gunakan password migrator yang dibuat saat provisioning. Jangan simpan URL ini dalam `.env` backend, JSON, frontend, atau Git. Jalankan perintah dari root:

```sh
bun run db:migrate --apply
bun run db:seed --apply
```

Migration baseline memberi komentar pada tabel metadata dan mencatat checksum file. Pengulangan migration yang sama melewati file yang sudah terapan. Seed awal tidak berisi data bisnis dan melaporkan nol seed; direktori `database/seeds/` dibuat saat file seed pertama ditambahkan. Kedua perintah memakai transaksi dan menolak perubahan file migration yang sudah terapan. Tambahkan file SQL berikutnya dengan nomor empat digit berurutan dan satu statement per file. Seed baru harus idempotent dan dibuktikan oleh test fiturnya. Runner tidak berjalan otomatis dari Compose, backend, `doctor`, atau `serve`.

Isi `DATABASE_URL` dalam `.env` dengan URL role `foundation_backend` sebelum menjalankan `doctor` dan `serve`. URL admin, migrator, dan backend berbeda.

Setelah provisioning role/schema dan migration melalui langkah terpisah, jalankan aplikasi:

```sh
bun run doctor
bun run serve
bun run test:tooling
```

Frontend development menggunakan port **8889**, backend **8888**. Worker dipilih dengan `--worker <nama>` setelah didaftarkan di `config/development.json`.

Doctor memeriksa prasyarat tanpa mengubah database atau menghentikan proses. Serve menjalankan preflight, hanya mengganti proses Foundation lama dari checkout yang sama jika identitasnya terbukti, lalu menunggu respons HTTP aplikasi sebelum menampilkan URL. Lihat [aturan perintah development](docs/rules/development-commands.md).

Frontend, backend, dan worker dijalankan melalui Bun/Angular CLI; Compose tidak memuat runtime aplikasi. Credential Compose terpisah dari `.env` aplikasi. Lihat [aturan infrastruktur](docs/rules/infrastructure.md) untuk port, volume, healthcheck, dan batas provisioning.

## Kerangka aplikasi (spec 0001)

Gunakan Node 24.21.0 dan Bun 1.4.2 sesuai `.node-version` serta `.bun-version`.

```sh
bun install --frozen-lockfile
bun run api:sync
bun run test:ci
```

Frontend Angular 22.2.0 dan backend Elysia 1.4.30 sudah tersedia. Route `/api/status` hanya ada pada development. SDK standalone berasal dari `openapi.json`, memakai `@ojiepermana/angular` 22.1.14 dan tidak diedit manual.

Untuk pembuktian kerangka tanpa database sesuai spec 0001, jalankan `bun run dev:backend` dan `bun run dev:frontend` pada dua terminal. Perintah ini memakai port development yang sama. Workflow aplikasi lengkap berjalan melalui `doctor` dan `serve` setelah PostgreSQL, role, schema, serta metadata migration tersedia. Worker bisnis menunggu scope terkait.

`api:check` meregenerasi artefak dua kali dan gagal jika isi atau daftar file berubah. Build frontend mengompilasi SDK di luar `src/`. Laporan fitur mencatat bukti dan batasnya.

## Gate CI (spec 0010)

Workflow `.github/workflows/application.yml` menjalankan empat job pada setiap push dan pull request. Setiap job memanggil script root yang sama dengan yang dapat Anda jalankan lokal:

```sh
bun run test:ci           # tier cepat, tanpa Docker
bun run test:ci:real      # tier nyata: Docker, PostgreSQL 18, dan Chromium
bun run test:ci:security  # tier keamanan: gitleaks, bun audit, dan actionlint yang dipin; butuh Docker dan registry npm
bun run test:report       # laporan gate dari ketiga bundle bukti
```

Setiap tier menulis bundle bukti beserta manifest di `.local/feature-11/evidence/<tier>/`. `test:report` menulis `.local/feature-11/report.json` dan `.local/feature-11/report.md` dalam bahasa Indonesia, lalu keluar 0 hanya bila gate `passed`: seluruh skenario lulus, ketiga tier lulus, discovery sesuai, ketiga pemindai lulus, dan ketiga tier terikat pada commit serta pohon sumber yang sama. Run lokal pada working tree yang belum masuk commit dapat lulus gate tetapi bukan kandidat release. Aturan lengkapnya ada di [aturan testing](docs/rules/testing.md) dan [aturan keamanan](docs/rules/security.md).

## Kapasitas k6 (spec 0011)

Pengujian kapasitas k6 mengukur `GET /api/status` dan `GET /api/readiness` dengan model beban dan target dari [spec 0011](docs/specs/0011-kapasitas-pemulihan-beban-meningkat/index.md). Setiap profil berjalan di environment Docker sendiri (PostgreSQL 18, backend, dan k6 dalam container berbatas resource) dengan image k6 dan Bun yang dipin di `tests/performance/images.json`. Mesin container membutuhkan paling sedikit 4 CPU dan 4 GiB memory, dan tidak boleh ada suite lain yang sedang berjalan.

```sh
bun run test:performance:smoke   # smoke, juga langkah terakhir test:ci:real pada setiap push
bun run test:ci:capacity         # tier kapasitas manual: load, stress, spike, outage, dan soak (sekitar 110 menit)
bun run test:report:capacity     # laporan kapasitas dari bundle tier kapasitas
```

Tier kapasitas tidak termasuk gate per push. Bundle buktinya ada di `.local/feature-11/evidence/capacity/`, dan `test:report:capacity` menulis `.local/feature-12/report.json` serta `.local/feature-12/report.md`, lalu keluar 0 hanya bila tier lulus, seluruh skenario kapasitas lulus, dan bundle terikat pada checkout. Di GitHub, workflow `.github/workflows/capacity.yml` hanya dijalankan manual (`gh workflow run capacity.yml --ref main`) dan mengunggah artifact `capacity-evidence`. Angka yang dihasilkan berlaku untuk satu backend development dengan satu CPU, bukan perkiraan kapasitas produk; batas buktinya tertulis di setiap hasil. Aturan lengkap dan langkah pembersihan manual ada di [aturan testing](docs/rules/testing.md).

## Deployment container (spec 0012)

Frontend, backend, dan runner migration masing masing mendapat image sendiri yang dibangun dari root monorepo. `deploy/compose.yaml` adalah topologi rujukan satu host Docker: edge nginx dengan TLS yang melayani frontend dan meneruskan `/api/`, backend serta PostgreSQL di network internal, dan migration sebagai job sekali jalan. Image hanya ditandai lokal; proyek tidak mendorong image ke registry dan tidak melakukan deploy.

```sh
docker build -f apps/frontend/Dockerfile -t foundation-frontend:<tag> .
docker build -f apps/backend/Dockerfile -t foundation-backend:<tag> .
docker build -f database/Dockerfile -t foundation-migrate:<tag> .
bun run test:deployment:plan   # bentuk statis dan test sinyal orkestrasi, langkah tier cepat
bun run test:deployment:real   # topologi rujukan pada container nyata, langkah tier nyata
bun run test:report:release    # status kesiapan release dari bundle CI yang diunduh untuk commit kandidat
```

Langkah deployment berurutan (build, PostgreSQL, provisioning sekali, backend, readiness, migration, edge), kebijakan endpoint production, retensi log, rotasi password, pembaruan sertifikat TLS, pembaruan pin, dan prosedur mengunduh artifact CI untuk `test:report:release` ada di [aturan deployment](docs/rules/deployment.md). Status `ready` dari `test:report:release` adalah ringkasan bukti untuk pemilik release, bukan izin deploy.

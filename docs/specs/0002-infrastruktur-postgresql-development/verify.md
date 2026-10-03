# Verify: Infrastruktur PostgreSQL development · spec 0002 · updated 2026-10-03
_Langkah diturunkan dari acceptance criteria spec 0002 dan tabel Value sourcing. `/check verify` menjalankannya; `/test` mengunci langkah yang tahan lama._

Semua perintah dijalankan dari root. Untuk langkah pada volume baru, pakai project uji `-p foundation-infra-test-<8 hex>` dengan env file sementara, lalu `down --volumes` untuk project itu saja. Jangan menghapus volume `foundation_pgsql_data` milik dev.

## Commands: build dan image

- [x] Bandingkan build dev terisolasi dengan `--pull` dan dengan `--pull --no-cache` → base image ID tetap `sha256:0660af1f...`; build biasa memakai cache pada langkah paket, build tanpa cache menjalankannya ulang, keduanya mencatat `postgresql18-server-18.6-4PGDG.rhel10.2.aarch64` → [bukti refresh](../../testing/evidence/0002/dev-refresh.json) → AC-2, AC-9 (2026-10-03)
- [x] `docker run --rm --entrypoint rpm foundation-postgres:18-dev -q postgresql18-server` → versi 18 terbaru di `rhel-10.<minor>-<arch>` PGDG; `rpm -q postgresql18-contrib` → tidak terpasang; paket `postgresql18*` hanya `postgresql18`, `postgresql18-libs`, `postgresql18-server` → AC-1
- [x] `docker image inspect` dan `docker history --no-trunc` untuk image dev dan pinned → tidak memuat `POSTGRES_PASSWORD` atau nilai password; `Config.Env` hanya `PATH`, `PGDATA`, `TZ` → AC-1
- [x] `docker buildx build --platform linux/amd64` dengan pin base dan paket → exit 0, `rpm -q` menunjukkan `18.6-4PGDG.rhel10.2`, proses UID 26, key cocok dengan fingerprint dan signature repo lolos sebelum instalasi → [bukti build arm64/amd64](../../testing/evidence/0002/reproducibility.json) → AC-1, AC-2 (2026-10-03; amd64 melalui emulasi)
- [x] `bun test ./tests/integration/infrastructure/postgres.test.ts -t 'INFRA-002 key PGDG dan signature repo diverifikasi sebelum RPM diinstall'` → test mengunci urutan unduh key, listing GnuPG read-only, pencocokan fingerprint primary penuh, import ke RPM database sementara, pemeriksaan satu record key, import global, verifikasi wajib, pemeriksaan ID key penanda tangan, lalu instalasi → AC-1
- [x] `bun test ./tests/integration/infrastructure/postgres.test.ts -t 'INFRA-002 key bundle dan signature unsigned, rusak, atau dari signer lain ditolak sebelum instalasi'` → helper yang sama dengan Dockerfile menolak bundle yang berisi key tambahan sebelum import global, RPM unsigned, signature valid dari key lain yang dipercaya RPM, dan fixture dengan payload yang diubah; paket, payload, dan penanda `%post` tidak terpasang atau berjalan → AC-1
- [x] Ubah satu karakter konstanta fingerprint di salinan Dockerfile lalu build → gagal karena fingerprint public key tidak sama dengan konstanta → AC-1 (value sourcing: fingerprint konstanta)
- [x] Build terkunci dua kali (salah satunya `--no-cache`) → label base sama dengan `pins.baseImage` dan `rpm -q postgresql18-server` sama dengan `pins.postgresPackageVersion` pada keduanya → AC-2
- [x] Isi `postgresPackageVersion` dengan versi yang tidak ada di PGDG pada salinan `pins.json` → build terkunci gagal, bukan memasang versi lain → AC-2 (value sourcing: pin)
- [x] `.local/feature-3/image.json` setelah `bun run test:infrastructure` → `baseIndexDigest`, `packageVersion`, `serverVersion`, `imageId`, `architecture`, `processUid` terisi dan sesuai pin → AC-2

## Commands: inisialisasi dan konfigurasi cluster

- [x] Volume baru dengan password benar → `SELECT datlocprovider, datlocale, pg_encoding_to_char(encoding) FROM pg_database WHERE datname = 'foundation'` → `b | C.UTF-8 | UTF8` → AC-3
- [x] `SHOW timezone` dan `SHOW log_timezone` → `UTC`; `SHOW data_checksums` → `on`; `SHOW logging_collector` → `off` → AC-3 (value sourcing: `ENV TZ=UTC`)
- [x] `SET TIME ZONE 'Asia/Jakarta'; SELECT now();` → berhasil, tidak `invalid value for parameter "TimeZone"` (tzdata tersedia) → AC-3
- [x] `SELECT type, auth_method, error FROM pg_hba_file_rules` → tiga baris (`local`, `host`, `host`), semua `scram-sha-256`, tanpa error; `pg_authid.rolpassword` admin berawalan `SCRAM-SHA-256$` → AC-3
- [x] `current_user` → `foundation_admin` dengan `rolsuper = true`; database `foundation` ada → AC-3 (value sourcing: `POSTGRES_USER`, `POSTGRES_DB`)
- [x] Volume baru dengan password 15 karakter → container berhenti, log memuat `minimal 16 karakter`, volume tanpa `18/data` → AC-3 (value sourcing: password)
- [x] Setelah cluster ada, ganti `FOUNDATION_POSTGRES_PASSWORD` di env lalu `up` → koneksi baru dengan password lama berhasil, password baru ditolak; cluster tidak diinisialisasi ulang (`system_identifier` sama) → AC-3
- [x] Volume uji berisi `18/data.init` sisa → `up --wait` sehat, log memuat `Menghapus staging sisa inisialisasi`, `ls -A /var/lib/pgsql/18` → `backups data` → AC-3
- [x] Volume uji berisi `18/data` tanpa `PG_VERSION` → container `exited` dengan exit bukan nol, log memuat `tanpa PG_VERSION`, isi folder identik sebelum dan sesudah → AC-3
- [x] `docker compose exec postgres cat /proc/1/environ` → tidak memuat `POSTGRES_PASSWORD=`; `/proc/1/status` Uid 26 → AC-1, security model

## Commands: Compose, koneksi, dan port

- [x] `docker compose --env-file .env.infrastructure config --quiet` → exit 0 tanpa output → AC-4
- [x] Env file dengan `FOUNDATION_POSTGRES_PASSWORD=` kosong → `config --quiet` gagal, pesan menyebut `FOUNDATION_POSTGRES_PASSWORD`, nilai variabel lain tidak tercetak → AC-4
- [x] `docker compose --env-file .env.infrastructure up -d --wait postgres` → kembali setelah healthy; `ps` → `healthy` → AC-4
- [x] `docker compose --env-file .env.infrastructure port postgres 5432` → `127.0.0.1:<port>`; `docker inspect` binding hanya `HostIp 127.0.0.1` → AC-4 (value sourcing: `FOUNDATION_POSTGRES_PORT`, default `5432`, ganti misalnya `55432`)
- [x] Koneksi admin lewat `127.0.0.1:<port>` dengan password benar → berhasil, `server_version_num >= 180000` dan `server_version` sama dengan pin pada build terkunci; password salah → `password authentication failed` → AC-4 (value sourcing: versi server)
- [x] Tanpa `-p`, nama container `foundation-postgres-1` dan volume `foundation_pgsql_data` tidak bergantung pada nama folder → value sourcing: `name: foundation`

## Commands: persistensi dan shutdown

- [x] Catat `SELECT system_identifier FROM pg_control_system()`, `down` tanpa `-v`, `up -d --wait` → identitas sama, volume tetap ada → AC-5
- [x] Buka satu koneksi idle, `docker compose stop postgres` → selesai di bawah 30 detik, exit code container `0`; log start berikutnya memuat `database system was shut down at` tanpa `not properly shut down` atau `redo starts` → AC-5

## Commands: batas Compose dan secret

- [x] `docker compose --env-file .env.infrastructure config --services` → hanya `postgres`; tidak ada mount `/docker-entrypoint-initdb.d`, service aplikasi, migration, atau seed → AC-6
- [x] `grep -rni docker scripts/` → kosong (doctor dan serve tidak menjalankan Compose) → AC-6
- [x] `git check-ignore -v .env.infrastructure` → pola `.env.*`; `git check-ignore --no-index .env.example .env.infrastructure.example` → tidak diabaikan; `git status` tidak menampilkan `.env.infrastructure` → AC-7
- [x] Dari root, `bun -e 'console.log(process.env.FOUNDATION_POSTGRES_PASSWORD)'` → `undefined` → AC-7
- [x] `.env.infrastructure.example` → hanya `FOUNDATION_POSTGRES_PASSWORD=` kosong tanpa komentar; variabel lain berupa komentar dengan default → AC-7
- [x] `DATABASE_URL` dengan `foundation_admin` lalu `bun run doctor` → error, role superuser ditolak, password tidak tercetak → AC-7

## Commands: suite terisolasi

- [x] `bun run test:infrastructure` pada 2026-10-03 → 18 pass, 0 skip, 0 fail, 168 assertions; JUnit `.local/feature-3/infrastructure.xml` → AC-8. Test mengunci urutan validasi fingerprint penuh, RPM database sementara, import global, dan signature sebelum pemasangan; menolak key bundle, RPM unsigned, signature rusak, dan signer tepercaya lain tanpa memasang payload atau menjalankan scriptlet; juga menjaga dokumentasi refresh tetap sinkron.
- [x] Setelah suite: `docker ps -a`, `docker network ls`, `docker volume ls` tanpa `foundation-infra-test-*`; `CreatedAt` volume `foundation_pgsql_data` tidak berubah; tag `foundation-postgres:18-dev` tidak berubah → AC-8 (value sourcing: nama project dan tag image uji)
- [x] Buat satu test gagal secara sengaja → cleanup tetap menghapus resource project uji → AC-8
- [x] `DOCKER_HOST=unix:///nonexistent/docker.sock bun test ./tests/integration/infrastructure` pada 2026-10-01 → 4 pass, 12 skip dengan alasan `Docker daemon tidak dapat dihubungi`, 0 fail → AC-8

## UI / manual

- [x] Baca `docs/rules/infrastructure.md`, `docs/rules/database.md`, dan `README.md` → menjelaskan image proyek, path `/var/lib/pgsql/18/data` dan volume `pgsql_data`, `docker compose --env-file .env.infrastructure build --pull --no-cache postgres`, cara memperbarui `pins.json`, script `test:infrastructure`, serta tidak lagi menyebut image resmi `postgres:18` sebagai image yang dipakai → AC-9

## Acceptance-criteria coverage

- AC-1: build dan image (5 langkah), `/proc/1` · otomatis di INFRA-002
- AC-2: build terkunci dua kali, pin tidak ada, `image.json` · otomatis di INFRA-002
- AC-3: inisialisasi dan konfigurasi cluster (10 langkah) · otomatis di INFRA-003 dan INFRA-006
- AC-4: Compose, koneksi, dan port · otomatis di INFRA-001 dan INFRA-003
- AC-5: persistensi dan shutdown · otomatis di INFRA-004
- AC-6: `config --services`, `scripts/` · otomatis di INFRA-001
- AC-7: ignore Git, Bun, file contoh, doctor · otomatis di INFRA-001 dan INFRA-003
- AC-8: suite terisolasi (4 langkah) · otomatis di INFRA-005
- AC-9: dokumen, dibaca manual

# 0002. Infrastruktur PostgreSQL development

**Date**: 2026-09-28
**Status**: Accepted

## Summary

Anda mendapat server PostgreSQL 18 development dari image buatan sendiri berbasis Oracle Linux 10 slim dengan paket resmi PGDG (repository paket komunitas PostgreSQL). Image yang sama nanti menjadi dasar server database production, sehingga dev, CI, dan production tidak menyimpang. Dev memakai build terbaru dalam major 18, sedangkan test dan CI memakai versi yang dikunci agar hasilnya dapat diulang. Suite test terisolasi membuktikan startup, healthcheck, koneksi, dan persistensi tanpa menyentuh data dev Anda.

## Requirements

**User stories**:

- Sebagai pengembang, Anda dapat menjalankan PostgreSQL 18 lokal dengan satu perintah Compose, memakai password admin milik Anda sendiri, dan data tetap ada setelah container dibuat ulang.
- Sebagai pengelola CI, Anda dapat membangun image yang sama dari versi yang dikunci dan mencatat identitasnya sebagai bukti kandidat.
- Sebagai pemilik keamanan, Anda dapat memastikan credential admin tidak masuk Git, image, log, atau environment aplikasi.

**Acceptance criteria**:

1. **AC-1**: Image dibangun dari `infrastructure/postgres/Dockerfile` di atas `oraclelinux:10-slim` dengan paket `postgresql18-server` dari repo PGDG yang terverifikasi GPG, untuk `linux/arm64` dan `linux/amd64`. Sebelum memasang RPM repo, GnuPG mencantumkan sertifikat pada file key dan build memastikan tepat satu public key primary mempunyai fingerprint penuh 40 digit yang sama dengan konstanta. RPM database sementara kemudian memastikan RPM membaca tepat satu key ID yang sesuai tanpa deduplikasi. Key tambahan ditolak sebelum import ke RPM global; paket GnuPG sementara dan seluruh dependency yang baru dipasang dibuang setelah verifikasi. Build mewajibkan digest dan signature valid serta memastikan ID key penanda tangan cocok dengan PGDG. Hanya paket server dan dependensinya yang terpasang, tanpa `postgresql18-contrib`. Proses PostgreSQL berjalan sebagai user OS `postgres`, bukan root. Image tidak memuat password atau secret di `ARG`, `ENV`, maupun layer.
2. **AC-2**: Build tanpa variabel pin memakai tag `oraclelinux:10-slim` dan paket 18 terbaru dari PGDG. Build terkunci memakai digest indeks multi arch base image dan versi paket PGDG tepat dari `infrastructure/postgres/pins.json`; dua build terkunci menghasilkan digest base dan versi paket yang sama. Identitas image (digest base, versi paket terpasang, `server_version`, ID image, arsitektur) dicatat sebagai bukti.
3. **AC-3**: Cluster dibuat sekali pada volume kosong dengan autentikasi `scram-sha-256` untuk semua koneksi (tanpa `trust` atau `peer`), locale provider builtin `C.UTF-8`, encoding `UTF8`, timezone `UTC`, dan data checksums aktif. Superuser `foundation_admin` dan database `foundation` tersedia. Inisialisasi yang terputus tidak pernah menghasilkan cluster setengah jadi yang dianggap siap; cluster yang sudah ada tidak pernah diinisialisasi ulang atau diubah oleh entrypoint.
4. **AC-4**: `docker compose --env-file .env.infrastructure config --quiet` lulus tanpa mencetak secret, dan gagal dengan pesan yang menyebut `FOUNDATION_POSTGRES_PASSWORD` bila nilainya kosong. `up -d --wait postgres` baru selesai setelah healthcheck lulus lewat TCP. Port hanya dipublikasikan ke `127.0.0.1`. Koneksi admin dengan password benar berhasil dan versi server minimal 18; password salah ditolak.
5. **AC-5**: Setelah `down` tanpa `-v` lalu `up` lagi, `system_identifier` cluster tetap sama, sehingga data terbukti hidup di named volume. `stop` dan `down` mematikan server secara tertib dalam grace period, dan start berikutnya tidak menjalankan recovery.
6. **AC-6**: Compose root hanya berisi service `postgres`. Tidak ada service aplikasi, migration, seed, atau mount ke `/docker-entrypoint-initdb.d`. `doctor` dan `serve` tidak menjalankan atau menghentikan Compose.
7. **AC-7**: `.env.infrastructure` diabaikan Git melalui pola `.env.*` dengan pengecualian `.env.example` dan `.env.infrastructure.example`. File itu tidak dimuat otomatis oleh Bun. `.env.infrastructure.example` tersedia tanpa nilai secret. Doctor tetap menolak `DATABASE_URL` yang memakai role superuser.
8. **AC-8**: `bun run test:infrastructure` menjalankan suite terisolasi dengan project name unik, port bebas, dan password acak yang dibuat saat test, memakai build terkunci. Suite tidak pernah menyentuh project `foundation` atau volumenya; di akhir, termasuk saat test gagal, suite hanya menghapus container, network, dan volume milik project uji. Tanpa Docker, skenario yang membutuhkan daemon dilaporkan dilewati dengan alasan, bukan lulus.
9. **AC-9**: `docs/rules/infrastructure.md`, `docs/rules/database.md`, dan `README.md` menjelaskan image buatan sendiri, path data dan volume, perintah update dev (`docker compose --env-file .env.infrastructure build --pull --no-cache postgres`), cara memperbarui `pins.json`, dan script `test:infrastructure`, serta tidak lagi merujuk image resmi `postgres:18`.

## Decision

**Chosen option**: Image PostgreSQL 18 buatan sendiri di atas Oracle Linux 10 slim dengan paket PGDG, dibangun oleh Compose root, floating di dev dan terkunci di test serta CI, dibuktikan oleh suite Bun terisolasi.

Pilihan Anda yang mengikat build ini: base Oracle Linux 10 slim sebagai dasar dev dan production; paket dari PGDG; hanya paket server; Dockerfile di `infrastructure/postgres/`; entrypoint minimal milik proyek; locale provider builtin `C.UTF-8`; timezone `UTC`; project Compose dikunci `name: foundation`; log default ke stderr; update dev lewat rebuild manual; password dibuat dengan `openssl rand -hex 32` sesuai komentar di file contoh; `.gitignore` kembali memakai pola `.env.*`; suite terisolasi dengan bukti persistensi lewat `system_identifier`, yang hanya menghapus volume miliknya, dijalankan lewat script terpisah `test:infrastructure`. (basis: jawaban Anda pada sesi desain, `docs/scope/scope.md` fitur 3)

Keputusan implementasi yang saya tetapkan (pilihan, alasan, dan alternatif kedua):

- **Volume baru `pgsql_data` di `/var/lib/pgsql`**, dengan `PGDATA=/var/lib/pgsql/18/data`. Paket PGDG memakai UID `postgres` 26 dan path berbeda dari image resmi (UID 999), jadi volume baru mencegah bentrok kepemilikan dengan volume dari Compose lama. Mount di folder induk memberi ruang untuk `pg_upgrade --link` ke major berikutnya dalam volume yang sama. Alternatif kedua: tetap `postgres_data` dan entrypoint gagal dengan pesan jelas saat kepemilikan tidak cocok. (basis: pola mount induk pada image PostgreSQL 18 resmi, pemisahan data per major)
- **Inisialisasi lewat folder staging.** Entrypoint menjalankan `initdb` ke `/var/lib/pgsql/18/data.init`, membuat database `foundation` lewat `postgres --single` (tanpa server sementara di TCP), menulis konfigurasi, lalu memindahkan folder itu ke `PGDATA` dengan satu `mv` atomik. Folder staging sisa run yang terputus dihapus lalu inisialisasi diulang, karena belum pernah menjadi cluster aktif. `PGDATA` yang ada tetapi tanpa `PG_VERSION` membuat container berhenti dengan pesan jelas dan tanpa menyentuh isinya. Alternatif kedua: pola image resmi dengan server sementara yang hanya mendengar socket.
- **Password hanya saat runtime.** Entrypoint menolak inisialisasi bila `POSTGRES_PASSWORD` kosong atau kurang dari 16 karakter, meneruskannya ke `initdb --pwfile` lewat file sementara berizin 0600 yang langsung dihapus, tidak pernah mencetaknya, dan menghapus variabel itu dari environment sebelum `exec postgres`. Setelah cluster ada, perubahan password di env diabaikan; ganti lewat `ALTER ROLE`. Alternatif kedua: tanpa batas panjang minimum.
- **`pg_hba.conf` tanpa pengecualian**: `local all all scram-sha-256`, `host all all 0.0.0.0/0 scram-sha-256`, `host all all ::/0 scram-sha-256`, dengan `listen_addresses='*'` di dalam container. Host hanya membuka `127.0.0.1`. Env `POSTGRES_HOST_AUTH_METHOD` dihapus karena metode auth tidak boleh dilemahkan lewat konfigurasi. Alternatif kedua: `local all all peer`.
- **Shutdown cepat**: `STOPSIGNAL SIGINT` di Dockerfile dan `stop_grace_period: 30s` di Compose. SIGTERM bawaan Docker memicu smart shutdown yang menunggu semua klien, lalu SIGKILL setelah 10 detik dan recovery saat start berikutnya. Alternatif kedua: SIGTERM dengan grace period panjang.
- **Pemilihan repo per arsitektur** memakai `uname -m` saat build (`x86_64` atau `aarch64`) untuk URL `https://download.postgresql.org/pub/repos/yum/reporpms/EL-10-<arch>/pgdg-redhat-repo-latest.noarch.rpm`. Dockerfile memasang GnuPG sementara untuk menampilkan semua sertifikat key, mencocokkan satu-satunya fingerprint primary penuh dengan konstanta, lalu menghapus GnuPG dan seluruh dependency yang baru dipasang. RPM database sementara memastikan file key menghasilkan satu record key ID sebelum helper mengimpor key PGDG ke RPM global. Helper mewajibkan digest dan signature RPM yang valid, memastikan key penanda tangan cocok, lalu memasang repo RPM. Paket database dipasang dengan `gpgcheck=1`. Alternatif kedua: `TARGETARCH` dari BuildKit.
- **Nama image lokal** `foundation-postgres:18-dev` untuk dev dan `foundation-postgres:18-pinned` untuk test, sehingga build terkunci tidak menimpa image dev. Nama satu segmen tidak bisa dipublikasikan pihak lain di Docker Hub.
- **Format `pins.json`**: `{ "baseImage": "oraclelinux:10-slim@sha256:<digest indeks>", "postgresPackageVersion": "<versi>-<release>" }`, misalnya `18.N-1PGDG.rhel10`; nilai tepat dibaca dari repo saat build. Digest harus digest indeks multi arch, bukan digest satu platform.

## Feature design

**Data model sketch**: Tidak ada entitas, migration, seed, atau schema baru; fitur ini tidak membutuhkan schema (sumber: `docs/scope/scope.md` fitur 3). Data yang dikelola hanya volume `pgsql_data` berisi cluster PostgreSQL. Role runtime, schema `common`, `users`, `auth`, dan grants milik fitur 5 dan 6.

**State transitions** (volume dan container):

- Volume kosong → staging `18/data.init` → `18/data` siap (setelah `mv` atomik) → server berjalan.
- Staging tersisa dari run terputus → dihapus → inisialisasi ulang dari awal.
- `18/data` tanpa `PG_VERSION` → container berhenti dengan exit bukan nol dan pesan jelas; reset volume tetap tindakan manual.
- `18/data` dengan `PG_VERSION` → langsung `exec postgres`, tanpa perubahan apa pun.

**Interface surface** (perintah dan artefak, bukan endpoint HTTP):

| Perintah atau artefak | Fungsi | Input | Output | Kesalahan penting |
| --- | --- | --- | --- | --- |
| `docker compose --env-file .env.infrastructure config --quiet` | Validasi konfigurasi | `.env.infrastructure` | Exit 0 tanpa output | Exit bukan nol dan pesan variabel wajib bila password kosong |
| `docker compose --env-file .env.infrastructure up -d --wait postgres` | Build bila image belum ada, start, tunggu healthy | Env di atas | Container healthy di `127.0.0.1:<port>` | Port terpakai, build gagal (jaringan, GPG), inisialisasi ditolak |
| `docker compose --env-file .env.infrastructure ps` | Status | Tidak ada | Status healthy | Tidak ada |
| `docker compose --env-file .env.infrastructure build --pull --no-cache postgres` | Update patch dev dan ambil ulang paket PGDG | Tidak ada | Image dev baru | Jaringan atau GPG gagal |
| `docker compose --env-file .env.infrastructure down` | Stop, volume dipertahankan | Tidak ada | Container dan network dihapus | Tidak ada |
| `bun run test:infrastructure` | Suite terisolasi | `pins.json` | JUnit `.local/feature-3/infrastructure.xml`, identitas `.local/feature-3/image.json` | Skenario daemon dilewati tanpa Docker; gagal bila Compose tidak mendukung `up --wait` |
| `infrastructure/postgres/pins.json` | Sumber pin test dan CI | Diperbarui manual lewat PR | Digest base dan versi paket | Digest satu platform ditolak saat review |

**Value sourcing**:

| Aksi | Nilai yang dihasilkan atau dipakai | Sumber |
| --- | --- | --- |
| Build dev | Base image | `FOUNDATION_POSTGRES_BASE_IMAGE`, default `oraclelinux:10-slim` |
| Build dev | Versi paket | `FOUNDATION_POSTGRES_PACKAGE_VERSION`, kosong berarti paket 18 terbaru dari PGDG |
| Build terkunci | Digest base dan versi paket | `infrastructure/postgres/pins.json`, dibaca test atau CI lalu diteruskan lewat env ke build args |
| Build | URL repo RPM PGDG | Hasil `uname -m` saat build dipetakan ke `EL-10-x86_64` atau `EL-10-aarch64` |
| Build | Fingerprint dan isi key PGDG | GnuPG memastikan satu-satunya fingerprint primary penuh sama dengan konstanta; RPM database sementara memastikan satu key ID tanpa deduplikasi sebelum import global |
| Build | Signature repo RPM yang diizinkan | Mode verifikasi RPM mewajibkan digest dan signature valid; ID key signature harus sama dengan delapan karakter terakhir fingerprint PGDG yang dipilih |
| Menamai image | Tag image | `FOUNDATION_POSTGRES_IMAGE`, default `foundation-postgres:18-dev`; test mengisi `foundation-postgres:18-pinned` |
| Inisialisasi | Superuser dan database | `POSTGRES_USER=foundation_admin` dan `POSTGRES_DB=foundation` di Compose (bukan secret) |
| Inisialisasi | Password admin | `FOUNDATION_POSTGRES_PASSWORD` dari `.env.infrastructure` lewat `--env-file`; test membuat nilai acak per run di env file sementara |
| Inisialisasi | Locale, encoding, auth | Konstanta entrypoint: builtin `C.UTF-8`, `UTF8`, `scram-sha-256` (keputusan spec ini) |
| Inisialisasi | Timezone | `ENV TZ=UTC` di Dockerfile, terbaca `initdb` sebagai `timezone` dan `log_timezone` |
| Publikasi port | Port host | `FOUNDATION_POSTGRES_PORT`, default `5432`; test memilih port bebas lewat listener Bun port 0 |
| Nama project | Nama container, network, volume | `name: foundation` di Compose; test memakai `-p foundation-infra-test-<8 hex acak>` |
| Bukti persistensi | Identitas cluster | `system_identifier` dari `pg_catalog.pg_control_system()` |
| Bukti versi | Versi server | `server_version_num` dan `server_version` |
| Bukti konfigurasi | Locale provider, encoding, timezone, checksums, aturan auth | `pg_database.datlocprovider` dan `datlocale`, `pg_encoding_to_char(encoding)`, `SHOW timezone`, `SHOW data_checksums`, `pg_hba_file_rules` |
| Bukti image | Versi paket terpasang, daftar paket, user proses, ID image, arsitektur | `rpm -q` dan `rpm -qa` serta `id -u` lewat `docker compose exec`, `docker image inspect` |
| Bukti shutdown | Shutdown tertib | Log start berikutnya tidak memuat pesan recovery atau `not properly shut down` |

**Key invariants**:

- Compose root hanya mengelola layanan pendukung; saat ini hanya `postgres`.
- Tidak ada migration, seed, atau `initdb.d` saat container start. Entrypoint tidak menjalankan SQL apa pun pada cluster yang sudah ada.
- Inisialisasi hanya terjadi pada `PGDATA` yang belum ada, dan cluster menjadi terlihat hanya setelah `mv` atomik.
- Volume dev tidak pernah dihapus oleh agent, doctor, serve, atau test. Cleanup test menolak nama project yang tidak berawalan `foundation-infra-test-`.
- Satu volume memakai satu major (18); pindah major membutuhkan prosedur upgrade terpisah.
- Test dan CI selalu memakai `pins.json`; dev tidak pernah membutuhkannya.

**Security model**:

- `foundation_admin` adalah superuser untuk provisioning saja (runner fitur 5 dan 6), tidak pernah menjadi `DATABASE_URL` backend atau worker. Doctor tetap menolak runtime superuser.
- Semua koneksi memakai `scram-sha-256`; tidak ada `trust` atau `peer`. Port hanya terbuka di `127.0.0.1`.
- Secret hanya ada di `.env.infrastructure` (diabaikan Git, dimuat eksplisit lewat `--env-file`, tidak dimuat Bun) dan di env container saat runtime. Tidak ada secret di build args, `ENV`, atau layer image. Entrypoint menghapus password dari environment proses sebelum `exec postgres`. Test menyamarkan password acaknya pada output yang dicetak saat gagal.
- Siapa pun dengan akses Docker dapat membaca env container lewat `docker inspect`. Ini diterima untuk development karena akses Docker setara root di host.
- Rantai pasok: public key dan repo RPM diambil lewat HTTPS, GnuPG memeriksa fingerprint primary penuh untuk setiap sertifikat pada file key, RPM database sementara memastikan hanya satu key ID dibaca, mode RPM mewajibkan digest dan signature valid, ID key signature harus cocok dengan key PGDG yang diharapkan sebelum instalasi, `gpgcheck=1`, dan base image dikunci dengan digest di test serta CI.
- Proses server berjalan sebagai user OS `postgres`, bukan root.

**Configuration required**:

- `FOUNDATION_POSTGRES_PASSWORD`: password `foundation_admin`, wajib, secret, minimal 16 karakter; disarankan `openssl rand -hex 32`.
- `FOUNDATION_POSTGRES_PORT`: port host, opsional, default `5432`.
- `FOUNDATION_POSTGRES_BASE_IMAGE`: base image build, opsional; test dan CI mengisinya dari `pins.json`.
- `FOUNDATION_POSTGRES_PACKAGE_VERSION`: versi paket PGDG tepat, opsional; test dan CI mengisinya dari `pins.json`.
- `FOUNDATION_POSTGRES_IMAGE`: tag image lokal, opsional, default `foundation-postgres:18-dev`.
- `infrastructure/postgres/pins.json`: file pin yang di commit, bukan secret.

Isi `.env.infrastructure.example`: `FOUNDATION_POSTGRES_PASSWORD=` kosong dengan komentar perintah generate dan peringatan agar tidak dipakai di `.env` aplikasi; variabel lain sebagai komentar beserta nilai defaultnya.

**Critical test scenarios** (registry `tests/scenarios/infrastructure.json`, runner `bun:test`, file `tests/integration/infrastructure/postgres.test.ts`, override `tests/integration/infrastructure/compose.test.yml` yang mengisi `restart: "no"` dan label `dev.foundation.purpose=infrastructure-test`):

1. `INFRA-001` (tanpa daemon): Compose hanya punya service `postgres`, tanpa mount `initdb.d`, port terikat ke `127.0.0.1`; `git check-ignore` mengabaikan `.env.infrastructure` dan tidak mengabaikan kedua file contoh; Bun di folder sementara tidak memuat `.env.infrastructure`; file contoh tanpa nilai secret; `scripts/` tidak memanggil `docker`; `config --quiet` dengan password kosong gagal, menyebut variabelnya, dan tidak mencetak nilai lain. Membuktikan **AC-4**, **AC-6**, dan **AC-7**.
2. `INFRA-002`: build terkunci dari `pins.json`; identitas image tercatat; `id -u` bukan 0; paket `postgresql18-contrib` tidak ada; `docker image inspect` dan history tidak memuat variabel password. Membuktikan **AC-1** dan **AC-2**.
3. `INFRA-003`: `up --wait` sampai healthy; Bun.SQL sebagai admin di `127.0.0.1:<port>` berhasil; versi sama dengan pin dan minimal 18; `datlocprovider` builtin dengan `C.UTF-8`, encoding `UTF8`, timezone `UTC`, `data_checksums` on, semua aturan `pg_hba_file_rules` memakai `scram-sha-256`; password salah ditolak; `docker compose port` hanya `127.0.0.1`. Membuktikan **AC-3** dan **AC-4**.
4. `INFRA-004`: baca `system_identifier`, `down` tanpa `-v`, `up`, identitas sama; `stop` selesai dalam grace period dan log start berikutnya tanpa recovery. Membuktikan **AC-5**.
5. `INFRA-005`: kondisi project `foundation` dan volumenya (ada atau tidak, beserta waktu pembuatan) sama sebelum dan sesudah suite; setelah suite tidak ada container, network, atau volume milik project uji; fungsi cleanup menolak nama tanpa awalan uji; tanpa Docker skenario daemon tercatat dilewati dengan alasan. Membuktikan **AC-8**.
6. `INFRA-006`: volume uji berisi staging sisa run terputus tetap berakhir dengan cluster sehat; volume uji dengan `18/data` tanpa `PG_VERSION` membuat container berhenti dengan exit bukan nol dan pesan jelas, dan isinya tidak berubah. Membuktikan **AC-3**.

**AC-9** diperiksa oleh `/check verify` dengan membaca dokumen terkait. Bukti arsitektur kedua (`linux/amd64` di Mac arm64) memakai `docker buildx build --platform linux/amd64` untuk build saja; eksekusi amd64 native menunggu CI fitur 11.

## Build plan

Urutan mengikuti Tracer Bullet pada `docs/scope/scope.md`: amankan batas secret dulu, lalu satu jalur tipis dari Dockerfile, Compose, sampai suite yang membuktikan koneksi nyata, kemudian tebalkan dengan pin, persistensi, kegagalan, dan dokumentasi. Tidak ada migration pada fitur ini.

1. Kembalikan `.gitignore` ke pola `.env.*` dengan pengecualian `!.env.example` dan `!.env.infrastructure.example` (pertahankan `dist/` dari perubahan lokal), lalu buat `.env.infrastructure.example`. Memenuhi **AC-7**.
2. Jalur tipis end to end: tulis `infrastructure/postgres/Dockerfile` (base lewat `ARG`, repo PGDG per arsitektur, validasi GnuPG atas satu-satunya fingerprint primary penuh dan RPM database sementara sebelum impor global, hapus paket GnuPG sementara, wajibkan signature dan digest RPM yang cocok dengan key PGDG sebelum instalasi, `postgresql18-server` saja, `ENV TZ=UTC`, `PATH` ke `/usr/pgsql-18/bin`, `USER postgres`, `STOPSIGNAL SIGINT`) dan entrypoint (staging, `initdb` dengan scram dan builtin `C.UTF-8`, `postgres --single` untuk database, `pg_hba.conf`, `mv` atomik, hapus password dari env, `exec postgres`). Ubah `docker-compose.yml`: `name: foundation`, `build` dengan args, `image`, volume `pgsql_data` di `/var/lib/pgsql`, healthcheck `pg_isready -h 127.0.0.1`, `stop_grace_period: 30s`, hapus `POSTGRES_HOST_AUTH_METHOD`. Buat suite dengan helper project unik, port bebas, env file sementara, cleanup berpagar, override Compose uji, lalu `INFRA-003` dan `INFRA-005`; tambahkan script `test:infrastructure` dan registry. Memenuhi **AC-1**, **AC-3**, **AC-4**, dan **AC-8**.
3. Reproducibility: isi `pins.json` dengan digest indeks multi arch dan versi paket PGDG yang dibaca dari repo, sambungkan build terkunci di suite, tambahkan `INFRA-002` dan penulisan `.local/feature-3/image.json`. Jalankan `docker buildx build --platform linux/amd64` sekali dan catat hasilnya. Memenuhi **AC-1** dan **AC-2**.
4. Ketahanan: tambahkan `INFRA-004` (persistensi dan shutdown tertib) dan `INFRA-006` (inisialisasi terputus dan `PGDATA` rusak). Memenuhi **AC-3** dan **AC-5**.
5. Batas dan dokumentasi: tambahkan `INFRA-001`; perbarui `docs/rules/infrastructure.md` (image, path, volume, `build --pull --no-cache`, prosedur pembaruan pin, script test, sisa volume lama), struktur di `docs/rules/database.md`, dan `README.md`. Jalankan suite penuh dan alur dev sekali dengan `.env.infrastructure` milik Anda, lalu catat bukti beserta keterbatasannya. Memenuhi **AC-4**, **AC-6**, **AC-7**, dan **AC-9**.

## Consequences

**Positive**:

- Dev, CI, dan production memakai dasar OS dan paket yang sama, sehingga perilaku server tidak menyimpang antar environment.
- CI dapat membangun ulang image yang sama dari digest dan versi paket, dan identitasnya tercatat sebagai bukti.
- Collation builtin tidak bergantung pada glibc, sehingga upgrade base image tidak merusak index teks.
- Bukti infrastruktur dapat diulang tanpa menyentuh data dev, dan batas secret diperiksa otomatis.

**Negative / tradeoffs**:

- Proyek kini memiliki Dockerfile dan entrypoint sendiri. Patch keamanan hanya masuk saat Anda rebuild, dan kemudahan image resmi (initdb.d, variabel tambahan, dokumentasi komunitas yang luas) hilang.
- Build pertama butuh internet dan beberapa menit; suite infrastruktur lambat dan membutuhkan Docker.
- `C.UTF-8` mengurutkan teks berdasarkan code point, bukan urutan bahasa. Kolom yang butuh urutan linguistik harus memakai collation ICU per kolom.
- Dev floating dapat berjalan di patch yang lebih baru daripada CI. Pin tidak diperbarui otomatis; perlu disiplin PR berkala.
- Password admin terlihat lewat `docker inspect` bagi siapa pun yang punya akses Docker.
- Kombinasi Oracle Linux 10 dan PGDG lebih jarang dipakai daripada image resmi, sehingga contoh dan diagnosis komunitas lebih sedikit.

**Neutral**:

- Volume lama `foundation_postgres_data` (bila ada dari Compose sebelumnya) dibiarkan utuh dan tidak dipakai; penghapusannya manual dan dicatat di aturan infrastruktur. Revert satu commit mengembalikan Compose lama beserta volumenya, jadi tidak perlu migration plan terpisah.
- Aturan infrastruktur berubah dari image resmi `postgres:18` menjadi image proyek.
- Konfigurasi server lain (misalnya `max_connections`, memory) tetap default sampai fitur 12 mengukur kebutuhannya.

## Follow-up

- [ ] Fitur 11: jalankan `test:infrastructure` di runner CI amd64 dengan Docker agar eksekusi amd64 native terbukti.
- [ ] Fitur 13: turunkan image production dari Dockerfile ini, termasuk TLS, konfigurasi resource, dan kebijakan log production.
- [ ] Fitur 14 atau spec terpisah: prosedur upgrade major (misalnya `pg_upgrade --link` dalam volume yang sama) sebelum major 19 dipakai.
- [ ] Fitur 12: bila `pg_stat_statements` dibutuhkan, keputusan "hanya paket server" pada AC-1 perlu ditinjau ulang lewat `/architect`.
- [ ] Pertimbangkan pemeriksaan berkala pin (digest base dan versi PGDG) karena tidak ada bot update otomatis.
- [ ] `AGENTS.md` menyebut PostgreSQL 18 lewat Compose; pointer ke image proyek dan `test:infrastructure` diperbarui oleh `/sync` setelah fitur selesai.

## Rationale

Alasan dan perbandingan pilihan ada di [rationale.md](rationale.md).

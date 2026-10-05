# Infrastruktur pendukung development

`docker-compose.yml` berada di root monorepo dan hanya mengelola layanan pendukung di luar runtime aplikasi. Saat ini layanan yang didefinisikan adalah PostgreSQL 18 dari image buatan proyek (spec 0002). Frontend Angular, backend Bun/Elysia, dan worker tidak dimasukkan sebagai service Compose; jalankan melalui `bun run serve` sesuai [aturan development](development-commands.md).

Cache, broker antrean, object storage, atau layanan pendukung lain dapat ditambahkan jika kebutuhan fitur telah diputuskan dalam specs. Jangan menambahkan layanan contoh tanpa kebutuhan atau menjadikan Compose root tempat build SDK, test runner, migration, seed, maupun orchestration aplikasi. Dockerfile aplikasi/worker tetap dapat digunakan untuk deployment mandiri; file deployment runtime diatur terpisah ketika diperlukan.

Topologi deployment rujukan berada terpisah di `deploy/compose.yaml` (spec 0012, project `foundation-deploy`): edge, backend, PostgreSQL dari image `foundation-postgres:18-pinned`, dan job migration, dengan network internal, batas resource, dan credential per service dari `.env.deploy`. File itu tidak membangun image dan tidak dipakai untuk development; `docker-compose.yml` root tetap hanya infrastruktur pendukung development. Langkah build, provisioning, migration, rotasi password, dan pembaruan sertifikat ada di [aturan deployment](deployment.md).

## Image PostgreSQL proyek

Server dibangun dari `infrastructure/postgres/Dockerfile` di atas `oraclelinux:10-slim` dengan paket `postgresql18-server` dari repository resmi PGDG. Image yang sama nanti menjadi dasar server database production, sehingga dev, CI, dan production memakai OS dan paket yang sama.

- Repo PGDG dipilih per arsitektur (`x86_64` atau `aarch64`). Dockerfile memasang GnuPG sementara untuk membaca semua sertifikat public key, mewajibkan tepat satu fingerprint primary 40 digit yang sama dengan konstanta, lalu membuang GnuPG dan seluruh dependency paket yang baru dipasang. Sebelum import ke RPM global, helper mengimpor key yang sama ke RPM database sementara dan memastikan tepat satu key ID yang sesuai terlihat tanpa deduplikasi. Key tambahan ditolak. Mode verifikasi RPM mewajibkan digest dan signature valid; ID key penanda tangan juga harus cocok sebelum RPM repo dipasang atau scriptlet dijalankan. Paket database dipasang dengan `gpgcheck=1`.
- Hanya paket server beserta dependensinya yang terpasang, tanpa `postgresql18-contrib`. `tzdata` ikut dipasang karena server PGDG membaca zona waktu dari `/usr/share/zoneinfo` tetapi tidak mendeklarasikannya; tanpa itu timezone menjadi `UTC0` dan zona bernama ditolak.
- Proses server berjalan sebagai user OS `postgres` (UID 26), bukan root. `STOPSIGNAL SIGINT` memicu fast shutdown sehingga `stop` dan `down` selesai dalam `stop_grace_period: 30s` tanpa recovery pada start berikutnya.
- Log server ditulis ke stderr dan dibaca lewat `docker compose logs`. `logging_collector` dimatikan karena paket PGDG menyalakannya secara default.
- Image tidak memuat password atau secret pada `ARG`, `ENV`, maupun layer. Password hanya diberikan saat runtime.

Entrypoint `infrastructure/postgres/docker-entrypoint.sh` adalah milik proyek dan sengaja minimal. Pada volume kosong, entrypoint menjalankan `initdb` ke folder staging `/var/lib/pgsql/18/data.init` dengan `scram-sha-256` untuk semua koneksi, locale provider builtin `C.UTF-8`, encoding `UTF8`, timezone `UTC`, dan data checksums aktif. Entrypoint lalu membuat database `foundation`, menulis konfigurasi, dan memindahkan staging ke `PGDATA` dengan satu `mv` atomik. Staging sisa run yang terputus dihapus lalu inisialisasi diulang. `PGDATA` yang ada tetapi tanpa `PG_VERSION` membuat container berhenti dengan pesan jelas tanpa mengubah isinya. Cluster yang sudah ada tidak pernah diinisialisasi ulang atau diubah; entrypoint tidak menjalankan SQL apa pun pada cluster itu.

Tidak ada dukungan `/docker-entrypoint-initdb.d`, `POSTGRES_HOST_AUTH_METHOD`, atau variabel tambahan image resmi. Metode autentikasi tidak dapat dilemahkan lewat konfigurasi.

## Konfigurasi dan pengoperasian

Docker Engine dan Docker Compose v2 yang mendukung `up --wait` diperlukan untuk menjalankan infrastruktur lokal. Compose tidak menambah dependency pada `package.json`. Build pertama membutuhkan internet untuk base image dan repository PGDG.

1. Salin `.env.infrastructure.example` ke `.env.infrastructure` lalu isi `FOUNDATION_POSTGRES_PASSWORD` dengan hasil `openssl rand -hex 32` (minimal 16 karakter). File asli diabaikan Git melalui pola `.env.*`; kedua file contoh tidak berisi secret.
2. Jalankan perintah dari root:

```sh
docker compose --env-file .env.infrastructure config --quiet
docker compose --env-file .env.infrastructure up -d --wait postgres
docker compose --env-file .env.infrastructure ps
```

`up` membangun image `foundation-postgres:18-dev` bila belum ada. Gunakan `config --quiet` untuk validasi tanpa mencetak konfigurasi yang telah memuat secret; perintah itu gagal dan menyebut `FOUNDATION_POSTGRES_PASSWORD` bila nilainya kosong. Project Compose dikunci dengan `name: foundation`, sehingga nama container, network, dan volume tidak bergantung pada nama folder.

| Variabel | Fungsi | Default |
| --- | --- | --- |
| `FOUNDATION_POSTGRES_PASSWORD` | Password `foundation_admin`, wajib dan secret. Hanya dipakai saat cluster pertama kali dibuat. | Tidak ada |
| `FOUNDATION_POSTGRES_PORT` | Port host. | `5432` |
| `FOUNDATION_POSTGRES_IMAGE` | Tag image lokal. | `foundation-postgres:18-dev` |
| `FOUNDATION_POSTGRES_BASE_IMAGE` | Base image build. Test dan CI mengisinya dari `pins.json`. | `oraclelinux:10-slim` |
| `FOUNDATION_POSTGRES_PACKAGE_VERSION` | Versi paket PGDG tepat. Test dan CI mengisinya dari `pins.json`. | Kosong, paket 18 terbaru |

Setelah cluster ada, perubahan password di env diabaikan. Ganti password lewat `ALTER ROLE foundation_admin PASSWORD ...` dengan koneksi admin, lalu perbarui `.env.infrastructure`.

PostgreSQL tersedia pada `127.0.0.1:5432`; `FOUNDATION_POSTGRES_PORT` dapat mengubah port host jika ada layanan lokal lain. Port hanya dipublikasikan ke `127.0.0.1`. Port infrastruktur bukan target cleanup `serve`. Healthcheck memakai `pg_isready` lewat TCP dan membuktikan server menerima koneksi, bukan schema, grants, migration, atau kesiapan aplikasi.

Data disimpan pada named volume `pgsql_data` (nama Docker `foundation_pgsql_data`) yang di mount ke `/var/lib/pgsql`, dengan `PGDATA=/var/lib/pgsql/18/data`. Mount di folder induk memberi ruang untuk upgrade major ke folder sebelahnya dalam volume yang sama. Satu volume memakai satu major; jangan mengganti major PostgreSQL pada volume lama tanpa prosedur upgrade terpisah.

Volume lama `foundation_postgres_data` dari Compose sebelumnya (image resmi `postgres:18`, UID 999, mount `/var/lib/postgresql`) dibiarkan utuh dan tidak dipakai. Periksa isinya bila perlu, lalu hapus secara manual dengan `docker volume rm foundation_postgres_data` ketika Anda yakin datanya tidak dibutuhkan.

Port infrastruktur tidak boleh tumpang tindih dengan frontend `8889`, backend `8888`, atau port HTTP worker. Jangan mendaftarkan port PostgreSQL sebagai port layanan runtime pada `config/development.json`; seleksi dan cleanup worker hanya memakai port worker itu sendiri.

Batas development saat ini adalah 1 GiB memory, 2 CPU, dan 128 MiB shared memory. Konfigurasi server lain tetap default. Sesuaikan dengan kebutuhan yang terukur dan jangan menganggapnya bukti kapasitas production.

Hentikan layanan dengan:

```sh
docker compose --env-file .env.infrastructure down
```

Perintah tersebut mempertahankan named volume. Penghapusan volume merupakan reset data yang terpisah dan tidak dijalankan otomatis oleh agent, doctor, serve, atau test.

## Pembaruan image dan pin

Dev memakai build terbaru dalam major 18. Patch keamanan hanya masuk saat Anda rebuild, jadi perbarui image dev secara berkala:

```sh
docker compose --env-file .env.infrastructure build --pull --no-cache postgres
docker compose --env-file .env.infrastructure up -d --wait postgres
```

`--pull` mengambil base image terbaru, sedangkan `--no-cache` menjalankan ulang langkah pemasangan paket agar patch baru dari PGDG tidak tertutup cache build.

Test dan CI selalu memakai `infrastructure/postgres/pins.json`, sehingga hasilnya dapat diulang. Dev tidak membutuhkan file itu.

```json
{
  "baseImage": "oraclelinux:10-slim@sha256:<digest indeks multi arch>",
  "postgresPackageVersion": "<versi>-<release>"
}
```

Cara memperbarui pin lewat PR:

1. Baca digest indeks multi arch dengan `docker buildx imagetools inspect oraclelinux:10-slim`. Pakai baris `Digest` teratas (media type image index), bukan digest satu platform.
2. Baca versi paket terbaru yang tersedia untuk kedua arsitektur di `https://download.postgresql.org/pub/repos/yum/18/redhat/rhel-10.<minor>-x86_64/` dan `rhel-10.<minor>-aarch64/`, dengan `<minor>` sesuai rilis Oracle Linux pada base image. Nilainya berbentuk `18.N-RPGDG.rhel10.M`.
3. Perbarui `pins.json`, jalankan `bun run test:infrastructure`, dan lampirkan `.local/feature-3/image.json` pada PR. Reviewer menolak digest satu platform.

Tidak ada bot update otomatis untuk pin; jadwalkan pemeriksaan berkala.

## Provisioning database dan batas credential

`foundation_admin` dibuat oleh entrypoint proyek sebagai superuser untuk provisioning awal (runner fitur model data dan migration). Jangan gunakan credential tersebut sebagai `DATABASE_URL` backend atau worker; doctor menolak runtime superuser. Simpan credential Compose pada `.env.infrastructure`, yang diberikan eksplisit melalui `--env-file`, agar tidak dimuat otomatis sebagai `.env` runtime Bun. Jangan mengekspor credential administrator ke environment aplikasi.

Entrypoint menghapus password dari environment proses server sebelum `exec postgres`. Siapa pun dengan akses Docker tetap dapat membaca env container lewat `docker inspect`; ini diterima untuk development karena akses Docker setara root di host.

Compose hanya membuat database dasar `foundation`. Provisioning role migration/runtime, schema `common`, `users`, `auth`, grants, migration, dan seed mengikuti [aturan database](database.md) melalui langkah/runner terpisah. Setelah provisioning selesai, `.env` aplikasi berisi DSN role backend dengan host/port yang sesuai; setiap worker memakai credential sendiri.

`bun run doctor` dan `bun run serve` tidak otomatis menjalankan atau menghentikan Compose. Siapkan infrastruktur serta database terlebih dahulu, lalu jalankan doctor/serve. Docker tidak menjadi prasyarat runtime jika memakai PostgreSQL eksternal yang memenuhi aturan project.

## Tanggung jawab agent dan verifikasi

Agent utama dan subagent yang mengubah infrastruktur wajib membaca aturan ini serta aturan database/keamanan yang relevan. Tetapkan satu pemilik Compose, Dockerfile, pin, port, volume, dan konfigurasi bersama. Perubahan layanan pendukung harus menyebut kebutuhan specs dan dampaknya pada credential, resource, kesiapan, serta persistensi data.

Buktikan infrastruktur dengan suite terisolasi:

```sh
bun run test:infrastructure
```

Suite di `tests/integration/infrastructure/` (registry `tests/scenarios/infrastructure.json`, skenario `INFRA-001` sampai `INFRA-006`) membangun image terkunci `foundation-postgres:18-pinned` dari `pins.json`, lalu membuktikan startup, healthcheck, koneksi admin, konfigurasi cluster, persistensi lewat `system_identifier`, shutdown tertib, inisialisasi terputus, dan batas secret. Setiap project uji bernama `foundation-infra-test-<8 hex acak>` dengan port bebas dan password acak, memakai override `compose.test.yml` tanpa restart otomatis. Di akhir, termasuk saat test gagal, suite hanya menghapus container, network, dan volume milik project uji; project `foundation` dan volumenya tidak pernah disentuh. Tanpa Docker, skenario yang membutuhkan daemon dilaporkan dilewati beserta alasannya.

Hasil JUnit tersimpan di `.local/feature-3/infrastructure.xml` dan identitas image (digest base, versi paket, `server_version`, ID image, arsitektur, daftar paket) di `.local/feature-3/image.json`. Suite ini adalah langkah pertama tier nyata gate CI `bun run test:ci:real` (spec 0010), yang dijalankan job `real` pada `ubuntu-24.04` setiap push dan pull request; image `foundation-postgres:18-pinned` dibangun dari `pins.json` pada job yang sama, lalu dipakai langkah tier nyata berikutnya. JUnit dan `image.json` tersalin ke bundle `.local/feature-11/evidence/real/`, dan laporan gate menampilkan identitas image dari `image.json` itu. Docker yang tidak tersedia membuat tier nyata gagal, bukan lulus dengan skip. Hasil eksekusi amd64 di GitHub Actions dicatat dari run setelah push, bukan disimpulkan dari run lokal. Laporkan pemeriksaan yang belum dapat dijalankan; YAML yang dapat diparse saja bukan bukti container bekerja.

## Referensi

- [Repository RPM PostgreSQL (PGDG)](https://yum.postgresql.org/).
- [initdb PostgreSQL 18](https://www.postgresql.org/docs/18/app-initdb.html) dan [provider collation builtin](https://www.postgresql.org/docs/18/locale.html).
- [Shutdown server PostgreSQL 18](https://www.postgresql.org/docs/18/server-shutdown.html).
- [Image Oracle Linux resmi](https://hub.docker.com/_/oraclelinux).
- [Konfigurasi service Docker Compose](https://docs.docker.com/reference/compose-file/services/).

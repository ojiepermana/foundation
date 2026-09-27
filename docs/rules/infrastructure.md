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

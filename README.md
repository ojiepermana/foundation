# Foundation

Fondasi aplikasi Angular dan Elysia dengan Bun native. Satu `package.json`, `bun.lock`, dan instalasi `node_modules` di root.

## Mulai lokal

Prasyarat: Bun **1.4.2**, PostgreSQL **18**, Redis **7.2+**, SMTP, serta Node **22.23.1** atau versi yang didukung Angular untuk tooling frontend. Backend, worker, migrasi, dan CLI dijalankan Bun. Angular memakai core 22.1.6 dan CLI/build 22.1.8.

```sh
bun install --frozen-lockfile
cp .env.example .env
```

Isi `.env`, termasuk database yang sudah dibuat, Redis, SMTP, dan `APP_ENCRYPTION_KEY`. Generate key sekali dan simpan dengan aman:

```sh
bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"))'
bun run db:migrate
bun run dev
```

Frontend: [localhost:8088](http://localhost:8088). API: [localhost:8888/api/health/live](http://localhost:8888/api/health/live). Angular memproksi `/api` sehingga cookie dan CSRF menggunakan origin yang sama. Buka frontend memakai `localhost`, sesuai `APP_URL` dan RP ID passkey.

`bun run dev` menjalankan Angular, API, dan worker. Satu proses gagal akan menghentikan proses lain agar kegagalan tidak tersembunyi. `Ctrl+C` menghentikan semuanya. Menjalankan API atau worker sendiri tersedia melalui `dev:api`, `dev:worker`, `start:api`, dan `start:worker`.

Pada workspace pengembangan ini, database lokal `foundation` dan `foundation_test` sudah disiapkan. `.env` lokal memakai SMTP 127.0.0.1:1025 sebagai placeholder. Isi SMTP Anda sebelum mengirim aktivasi akun sebenarnya. Uji otomatis menggunakan SMTP sink tersendiri dan tidak mengirim ke pihak luar.

## Akun pertama

```sh
bun run user:register --name "Nama Admin" --email "admin@example.com" --role admin
bun run user:resend-activation --email "admin@example.com"
```

Role hanya `admin` atau `user`. Akun dibuat dalam status pending; worker mengirim email aktivasi. CLI tidak menerima atau mencetak password/token. Tautan email digunakan untuk menetapkan password 12–128 karakter. Aktivasi berlaku 24 jam, reset 30 menit, challenge passkey 5 menit, dan session 7 hari, dapat diatur melalui env.

Sesudah masuk, buka Profil untuk mengubah nama/password dan menambahkan passkey. Pendaftaran/penghapusan passkey memerlukan konfirmasi password yang masih berlaku. Login memakai passkey tidak dianggap sebagai konfirmasi password. Admin dapat mencari pengguna, mengganti nama/role, dan menonaktifkan akses. Admin aktif terakhir dilindungi. Akun pending tetap harus menyelesaikan aktivasi.

## Perintah operasional

```sh
bun run db:status
bun run jobs:failed
bun run jobs:retry <job-id>
bun run cache:forget <key>
bun run cache:clear
```

Cache clear hanya membersihkan data cache aplikasi. Queue, lock aktif, dan namespace lain tidak disentuh. User registration, profile dan admin actions ada di aplikasi; cron, chain/batch, tenant, registrasi publik, OAuth dan deployment belum termasuk.

Redis queue memakai Streams, consumer groups, due sorted set dan Lua atomik. Default concurrency4, timeout30detik, lease60detik, heartbeat15detik, maksimal5percobaan. Backoff1,5,15,60detik. Retensi pekerjaan selesai24jam dan gagal30hari. Registry handler berada di `apps/worker/main.ts`; handler baru menerima payload dan context berisi jobId, attempt, dan AbortSignal. Handler perlu idempotent dan menghormati pembatalan. Worker lama tidak dapat menyelesaikan status queue setelah kehilangan lease.

Pakai Redis **noeviction** dan persistence. AOF everysec dapat kehilangan sekitar1detik pada bencana; always mempunyai biaya latency lebih tinggi. Redis lokal yang terdeteksi saat pembangunan belum mengaktifkan AOF. Konfigurasi layanan bersama tidak diubah. Tes ketahanan memakai Redis terpisah dengan AOF. Implementasi queue/lock menargetkan satu Redis primary, bukan Redis Cluster atau jaminan failover lintas primary.

PostgreSQL outbox menyimpan intent email terenkripsi sampai terkirim. Redis hanya menerima outbox ID. SMTP tidak dapat menjamin exactly once; crash setelah server menerima pesan dapat menyebabkan pesan yang sama dikirim ulang. Token tetap sekali pakai. `jobs:retry` mengulangi pekerjaan yang gagal; outbox yang memerlukan investigasi ditandai `failed` dengan kode aman. Jangan mengganti encryption key ketika masih ada encrypted outbox tanpa memigrasikan payload atau menyelesaikan antrean.

## Pengujian

```sh
bun run check:structure
bun run typecheck:server
bun test tests/unit
TEST_REDIS_URL=redis://127.0.0.1:6379 bun run test:integration
bun run test:web
bun run build
bun x playwright install chromium
bun run test:e2e
```

`TEST_DATABASE_URL` wajib menunjuk database pengujian PostgreSQL 18 yang sudah dimigrasikan. Sebagian tes database/relay akan skipped jika env terkait tidak tersedia; tes queue/cache tetap memerlukan Redis. Hasil dengan tes skipped bukan bukti integrasi penuh. Redis tes menggunakan prefix unik. Tes restart Redis memerlukan `redis-server` lokal dan memakai direktori sementara dengan AOF sendiri.

Suite browser membuat database sementara dengan nama unik (user database memerlukan izin CREATE DATABASE), namespace Redis unik, SMTP sink lokal, API8890, dan Angular8090. Layanan dev8088/8888 tetap terpisah. Database, namespace dan konteks rahasia dihapus saat harness berhenti. Log/screenshot ada di `.local/e2e`, trace kegagalan ada di `test-results`; semuanya diabaikan Git. Hanya satu suite E2E dapat berjalan per workspace pada saat yang sama.

Suite `[UI isolation]` menguji UI dengan API mock. Suite `[Live services]` menggunakan CLI, PostgreSQL, Redis, worker, SMTP, API, browser, dan authenticator virtual sebenarnya. Verifikasi perangkat passkey fisik tetap terpisah dan belum dilakukan.

## Dokumen dan struktur

* [Scope dan urutan pembangunan](docs/scope/_root/scope.md)
* [Spec fondasi](docs/specs/_root/0001-foundation/index.md)
* [Spec user/auth/passkey](docs/specs/_root/0003-user-auth/index.md)
* [Spec jobs](docs/specs/_root/0004-jobs/index.md)
* [Matriks AC dan bukti](docs/verification/ac-matrix.md)
* [Pemulihan layanan dan batas durability](docs/verification/operations.md)
* [Review auth](docs/reviews/2026-09-16-auth.md)
* [Panduan visual](design.md)

`apps/web` memuat Angular. `apps/api` memuat HTTP entrypoint. `apps/worker` memuat worker. `server` berisi layanan backend yang dipakai API/worker/CLI. `shared` hanya DTO aman bagi browser. `database/migrations` berisi SQL immutable setelah diterapkan. `scripts` memuat perintah Bun. Tidak ada package manifest atau instalasi dependensi per aplikasi.

Setiap fitur memiliki AC, tugas dan bukti di spec/matriks. Status yang belum terverifikasi tetap terbuka, termasuk perangkat passkey fisik. Jangan menandai `done` hanya karena build lulus.

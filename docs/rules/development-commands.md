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

`config/development.json` adalah konfigurasi bersama untuk kedua perintah. `database.expectedName` menyebut nama database development yang diprovision, saat ini `foundation`. Backend menerima `HOST=127.0.0.1` dan `PORT=8888`; `index.ts` wajib menggunakan nilai tersebut. Angular CLI mendapat host/port melalui argumen. Jangan menyebarkan angka port lain ke script yang berbeda.

Frontend memakai `apps/frontend/proxy.conf.json` untuk meneruskan API ke backend, agar SDK dapat memakai URL relatif pada development. Saat aplikasi dibuat, sepakati prefix API `/api` dan konfigurasi proxy yang sesuai, misalnya `/api/**` menuju `http://127.0.0.1:8888`. Konfigurasi ini tidak memindahkan backend ke port frontend.

Dependency Angular/Elysia tetap dipasang melalui package root. Tooling ini tidak mengunduh dependency otomatis dan tidak membuat aplikasi contoh untuk menutupi prasyarat yang belum ada.

## Akun pengguna development (spec 0014)

Halaman `/masuk` membutuhkan akun, dan tidak ada registrasi publik. Sesudah provisioning dan migration, buat akun lewat perintah operator dengan `FOUNDATION_MIGRATOR_DATABASE_URL` seperti runner migration. Password hanya dibaca dari `FOUNDATION_ACCOUNT_PASSWORD` (15 sampai 128 karakter); isi lewat `read -rs` agar tidak tersimpan di riwayat shell, lalu hapus sesudahnya:

```sh
read -rs FOUNDATION_ACCOUNT_PASSWORD && export FOUNDATION_ACCOUNT_PASSWORD
bun run db:accounts create --email <email> --display-name '<nama>' --apply
unset FOUNDATION_ACCOUNT_PASSWORD
```

Hasilnya satu baris `Account created: <uuid>`. `set-password` dan `revoke-sessions` memakai bentuk yang sama menurut [aturan deployment](deployment.md). `serve` menghapus `FOUNDATION_ACCOUNT_PASSWORD` dari environment setiap proses anak, seperti variable provisioning.

Backend development menerima `PUBLIC_ORIGIN` opsional (`http:` atau `https:`). Tanpa nilai itu, origin yang diizinkan untuk request yang mengubah data adalah `http://127.0.0.1:8889` dan `http://localhost:8889`, yaitu frontend development yang meneruskan `/api` lewat proxy. Request dari origin lain, termasuk port backend `8888` langsung, ditolak 403. Cookie sesi development bernama `foundation_session` tanpa `Secure`, karena berjalan di HTTP lokal.

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

Worker dengan port HTTP juga wajib mendeklarasikan `readinessPath` lokal, misalnya `"/ready"`. Saat startup, `serve` meminta path itu pada host dan port worker serta menunggu HTTP 200. Worker tanpa port dinilai dari proses yang tetap hidup selama startup.

Variable aplikasi worker lain, seperti API key penyedia email, didaftarkan sebagai nama variable pada array `env` entri worker. Nilai berasal dari environment lokal dan tidak disimpan pada JSON. Worker hanya menerima environment dasar proses serta variable yang dinyatakan untuknya; frontend tidak menerima secret backend/worker.

## Pemeriksaan doctor

- Runtime Bun, platform, `lsof`, dan Node.js/Angular CLI lokal tersedia.
- Workspace Angular, entry backend, entry worker yang dipilih, serta konfigurasi proxy tersedia.
- Dokumen OpenAPI, konfigurasi SDK, dan barrel SDK frontend tersedia. Kesesuaian isi serta reproduksibilitas tetap dibuktikan oleh `api:check` saat tooling OpenAPI diimplementasikan.
- `DATABASE_URL` backend dan URL database worker yang memerlukannya tersedia tanpa dicetak.
- PostgreSQL minimal 18 dan nama database backend sesuai `database.expectedName`. Schema yang dibutuhkan tersedia dan role runtime mempunyai `USAGE` tanpa `CREATE` pada schema aplikasi maupun `public`; role bukan superuser serta tidak dapat membuat database atau role.
- Metadata `common.schema_migrations` dengan kolom `name` dan checksum SHA-256 sesuai seluruh file `database/migrations/*.sql`. Direktori tanpa file SQL gagal. Metadata migration milik runner; role backend dapat membaca tetapi tidak mempunyai hak tulis, kepemilikan tabel, atau jalan untuk mengambil alih role penulis.
- Listener port frontend/backend serta worker terpilih dapat diperiksa. Port terpakai adalah warning pada doctor, tetapi `serve` hanya dapat membersihkan proses Foundation lama dari checkout yang sama dan tercatat dengan identitas yang dapat dibuktikan.

Doctor mengembalikan exit code `0` jika pemeriksaan wajib lulus dan `1` bila ada error. Koneksi/query mempunyai batas waktu. Temuan ditampilkan tanpa DSN, password, atau error database mentah.

Pemeriksaan ini merupakan preflight development. Privilege tabel bisnis, kebijakan keamanan, build, test, dan readiness aplikasi setelah startup tetap mempunyai pembuktian sendiri; doctor tidak menggantikan seluruh pemeriksaan release.

## Startup, cleanup port, dan shutdown

Urutan `serve`:

1. Muat konfigurasi dan pilihan worker, lalu ambil lock invocation per checkout secara atomik. Invocation kedua gagal tanpa mengubah proses pertama.
2. Jalankan doctor. Jika prasyarat gagal, berhenti sebelum menghentikan proses yang sedang berjalan.
3. Pada port `8888`, `8889`, dan port HTTP worker yang dipilih, hanya proses Foundation lama dari checkout yang sama yang boleh dihentikan. Periksa UID, checkout, waktu mulai proses, grup, dan pemegang port sebelum setiap sinyal. Jika identitas tidak pasti atau port diambil proses lain, gagal tanpa memberi sinyal kepada proses itu.
4. Jalankan backend dan frontend dalam mode development/watch, lalu worker yang dipilih. Tunggu paling lama 60 detik sampai frontend `/` menjawab HTTP 200 sebagai HTML, backend `/api/status` menjawab HTTP 200 dengan JSON `{ "status": "ok" }`, dan worker HTTP terpilih menjawab HTTP 200 pada `readinessPath`. Setiap respons harus berasal dari grup proses baru invocation ini. Umumkan URL hanya setelah semua check lulus.
5. Saat Ctrl+C/termination, timeout readiness, atau satu layanan keluar, hentikan seluruh grup proses yang dibuat invocation ini, termasuk turunan watcher/build. Lepas lock setelah shutdown. Kegagalan mengembalikan exit code gagal.

Cleanup hanya mencakup proses Foundation lama dari checkout yang sama dengan catatan kepemilikan yang dapat dibuktikan. Listener dari aplikasi atau checkout lain tidak dihentikan. Lock lama dipulihkan oleh satu invocation saja; keadaan yang tidak dapat dibuktikan meminta penghentian manual. Tidak memakai `pkill bun/node`, tidak membersihkan seluruh port komputer, dan tidak menghentikan PostgreSQL. Pemeriksaan HTTP hanya terjadi saat startup; alur browser dan kesiapan database sesudah startup mempunyai bukti tersendiri.

`serve` khusus development dan menolak `NODE_ENV=production`. Production menggunakan image/container serta langkah migration/deployment tersendiri sesuai rules, tanpa cleanup port development.

## Kriteria verifikasi tooling

- `TOOL-001`: doctor melaporkan prasyarat yang hilang dan mengembalikan status gagal, tanpa mutasi atau cleanup port.
- `TOOL-002`: cleanup membebaskan port proses Foundation lama yang tercatat dan mempertahankan listener asing serta port lain; listener tercatat yang mengabaikan `SIGTERM` dihentikan secara terbatas.
- `TOOL-003`: worker hanya berjalan ketika terdaftar dan dipilih; URL database backend tidak diwariskan otomatis ke worker tanpa konfigurasi database.
- `TOOL-004`: kegagalan satu layanan menghentikan grup layanan lain beserta turunannya dan mengembalikan status gagal.
- `TOOL-005`: dua invocation bersamaan tidak saling menghentikan; pemulihan lock lama mempunyai satu pemilik.
- `TOOL-006`: readiness menerima respons HTTP yang tepat dari proses baru dan menolak respons salah, timeout, atau listener asing.
- `TOOL-007`: doctor dan serve dibuktikan pada PostgreSQL, frontend, backend, proxy, serta alur browser nyata setelah fitur database dan kesiapan tersedia.
- `TOOL-008`: mode production dan konfigurasi tidak valid gagal sebelum cleanup.

Tooling diuji melalui `bun run test:tooling` dengan fixture proses lokal pada port sementara. Jangan memakai port aplikasi nyata untuk test penghentian proses. Ketika aplikasi belum tersedia, doctor/serve harus melaporkan kondisi tersebut, bukan mengklaim semua aplikasi sudah berjalan.

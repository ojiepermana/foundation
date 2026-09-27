# Doctor dan serve development

Perintah dijalankan dari root monorepo melalui satu `package.json`. Script menggunakan Bun; Angular CLI lokal berjalan melalui Node.js yang kompatibel. Tooling cleanup port saat ini mendukung macOS/Linux dan memerlukan `lsof`.

```sh
bun run doctor
bun run serve
```

`doctor` memeriksa prasyarat tanpa menyalakan aplikasi, mengubah database, menjalankan migration/seed, atau menghentikan listener. `serve` otomatis menjalankan pemeriksaan yang sama sebelum startup. Aplikasi hanya dijalankan ketika tidak ada error pemeriksaan.

## Layanan dan konfigurasi

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

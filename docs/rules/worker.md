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

# Operasional lokal Foundation

## Persiapan layanan

Gunakan PostgreSQL 18, Redis 7.2+ dan SMTP yang tersedia. Isi `.env` mengikuti `.env.example`; jangan menyalin secret ke dokumen, tiket, atau output tes. `APP_URL=http://localhost:8088` dan `WEBAUTHN_RP_ID=localhost` harus cocok dengan URL browser. Jangan membuka aplikasi melalui alamat IP ketika RP ID masih `localhost`.

Migrasi melalui `bun run db:migrate`, periksa melalui `bun run db:status`. File migrasi yang sudah diterapkan tidak diedit; perubahan schema ditambahkan sebagai file berikutnya. Migrasi 0002 membuat default password reauthentication kedaluwarsa agar insert session baru tidak memperoleh kewenangan implisit.

`bun run dev` menjalankan tiga proses. Log JSON API memakai request ID; worker memakai job ID. `/api/health/live` hanya menyatakan proses hidup, sedangkan `/api/health/ready` memeriksa PostgreSQL dan Redis. SMTP bukan bagian dari readiness; buktikan lewat pengiriman yang diizinkan.

## Respons dan pemulihan

| Gangguan | Perilaku aplikasi | Pemulihan dan pemeriksaan |
|---|---|---|
| PostgreSQL tidak tersedia | Operasi akun gagal dengan envelope aman/503; readiness 503; tidak boleh menganggap transaksi akun sudah commit. | Pulihkan koneksi, periksa migration status dan readiness. Ulangi operasi yang diketahui gagal; email unik mencegah akun ganda. |
| Redis tidak tersedia | Login/mutasi auth yang memakai limiter gagal tertutup dengan 503. Outbox PostgreSQL dipertahankan; relay mencoba lagi. Worker mencatat gangguan. | Pulihkan Redis, periksa readiness dan worker. Bila proses sudah keluar, jalankan kembali `bun run dev` atau `bun run start:worker`. Amati outbox berubah hingga `sent`; antrean dapat dipulihkan dari intent outbox yang belum selesai. |
| SMTP tidak tersedia/menolak | Job mencoba lagi dengan backoff hingga budget habis; payload outbox tetap terenkripsi. | Koreksi host/port/TLS/auth di env, restart worker, lihat `bun run jobs:failed`, kemudian `bun run jobs:retry <job-id>`. Pastikan status akhirnya completed/sent. |
| Worker mati | Pekerjaan yang telah diklaim tetap pending; lease habis dan consumer lain mengambil alih. | Nyalakan worker; verifikasi attempt bertambah dan job selesai. Jangan menghapus stream atau pending entries untuk memaksa pemulihan. |
| Callback lama selesai setelah lease berpindah | Token lama ditolak ketika memperbarui metadata queue/outbox. | Pastikan pemilik baru melanjutkan. Side effect eksternal yang sudah terjadi tetap memerlukan idempotency/reconciliation. |
| Cache gagal | Operasi cache melempar error; caller menentukan fallback. Kegagalan lock tidak dianggap berhasil. | Pulihkan Redis. `cache:clear` hanya menghapus data cache dalam prefix aplikasi, bukan lock atau queue. |
| Token aktivasi/reset kedaluwarsa | Token ditolak tanpa membuka akun/session. | Aktivasi: `bun run user:resend-activation --email ...`. Reset: minta tautan baru dari login. Token lama tidak diaktifkan ulang. |

Untuk inspeksi outbox, baca hanya `id`, `status`, `attempts`, `last_error`, `updated_at`, dan `sent_at`. Jangan menampilkan payload atau secret. Job email mempunyai ID `mail-<outbox-id>`. `OUTBOX_REVIEW_REQUIRED` menunjukkan metadata queue hilang/tidak konsisten atau budget habis; jangan mengubah row menjadi sent tanpa bukti penerimaan.

Jika job gagal masih ada, perbaiki penyebab lalu gunakan `jobs:retry`. Jika metadata queue sudah hilang dan outbox membutuhkan review, selesaikan pemeriksaan operator terlebih dahulu. Untuk aktivasi/reset, jalur aman adalah menerbitkan tautan baru melalui perintah/alur aplikasi; jangan memakai kembali token lama dengan mengubah database secara manual. Pengiriman ulang dapat menghasilkan pesan duplikat, tetapi action token tetap sekali pakai.

## Durability dan retensi

- Redis wajib memakai `noeviction` dan persistence untuk jaminan pemulihan queue. AOF `everysec` menerima kemungkinan kehilangan sekitar satu detik saat bencana; `always` meningkatkan biaya latency. RDB saja memiliki jendela kehilangan sesuai interval snapshot.
- Redis lokal yang ditemukan saat pembangunan memakai `noeviction` tetapi AOF belum aktif. Konfigurasinya tidak diubah karena merupakan layanan bersama. Tes restart memakai Redis sementara dengan AOF `always`, bukan bukti persistence layanan ini.
- Queue menjalankan job setidaknya sekali. Gunakan kunci idempotency pada resource efek samping. Token lease melindungi transisi queue, bukan transaksi atomik dengan server SMTP atau layanan lain.
- Completed job disimpan 24 jam, failed job 30 hari. Retensi ini berlaku pada metadata job; tidak berarti semua data PostgreSQL dihapus otomatis. Payload email dibersihkan setelah sent. Maintenance/arsip data akun dan audit mengikuti kebutuhan aplikasi berikutnya.
- Pertahankan encryption key sampai semua payload yang memakai key tersebut selesai atau sudah dimigrasikan. Mengganti key langsung membuat outbox lama tidak dapat didekripsi.

## Menjalankan verifikasi lagi

Gunakan perintah pengujian di [README](../../README.md). `TEST_DATABASE_URL` menunjuk database pengujian yang telah dimigrasikan dan `TEST_REDIS_URL` menunjuk Redis yang dapat diakses. Suite E2E memerlukan hak CREATE DATABASE, memakai namespace unik, dan membersihkan database yang dibuatnya. Jangan menggunakan identitas/alamat email pengguna sebenarnya untuk pengujian otomatis.

Catat hasil di [matriks AC](ac-matrix.md). Tes yang skipped, typecheck, screenshot, dan verifikasi perangkat fisik adalah bukti berbeda. Jangan menutup AC menggunakan jenis bukti yang tidak menguji perilakunya.

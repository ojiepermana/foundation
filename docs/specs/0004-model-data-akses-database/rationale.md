# Rationale: model data dan batas akses database

## Context

PostgreSQL development sudah tersedia, tetapi backend belum mempunyai role runtime, metadata migration, atau pool aplikasi. `doctor` dari spec 0003 sengaja menolak database yang belum diprovision. Scope menunda tabel pengguna dan sesi, sehingga batas akses awal dapat dibuktikan tanpa membuat data bisnis contoh.

## Options considered

1. Satu role untuk provisioning, migration, dan backend. Perintah lebih sedikit, tetapi aplikasi akan memiliki DDL dan hak tulis riwayat; satu kebocoran credential memberi kendali penuh.
2. Owner tanpa login, migrator terpisah yang dapat `SET ROLE`, dan backend baca minimum. Ada credential dan langkah provisioning tambahan, tetapi kepemilikan stabil dan hak aplikasi dapat diuji negatif. Ini pilihan yang disetujui.
3. Hanya membuat schema lalu membiarkan runner fitur 6 membuat role dan tabel. Ini mengurangi pekerjaan fitur 5, tetapi menunda pembuktian privilege dan menempatkan bootstrap credential di runner yang seharusnya memakai role migrator yang sudah ada.

## Rationale

Pemisahan owner, migrator, dan backend memberi batas yang tetap ketika tabel domain ditambahkan. Provisioning admin dilakukan sekali dan aman diulang; runner migration tidak perlu credential administrator. Pemilihan target tetap `foundation` dan flag `--apply` mencegah salah sasaran development. Backend tetap melayani route dasar tanpa URL agar kontrak aplikasi yang sudah ada tidak rusak, sementara `doctor` menjadi gerbang wajib bagi `serve`.

Grant tabel baru tidak dibuat otomatis karena `users` dan `auth` akan menyimpan data dengan kebutuhan akses berbeda. Tiap fitur pemilik data harus memilih dan menguji grant yang memang dibutuhkan.

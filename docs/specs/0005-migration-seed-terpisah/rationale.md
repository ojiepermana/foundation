# Rationale: migration dan seed terpisah

## Context

Provisioning fitur 5 telah membuat role, schema, dan metadata, tetapi belum ada file migration yang dapat dibandingkan oleh doctor. Runner harus menyatukan SQL dan pencatatan checksum tanpa memberikan hak DDL kepada backend. Dua invocation dan kegagalan pada file tengah harus mempunyai hasil yang dapat diprediksi.

Seed bisnis belum mempunyai data awal yang disepakati. Runner tetap perlu menyediakan jalur terpisah agar fitur berikutnya dapat mengisi data dengan role yang benar dan membuktikan pengulangan aman.

## Options considered

1. Menjalankan migration otomatis saat backend mulai. Operasi pengembang lebih singkat, tetapi setiap replika membawa hak DDL dan startup bisa bersaing atau mengubah database tanpa langkah eksplisit.
2. Runner sekali jalan dengan transaksi, lock, checksum, dan riwayat. Ada perintah tambahan dan file SQL bernomor, tetapi kegagalan dapat rollback serta runtime tetap memakai role minimum. Ini pilihan yang diterima.
3. Mendukung SQL nontransaksi sejak awal. Fleksibel untuk operasi tertentu, tetapi membutuhkan state pemulihan ketika SQL berhasil dan pencatatan gagal. Belum ada kebutuhan nyata yang membayar kompleksitas itu.

## Rationale

Satu statement per file membuat batas transaksi dan urutan global mudah diperiksa tanpa parser penuh. Pemindai leksikal tetap diperlukan karena Bun dapat mengeksekusi beberapa statement dari satu string SQL, termasuk pengendali transaksi; PostgreSQL sendiri menolak operasi yang tidak bisa berjalan dalam transaksi. Kunci provisioning dipakai bersama agar runner tidak membaca metadata saat bootstrap berubah. Transaksi `READ COMMITTED` dan pembacaan riwayat setelah kedua lock memastikan runner yang menunggu melihat commit runner pertama sebelum menghitung file pending.

Migrator tidak mewarisi privilege owner. Pemeriksaan identitas dan membership dilakukan sebagai migrator, sedangkan pemeriksaan metadata dilakukan setelah `SET LOCAL ROLE foundation_owner`. Lingkup `LOCAL` mengembalikan role ketika transaksi berakhir sehingga koneksi yang dipakai ulang tidak membawa privilege owner. Lokasi file ditambatkan pada root repository dari modul runner dan setiap direktori serta entri diperiksa terhadap symlink; pemanggilan dari direktori kerja lain tidak mengubah sumber SQL.

Baseline memberi satu file nyata untuk doctor tanpa menciptakan tabel bisnis contoh. Seed kosong sukses, sedangkan seed berikutnya dijalankan ulang dan wajib membuktikan idempotensi pada fitur pemilik data. Test idempotensi fitur ini memakai tabel fixture sementara yang dibuat dan dibersihkan harness pada schema `users` di PostgreSQL terisolasi; fixture tidak menjadi objek produk. Biayanya adalah disiplin nama file dan test setiap seed baru.

# Alasan autentikasi dengan tautan email

## Context

Anda ingin pengguna cukup memasukkan email, membuka tautan pada frontend, lalu divalidasi backend. Implementasi sekarang masih memakai password untuk login, aktivasi, pemulihan, dan konfirmasi pengelolaan passkey. Schema juga mengharuskan akun active memiliki hash password. Menghapus input login saja akan meninggalkan syarat password pada jalur lain.

Repo memiliki 52 file sumber, Angular 22, Bun, Elysia, PostgreSQL, Redis, SMTP melalui outbox terenkripsi, serta SimpleWebAuthn. Scope memakai Tracer Bullet dengan tingkat Beta dan auth/passkey pada gerbang GA. Tidak ada konteks agen proyek. Branch tidak tertinggal dari basis remote saat preflight, dan tidak ada perubahan lokal sebelum penulisan spec.

Pengguna berasal dari CLI, bukan registrasi publik. Anda ingin passkey tetap tersedia dan mode perangkat dipilih secara eksplisit melalui ENV. Anda menyetujui jeda layanan singkat serta penyelesaian antrean email sebelum migrasi. Tidak ada kewajiban regulasi tambahan yang dinyatakan.

## Options considered

### Opsi 1. Perubahan terarah pada sistem sekarang

Ganti pembuktian password dengan token email sambil mempertahankan sesi, outbox, pembatas, role, dan passkey.

**Kelebihan**: Memakai transaksi dan operasi yang sudah dipahami. Perubahan tetap berpusat pada auth, bukan perpindahan platform.

**Kekurangan**: Tim tetap bertanggung jawab atas keamanan autentikasi native, termasuk race, pembatas, dan pengikatan sesi. Peralihan schema perlu dihentikan dan diuji dengan sengaja.

### Opsi 2. Jalur baru berdampingan dengan jalur lama

Tambahkan login email sambil mempertahankan password selama masa transisi, lalu pindahkan pengguna secara bertahap.

**Kelebihan**: Memudahkan peralihan layanan yang tidak boleh berhenti dan memberi jalan kembali selama masa transisi.

**Kekurangan**: Mempertahankan data password, memperbanyak kombinasi pengujian, dan bertentangan dengan pilihan Anda untuk menghapus kolom langsung serta menerima jeda singkat.

### Opsi 3. Penggantian seluruh subsistem auth

Pindahkan autentikasi ke library atau provider lain yang mendukung tautan email.

**Kelebihan**: Sebagian tanggung jawab mekanisme auth dapat diserahkan ke implementasi terpusat yang dipelihara pihak lain.

**Kekurangan**: Memerlukan pemilihan alat baru, integrasi sesi dan role, serta evaluasi migrasi passkey dan pengguna. Cakupannya lebih besar daripada perubahan metode pembuktian yang Anda minta.

## Rationale

Opsi 1 dipilih karena kode sudah memiliki token acak, hash token, transaksi DB, cookie sesi, dan email terenkripsi. Risiko utama adalah syarat password yang tersebar, bukan kekurangan framework atau kebutuhan skala baru. Pengujian tetap menyeluruh karena perubahan menyentuh batas keamanan, meskipun tidak mengganti seluruh sistem.

Pengikatan browser menggunakan hash rahasia cookie, bukan tabel browser baru. Hubungan token dengan sesi hanya ditambahkan untuk konfirmasi ulang. Ini membatasi perubahan schema sambil mencegah tautan konfirmasi dipakai untuk sesi lain. Masa berlaku default 15 menit memberi waktu pengiriman; rentang teknis 60 sampai 1800 detik dipilih daripada menerima konfigurasi tanpa batas. Periode konfirmasi tetap 5 menit dan bukan umur sesi.

Mode ENV tidak memiliki default sesuai pilihan Anda. Pembatalan token mode lama saat startup dipilih daripada membiarkan token mewarisi kebijakan lama sampai expiry. Pemeriksaan mode saat verifikasi tetap diperlukan, tetapi pemeriksaan itu saja tidak cukup karena token dapat hidup kembali jika mode dibalik lagi sebelum expiry.

Undangan CLI menuju halaman masuk karena CLI tidak mempunyai browser untuk mengikat token. Alternatif tautan langsung memerlukan pengecualian terhadap mode same_browser. API terpisah untuk login dan konfirmasi ulang membuat tujuan token dan kebutuhan sesi terlihat jelas; endpoint bersama dengan parameter purpose adalah alternatif yang ditolak.

Anda memilih tombol konfirmasi agar pemindai email yang hanya membuka halaman tidak langsung memakai token. Anda tidak memilih endpoint pemeriksaan awal untuk menampilkan akun tujuan. Karena itu, cross_device tetap menerima risiko pengguna mengonfirmasi tautan milik orang lain. Tombol bukan bukti bahwa orang yang membuka email adalah orang yang meminta tautan.

Worker membersihkan token saat mulai dan setiap jam sesuai pilihan Anda, dengan batch kecil dan penguncian baris yang dapat dilewati bila sedang dipakai. Alternatif CLI manual ditolak. Pemeliharaan ini tidak memperluas fitur menjadi scheduler umum. Pengiriman email tetap memiliki kemungkinan duplikat atau terlambat; token tunggal dan pembatas umur mengendalikan dampaknya, bukan menjanjikan pengiriman tepat sekali.

Tidak ada riset web atau bagian referensi tambahan, sesuai pilihan Anda. Alasan keputusan tetap tersimpan di sini. Semua hasil pengujian versi baru masih perlu diperoleh saat implementasi.

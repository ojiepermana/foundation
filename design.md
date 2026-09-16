# Foundation UI

Foundation memakai komponen dan tema resmi `@ojiepermana/angular` 22.1.13. Aplikasi hanya mengatur komposisi halaman dan isi. Package tidak dipatch.

## Arah visual

Ruang kerja yang tenang dengan judul jelas, aksen teal, neutral zinc, sudut `md`, dan jarak `normal`. Mode awal terang; pilihan tema dari library tetap tersedia dan dihormati. Tipografi memakai font sistem agar tidak bergantung pada jaringan eksternal. Material Symbols Rounded dan Sharp, termasuk sumbu variable, disimpan di `apps/web/public/fonts` bersama lisensi Apache 2.0. Font dibatasi pada glyph yang digunakan, dan dapat diperbarui dengan `bun apps/web/tools/update-icon-fonts.ts` ketika icon atau versi library berubah.

Panduan UI UX Pro Max dipakai untuk pemeriksaan label, fokus, status, responsivitas, dan konsistensi. Rekomendasi palet dan jenis font umum tidak menggantikan token library yang telah dipilih sebagai fondasi.

## Komposisi

1. Halaman akun memakai `Layout > LayoutFluid`, kartu terpusat, identitas Foundation, satu tindakan utama, dan pilihan passkey pada login.
2. Dashboard memakai `LayoutWrapperDefault` dengan sidebar dan drawer mobile bawaan. Brand, identitas pengguna, navigasi, dan logout diberikan melalui API publik library.
3. Konten memakai heading halaman dan kelompok `Card`. Dashboard berisi placeholder dengan label `Belum tersedia`, tanpa metrik buatan.
4. Profil terdiri dari informasi pribadi, kata sandi, dan passkey. Penghapusan passkey meminta konfirmasi kata sandi dalam halaman.
5. Pengguna ditampilkan sebagai daftar responsif dengan pencarian dan pagination. Edit muncul dalam panel berlabel yang menerima fokus. Role dan status memakai `NativeSelect`.

## Kontrak interaksi

Form memakai Angular Signal Forms. Label selalu terlihat. Kata sandi baru membutuhkan konfirmasi. Tautan aktivasi dan reset membaca token dari fragment, lalu membersihkan fragment dari address bar. Session dan CSRF hanya hidup dalam memori frontend; browser menerima cookie session dari server.

Pesan server ditampilkan sebagai alert, hasil berhasil sebagai status, dan tombol menampilkan proses saat permintaan berjalan. UI guard meningkatkan pengalaman navigasi; backend tetap menjadi sumber otorisasi. Ikon tidak menggantikan teks untuk tindakan utama. Layout library memiliki skip link dan fokus setelah navigasi. Reduced motion mengikuti preferensi sistem.

## Verifikasi

`bun run build` memeriksa template dan TypeScript ketat. `bun run test:web` memeriksa boundary session, CSRF, token dan validasi form. `tests/e2e/ui.spec.ts` secara eksplisit mengisolasi UI memakai respons API tiruan untuk guard, placeholder, dan navigasi mobile. Pengujian integrasi layanan nyata dan authenticator dicatat terpisah dalam suite alur utama.

Anggaran bundle awal adalah warning 600 kB dan error 800 kB, berdasarkan baseline aplikasi sekitar 525 kB raw (sekitar 118 kB transfer) termasuk tema lengkap yang mendukung pengaturan bawaan library. Asset font dilaporkan terpisah.

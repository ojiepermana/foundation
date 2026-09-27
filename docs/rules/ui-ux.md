# Aturan UI dan UX frontend

Aturan ini berlaku untuk semua halaman dan fitur frontend, termasuk pekerjaan agent utama dan subagent. Struktur kode mengikuti [aturan frontend Angular](angular.md).

## Sumber komponen UI

Seluruh komponen library UI menggunakan package `@ojiepermana/angular`, sesuai pilihan project. `theme` adalah salah satu bagian yang dapat digunakan melalui entry point `@ojiepermana/angular/theme`, bukan nama package terpisah atau sumber seluruh komponen UI.

Gunakan entry point publik yang sesuai dengan komponen yang dibutuhkan, berdasarkan API versi package yang digunakan. Untuk layout aplikasi, pilihan yang telah disepakati tetap menggunakan default layout wrapper dari bagian `theme`.

- Gunakan komponen library yang tersedia untuk kebutuhan UI, seperti tombol, input, pilihan, dialog, dan tampilan data. Periksa ketersediaan setiap komponen sebelum implementasi.
- Jangan menambahkan component library lain atau membuat ulang komponen dasar yang sudah tersedia.
- Komponen aplikasi boleh dibuat untuk menyusun komponen library menjadi halaman atau tampilan khusus fitur. Komponen aplikasi tidak menjadi pengganti component library.
- Wrapper lokal hanya dibuat jika memiliki tanggung jawab tambahan yang jelas, bukan sekadar meneruskan seluruh API komponen library.
- Jika kebutuhan UI belum didukung library, laporkan kebutuhan dan dampaknya kepada agent utama. Agent utama mengoordinasikan keputusan dengan pengguna; jangan mengganti library atau membuat pengganti secara sepihak. Lanjutkan bagian pekerjaan independen yang masih dapat dilakukan.

## Penggunaan API library

Sebelum menggunakan komponen, periksa dokumentasi, entry point, export publik, dan tipe pada versi `@ojiepermana/angular` yang digunakan project. Jangan menganggap semua komponen diekspor melalui `@ojiepermana/angular/theme`.

Jangan menebak selector, nama export, input, output, provider, atau token style. Jangan mengimpor dari file internal library atau menyalin implementasinya.

Aturan ini menetapkan pilihan library, bukan daftar API yang sudah diverifikasi. Detail integrasi ditentukan dari API publik saat implementasi.

## Konsistensi tampilan

- Ikuti theme, varian, dan token tampilan yang tersedia melalui API publik library.
- Gunakan pola spacing, warna, tipografi, ukuran, dan state yang konsisten antarhalaman.
- Style lokal menangani komposisi dan kebutuhan khusus fitur. Jangan mengubah tampilan komponen library dengan menargetkan struktur DOM internalnya.
- Gunakan default layout wrapper. Konfigurasi atau integrasi tambahan mengikuti batas `shell/` dalam aturan frontend Angular.

## Perilaku UX

- Setiap halaman memiliki tujuan dan tindakan utama yang jelas. Label menjelaskan tindakan atau isi, bukan detail implementasi.
- Untuk proses mengambil atau mengubah data, tangani state yang relevan: loading, kosong, berhasil, dan gagal.
- Saat proses berjalan, tampilkan feedback dan cegah pengiriman berulang yang tidak disengaja.
- Pesan kesalahan menjelaskan masalah dan tindakan yang dapat dilakukan pengguna. Sediakan retry jika sesuai dengan alur fitur.
- Form memiliki label yang jelas, validasi yang dapat dipahami, dan mempertahankan input pengguna saat pengiriman gagal jika sesuai dengan alur.
- Gunakan istilah dan pola interaksi yang konsisten untuk tindakan yang sama di seluruh aplikasi.
- Tampilan tetap dapat digunakan pada ukuran layar yang menjadi target fitur, termasuk konten panjang dan data kosong.

## Aksesibilitas

Gunakan kemampuan aksesibilitas komponen library dan lengkapi integrasinya di aplikasi.

- Kontrol interaktif memiliki nama atau label yang dapat dipahami.
- Alur dapat dioperasikan dengan keyboard, dengan indikator focus yang terlihat.
- Focus dikelola dengan benar pada interaksi seperti dialog dan perubahan konteks.
- Informasi penting tidak disampaikan melalui warna saja.
- Perubahan konten atau style tidak menghilangkan perilaku aksesibilitas bawaan komponen.

## Penempatan komponen aplikasi

- Komponen khusus satu fitur berada di `features/<nama-fitur>/`.
- Komposisi UI yang digunakan beberapa fitur frontend ini dapat berada di `shared/`.
- Komposisi UI yang benar-benar diperlukan beberapa aplikasi Angular dapat berada di `libs/ui/`.
- `shared/` dan `libs/ui/` tetap menyusun komponen dari library pilihan project, bukan membuat component library dasar baru.

## Tanggung jawab agent

Agent utama menyertakan aturan UI/UX dan struktur frontend saat mendelegasikan pekerjaan frontend. Setiap subagent membacanya sebelum implementasi.

Subagent melaporkan kekurangan API atau komponen, perubahan pola UX yang berdampak pada fitur lain, serta kebutuhan perubahan file bersama.

Verifikasi mencakup alur pengguna, state yang relevan, ukuran layar target, dan interaksi keyboard. Build yang berhasil saja belum membuktikan UI/UX fitur selesai.

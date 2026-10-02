# Alasan keputusan doctor dan serve pada aplikasi nyata

## Context

Tooling `doctor` dan `serve` sudah mempunyai preflight, pilihan worker, cleanup port, serta supervisor grup proses. Frontend Angular dan backend Elysia nyata juga sudah tersedia. Pemeriksaan sekarang berhenti pada database karena schema, role, dan migration yang diperlukan belum disiapkan oleh fitur 5 dan 6. Browser alur metadata menunggu fitur 10.

Aturan lama mengizinkan `serve` menghentikan semua listener milik user lokal pada port target. Saat dua checkout atau aplikasi lain memakai port yang sama, perilaku itu dapat menghentikan pekerjaan yang tidak dimaksud. `serve` juga mencetak URL sebelum frontend dan backend menjawab HTTP, sehingga URL dapat terlihat siap saat kompilasi Angular masih berlangsung atau startup gagal.

Keputusan harus menjaga pemisahan credential administrator dan runtime, mempertahankan migration sebagai langkah terpisah, serta membuat bukti nyata dapat diulang tanpa menghentikan layanan development lain. Saat ini belum ada worker terdaftar. Desain worker harus berlaku saat worker pertama ditambahkan tanpa mengklaim bukti yang belum tersedia.

## Options considered

### Memperbaiki tooling yang ada

Tambahkan readiness, identitas proses, dan bukti database pada modul yang sekarang. Kelebihannya adalah kontrak CLI dan test fixture tetap dipakai. Kekurangannya adalah catatan kepemilikan proses menambah keadaan lokal yang perlu dipulihkan setelah crash.

### Menjalankan supervisor baru berdampingan

Jalankan jalur baru untuk aplikasi nyata sambil mempertahankan jalur lama selama peralihan. Kelebihannya adalah perilaku lama tetap tersedia sebagai pembanding. Kekurangannya adalah dua pemilik port dan dua kontrak preflight membuka peluang perilaku yang berbeda serta memperpanjang peralihan.

### Mengganti tooling secara langsung

Tulis ulang doctor, cleanup, dan supervisor sebagai satu perintah baru. Kelebihannya adalah struktur baru bisa dirancang tanpa batas modul lama. Kekurangannya adalah test dan aturan yang sudah berjalan harus dibuktikan ulang, sementara gap utama dapat diselesaikan pada modul yang ada.

## Rationale

Perbaikan di tempat paling sesuai karena frontend, backend, dan tooling sudah mempunyai kontrak kerja yang dapat diuji. Risiko utama berada pada pengakuan siap terlalu dini dan sinyal ke listener yang salah. Respons HTTP saat startup perlu disertai bukti bahwa listener berasal dari grup proses yang baru dijalankan. Lock invocation, guard pemulihan, dan pemeriksaan identitas proses membatasi risiko sinyal ke proses yang salah. Jika identitas tidak dapat dibuktikan, startup gagal dan meminta penghentian manual.

Doctor tetap membaca metadata dengan role runtime dan memeriksa bahwa role itu tidak dapat menulis atau mengambil alih role penulis. Hal itu menjaga runner migration sebagai satu satunya penulis. Nama database yang diharapkan berasal dari konfigurasi yang diselaraskan dengan provisioning fitur 5, bukan dari DSN yang sedang diuji saja. Pemeriksaan HTTP sesudah startup hanya membuktikan layanan menjawab; Playwright pada fitur 10 tetap diperlukan untuk membuktikan alur Angular, SDK, backend, dan PostgreSQL secara utuh.

## Bukti keadaan awal

Pada 2026-10-01, `bun run doctor` mengembalikan exit 1. Pemeriksaan tooling, file frontend, SDK, dan port lulus, lalu pemeriksaan database backend gagal dengan pesan aman. Direktori `database/` belum ada. Suite tooling yang ada memakai fixture port sementara untuk `TOOL-001` sampai `TOOL-004`; hasilnya belum dijalankan ulang dalam rancangan ini. Tidak ada klaim readiness aplikasi nyata dari keadaan awal tersebut.

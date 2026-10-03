# Verifikasi: kerangka UI dan navigasi · spec 0007

## UI / manual

- [x] Buka `/` pada 1280×812 dan pastikan wrapper vertical dengan sidebar serta halaman Foundation statis tampil tanpa terpotong → AC-1, AC-2, AC-4
- [x] Pilih `Kesiapan` dan pastikan URL tetap `/` serta konten root tampil → AC-2
- [x] Pada 375×812, buka drawer dengan `Buka navigasi`, tutup dengan Escape dan `Tutup navigasi`, lalu pastikan focus dikembalikan oleh wrapper → AC-3, AC-4
- [x] Gunakan keyboard untuk mencapai dan memilih navigasi; gunakan skip link dan pastikan focus mencapai landmark utama → AC-3
- [x] Buka path yang tidak dikenal, pastikan diarahkan ke route root, lalu pastikan landmark utama menerima focus setelah perubahan route → AC-3, AC-6

## Perintah

- [x] `bun run build:frontend` → build production berhasil → AC-1, AC-5
- [x] `bun run test:e2e` → skenario shell dan navigasi responsif lulus pada kedua viewport → AC-2, AC-3, AC-4, AC-6
- [x] Periksa asset production untuk memastikan credential atau URL database tidak tersertakan, dan pastikan halaman root tidak membuat request API/backend → AC-5
- [x] Jalankan fixture checker pada import server samping, bare Node/Bun runtime, import/export/dynamic/require, URL PostgreSQL, private key, credential sintetis, serta source bersih; output tidak membocorkan nilai credential → AC-5

## Acceptance-criteria coverage

- AC-1: wrapper publik dan default layout versi terpasang digunakan.
- AC-2: route root dan item navigasi Kesiapan menampilkan halaman statis.
- AC-3: skip link, focus keyboard, label navigasi mobile, dan focus setelah route berubah berfungsi.
- AC-4: tampilan desktop dan mobile dapat digunakan.
- AC-5: tidak ada request backend, credential, atau URL database pada bundle frontend.
- AC-6: path yang tidak dikenal diarahkan ke route root.

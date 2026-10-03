# Rationale: alur pemeriksaan kesiapan lintas aplikasi

## Context

`doctor` dan `serve` sudah memeriksa PostgreSQL serta respons HTTP awal, tetapi `/api/status` hanya membuktikan proses backend hidup. Scope fitur 2 masih memerlukan bukti browser yang melewati frontend, proxy, SDK, backend, dan database nyata. Metadata migration di `common` adalah sumber baca yang sudah tersedia dengan role minimum, tanpa membuat data bisnis contoh.

Halaman ini untuk pengembang lokal. Belum ada model sesi atau hak diagnostik production. Ketika database putus sesudah startup, pengguna perlu melihat kegagalan yang aman dan mencoba lagi tanpa memulai ulang aplikasi.

## Options considered

1. Memakai `/api/status` saja. Permukaan tetap kecil dan tidak menambah query, tetapi browser tidak membuktikan akses database atau privilege runtime.
2. Menambah route baca metadata dan panel development pada `/`. Ini membuktikan seluruh alur dengan data minimum yang sudah ada; biaya tambahannya adalah query, batas waktu, dan state gagal pada UI. Ini pilihan yang diterima untuk draft.
3. Menambah route diagnostik production sekarang. Satu endpoint dapat dipakai operasi kelak, tetapi model autentikasi, eksposur jaringan, dan kebijakan health production belum disepakati; keputusan itu menjadi bagian fitur deployment.

## Rationale

Metadata migration sudah dimiliki schema `common` dan dapat dibaca role backend tanpa DDL. Agregat jumlah cukup untuk membuktikan query nyata serta menjaga nama file dan checksum keluar dari respons. `status = available` sengaja hanya berarti pembacaan berhasil; `doctor` tetap membuktikan kelengkapan migration sebelum `serve`.

Route development pada loopback mengikuti batas route status yang sudah ada. Satu query aktif, batas lima detik, dan `no-store` menjaga pemeriksaan dapat diprediksi saat database lambat. Frontend production tetap menampilkan pengantar sampai akses diagnostik production dirancang. Halaman memakai wrapper dan SDK yang sudah ada, tanpa dependency atau aset baru.

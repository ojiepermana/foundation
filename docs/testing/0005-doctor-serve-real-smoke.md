# Bukti sementara fitur 2: doctor dan serve pada aplikasi nyata

Tanggal: 2026-10-02. Kandidat: commit dasar `9227a71c26af7a36188116415bf94f5aaa3d2e4e` ditambah perubahan lokal pada `tests/integration/tooling-real/doctor-smoke.ts`. Sumber kriteria: [spec 0003](../specs/0003-doctor-serve-aplikasi-nyata/index.md), khususnya TOOL-001 dan bagian HTTP TOOL-007.

## Lingkungan dan perintah

`bun run test:tooling:real` membuat container sementara `foundation-postgres:18-pinned` pada port acak. Script memakai file environment berizin `0600`, menjalankan `database/provision.ts --apply` dan `database/migrate.ts --apply` dengan tiga credential terpisah, lalu menghapus container. Database dan volume Compose development tidak disentuh. Frontend dan backend dijalankan oleh `scripts/serve.ts` pada port 8889 dan 8888 hanya setelah script membuktikan kedua port kosong.

## Hasil aktual

Perintah keluar dengan status **0**. Doctor menerima role backend hasil provisioning: 12 pemeriksaan database lulus, termasuk target, versi, schema, batas role, privilege metadata, dan checksum migration. Doctor menolak target lain, hak `INSERT` metadata, keanggotaan role penulis, checksum berbeda, direktori migration kosong, role admin, serta database yang dihentikan. Output provisioning, migration, dan doctor diperiksa agar tidak memuat credential uji.

`serve` mengumumkan siap setelah preflight. GET backend `/api/status` memberi HTTP 200 dengan `{"status":"ok"}` dan GET frontend `/` memberi HTTP 200 dengan `Content-Type` HTML. Setelah SIGTERM ke supervisor, listener 8888 dan 8889 tidak tersisa. Script lama yang membuat schema contoh dan mengubah direktori migration proyek diganti dengan setup provisioning serta migration produk yang nyata.

## Batas bukti

Ini adalah smoke test CLI dan HTTP, tanpa JUnit. TOOL-007 masih **parsial**: alur Angular melalui SDK, proxy, backend, dan database di browser belum tersedia sebelum fitur 10. Pemeriksaan kegagalan database sesudah startup pada halaman juga menunggu fitur 10. Test fixture TOOL-002 sampai TOOL-006 dan TOOL-008 berada pada suite `bun run test:tooling`; hasil smoke ini tidak menggantikan review independen atau verifikasi penuh fitur 2.

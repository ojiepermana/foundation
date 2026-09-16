# Foundation

**Status**: Implemented and verified within recorded scope
**Date**: 2026-09-16

## Summary
Implementasi keputusan yang disetujui pengguna. Cakupan AC: FND-001, FND-002, FND-003, OPS-001.

## Requirements dan design
Satu package.json, bun.lock, dan node_modules di root. Tidak ada manifest aplikasi lain. apps/web, apps/api, apps/worker, server, shared, scripts, dan database/migrations memiliki tanggung jawab terpisah. DTO bersama tidak mengimpor kode server.

Bun 1.4.2 menjalankan API, worker, CLI dan tes backend. Angular core 22.1.6, CLI/build 22.1.8, TypeScript 6.0.3, @ojiepermana/angular 22.1.13. Dependensi dikunci exact. Node hanya untuk tooling Angular apabila diperlukan. PostgreSQL 18 dan Redis >=7.2 menggunakan API native Bun. Lingkungan awal lokal, tanpa Docker dan deployment.

bun run dev mengelola ketiga proses, meneruskan signal, dan menghentikan seluruh anak jika salah satu gagal. Angular pada localhost:8088 memproksi /api ke localhost:8888. APP_URL memakai origin browser yang sama. API REST /api/v1 mengembalikan {data,meta?}; error {error:{code,message,fields?},requestId}. GET /api/health/live memeriksa proses; GET /api/health/ready memeriksa database dan Redis tanpa membocorkan koneksi.

Konfigurasi wajib: DATABASE_URL, REDIS_URL, APP_URL, APP_ENCRYPTION_KEY (base64 32 byte), SMTP_HOST, SMTP_PORT, SMTP_FROM. Opsional SMTP_USER, SMTP_PASSWORD, SMTP_SECURE, API_PORT, REDIS_PREFIX, WEBAUTHN_RP_ID, WEBAUTHN_RP_NAME dan TTL auth. Secret hanya di .env yang diabaikan Git. Config gagal cepat jika tidak valid. Log JSON menggunakan request/job ID dan tidak menyimpan token/password/koneksi/payload email.

FND-001: instalasi frozen berhasil dan pemeriksaan struktur menemukan hanya manifest root di luar dependensi/output. FND-002: browser mencapai Angular8088 dan proxy API8888. FND-003: migrasi database kosong berhasil, pengulangan aman, checksum berubah ditolak. OPS-001: database/Redis/SMTP gagal menghasilkan status terkontrol dan pemulihan terdokumentasi.

## Decision
Kontrak di atas disetujui dalam rencana Foundation. Default berasal dari rencana dan konfigurasi aplikasi; secret berasal dari environment.

## Build plan
* [x] Implementasikan kontrak dan batas otorisasi (FND-001, FND-002, FND-003, OPS-001).
* [x] Tambahkan pemeriksaan otomatis untuk hasil normal, input salah, dan kegagalan layanan (FND-001, FND-002, FND-003, OPS-001).
* [x] Jalankan verifikasi nyata dan catat bukti di matriks AC (FND-001, FND-002, FND-003, OPS-001).

## Consequences
Pemeriksaan otomatis tidak membuktikan kompatibilitas perangkat fisik. Bukti yang belum diperoleh tetap pending.

## Follow-up
Deployment dan fitur yang ditunda tidak termasuk versi ini. Review spec independen dilewati sesuai pilihan pengguna; review kode auth tetap diperlukan.

## Rationale
Reasoning dan sumber: [rationale.md](rationale.md).

## Evidence
Implementasi, skenario uji, hasil dan batas bukti: [matriks AC](../../../verification/ac-matrix.md).

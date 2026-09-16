# Cache dan lock

**Status**: Implemented and verified within recorded scope
**Date**: 2026-09-16

## Summary
Implementasi keputusan yang disetujui pengguna. Cakupan AC: CACHE-001, OPS-001.

## Requirements dan design
RedisCache melalui Bun.RedisClient menyediakan get, put(key,value,ttlSeconds), remember, forget, atomic add, increment, lock(key,ttlMs), clear, close. Semua key memakai prefix aplikasi:cache, queue memakai prefix terpisah. TTL wajib positif untuk penyimpanan baru. Serialization JSON dan counter memiliki kontrak eksplisit.

CACHE-001: get mengembalikan null untuk miss/expiry maupun nilai JSON null; remember memeriksa keberadaan key mentah sehingga cached null tidak dihitung ulang. remember menghitung lalu menyimpan ketika miss. Lock SET NX PX menggunakan token random; release/renew Lua membandingkan token. Lock habis tidak memberi pemilik lama hak melepaskan lock baru. Lock best effort untuk koordinasi, tidak menggantikan constraint/transaction untuk integritas bisnis.

Cache get/put yang gagal ditangani pemanggil sebagai kegagalan cache atau perhitungan ulang; lock/rate limiter tidak boleh dianggap berhasil saat Redis tidak tersedia. clear hanya SCAN dan hapus namespace cache aplikasi, tidak memakai FLUSHDB. CLI cache:forget <key>, cache:clear. Tes memakai dua client/proses dan memverifikasi TTL, counter concurrent, owner mismatch, serta queue tetap utuh.

## Decision
Kontrak di atas disetujui dalam rencana Foundation. Default berasal dari rencana dan konfigurasi aplikasi; secret berasal dari environment.

## Build plan
* [x] Implementasikan kontrak dan batas otorisasi (CACHE-001, OPS-001).
* [x] Tambahkan pemeriksaan otomatis untuk hasil normal, input salah, dan kegagalan layanan (CACHE-001, OPS-001).
* [x] Jalankan verifikasi nyata dan catat bukti di matriks AC (CACHE-001, OPS-001).

## Consequences
Pemeriksaan otomatis tidak membuktikan kompatibilitas perangkat fisik. Bukti yang belum diperoleh tetap pending.

## Follow-up
Deployment dan fitur yang ditunda tidak termasuk versi ini. Review spec independen dilewati sesuai pilihan pengguna; review kode auth tetap diperlukan.

## Rationale
Pilihan mengikuti keputusan pengguna agar memakai Bun native dan kontrak library resmi. Referensi: https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/.

## Evidence
Implementasi, skenario uji, hasil dan batas bukti: [matriks AC](../../verification/ac-matrix.md).

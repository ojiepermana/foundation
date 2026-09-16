# Email SMTP dan outbox

**Status**: Implemented and verified within recorded scope
**Date**: 2026-09-16

## Summary
Implementasi keputusan yang disetujui pengguna. Cakupan AC: MAIL-001, OPS-001.

## Requirements dan design
Nodemailer10 mengirim SMTP dengan TLS sesuai config dan kredensial dari env. Semua email memiliki HTML dan teks; nama dan URL di HTML di-escape. Template activation dan reset menggunakan APP_URL dan token dalam fragment agar tidak masuk access log/referer.

MAIL-001: enqueueMail(tx,config,message) mengenkripsi payload AES256GCM dengan key32byte dan IV random, lalu insert outbox pada transaksi pemanggil. Redis hanya menerima outboxId. Relay memakai lease dan SKIP LOCKED, dispatch id deterministik mail-UUID, dan tidak menghilangkan outbox ketika Redis gagal. Handler memeriksa sent sebelum mengirim, memakai lease token dan heartbeat, lalu menandai sent dan menghapus payload sensitif.

Pengiriman SMTP tidak memiliki transaksi atomik dengan DB; retry setelah penerimaan SMTP dapat mengirim email yang sama lagi. Token tetap sama dan hanya satu kali dapat digunakan. Failed disimpan untuk retry CLI, tidak dicoba tanpa batas. last_error hanya kategori aman. Rotasi encryption key memerlukan penyelesaian outbox atau migrasi ciphertext sebelum mengganti key.

Verifikasi memakai SMTP sink lokal, tidak mengirim email nyata ke pihak lain. Tes mencakup HTML escaping, dekripsi dengan key salah, rollback enqueue, gangguan SMTP, replay sent, dan relay Redis gagal.

## Decision
Kontrak di atas disetujui dalam rencana Foundation. Default berasal dari rencana dan konfigurasi aplikasi; secret berasal dari environment.

## Build plan
* [x] Implementasikan kontrak dan batas otorisasi (MAIL-001, OPS-001).
* [x] Tambahkan pemeriksaan otomatis untuk hasil normal, input salah, dan kegagalan layanan (MAIL-001, OPS-001).
* [x] Jalankan verifikasi nyata dan catat bukti di matriks AC (MAIL-001, OPS-001).

## Consequences
Pemeriksaan otomatis tidak membuktikan kompatibilitas perangkat fisik. Bukti yang belum diperoleh tetap pending.

## Follow-up
Deployment dan fitur yang ditunda tidak termasuk versi ini. Review spec independen dilewati sesuai pilihan pengguna; review kode auth tetap diperlukan.

## Rationale
Pilihan mengikuti keputusan pengguna agar memakai Bun native dan kontrak library resmi. Referensi: https://nodemailer.com/smtp.

## Evidence
Implementasi, skenario uji, hasil dan batas bukti: [matriks AC](../../verification/ac-matrix.md).

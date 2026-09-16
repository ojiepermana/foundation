# Jobs native Redis

**Status**: Implemented and verified within recorded scope
**Date**: 2026-09-16

## Summary
Implementasi keputusan yang disetujui pengguna. Cakupan AC: JOB-001, JOB-002, JOB-003, MAIL-001.

## Requirements dan design
RedisQueue memakai Bun.RedisClient tanpa BullMQ. API dispatch(name,payload,{id?,delayMs?,maxAttempts?}), work(handlerRegistry,{signal,concurrency}), failed({limit}), inspect(id), retry(id), close(). Payload JSON, nama handler berasal dari registry server, bukan kode yang dieksekusi dari payload. ID deterministik mencegah enqueue ganda selama metadata masih tersimpan.

JOB-001: Streams consumer group memegang ready jobs, sorted set memegang due time, hash memegang metadata status. Lua pendek menggabungkan perubahan metadata dan enqueue/ack/retry. Delay memakai clock Redis. Status ready/delayed/running/completed/failed. Default concurrency4, timeout30detik, lease60detik, heartbeat15detik, maxAttempts5. Retry bertahap dengan backoff terbatas. Failed dapat dilihat dan dicoba lagi melalui CLI; manual retry hanya failed dan mengulang budget percobaan dengan transisi atomik.

JOB-002: XAUTOCLAIM memulihkan pending entries setelah lease idle. Heartbeat memperbarui lease sekaligus idle PEL. Jangan menghapus atau memangkas stream yang masih pending. Retensi completed24jam dan failed30hari, cleanup hanya terminal. Worker shutdown menghentikan claim baru, membatalkan pekerjaan kooperatif, dan menyisakan pending untuk pemulihan.

JOB-003: setiap attempt memiliki owner token. ACK, failure, retry, heartbeat dan completion memverifikasi token agar worker lama ditolak. Timeout kooperatif tidak dapat membatalkan side effect eksternal yang sudah terjadi. Eksekusi setidaknya sekali; handler wajib idempotent pada resource yang dilindungi. Fencing metadata queue tidak menjamin exactly once SMTP.

Namespace queue terpisah dari cache. Redis noeviction dan persistence wajib untuk durability. AOF everysec menerima potensi kehilangan sekitar1detik pada bencana, always memperkecil jendela dengan biaya latency. Outbox PostgreSQL menyimpan intent email hingga terkirim, dan direkonsiliasi ketika queue hilang. Tidak ada perubahan config shared Redis otomatis.

CLI: bun run jobs:work, jobs:failed, jobs:retry <id>. Tidak mencakup cron, chain/batch, Redis Cluster, atau failover correctness lintas primary. Test memakai namespace unik dan isolated Redis untuk restart/crash.

## Decision
Kontrak di atas disetujui dalam rencana Foundation. Default berasal dari rencana dan konfigurasi aplikasi; secret berasal dari environment.

## Build plan
* [x] Implementasikan kontrak dan batas otorisasi (JOB-001, JOB-002, JOB-003, MAIL-001).
* [x] Tambahkan pemeriksaan otomatis untuk hasil normal, input salah, dan kegagalan layanan (JOB-001, JOB-002, JOB-003, MAIL-001).
* [x] Jalankan verifikasi nyata dan catat bukti di matriks AC (JOB-001, JOB-002, JOB-003, MAIL-001).

## Consequences
Pemeriksaan otomatis tidak membuktikan kompatibilitas perangkat fisik. Bukti yang belum diperoleh tetap pending.

## Follow-up
Deployment dan fitur yang ditunda tidak termasuk versi ini. Review spec independen dilewati sesuai pilihan pengguna; review kode auth tetap diperlukan.

## Rationale
Reasoning dan sumber: [rationale.md](rationale.md).

## Evidence
Implementasi, skenario uji, hasil dan batas bukti: [matriks AC](../../../verification/ac-matrix.md).

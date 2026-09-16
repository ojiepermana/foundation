# Verifikasi jobs native Redis

```sh
TEST_REDIS_URL=redis://127.0.0.1:6379 bun test --timeout 30000 tests/unit/queue.test.ts tests/integration/queue.test.ts tests/integration/queue-durability.test.ts tests/integration/mail.test.ts
```

| AC | Kondisi dan hasil yang harus dibuktikan |
|---|---|
| JOB-001 | ID deterministik tidak menggandakan job; delay tidak berjalan sebelum due; kegagalan mengikuti backoff; timeout membatalkan handler; concurrency dibatasi; failed dapat diulang dengan budget baru. |
| JOB-002 | Dua worker mempertahankan pemilik sehat melalui heartbeat; child process dibunuh sesudah efek samping, lalu worker lain memulihkan pending tanpa mengulangi efek yang terlindungi idempotency key. |
| JOB-002 | SIGKILL/restart Redis uji dengan AOF mempertahankan ready, delayed, dan pending; pending yang belum menghasilkan efek diselesaikan oleh worker baru. Jangan menghapus pending entries. |
| JOB-003 | Token lease lama tidak dapat heartbeat, complete atau retry sesudah takeover; pemilik baru dapat complete; callback terlambat tidak mengubah status terminal. |
| MAIL-001 | Relay hanya mengirim referensi outbox ke Redis; SMTP sink menerima pesan; outbox sent dan job completed; replay sent tidak mengirim lagi. |

`redis-server` harus tersedia untuk tes durability. Tes memakai prefix/direktori sementara; tidak mengubah persistence Redis bersama. Tes yang skipped bukan bukti pemulihan. Rekam ringkasan dan batas lingkungan di [matriks AC](../../../verification/ac-matrix.md).

Pemeriksaan operasional: `bun run jobs:failed`, lalu `bun run jobs:retry <job-id>` setelah penyebab gagal diperbaiki. Verifikasi attempt baru dan status akhir. Gunakan [runbook](../../../verification/operations.md) bila metadata queue hilang atau outbox memerlukan review. Queue menjamin eksekusi setidaknya sekali, bukan exactly once efek samping.

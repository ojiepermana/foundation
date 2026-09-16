# Verifikasi Foundation

Hasil tercatat di [matriks AC](../../../verification/ac-matrix.md). Perintah dijalankan dari root; siapkan env dan layanan sesuai README.

| AC | Langkah | Hasil yang harus diperiksa |
|---|---|---|
| FND-001 | `bun install --frozen-lockfile`, `bun run check:structure` | Tidak ada perubahan lockfile; satu manifest aplikasi dan instalasi root; Bun 1.4.2. |
| FND-002 | `bun run dev`, buka login 8088 dan ready melalui 8088/8888 | Angular, API dan worker hidup; proxy same origin memberi respons sehat. Tidak ada fallback port diam-diam. |
| FND-003 | `bun run typecheck:server`, `bun run build`, jalankan `operations.test.ts` | Build/typecheck lulus; migrasi serialized, repeat aman, checksum berubah ditolak, SQL rusak rollback. |
| FND-003 | `bun run test:e2e` | Harness membuat database kosong dan menerapkan semua migrasi sebelum alur aplikasi. |
| OPS-001 | Jalankan tes integration operations/mail/queue durability | DB/Redis gagal menghasilkan error terkontrol; SMTP retry; restart Redis terisolasi memulihkan queue. |

```sh
TEST_REDIS_URL=redis://127.0.0.1:6379 bun test --timeout 30000 tests/integration/operations.test.ts tests/integration/mail.test.ts tests/integration/queue-durability.test.ts
```

Jangan mematikan layanan bersama untuk tes kegagalan. Suite memakai endpoint tertutup untuk simulasi outage dan Redis terpisah untuk SIGKILL/restart. Ikuti [runbook](../../../verification/operations.md) untuk pemulihan operasional dan batas jaminan AOF.

# Review, db21ead, 2026-10-02

**Reviewed by**: GPT-6 Sol (author on GPT-6 Astra)
**Scope**: 12 files, `db21ead^` vs `db21ead`
**Verdict**: Changes requested

## Summary

Fitur ini memisahkan role owner, migrator, dan backend, membuat metadata migration, serta menghubungkan pool ke lifecycle backend. Pemeriksaan privilege efektif, transaksi dengan advisory lock, dan test PostgreSQL nyata memberi dasar yang kuat. Validasi constraint checksum masih dapat menerima drift yang melemahkan integritas metadata; ada pula jalur shutdown gagal dan cakupan test yang belum memenuhi seluruh skenario spec.

## Major

### 🟠 Drift CHECK checksum dapat diterima, `database/provision.ts:119`
**Problem**: Validasi `schema_migrations_checksum_hex` hanya menguji apakah teks definisi mengandung pola `'^[0-9a-f]{64}$'`. Definisi dengan nama yang sama seperti `CHECK (checksum ~ '^[0-9a-f]{64}$' OR true)` tetap lulus bersama empat constraint lain, padahal membolehkan checksum apa pun. Test DATA-002 hanya mengubah default kolom, bukan ekspresi CHECK.
**Why it matters**: Rerun provisioning melaporkan tabel terverifikasi ketika invariant 64 karakter heksadesimal sudah hilang. Ini melanggar AC-2 dan ketentuan AC-5 untuk gagal aman pada drift struktural, serta dapat membiarkan riwayat migration yang tidak valid masuk.
**Suggested fix**: Bandingkan struktur atau definisi CHECK secara penuh dengan bentuk yang diharapkan pada PostgreSQL 18; tambahkan test yang mengganti constraint bernama sama dengan ekspresi yang memuat pola tetapi menerima nilai salah, lalu pastikan provisioning menolak tanpa mengubah state.

## Minor

### 🟡 Pool dapat tertinggal saat penghentian listener gagal, `apps/backend/src/index.ts:17`
**Problem**: `pool.close()` hanya berjalan setelah `app.stop(true)` berhasil. Jika penghentian listener menolak, `finally` hanya membatalkan timer; pool tidak ditutup dan async signal handler berakhir dengan rejection.
**Why it matters**: Jalur error melewatkan janji AC-6 bahwa pool ditutup saat shutdown, sementara deadline lima detik yang seharusnya membatasi lifecycle juga dibatalkan.
**Suggested fix**: Letakkan penutupan pool dalam jalur `finally` yang tetap berjalan setelah `app.stop(true)` gagal, dan pertahankan batas waktu serta penanganan error shutdown.

### 🟡 DATA-005 tidak membuktikan beberapa cabang kontrak, `tests/integration/database/provision.test.ts:232`
**Problem**: Test backend hanya menjalankan `DATABASE_URL` terisi dan `SIGTERM`. Spec DATA-005 juga mensyaratkan start langsung tanpa URL, `SIGINT`, serta pemeriksaan bahwa URL atau credential tidak masuk output, JUnit, dan bundle frontend. Test pool terpisah tidak menguji cabang tersebut.
**Why it matters**: Perubahan pada cabang tanpa URL atau propagasi secret ke artefak dapat lolos dari suite fitur 5, meski skenario terdaftar sebagai bukti AC-6 dan AC-7.
**Suggested fix**: Tambahkan verifikasi cabang tanpa URL dan artefak yang disebut spec; jalankan kedua sinyal atau dokumentasikan bukti runtime yang terikat pada commit kandidat dan tercatat pada skenario.

## Strengths

- Provisioning memakai satu transaksi dan advisory lock sebelum pemeriksaan katalog serta perubahan role, schema, dan grant.
- Test nyata memeriksa penolakan INSERT, UPDATE, DELETE, TRUNCATE, DDL, TEMP, dan `SET ROLE` untuk backend; password tidak dicetak pada output yang diuji.

## Test coverage

Saya membaca test DATA-001 sampai DATA-005 dan registry skenario, serta menjalankan `git diff --check db21ead^ db21ead` (exit 0, tanpa output). Saya tidak menjalankan suite database atau gate CI pada review ini; hasil 10 test dan 64 assertion dalam laporan implementasi adalah bukti penulis, bukan rerun independen saya. Cakupan drift privilege, membership, default ACL, dan lock timeout sudah ada; drift ekspresi CHECK serta cabang DATA-005 di atas belum dibuktikan oleh test dalam commit yang ditinjau.

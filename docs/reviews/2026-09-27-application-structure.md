# Review, main, 2026-09-27

**Reviewed by**: GPT-6 Sol (author on GPT-6 Astra)
**Scope**: 59 files, uncommitted against HEAD `4daedac1d2836a68ed11509271a2f82a66dd7841`; excludes the pre-existing dirty root `.gitignore` and this review report.
**Verdict**: Approve

## Summary

Fitur 4 menyediakan aplikasi Angular dan komposisi backend nyata, runtime/dependency pins, ekspor OpenAPI, SDK standalone, serta gate dan skenario pengujian. Pemisahan komposisi dari listener dan penutupan permukaan diagnostik production sesuai spec 0001. Satu temuan Major pada pemeriksaan inventory SDK dan satu Minor pada literal generated telah diperbaiki selama review. Tidak ada temuan terbuka pada source akhir yang ditinjau.

## Resolved during review

### Major: file SDK tambahan di luar manifest diterima oleh `api:check`

Versi awal `scripts/check-api.ts` hanya membandingkan snapshot folder sebelum dan sesudah regenerasi. Reproduksi reviewer pada workspace sementara menambahkan `sdk/unowned-extra.ts` tanpa mengubah manifest: dua regenerasi selesai, file tetap ada, dan `api:check` exit 0. Test awal bernama `new generated artifacts` hanya menambahkan file sekaligus memasukkannya ke manifest, sehingga tidak menangkap kasus tersebut.

Agent utama menambahkan validasi manifest dan kesamaan inventory aktual terhadap manifest di `scripts/check-api.ts:15`, serta regression `new-unowned` di `tests/integration/contract/openapi.test.ts`. Reviewer membaca perbaikan dan mengulang seluruh suite kontrak: **47 passed, 0 failed**, termasuk reproduksibilitas, file changed/missing/new/new-unowned, serta penghentian tahap pipeline. Temuan Major ini selesai dan tidak menjadi penghambat verdict akhir.

### Minor: literal response hilang pada tipe SDK

Awalnya OpenAPI memakai `const: "ok"`, tetapi `apps/frontend/sdk/models/development-status.ts:5` menghasilkan `status: string` karena parser generator membaca `enum`, bukan `const`, pada field primitive. Agent utama memperbaiki schema sumber di `apps/backend/src/features/development/status.routes.ts:4` menjadi `t.Literal('ok', { enum: ['ok'] })`, lalu mengekspor dan meregenerasi SDK. Reviewer membaca delta aktual: OpenAPI mempunyai const dan enum singleton, tipe generated kini `status: 'ok'`, serta response 500 memiliki schema eksplisit. Suite kontrak diulang setelah delta ini: **47 passed, 0 failed**. SDK tidak diedit manual; temuan ini selesai.

Regression tambahan mengompilasi consumer SDK dengan `status: 'ok'` serta `@ts-expect-error` untuk `status: 'unexpected'`. Reviewer menjalankan test tersebut secara langsung dan mendapat **1 passed, 0 failed**; tipe yang kembali melonggar ke string akan membuat directive tidak terpakai dan compiler gagal.

## Strengths

- `createApp()` dapat dipakai tanpa listener atau database. Production menghilangkan route development dan plugin OpenAPI; focused reviewer test membuktikan 404 pada komposisi dan listener bundle production serta sanitasi error 500.
- Test lifecycle memakai port sementara, menguji source dan bundle, SIGTERM/SIGINT, serta penggunaan ulang port. Gate kontrak menjalankan generator sebenarnya; fixture negatif mencakup metadata, operationId, security, schema, dan reference.
- UI menggunakan public entry point layout library, alias SDK masuk kompilasi Angular, dan E2E memeriksa halaman tanpa panggilan API, proxy backend nyata, viewport desktop/mobile, serta skip-link keyboard.

## Test coverage

Reviewer menjalankan perintah berikut secara aktual:

| Command | Result |
| --- | --- |
| `bun run check:dependencies` | Exit 0; pins, runtime, engines, installed peers diperiksa. |
| `bun run test:scenarios` | Exit 0; 8 unique IDs dan referensi lolos. Validator ini memeriksa referensi, bukan hasil runner. |
| `bun run typecheck:backend` | Exit 0 pada source akhir, termasuk schema literal/response500. |
| `bun run api:check` | Exit 0 pada source akhir; ekspor, validasi, dan regenerasi SDK dua kali identik dengan kandidat. Model generated tetap `status: 'ok'`. |
| `bun test ./tests/integration/contract --test-name-pattern 'checker\|validation CLI'` | 39 passed, 7 filtered out, 0 failed pada kandidat sebelum inventory fix. |
| `bun test ./tests/integration/contract` | Dua eksekusi: setelah inventory fix dan setelah perbaikan literal/response500; masing-masing 47 passed, 0 failed, 63 assertions. |
| `bun test ./tests/integration/contract --test-name-pattern 'generated status type'` | 1 passed, 47 filtered out, 0 failed; consumer TypeScript membuktikan literal SDK. |
| `bun test ./tests/integration/backend --test-name-pattern 'production\|unexpected\|invalid configuration\|configuration accepts'` | 13 passed, 7 filtered out, 0 failed; 54 assertions. Listener production memakai port sementara. |
| Reproduksi `bun --no-env-file -e ...` pada workspace temp dengan extra SDK file tanpa manifest | Sebelum fix: `api:check` exit 0 dan extra file tetap ada; seluruh temp workspace dibersihkan. Kasus ini kini dicakup regression yang lulus di suite kontrak. |

Perintah inspeksi: `git status --short`, `git diff HEAD --stat`, `git diff HEAD --name-only`, `git diff HEAD -- README.md package.json docs/specs/0001-struktur-aplikasi-dependency/index.md`, `git ls-files --others --exclude-standard`, `git rev-parse HEAD`, `git branch --show-current`, pembacaan source/config/test/rules dengan `cat`/`sed`/`nl`, dan pencarian terkait melalui `rg`. Query lokal `graphify query 'check-api snapshot SDK manifest stale files api sync' --budget 1000` menemukan rules dan struktur lama; graph belum memuat seluruh source baru, sehingga keputusan review bertumpu pada source aktual.

Root melaporkan gate akhir `test:ci` exit 0 setelah semua perbaikan dan regression consumer. Reviewer membaca `.local/feature-4/test-ci-final.log` dan fresh JUnit: 68 server/contract, 1 Vitest, 7 tooling, 2 Playwright = **78 passed, 0 failed, 0 skipped**. Reviewer tidak menjalankan sendiri gate penuh, build Angular, frontend suite, atau Playwright karena root memiliki verifikasi integrasi; angka gate tersebut merupakan bukti runner root yang dibaca reviewer. Reviewer kemudian mengulang typecheck backend dan `api:check` secara langsung, dengan exit 0 dan artefak identik. Tidak ada eksekusi CI remote dalam review ini; kandidat adalah worktree lokal uncommitted terhadap base `4daedac1d2836a68ed11509271a2f82a66dd7841`.

## Scope and limits

Governing scope: fitur 4 GA pada `docs/scope/scope.md`; governing spec: `docs/specs/0001-struktur-aplikasi-dependency/index.md`, AC-1 sampai AC-6. Rubric: skill `/check review`, review-agent-prompt dan review-guide. Aturan repo yang dibaca mencakup workflow, testing, security, Angular/UI/UX, Bun/Elysia, database, OpenAPI/SDK, dan development commands.

Review meliputi manifest/pins/lock metadata, backend, frontend, generated SDK, checker/exporter/orchestration, fixtures/registry, Playwright config, CI workflow, README, dan verify checklist. Binary favicon tidak dianalisis sebagai source. Tidak ada perubahan schema, role, privilege, query database, migration, atau worker. Tidak ada provider eksternal yang diperlukan atau dipanggil.

Route publik development hanya memberi konstanta, bind lokal ditegakkan oleh validasi konfigurasi, dan production menutup route serta dokumentasi. Tidak ditemukan Blocker atau Major yang masih terbuka pada source yang ditinjau. Batas resource pada listener tersedia (body 1024 bytes, idle timeout 10 detik); pengukuran kapasitas, header dokumen deployment, scanner keamanan kandidat, integrasi database, konsumsi runtime SDK, dan readiness production berada di scope berikutnya. Verdict review ini bukan sertifikasi penuh OpenAPI, bukti readiness production, atau izin deployment.

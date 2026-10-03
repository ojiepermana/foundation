# Review, main, 2026-10-03

**Reviewed by**: Sonnet 5.5 (author on opus)
**Scope**: 31 file, uncommitted (`git diff HEAD` ditambah file untracked; dasar `79075e8c3cf52f645b140f49e6b38f5f328a92e7`)
**Verdict**: Approve with nits

## Summary

Perubahan ini mengganti `api:check` dengan regenerasi terisolasi dua run yang membandingkan seluruh pohon file, menambah `runProcessGroup` yang menghentikan seluruh process group tahap sebelum folder sementara dihapus, mempin locale `sdk:generate`, memasang tabel batas impor `@sdk` pada checker bundle, dan menyediakan harness backend nyata untuk test Vitest. Reviewer tidak menemukan blocker maupun major. Perilaku sesuai spec 0009 pada semua jalur yang dijalankan reviewer, dan seluruh gate lokal lulus. Temuan yang tersisa adalah isolasi symlink yang lebih sempit daripada klaimnya (dibuktikan dua probe reviewer), pesan checker bundle yang mencetak nama file mentah, bukti yang sudah usang terhadap suite saat ini, dan beberapa cabang pertahanan yang belum diuji.

## Minor

### 🟡 Pemeriksaan symlink pada `copyApiInputs` hanya leksikal dan tidak menutup janji isolasi `.env`, `scripts/lib/api-artifacts.ts:52`

**Problem**: `checkSymlinks` memutuskan dengan `resolve(dirname(path), target)`, yang menghitung `..` secara leksikal, dan hanya memeriksa symlink di dalam input. Dua celah dibuktikan reviewer dengan probe di scratchpad di luar repository. Pertama, symlink `scripts/leak` dengan target `../node_modules/../.env` diterima, karena secara leksikal hasilnya `<root>/.env`. Di workspace, `node_modules` adalah symlink ke checkout, sehingga sistem operasi menelusuri `node_modules/..` ke root checkout dan membaca `.env` asli (probe mencetak nilai sentinel dari `.env` checkout). Kedua, bila `apps` pada checkout adalah symlink ke direktori di luar checkout, `lstat` pada `apps/backend` mengikutinya dan `copyApiInputs` menyalin isi dari luar tanpa error, karena segmen perantara path input tidak diperiksa, padahal `readArtifacts` memeriksa segmen untuk sisi artefak.

**Why it matters**: Spec (bagian `API_INPUTS`), `docs/rules/openapi-sdk.md`, dan AC-9 menyatakan symlink relatif yang tetap di dalam root hanya dapat menjangkau salinan di workspace, yang tidak pernah memuat `.env`. Klaim itu keliru untuk dua bentuk di atas. Model ancaman spec menyebut branch dengan symlink sebagai masukan yang harus ditangani. Dampak nyata hari ini kecil, karena membaca symlink itu ke dalam artefak membutuhkan kode tepercaya yang membacanya, dan tidak ada kode seperti itu di repository. Tetapi jaminan yang ditulis lebih kuat daripada yang ditegakkan, dan test AC-9 hanya mencakup target absolut serta target relatif yang keluar secara leksikal.

**Suggested fix**: Tolak target relatif yang memuat segmen `node_modules` (atau yang memuat `..` sesudah segmen biasa), atau verifikasi sesudah salinan dengan `realpath` bahwa setiap symlink di workspace tetap berada di dalam workspace di luar `node_modules`. Periksa juga setiap segmen path input dari root dengan `lstat`, seperti yang sudah dilakukan `readArtifacts`. Tambah dua kasus ke test `copyApiInputs` SDK-009, lalu perbaiki kalimat jaminannya di spec dan aturan bila cakupannya tetap lebih sempit.

### 🟡 Checker bundle mencetak path file apa adanya, `scripts/lib/frontend-bundle.ts:220`

**Problem**: `displayPath` hanya mengubah path menjadi relatif dengan `/`, lalu path itu masuk ke tiga pesan tetap (baris 251, 254, dan 296). Reviewer membuat fixture dengan nama file yang memuat newline (`a<newline>::error::injected.ts` berisi `import 'node:fs'`) dan menjalankan `scripts/check-frontend-bundle.ts`. Stderr berisi dua baris, dan baris kedua `::error::injected.ts.` mulai di kolom pertama.

**Why it matters**: AC-3 menjanjikan stderr tepat satu pesan dan satu newline. Model ancaman spec menyebut nama file berkarakter kontrol, dan `api:check` sudah menanganinya lewat `formatArtifactPath`, tetapi checker bundle tidak. Pada GitHub Actions, baris yang diawali `::` adalah perintah workflow, sehingga branch dengan nama file seperti itu dapat memalsukan anotasi pada log CI. Kebocoran data tidak terjadi.

**Suggested fix**: Pakai aturan yang sama dengan `formatArtifactPath` (apa adanya bila cocok `^[A-Za-z0-9._@+/-]+$`, selain itu literal berkutip dengan `\uXXXX`) untuk path di ketiga pesan, sebaiknya dengan memindahkan fungsi itu ke satu helper bersama. Tambah test SDK-003 dengan nama file berisi newline dan U+001B.

### 🟡 Laporan bukti dan JUnit masih menggambarkan suite sebelum `/check verify` dan `/test`, `docs/testing/0008-sdk-contract.md:3`

**Problem**: Laporan ditulis pada langkah build dan baris 3 serta 108 masih menyatakan verifikasi, pengujian, dan review belum dijalankan. Reviewer menjalankan ulang suite: `bun test ./tests/integration/backend ./tests/integration/contract` menghasilkan 577 test dengan 1.968 assertion, 0 gagal; `bun test` pada `sdk.test.ts` dan `frontend-bundle.test.ts` menghasilkan 105 test (laporan: 37 ditambah 55 sama dengan 92); `bun run test:frontend` menghasilkan 7 test (laporan: 6). Laporan (tabel perintah baris 22 sampai 26 dan tabel per skenario baris 40 sampai 51) dan JUnit di `docs/testing/evidence/0008/` (`integration.xml` 564 test dengan 1.850 assertion, `frontend.xml` 6 test, `sdk.xml` 37 test) masih memakai angka lama. Scope sudah mencatat 577 dan 7 pada paragraf `Kode tersedia`, sehingga dua dokumen yang di-commit saling berbeda.

**Why it matters**: Aturan testing meminta laporan memuat perintah dan hasil aktual. Pembaca laporan dapat menyangka 13 test Bun dan 1 test Vitest tambahan dari `/test` tidak pernah dijalankan, dan bukti yang menyertai commit tidak cocok dengan test yang di-commit.

**Suggested fix**: Jalankan ulang perintah JUnit di laporan sesudah review ini, salin hasilnya ke `docs/testing/evidence/0008/` tanpa atribut `hostname`, lalu perbarui jumlah test, tabel per skenario, dan bagian batas bukti. Langkah ini cocok dikerjakan bersama `/document`. Perbarui juga kalimat terakhir paragraf `Kode tersedia` di `docs/scope/scope.md:249` ("Review dan dokumentasi belum dijalankan") setelah dokumentasi selesai.

### 🟡 Tiga cabang pertahanan belum punya bukti, `scripts/lib/api-check.ts:130`

**Problem**: Tidak ada test yang menjalankan (a) kegagalan `rm` pada pembersihan folder sementara (baris 130 sampai 135, yang mengubah hasil lulus menjadi exit 1 dengan `API check failed`), (b) `runProcessGroup` yang melempar `Process group did not stop` ketika group bertahan 5 detik sesudah SIGKILL (`scripts/lib/process-group.ts:56` dan `:104`), dan (c) `stopChild` pada harness yang melempar `SDK contract backend did not stop` (`apps/frontend/vitest-backend.setup.ts:148`). Laporan bukti sendiri mencatat butir (b) sebagai tidak diuji.

**Why it matters**: Ketiganya adalah jalur yang menjaga janji bahwa tidak ada proses atau folder tersisa. Bila salah satunya rusak pada refactor berikutnya, seluruh suite tetap hijau.

**Suggested fix**: Untuk (a), jalankan `runApiCheck` dengan `TMPDIR` berisi folder yang tidak dapat dihapus (mode tanpa izin tulis pada subfolder) dan periksa pesan serta exit 1. Untuk (b), suntikkan fungsi `groupAlive` yang selalu `true` lewat parameter test, atau pakai group yang tidak dapat dihentikan bila ada. Untuk (c), suntikkan child tiruan yang tidak pernah memancarkan `exit` supaya cabang itu dapat dijalankan dengan batas waktu kecil.

## Nits

- ⚪ `scripts/lib/process-group.ts:119`, listener `abort` dipasang sesudah menunggu event `spawn`. Sinyal yang tiba pada jeda beberapa milidetik itu hilang, group tidak dihentikan, dan `api:check` baru selesai setelah tahap itu berakhir atau melewati batas 120 detik. Periksa `options.signal.aborted` sekali lagi tepat sesudah listener dipasang.
- ⚪ `scripts/lib/api-check.ts:111`, hanya SIGINT dan SIGTERM yang ditangani sesuai spec. Karena `spawn` dengan `detached: true` membuat session baru, menutup terminal (SIGHUP) mematikan `api:check` tetapi membiarkan group `api:sync` berjalan dan folder `foundation-api-check-*` tertinggal. Pertimbangkan SIGHUP dengan exit 129, dan catat sebagai tambahan spec.
- ⚪ `scripts/lib/api-artifacts.ts:20`, `API_OUTPUTS` diekspor sesuai spec tetapi tidak dipakai di mana pun, sedangkan `scripts/lib/api-check.ts:18` menulis daftar `outputs` sendiri dan `readArtifacts` menulis ulang path SDK. Pakai satu sumber, atau hapus ekspor yang tidak terpakai dan ubah baris *Modul artefak* di spec.
- ⚪ `docs/specs/0009-sdk-sesuai-kontrak-backend/index.md:24`, AC-7 menulis hasil run pertama "disalin" ke `run1/`, sedangkan `keepFirstRun` (`scripts/lib/api-check.ts:47`) memindahkannya dengan `rename` supaya run kedua mulai kosong. Aturan OpenAPI dan laporan bukti sudah menulis "dipindahkan". Selaraskan kata di spec lewat `/architect` atau `/sync`.
- ⚪ `docs/rules/openapi-sdk.md:32`, pohon `Lokasi file` memuat `check-api.ts` dan `vitest-backend.setup.ts` tetapi belum memuat `scripts/lib/api-check.ts`, `scripts/lib/api-artifacts.ts`, `scripts/lib/process-group.ts`, `apps/frontend/vitest-base.config.ts`, dan `apps/frontend/vitest-provided-context.d.ts`.
- ⚪ `apps/frontend/vitest-backend.setup.ts:244`, bila `startShared()` gagal, state `{ promise, users }` yang menolak tetap tersimpan di `globalThis` karena tidak ada teardown yang menghapusnya. Pada Vitest yang dimulai ulang di proses yang sama (mode watch dengan perubahan config), setup berikutnya langsung gagal dengan error lama walau penyebabnya sudah diperbaiki. Hapus kunci itu pada jalur gagal.

## Strengths

- `runProcessGroup` dan `runApiCheck` menepati urutan yang dijanjikan: SIGTERM ke seluruh group, SIGKILL sesudah masa tenggang, menunggu group habis, baru menghapus folder sementara. Test SIGTERM, SIGINT, dan batas waktu memeriksa exit code, tidak ada baris laporan, proses cucu mati, `TMPDIR` kosong, dan checkout byte identik. Reviewer menjalankan seluruh suite dan tidak menemukan proses atau folder sisa.
- Pembandingan artefak dirancang defensif dan dibuktikan: `lstat` tanpa mengikuti symlink termasuk pada akar folder SDK, ukuran dibandingkan lebih dulu, hash streaming hanya untuk pasangan file berukuran sama, file sparse 2 GiB bermode `000` dan FIFO tidak pernah dibuka, serta nama path dengan karakter kontrol di-escape.
- Checker impor SDK memakai AST TypeScript dan tabel bentuk impor yang punya kasus uji untuk setiap baris, urutan file dan specifier menurut code unit, dan pesan tetap tanpa stack. Kasus UI-003 lama tetap lulus tanpa perubahan asersi selain penegasan stderr.
- Klaim kontrol negatif AC-4 benar: reviewer menjalankan backend dengan `DATABASE_URL=not-a-url` dan `--no-env-file`, dan backend gagal start (`Backend startup failed`), jadi kelulusan harness tanpa variabel itu memang membuktikan nilai tidak sampai ke backend. Environment child tepat lima kunci dan satu backend melayani seluruh run (satu baris `listening`, satu baris `stopped`, port ditolak sesudahnya).
- Laporan bukti jujur tentang batasnya (Linux aarch64 saja, symlink di `src` dilewati checker, cabang yang tidak diuji, deviasi `rename`), mencatat kontrol mutasi, dan rationale spec menandai keputusan sebagai keputusan agent atas delegasi pemilik.
- Tidak ada dependency, variable environment, secret, route, atau perubahan database baru. `check:dependencies` lulus dan `typecheck:contract` kini mencakup `scripts/` dan file Vitest, sehingga temuan gate tipe pada review fitur 8 sudah tertutup.

## Test coverage

Sinyal test **configured**. Reviewer membaca seluruh diff dan file baru (kode `scripts/`, tiga file harness Vitest, spec Vitest, `workspace.ts`, bagian besar `sdk.test.ts` dan `frontend-bundle.test.ts`), spec 0009 (`index.md`, header `rationale.md` dan `verify.md`), laporan bukti, aturan OpenAPI dan SDK, serta `AGENTS.md`.

Perintah yang dijalankan reviewer, semua exit 0: `bun run typecheck:contract` (bersih), `bun run test:scenarios` (48 ID unik), `bun run check:dependencies`, `bun test ./tests/integration/contract/sdk.test.ts ./tests/integration/contract/frontend-bundle.test.ts` (105 test, 741 assertion, 44,6 detik), `bun test ./tests/integration/backend ./tests/integration/contract` dengan reporter JUnit ke scratchpad (577 test, 1.968 assertion, 57,2 detik), `bun run test:frontend` (2 file, 7 test, tepat satu baris `SDK contract backend listening on 127.0.0.1:<port>` dan satu baris `stopped`), `bun run api:check` (baris sukses `OpenAPI and SDK match stored artifacts across two runs`), `bun run build:frontend` (initial 675,94 kB, warning anggaran 500 kB yang sudah ada), dan `bun run check:frontend:bundle`. Probe tambahan di scratchpad di luar repository: dua probe `copyApiInputs` (temuan minor pertama), satu fixture checker bundle dengan newline pada nama file (temuan minor kedua), dan backend dengan `DATABASE_URL=not-a-url`. Setelah semua run, `git status --short` tetap 27 baris seperti sebelum review, tidak ada proses `bun`, `ng`, atau `sleep` tersisa, tidak ada folder `foundation-*` di `TMPDIR`, dan port 8888 dan 8889 kosong. Reviewer tidak menjalankan `test:e2e`, `test:tooling`, kontainer Linux, dan `test:ci` penuh; hasilnya mengandalkan laporan bukti dan verify.

Cakupan fitur ini kuat: setiap AC punya skenario dengan kontrol negatif, mutasi, atau probe nyata, dan test menyentuh cabang sinyal, batas waktu, FIFO, file sparse, dan symlink. Celah yang tersisa adalah tiga cabang pertahanan pada temuan minor keempat, kasus symlink perantara dan `node_modules` pada temuan minor pertama, serta nama file berkarakter kontrol pada checker bundle. Kelulusan `api:check` dan test kesesuaian tetap membuktikan operasi yang diuji saja (`GET /api/status`), sesuai batas yang ditulis spec.

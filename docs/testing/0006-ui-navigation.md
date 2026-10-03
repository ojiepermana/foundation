# Bukti fitur 7: kerangka UI dan navigasi

Tanggal: 2026-10-03. Kriteria: [spec 0007](../specs/0007-kerangka-ui-navigasi/index.md). Bukti ini berasal dari checkout `main` pada dasar `cd9abcd3a0da5800e4de213c3acd2ed62a6c307b` dengan perubahan Scope 7 belum di-commit. Perubahan Scope 2 yang juga ada di checkout tidak termasuk dalam klaim fitur ini.

## Lingkungan dan hasil runtime

`bun run test:e2e` menjalankan aplikasi frontend Angular pada `http://127.0.0.1:8889` dan backend Bun pada `http://127.0.0.1:8888`, lalu membuka Chromium melalui Playwright. Halaman root yang diuji tidak memakai mock untuk komponen shell dan tidak mengirim request ke `/api`.

| Kriteria | Hasil dan bukti |
| --- | --- |
| AC-1 | Terpenuhi. Build production berhasil dan wrapper publik dengan sidebar tampil di `/`. [Screenshot desktop](evidence/0006/ui-shell-desktop.png). |
| AC-2 | Terpenuhi. Membuka `/` dan memilih `Kesiapan` menampilkan halaman Foundation pada URL root. Diuji di [Playwright JUnit](evidence/0006/playwright.xml). |
| AC-3 | Terpenuhi. Skip link memindahkan focus ke main; keyboard membuka drawer, menutupnya dengan Escape dan tombol `Tutup navigasi`, mengaktifkan `Kesiapan`, serta mengembalikan focus ke pemicu. Path yang tidak dikenal juga memindahkan focus ke main sesudah redirect. Diuji di [Playwright JUnit](evidence/0006/playwright.xml). |
| AC-4 | Terpenuhi. Pada 1280×812 sidebar berada di samping konten. Pada 375×812 header dan drawer dapat dipakai, label tidak terpotong, dan halaman tidak memiliki overflow horizontal. [Screenshot desktop](evidence/0006/ui-shell-desktop.png) dan [screenshot mobile](evidence/0006/ui-shell-mobile.png). |
| AC-5 | Terpenuhi. Root tidak mengirim request `/api`; `bun run check:frontend:bundle` menerima source dan asset production. Parser TypeScript menolak side-effect/export/import-type/dynamic/require yang menunjuk modul server atau runtime Node/Bun. Fixture juga menolak import tak terinspeksi, URL PostgreSQL, private key, dan credential sintetis; output tidak memuat nilai credential. Bukti [JUnit checker bundle](evidence/0006/frontend-bundle.xml). |
| AC-6 | Terpenuhi. `/unknown-route` diarahkan ke `/` dan landmark utama menerima focus. Diuji di [Playwright JUnit](evidence/0006/playwright.xml). |

## Pemeriksaan

`bun run test:ci` selesai dengan exit 0. Validasi mendaftarkan 30 ID skenario; ekspor OpenAPI dan SDK identik setelah dua run; build frontend dan backend, pemeriksaan bundle, typecheck backend, serta unit dan integration test berhasil. Suite mencatat 1 test frontend, 81 test backend dan kontrak dengan 172 assertion (termasuk 13 fixture checker dengan 29 assertion), 26 test tooling dengan 75 assertion, serta 4 test Playwright. [JUnit frontend](evidence/0006/frontend.xml), [JUnit checker bundle](evidence/0006/frontend-bundle.xml), dan [JUnit Playwright](evidence/0006/playwright.xml) disimpan bersama screenshot.

Build frontend memberi warning ukuran initial bundle 654,09 kB terhadap anggaran 500 kB. Build tetap berhasil. Playwright tidak mencatat page error; output Node menampilkan warning lingkungan bahwa `NO_COLOR` diabaikan saat `FORCE_COLOR` aktif.

## Batas bukti

`bun run doctor` selesai dengan exit 1 karena PostgreSQL lokal tidak dapat diverifikasi. Karena `serve` mewajibkan doctor lulus, `bun run serve` tidak dijalankan. E2E tetap menjalankan frontend dan backend nyata untuk alur Scope 7; fitur ini memang tidak memakai database. Verifikasi startup terintegrasi dengan PostgreSQL dan browser tetap berada pada penerimaan fitur 2 serta alur readiness fitur 10.

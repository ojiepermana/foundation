# Verify: struktur aplikasi dan dependency (spec 0001)

## UI dan runtime

- [x] Buka `http://127.0.0.1:8889`, heading Foundation dan isi statis terlihat pada Chromium desktop 1280 × 800 dan mobile 375 × 812, tanpa error browser atau request API dari halaman. Bukti awal `.local/feature-4/desktop.png` dan `mobile.png`, kemudian Playwright pada 1280 × 812 dan 375 × 812. AC-2.
- [x] Request `GET http://127.0.0.1:8889/api/status` melalui proxy menghasilkan 200 dan JSON tepat `{"status":"ok"}`. Backend nyata pada 8888, tanpa akses database. AC-4.
- [x] Listener development source dan bundle membuka HTTP, lalu SIGTERM/SIGINT mengembalikan exit 0 dan port dapat dipakai listener berikutnya. AC-3.
- [x] Listener production bundle memberi 404 pada `/api/status`, `/openapi`, dan `/openapi/json`. AC-4.
- [x] HOST, PORT, dan NODE_ENV salah, serta port terpakai, gagal dengan exit 1 dan pesan generik tanpa nilai secret. Error tidak terduga menghasilkan 500 tanpa stack. AC-6.

## Commands

- [x] `bun install --frozen-lockfile` berhasil tanpa perubahan lockfile; `bun run check:dependencies` memeriksa pin tepat, runtime, engines dan installed peers. AC-1.
- [x] `bun run build:frontend`, `bun run typecheck:backend`, `bun run build:backend` berhasil. SDK di luar src masuk kompilasi Angular. AC-1, AC-2, AC-3.
- [x] `bun run api:sync` mengekspor development dari komposisi route nyata, memvalidasi dan menghasilkan SDK melalui schematic terpasang. Komposisi serta exporter diuji dengan Bun.serve, Bun.SQL, dan fetch yang menolak alokasi eksternal. AC-3, AC-5.
- [x] `bun run api:check` menghasilkan artefak identik pada dua run. Fixture positif serta pelanggaran checker, drift file baru/berubah/hilang, dan penghentian pipeline ketika tahap gagal dibuktikan. AC-5.

## Acceptance criteria

| Kriteria | Bukti |
| --- | --- |
| AC-1 | Instalasi frozen, dependency checker, manifest dan lockfile root, build kedua aplikasi. |
| AC-2 | Build production Angular, browser development nyata dan screenshot, Vitest serta Playwright. |
| AC-3 | Pemeriksaan tipe dan bundle Bun, import tanpa resource, HTTP source/bundle serta shutdown. |
| AC-4 | HTTP langsung, proxy browser origin, produksi bundle 404. |
| AC-5 | Generate SDK nyata, api:check dua run, checker fixtures dan pipeline failure tests. |
| AC-6 | Startup negatif, listener terpakai dan error aman, hasil gagal awal dicatat pada laporan. |

## Batas

Doctor dijalankan dan gagal pada prasyarat PostgreSQL. Startup langsung mengikuti AC-6 serta Build plan spec 0001. Database, migration, seed, readiness lintas aplikasi, konsumsi SDK oleh fitur, kapasitas k6, container dan deployment menunggu scope masing masing. Build Angular memberi warning budget awal 500 kB; build tetap memenuhi batas gagal 1 MB. Tidak ada klaim siap production.

Hasil final, identitas kandidat, JUnit, dan riwayat perbaikan dicatat pada laporan bukti fitur 4.

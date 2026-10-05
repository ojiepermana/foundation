# Rationale: Kapasitas dan pemulihan saat beban meningkat

## Context

> Catatan premis: alur nyata yang dapat diberi beban saat ini hanya dua route diagnostik pada komposisi development, `GET /api/status` (proses saja) dan `GET /api/readiness` (membaca `common.schema_migrations` lewat pool backend, satu pemeriksaan aktif per proses). Catatan orkestrator menyebut `/api/status` ada di komposisi development dan production; kode berkata lain: `createApp('production')` di `apps/backend/src/app.ts` hanya memasang `onError`, sehingga setiap path di production menjawab 404 (spec 0001 AC-4, APP-004). Tidak ada endpoint bisnis dan tidak ada perkiraan trafik produk. Karena itu angka kapasitas dari fitur ini tidak dapat dibaca sebagai kapasitas produk. Bingkai yang tepat adalah membangun harness kapasitas yang dapat dipakai ulang dan membuktikan, pada alur yang ada, perilaku yang memang diminta scope: target per instance pada beban yang disepakati, penolakan terkontrol, dan pemulihan sesudah beban dan sesudah database berhenti. Model beban produk ditetapkan spec endpoint bisnis pertama.

Fitur 12 pada scope meminta kapasitas alur nyata pada beban yang disepakati, termasuk penolakan terkontrol dan pemulihan layanan. Selesai ketika: specs menetapkan model beban, durasi, data, limit, dan target; profil smoke, load, stress, spike, serta soak yang diwajibkan memiliki checks hasil bisnis dan thresholds yang menggagalkan pipeline; beban aktual serta dropped iterations tercatat; resource dan pool diamati; batas bukti environment dinyatakan tanpa melonggarkan target agar lulus. Datanya data test terkontrol sesuai schema fitur yang diukur, pengujian panjang memakai environment yang tidak terganggu suite lain, dan breakpoint serta k6 browser hanya ditambahkan bila dibutuhkan. Scope juga menyatakan tidak ada angka performance yang diasumsikan, sehingga seluruh angka harus ditetapkan di sini.

Keadaan saat ini (dibaca dari kode pada 2026-10-04):

- Backend Bun 1.4.2 dengan Elysia 1.4.30. Komposisi development hanya mendengar `127.0.0.1` (`apps/backend/src/config/env.ts`) dengan `maxRequestBodySize` 1.024 dan `idleTimeout` 10 detik. Pool `Bun.SQL` dibuat `libs/server/database/client.ts` dengan `max` 5 dan `connectionTimeout` 3 detik (spec 0004). Route readiness menjawab 200, 429 saat pemeriksaan lain aktif tanpa antrean, dan 503 saat database gagal atau batas 5.000 ms tercapai (spec 0006).
- Aturan testing sudah menamai k6, folder `tests/performance/` (journeys, profiles, helpers), dan script `test:performance:smoke` sampai `test:performance:soak`, tetapi belum ada satu pun file atau script nya. k6 tidak terpasang di Mac ini dan bukan package npm.
- Gate spec 0010 menjalankan tiga tier per push (`fast`, `real`, `security`) lewat `scripts/gate.ts`, menulis bundle bukti dengan manifest, dan laporannya menyebut performance k6 di luar cakupan sambil menunggu fitur ini. `check:workflow` hanya memvalidasi `.github/workflows/application.yml`. INFRA-001 menolak kata `docker` di seluruh `scripts/**/*.ts`, sehingga orkestrasi Docker berada di `tests/orchestration/`, dan pin image pemindai di `tests/security/scanners.json` memakai tag dan digest indeks.
- Docker Desktop di Mac ini tidak meneruskan `--network host` ke loopback host (probe), sedangkan runner Linux GitHub melakukannya. Mac ini juga menjalankan container proyek lain (tujuh container berjalan saat probe).

Kekuatan yang membatasi keputusan: aturan testing meminta target dari specs tanpa angka universal, checks dan thresholds yang menggagalkan CI, beban aktual dan iterasi yang tidak dimulai tercatat, resource dan pool diamati, dan k6 dijalankan sebagai binary atau container yang diorkestrasi root script, tidak lewat `bun:test`. Aturan keamanan meminta container berbatas resource tanpa privilege berlebih, image dan tool yang dipin, dan tanpa credential production. Pengujian panjang tidak boleh dipicu setiap edit. Docker bukan prasyarat runtime pengembang, tetapi sudah menjadi prasyarat tier nyata. Pipeline ini membuat commit di tahap terakhir, sehingga workflow baru hanya dapat dibuktikan di GitHub sesudah push. Build approach proyek adalah Tracer Bullet.

## Options considered

### Opsi 1: k6 dari image yang dipin, seluruh komponen di container berbatas resource, k6 berbagi network namespace backend

PostgreSQL 18, backend, dan k6 berjalan sebagai container per run profil. Backend berjalan dari `oven/bun:1.4.2-slim` dengan source yang di mount hanya baca, mendengar `127.0.0.1` di namespace nya, dan k6 bergabung ke namespace itu lewat `--network container:<backend>`, sehingga jalur yang diukur adalah loopback yang sama di macOS dan Linux. Image dipin tag dan digest indeks di `tests/performance/images.json`, mengikuti pola `scanners.json`. Resource diamati lewat `docker stats` dan `pg_stat_activity`. (basis: pola pin dan hardening container `tests/orchestration/security-scan.ts` spec 0010, orkestrasi `tests/orchestration/readiness-real.ts` spec 0006, aturan testing bagian k6)

**Pros**:
- Topologi, batas CPU, dan batas memory sama di macOS dan Linux, sehingga target yang sama bermakna di kedua environment.
- Tidak ada port host yang dipakai backend, sehingga run tidak bertabrakan dengan `serve` dan dapat diisolasi dari suite lain.
- Pengamatan per container seragam di kedua platform, dan proses backend adalah satu satunya proses di container nya.
- Tanpa dependency npm baru; mengikuti pola pin, hardening, dan penjaga container yang sudah dirawat.

**Cons**:
- Dua image baru dipin dan dirawat, dan image Bun ikut versi `engines.bun`.
- Backend di container dengan `node_modules` host berbeda dari cara `serve` menjalankannya, dan hanya bekerja selama dependency backend murni JavaScript.
- Lebih banyak bagian bergerak per run: network, tiga container, dan pembersihan masing masing.

### Opsi 2: Backend sebagai proses host, k6 container menjangkau host

Backend dijalankan seperti `serve` dan `test:readiness:real` sebagai proses Bun di host. k6 container menjangkaunya lewat `--network host` di Linux dan `host.docker.internal` di Docker Desktop macOS.

**Pros**:
- Backend diukur persis seperti pengembang menjalankannya, tanpa image Bun tambahan.
- Pola orkestrasi proses host sudah ada (`runProcessGroup`, pemeriksaan port).

**Cons**:
- Jalur yang diukur berbeda per platform: di macOS melewati proxy Docker Desktop (probe: p50 status naik dari sekitar 0,25 ms menjadi sekitar 0,65 ms pada 500 request per detik), di Linux langsung loopback.
- Backend tidak berbatas CPU, sehingga hasil bergantung pada jumlah core mesin dan target sulit dibandingkan antara Mac 10 core dan runner 4 vCPU.
- Memakai port host, sehingga run panjang dapat bertabrakan dengan `serve` atau suite lain.
- Pengamatan CPU dan memory proses host berbeda cara antara macOS dan Linux.

### Opsi 3: Binary k6 yang dipin checksum, dijalankan di host

Orkestrasi mengunduh binary k6 rilis GitHub sesuai platform, memeriksa SHA 256 terhadap pin di repository, lalu menjalankan k6 dan backend sebagai proses host; hanya PostgreSQL di container.

**Pros**:
- Tidak ada proxy Docker pada jalur k6 ke backend di platform mana pun.
- k6 tidak berbagi kuota CPU container.

**Cons**:
- Mekanisme baru untuk unduh, ekstraksi (tar.gz di Linux, zip di macOS), cache, dan pin per platform yang tidak ada padanannya di proyek.
- Backend tetap tanpa batas CPU dan memakai port host, dengan kelemahan yang sama seperti Opsi 2.
- Menjalankan executable hasil unduhan langsung di host memperluas permukaan rantai pasok dibanding image yang dijalankan read only tanpa capability.

### Opsi 4: Tanpa k6, generator beban Bun sendiri

Generator open model kecil berbasis `fetch` Bun (seperti probe baseline spec ini) dijalankan lewat script Bun, dengan thresholds ditulis sendiri.

**Pros**:
- Tidak ada image atau binary baru; satu bahasa di seluruh repository.
- Terbukti mampu membangkitkan lebih dari 32.000 request per detik di Mac ini.

**Cons**:
- Bertentangan dengan aturan testing yang menetapkan k6 untuk performance dan ketahanan.
- Executor, metrik, thresholds, dan dropped iterations harus dibuat dan dirawat sendiri, dan hasilnya tidak dapat dibandingkan dengan praktik k6 yang umum.

## Rationale

Masalah utamanya adalah membuat angka yang jujur dan dapat diulang pada dua environment yang sangat berbeda: Mac M1 Max dengan Docker Desktop yang dipakai bersama proyek lain, dan runner GitHub 4 vCPU yang juga dipakai bersama. Opsi 1 menyamakan hal yang paling memengaruhi angka: jalur jaringan yang diukur (loopback dalam satu namespace) dan anggaran resource backend (1 CPU, 512 MiB). Probe membuktikan Docker Desktop tidak meneruskan `--network host` ke loopback host, sehingga Opsi 2 dan 3 selalu bercabang per platform, dan cabang macOS melewati proxy yang menambah latency. Dengan backend berbatas satu CPU, target "beban normal memakai paling banyak setengah CPU" menjadi pernyataan kapasitas per instance yang dapat diperiksa di kedua mesin.

Opsi 1 juga memakai ulang hal yang sudah dirawat proyek: pin tag dan digest indeks seperti `scanners.json`, flag hardening container `check:security`, label dan penjaga container seperti `readiness-container.ts`, provisioning dan migration seperti `readiness-real.ts`, serta runner tier, manifest, dan laporan spec 0010. Biaya dua image baru lebih kecil daripada mekanisme unduhan binary Opsi 3, dan aturan testing menutup Opsi 4.

Untuk penempatan di pipeline, smoke cukup murah (sekitar dua sampai tiga menit) untuk berjalan setiap push sebagai langkah tier nyata, yang sudah punya Docker dan image PostgreSQL yang dipin. Profil lain mencapai sekitar 110 menit dan menurut aturan testing tidak boleh dipicu setiap edit, sehingga menjadi tier `capacity` yang memakai runner gate yang sama tetapi tidak menentukan status gate per push. Target ditetapkan dari baseline terukur dengan margin sekitar 4 sampai 7 kali untuk latency dan sekitar 3,5 kali untuk memory serta CPU, karena k6 belum pernah diukur di sini dan runner GitHub diperkirakan lebih lambat serta lebih berisik; target itu tetap jauh di bawah batas desain 5.000 ms dan tidak boleh diturunkan sesudah hasil pertama keluar.

## Keputusan agent atas delegasi pemilik

Pemilik proyek mendelegasikan keputusan desain fitur ini ("jika membutuhkan /architect anda bisa menjalankannya dengan mengambil keputusan sendiri berdasarkan rekomendasi anda"). Tidak ada manusia selama run. Percakapan desain dijalankan sebagai pertimbangan internal: setiap pertanyaan dicatat dengan pilihan, rekomendasi, dan pilihan akhir. Semua keputusan berikut diambil oleh agent pada 2026-10-04 atas delegasi tersebut, tanpa konfirmasi manusia.

Framing yang disimpulkan: mode FEATURE (harness kapasitas baru di atas stack dan gate yang ada, dengan membaca kode yang harus diintegrasikan), platform backend API serta tooling CLI dan CI tanpa UI, stack dari `AGENTS.md` (Bun 1.4.2, Elysia 1.4.30, PostgreSQL 18 image proyek, Docker, k6 menurut aturan testing), build approach Tracer Bullet dari scope. Tidak ada spec yang tumpang tindih untuk dipertimbangkan sebagai update atau supersede; spec 0006 dan 0010 menjadi batasan. Mode REFERENCES_LEVEL `sources`: sumber disebut tanpa tautan.

**Tahap kebutuhan**

1. **Pekerjaan inti.** Pilihan: (a) harness k6, profil, dan integrasi gate atas alur yang ada; (b) menambah endpoint baru yang lebih mirip beban bisnis agar ada yang diukur; (c) menunda fitur sampai endpoint bisnis ada. Rekomendasi dan pilihan (a): (b) mengarang kebutuhan produk yang belum ada, (c) meninggalkan butir Selesai ketika tanpa bukti padahal harness dan perilaku penolakan serta pemulihan dapat dibuktikan sekarang.
2. **Alur yang diukur.** Pilihan: (a) `GET /api/status` dan `GET /api/readiness` pada komposisi development; (b) ditambah frontend lewat proxy dev server; (c) status saja. Dipilih (a): keduanya satu satunya route nyata, readiness membawa database dan pool. Frontend development hanya aset dari dev server yang tidak mewakili deployment, dan komposisi production tidak mempunyai route.
3. **Jenis model beban.** Pilihan: (a) open model laju kedatangan tetap (`constant-arrival-rate` dan `ramping-arrival-rate`); (b) closed model VU tetap. Dipilih (a): request diagnostik datang independen, laju tetap membuat dropped iterations bermakna, dan sistem lambat tidak menurunkan beban sendiri seperti pada closed model.
4. **Granularitas journey.** Pilihan: (a) satu request per iterasi, scenario terpisah per endpoint; (b) satu journey status lalu readiness. Dipilih (a): laju iterasi sama dengan request per detik, target per endpoint jelas, dan laju readiness dapat diatur terpisah dari status.
5. **Beban normal N.** Pilihan: (a) status 1.000 dan readiness 50 per detik; (b) persentase dari kapasitas terukur, misalnya 25 persen; (c) beban ringan 100 dan 10. Dipilih (a). Kapasitas status melampaui 32.000 request per detik pada satu CPU, jauh di atas yang dapat dibangkitkan k6 di runner, sehingga (b) tidak praktis; (c) tidak membuktikan apa pun di atas smoke. Pada N, backend memakai sekitar 10 sampai 14 persen satu CPU, dan readiness sekitar 5 persen dari throughput pemeriksaan terukur.
6. **Beban lebih O.** Pilihan: (a) status 4.000 dan readiness 1.000 per detik; (b) status 8.000; (c) hanya 2 kali N. Dipilih (a): readiness 20 kali N berada di atas throughput pemeriksaan (sekitar 800 per detik di Mac), sehingga penolakan 429 pasti terjadi; total 5.000 request per detik masih dalam anggaran generator yang wajar. (b) berisiko membuat generator yang jenuh, bukan backend.
7. **Profil wajib.** Pilihan: (a) smoke, load, stress, spike, soak, ditambah outage database; (b) lima profil standar saja; (c) ditambah breakpoint dan k6 browser. Dipilih (a): pemulihan sesudah database berhenti termasuk cakupan fitur dan tidak tercakup lima profil standar. Breakpoint tidak dibutuhkan karena target tidak bergantung pada titik jenuh; k6 browser tidak dibutuhkan karena frontend hanya aset statis yang alurnya dibuktikan Playwright.
8. **Tempat menjalankan profil.** Pilihan: (a) smoke setiap push di tier nyata, profil lain di tier kapasitas manual; (b) semua profil setiap push; (c) profil panjang terjadwal malam. Dipilih (a): aturan testing melarang pengujian panjang dipicu setiap edit; jadwal menghabiskan waktu runner pada commit yang tidak berubah. Pilihan kedua (c) dicatat sebagai tindak lanjut bila pembaruan dependency sering.
9. **Durasi.** Pilihan: (a) smoke 40 detik, load 11 menit, stress sekitar 12 menit, spike sekitar 7 menit, outage sekitar 4 menit, soak 61 menit; (b) soak 30 menit; (c) soak beberapa jam. Dipilih (a): load 10 menit stabil cukup untuk p99 yang stabil; soak 60 menit menangkap kebocoran sekitar 5 KB per detik (16 MiB dalam 55 menit). (b) setengah daya deteksi; (c) tidak sebanding untuk dua route diagnostik dan ditunda sampai ada endpoint bisnis.
10. **Target latency.** Pilihan: (a) status p95 di bawah 10 ms dan p99 di bawah 25 ms, readiness berhasil p95 di bawah 25 ms dan p99 di bawah 50 ms; (b) sekitar 2 kali nilai terukur (status p95 3 ms); (c) lebih longgar, misalnya 100 ms. Dipilih (a): margin sekitar 4 sampai 7 kali nilai terburuk lokal menyerap overhead k6 yang belum terukur, runner yang diperkirakan 2 sampai 3 kali lebih lambat, dan lonjakan GC, tetapi tetap menangkap regresi seperti query tambahan atau kerja sinkron di handler. (b) berisiko gagal karena environment, yang akan mendorong pelonggaran sesudah hasil keluar; (c) tidak bermakna untuk loopback.
11. **Ketersediaan readiness.** Pilihan: (a) rasio 200 paling sedikit 0,98 pada N dan 0,20 pada O; (b) 0,95 dan 0,50; (c) tanpa target ketersediaan. Dipilih (a): pada N terukur 0,997 sampai 1,0 dengan kedatangan merata; pada O terukur 0,80, dan 0,20 berarti sedikitnya 200 pemeriksaan berhasil per detik tanpa kelaparan walau waktu pemeriksaan di runner dapat dua sampai tiga kali lebih lama. (c) membuat route yang selalu 429 dapat lulus.
12. **Penolakan yang diharapkan.** Pilihan: (a) readiness 429 diharapkan di semua fase, 503 hanya pada fase berhentinya database, status selalu 200; (b) 503 diizinkan kapan saja. Dipilih (a): 503 saat database sehat adalah kegagalan nyata yang harus terlihat.
13. **Definisi pemulihan.** Pilihan: (a) target normal berlaku lagi 10 detik sesudah beban turun atau sesudah database dijalankan lagi, ditambah waktu pemulihan aktual dicatat; (b) hanya mencatat waktu pemulihan tanpa ambang; (c) 30 detik seperti batas fungsional READY-008. Dipilih (a): terukur 0,23 detik sesudah start, dan batas 10 detik mencakup waktu start PostgreSQL ditambah `connectionTimeout` 3 detik pada pemeriksaan yang menggantung ke alamat lama. (c) terlalu longgar untuk klaim kapasitas.
14. **Cara menghentikan database.** Pilihan: (a) `docker stop` dan `docker start` container PostgreSQL; (b) `docker pause`; (c) `docker kill`; (d) `pg_terminate_backend` sesi backend. Dipilih (a): sama dengan READY-008 dan READY-009, image memakai `STOPSIGNAL SIGINT` sehingga stop selesai sekitar 0,4 detik. (b) menahan penanda readiness sampai socket selesai (konsekuensi spec 0006) dan sudah dibuktikan fungsional; (c) dan (d) dicatat sebagai variasi yang tidak dibutuhkan sekarang.
15. **Target resource.** Pilihan: (a) memory backend paling banyak 128 MiB, CPU rata rata pada `steady` paling banyak 50 persen satu CPU, pertumbuhan soak paling banyak 16 MiB, sesi pool paling banyak 5, sesi tidak idle paling banyak 1; (b) hanya mencatat tanpa ambang; (c) ambang lebih ketat, misalnya memory 64 MiB. Dipilih (a): puncak terukur 35,7 MiB dan CPU 9,8 sampai 13,6 persen, sehingga margin sekitar 3,5 kali; batas sesi berasal langsung dari desain spec 0004 dan 0006. (b) tidak memenuhi butir resource dan pool diamati sebagai bukti; (c) dekat dengan nilai awal proses Bun di runner yang belum terukur.

**Tahap model data**

16. **Schema dan data.** Tidak ada data persisten baru; pertanyaan schema `AGENTS.md` tidak berlaku. Pilihan data: (a) riwayat migration nyata dari runner spec 0005; (b) menambah baris tiruan ke `common.schema_migrations` agar jumlah lebih besar. Dipilih (a): runner adalah satu satunya penulis riwayat (spec 0005), dan baris tiruan membuat readiness tidak lagi nyata. Batas bukti menyebut data hanya satu baris.
17. **Model file bukti.** Pilihan: (a) `result.json` ternormalisasi, `summary.json` k6 apa adanya, `observation.json`, dan `artifact-scan.json` per profil; (b) keluaran per request `--out json`; (c) hanya ringkasan k6. Dipilih (a): laporan membaca satu bentuk tetap, ringkasan k6 tetap tersedia untuk audit, dan ukuran tetap kecil. (b) mencapai jutaan baris pada soak. Model ditinjau ulang sebagai tabel entitas pada spec, lalu diterima.

**Tahap stack dan tool**

18. **Cara menjalankan k6.** Pilihan: (a) image `grafana/k6` dipin tag dan digest indeks; (b) binary dipin checksum; (c) instalasi lewat package manager sistem. Dipilih (a) (lihat Opsi 1 dan 3). Versi `2.3.0`, rilis stabil terbaru pada daftar rilis GitHub grafana/k6 (21 September 2026, dibaca 2026-10-04); catatan rilis 2.0.0 menghapus `k6 pause`, `resume`, `scale`, dan `status`, executor `externally-controlled`, dan server REST bawaan, yang tidak dipakai spec ini. Digest dibaca saat implementasi.
19. **Topologi.** Pilihan: (a) semua container, k6 berbagi namespace backend; (b) backend host dengan cabang per platform; (c) k6 dan backend di host. Dipilih (a) (lihat Rationale).
20. **Image runtime backend.** Pilihan: (a) `oven/bun:1.4.2-slim`; (b) `oven/bun:1.4.2` penuh; (c) varian alpine; (d) image backend hasil build. Dipilih (a): glibc seperti image penuh dengan tarikan lebih kecil, dan probe membuktikan backend berjalan dengan mount minimum, read only, tmpfs `noexec`, user host, tanpa capability, lalu mencetak `Backend stopped` saat dihentikan. (c) memakai musl yang belum diuji; (d) adalah keputusan fitur 13.
21. **Batas resource.** Pilihan: (a) backend 1 CPU dan 512 MiB, PostgreSQL 2 CPU, 1 GiB, dan shm 128 MiB seperti Compose development, k6 3 CPU dan 2 GiB; (b) tanpa batas; (c) k6 2 CPU. Dipilih (a): backend satu CPU membuat target per instance dan sebanding antarmesin; PostgreSQL mengikuti batas yang sudah dinyatakan aturan infrastruktur; k6 tiga CPU memberi ruang bagi beban O karena biaya k6 belum terukur. Jumlah batas 6 CPU melebihi 4 vCPU runner, tetapi pemakaian terukur backend dan PostgreSQL pada O kurang dari setengah CPU, dan check generator menangkap perebutan CPU.
22. **Bahasa script k6.** Pilihan: (a) TypeScript yang dijalankan k6 langsung, modul rencana tanpa impor yang juga dipakai Bun, tanpa modul remote dan tanpa `@types/k6`; (b) JavaScript; (c) menambah `@types/k6` agar `tsc` memeriksa script. Dipilih (a): struktur aturan testing memakai `.ts`, rencana dan klasifikasi dapat diuji `bun:test`, dan validasi script k6 dilakukan `k6 inspect` pada setiap smoke. (c) menambah dependency hanya untuk tipe.
23. **Alat pengamatan.** Pilihan: (a) `docker stats` dan `pg_stat_activity`; (b) cAdvisor dan Prometheus; (c) extension k6. Dipilih (a): tanpa layanan baru, seragam di kedua platform, dan probe menunjukkan sekitar dua sampel per detik per container di Docker Desktop. Pool `Bun.SQL` tidak membuka statistiknya, sehingga pool diamati dari sisi server.
24. **Bentuk ringkasan k6.** Pilihan: (a) `handleSummary` menulis JSON ke folder yang di mount; (b) `--summary-export`; (c) keluaran per request. Dipilih (a): bentuk data lengkap termasuk `setup_data`, tanpa flag yang dapat berubah antar versi; submetrik per scenario dimunculkan lewat thresholds `iterations{scenario:...}`, dan submetrik latency per fase lewat kelompok Pencatatan (lihat bagian Cross check).
25. **Image PostgreSQL.** Pilihan: (a) `foundation-postgres:18-pinned` yang sudah dibangun tier nyata, dibangun dengan perintah build Compose INFRA-002 bila belum ada atau labelnya berbeda; (b) menjadikan `test:infrastructure` langkah pertama tier kapasitas; (c) image PostgreSQL resmi. Dipilih (a): (b) membuat satu script menjadi langkah dua tier, yang bertentangan dengan pemetaan script ke tier spec 0010; (c) bukan PostgreSQL proyek.
26. **Integrasi gate.** Pilihan: (a) smoke sebagai langkah tier nyata, tier `capacity` di runner gate yang sama, dua jenis bukti baru, dan laporan kapasitas terpisah; (b) tier keempat yang ikut gate per push; (c) script lepas tanpa manifest. Dipilih (a): memakai ulang manifest, pengikatan, dan pemeriksaan nilai sensitif tanpa membuat gate per push menunggu profil panjang. (b) membuat gate per push selalu `incomplete`; (c) kehilangan pengikatan kandidat.
27. **Workflow kapasitas di CI.** Pilihan: (a) `.github/workflows/capacity.yml` dengan `workflow_dispatch` saja; (b) ditambah `schedule` mingguan; (c) hanya lokal; (d) job di `application.yml` dengan syarat event. Dipilih (a): bukti Linux amd64 terikat commit tanpa memakai waktu runner setiap push. (c) tidak memberi bukti Linux; (d) melanggar daftar izin `application.yml` (trigger dan `if` tingkat job).
28. **Bentuk registry.** Pilihan: (a) check `command` untuk profil, tanpa perubahan schema registry; (b) runner baru `k6` di schema registry. Dipilih (a): status dari exit code langkah sudah cukup karena threshold menentukan exit code, dan rincian ada di `result.json`.
29. **Lokasi unit test.** Pilihan: (a) `tests/integration/performance/` dengan `test:performance:plan` di tier cepat, dan test gate di `tests/integration/gate/`; (b) semuanya di folder gate. Dipilih (a): test rencana k6 bukan bagian gate spec 0010, sedangkan perubahan gate diuji di dekat fixture gate yang ada.
30. **Validasi script.** Pilihan: (a) `k6 inspect` keenam profil pada smoke; (b) tanpa validasi sampai profil dijalankan. Dipilih (a): profil kapasitas yang rusak terlihat pada push berikutnya, bukan saat run manual.
31. **Telemetri k6.** Laporan pemakaian dimatikan dengan `--no-usage-report` dan `K6_NO_USAGE_REPORT=true`, karena container k6 berada di network yang dapat keluar ke internet.

**Tahap antarmuka**

32. **Permukaan perintah.** Enam script profil memanggil satu orkestrasi dengan argumen profil, ditambah `test:performance:plan`, `test:ci:capacity`, dan `test:report:capacity`. Exit code mengikuti pola orkestrasi nyata (0, 1, 2 untuk argumen salah, 130, 143, 129).
33. **Sumber nilai yang tidak dimiliki input.** Jumlah migration yang diharapkan berasal dari jumlah file migration, T0 dari jam host ditambah 15 detik dengan `setup()` yang menunggu, fase outage dari waktu mulai request sejak T0, dan URL dasar adalah konstanta. Waktu mulai scenario yang terlambat lebih dari 2 detik menggagalkan run karena jadwal stop dan start outage serta jendela pengamatan bertumpu pada T0.

**Tahap keamanan**

34. **Credential dan isolasi.** Credential acak per run di env file 0600, mount backend tanpa root repository (sehingga `.env` root tidak terlihat) ditambah penelusuran `.env` di folder yang di mount, backend tidak dipublikasikan, PostgreSQL hanya di loopback, container tanpa capability dengan `no-new-privileges` dan batas proses (read only kecuali PostgreSQL), dan pemindaian credential atas output serta bukti. Workflow hanya `contents: read` tanpa secret.
35. **Environment yang dipakai suite lain.** Pilihan: (a) gagal `environment_busy` bila ada container berlabel `foundation.test` yang berjalan, dan mencatat jumlah container lain; (b) hanya mencatat; (c) menolak bila ada container apa pun. Dipilih (a): menjaga aturan bahwa pengujian panjang tidak terganggu suite proyek, tanpa menuntut proyek lain di mesin pengembang berhenti. Sesudah cross check, pemeriksaan diulang sesudah k6 keluar dan nama container proyek yang menghalangi dicetak bersama langkah pembersihan manual.

**Tahap kegagalan**

36. **Generator jenuh.** Dipilih gagal `generator_saturated` (bukan peringatan): latency dan dropped iterations dari generator yang jenuh tidak dapat dipercaya.
37. **Sinyal dan batas waktu.** SIGINT, SIGTERM, dan SIGHUP menghentikan k6 dengan masa stop 10 detik agar ringkasan tetap ditulis, lalu pembersihan penuh dengan batas per perintah pada tabel *Batas waktu perintah*, terburuk 165 detik, di bawah masa tenggang tier 180 detik (diperbaiki sesudah cross check, lihat bagian Cross check).
38. **Abort lebih awal.** `abortOnFail` hanya pada respons tak terduga dan dropped iterations, agar soak yang jelas gagal tidak menunggu satu jam; latency dinilai di akhir.
39. **Kontrol outage yang terlambat dan jam yang bergeser.** Keduanya menggagalkan run, karena fase outage dihitung dari jadwal, bukan dari kejadian.

**Rekomendasi yang diputuskan saat menulis spec**

40. Rumus VUs (`preAllocatedVUs` 2 persen laju, `maxVUs` 25 persen laju) dipilih agar iterasi baru dijatuhkan hanya ketika latency rata rata melewati sekitar 250 ms; pilihan kedua angka tetap per scenario. Diganti keputusan 57 pada 2026-10-04: anggapan bahwa k6 memakai VU sampai `maxVUs` sebelum menjatuhkan iterasi tidak berlaku untuk k6 2.3.0 (lihat *Alokasi VU 2026-10-04*).
41. `gracefulStop` 6 detik di atas batas jawaban readiness 5 detik; pilihan kedua bawaan 30 detik yang memperpanjang tumpang tindih antarfase.
42. Ambang beban aktual 99,9 persen dari rencana per scenario laju tetap, karena dengan nol dropped iterations jumlah iterasi hanya berbeda karena pembulatan di akhir scenario. Diganti keputusan 62 pada 2026-10-04: anggapan itu tidak berlaku untuk akhir scenario pada k6 2.3.0 (lihat *Ambang beban aktual 2026-10-04*).

## Cross check

Cross check independen oleh model lain atas draf spec ini mengembalikan 25 celah (6 major, 19 minor; beberapa ganda). Tidak ada manusia selama run, sehingga setiap celah dinilai dan diputuskan oleh agent pada 2026-10-04 atas delegasi pemilik ("jika membutuhkan /architect anda bisa menjalankannya dengan mengambil keputusan sendiri berdasarkan rekomendasi anda"), dengan rekomendasi cross check sebagai titik awal. Kode diperiksa ulang sebelum memutuskan: `runProcessGroup` memang tidak mempunyai callback per potongan, `evidenceKinds` dan `REASON_CODES.release` memang hanya mengenal nilai lama, INFRA-001 memang menolak kata itu di seluruh `scripts/**/*.ts`, image PostgreSQL memang berjalan sebagai `USER postgres`, dan readiness memang menahan penanda aktif sampai hitungan selesai tanpa ulang. Keputusan yang diterapkan:

43. **Atribusi fase outage.** Pilihan: (a) fase dari waktu mulai request dengan batas fase yang berjarak dari perintah; (b) mengizinkan 200 pada `outage` bila jawaban tiba sesudah start terjadwal; (c) membiarkan. Dipilih (a): `before` 30 sampai 88 s, `stopping` 88 sampai 101 s, `outage` 101 sampai 145 s, `recovering` 145 sampai 160 s, `after` tetap 160 s, dihitung dari selisih jam 1.000 ms, keterlambatan perintah 1.000 ms, penyelesaian stop 8.000 ms, dan `connectionTimeout` 3.000 ms ditambah margin 1.000 ms. Baseline menunjukkan 200 pertama 227 ms sesudah start, yang dapat berasal dari pemeriksaan yang dimulai sebelum start; dengan rancangan awal itu akan dinilai `outage` dan menggagalkan run yang jujur. (b) membuat aturan klasifikasi bergantung pada waktu jawaban dan lebih sulit diuji. Stop dan start kini tidak boleh dikirim lebih awal dari jadwal, dan `readiness_recovery_ms` didefinisikan sebagai 200 pertama yang diterima pada atau sesudah start terjadwal, sama di AC-7 dan tabel metrik.
44. **Variable run dan `k6 inspect`.** Pilihan: (a) variable hanya dibaca dan divalidasi di `setup()`; (b) memberi `--env` palsu pada container inspect. Dipilih (a): inspect tetap memeriksa kode yang sama tanpa nilai palsu, dan aturan "kode tingkat modul tidak membaca `__ENV`" dapat diperiksa dari source oleh PERF-001.
45. **Sumber nilai ringkasan.** Kelompok threshold Pencatatan (`max>=0` atau target yang ada) untuk setiap fase membuat submetrik latency dan hasil readiness muncul di ringkasan; `count` ditambahkan ke `summaryTrendStats`; `actual.rate` = iterasi dibagi detik rencana dari `plan.ts`; submetrik yang tidak ada menjadi jumlah 0 dan statistik `null`. Probe langkah 1 membuktikan `count` dan perilaku threshold tanpa sampel, dan fixture PERF-001 adalah ringkasan nyata, bukan bentuk yang ditulis tangan.
46. **Kata terlarang INFRA-001.** Key `environment.docker` diganti `containerEngine`, label laporan memakai "mesin container", dan PERF-008 memeriksa pola INFRA-001 atas `scripts/` sesudah perubahan.
47. **Nama gate.** Tabel *Perubahan gate yang dinamai* menetapkan `RunTierName` dan `CAPACITY_TIER`, jenis bukti `performance` dan `data` pada kedua himpunan, `REASON_CODES.capacityRelease` terpisah dari kosakata per push (agar `event_not_push` dan test lama tidak berubah), `OUT_OF_SCOPE` dengan area `capacity_profiles`, field laporan kapasitas, isi kolom *Test dan profil* dengan contoh, opsi `onOutput` `runProcessGroup`, dan test gate lama yang diubah.
48. **Kontrak alasan.** Satu tabel *Kode alasan* dengan arti `detail` per kode; `pin_invalid` berdiri sendiri; kode baru `secret_in_output`, `summary_missing`, `env_file_present`, dan `environment_too_small`; `result.json` disusun di memori, diredaksi, dipindai, lalu ditulis sesudah pemindaian, sehingga temuan selalu membuat status `failed`.
49. **Batas waktu dan pembersihan.** Tabel *Batas waktu perintah* menyalin nilai `readiness-real.ts` (60 detik run, 30 detik inspect, 60 detik provision dan migrate) dan menurunkan batas pembersihan per perintah, sehingga perhitungan terburuk 165 detik, di bawah masa tenggang 180 detik, bukan 170 detik yang sebelumnya tidak cocok dengan jumlahnya.
50. **Ukuran mesin dan isolasi.** Pemeriksaan `NCPU` paling sedikit 4 dan `MemTotal` paling sedikit 4 GiB (`environment_too_small`); `environment_busy` mencetak nama container milik proyek yang menghalangi dan diulang sesudah k6 keluar; PostgreSQL mendapat `--cap-drop ALL`, `no-new-privileges`, dan `--pids-limit 256`, tetapi tidak read only karena `PGDATA` di lapisan tulis; kalimat keamanan tentang data keluar dipersempit menjadi telemetri k6 yang dimatikan.
51. **Pemeriksaan impor dan struktur script.** Ekspor setiap profil, nilai `exec` per scenario, fungsi `setupRun` dan `writeSummary`, serta pemeriksaan source PERF-001 atas impor dan `__ENV` ditetapkan; normalisasi keluaran inspect dibuktikan terhadap keluaran nyata.
52. **Cakupan pengamatan.** Jendela fase tertutup dengan celah tepi ikut dinilai, celah `pg_stat_activity` yang bersinggungan dengan jendela outage dikecualikan, dan sampler membuat ulang koneksinya sesudah gagal; selisih jam diukur dua kali.
53. **Aliran output.** `runProcessGroup` mendapat opsi `onOutput` yang menyerahkan potongan beserta waktu tiba tanpa mengumpulkannya, dengan test di PERF-008, dibanding jalur spawn kedua yang akan kehilangan jaminan penghentian grup; sampel dibatasi 4 per container per detik.
54. **Jalur keluar tidak normal.** Skenario baru PERF-009 (`tests/integration/performance/signal.test.ts`) membuktikan pembersihan pada `preparing`, `running`, dan `evaluating` lewat `runProfile` dengan pemanggil tiruan, dan exit 143, 130, serta 129 lewat proses nyata dengan `docker` palsu di workspace fixture, mengikuti pola GATE-007.
55. **Logika sisi k6 yang dapat diuji.** `classify` mengembalikan hasil terstruktur, `metricUpdates`, `recoveryValue`, `requestPhase`, `parseRunEnv`, dan `k6ExitReason` berada di modul tanpa impor dan diuji PERF-001; exit 99 dibuktikan dengan ringkasan dan exit code run gagal nyata.
56. **Urutan dan keamanan langkah.** Validasi argumen berjalan sebelum aksi filesystem apa pun; T0 ditetapkan sebelum `docker create` k6; keadaan backend dibaca dengan `--format` tiga field; setiap baris konsol melewati `redacted()`; folder keluaran k6 diserahkan ke 65534:65534 bila UID host 0; file berawalan `.env` di folder yang di mount menggagalkan run.

Bagian yang ditolak atau diganti:

- Kunci folder untuk menyerialkan run ditolak: kunci yang tertinggal sesudah SIGKILL menghalangi seperti container yang tertinggal; pemeriksaan ulang sesudah k6 dan runner gate yang berurutan sudah menangkap run yang bersamaan.
- `environment_busy` tanpa nama ditolak untuk container proyek: nama `foundation-perf-*` dan `foundation-readiness-*` milik proyek dan bukan rahasia, dan tanpa nama pengguna tidak dapat membersihkannya; container proyek lain tetap hanya dihitung.
- Suntingan sementara `plan.ts` untuk menangkap run gagal ditolak: pipeline berbagi working tree, sehingga probe memakai salinan di luar repository.
- Perluasan GATE-009 di `signal-cleanup.test.ts` diganti PERF-009: GATE-009 menurut aturan testing mengikat suite `bun:test` nyata, sedangkan script orkestrasi dibuktikan test sinyalnya sendiri seperti GATE-007 untuk `security-scan.ts`.
- Network internal untuk memblokir jalur keluar ditolak: orkestrasi membutuhkan port loopback PostgreSQL yang dipublikasikan, yang tidak tersedia pada network internal; klaim keamanan dipersempit.
- Penelusuran `.env` di dalam container backend diganti penelusuran host atas folder sumber mount yang sama: hasilnya sama tanpa bergantung pada `find` di image slim.

## Alokasi VU 2026-10-04

Builder berhenti di langkah 4 Build plan. Run nyata pertama kelima profil kapasitas, satu kali per profil tanpa mengubah beban atau target, semuanya keluar 1 dengan `k6_thresholds_failed`: `dropped_iterations` `count==0` dengan `abortOnFail` menghentikan k6 (exit 99) pada beban N, jauh sebelum fase O atau stop outage. Generator tidak jenuh CPU (rata rata 38 sampai 41 persen satu CPU pada N) dan latency jauh di bawah target. Penyebabnya keputusan 40. Rumus `preAllocatedVUs` = max(10, ceil(0,02 × laju)) dan `maxVUs` = max(100, ceil(0,25 × laju)) menganggap k6 memakai VU sampai `maxVUs` sebelum menjatuhkan iterasi. k6 2.3.0 tidak bekerja begitu: executor laju kedatangan menjatuhkan iterasi begitu tidak ada VU yang sudah dibuat dan sedang bebas, lalu baru membuat VU tambahan satu per satu di latar belakang. Probe builder di luar repository membuktikannya: 100 iterasi per detik dengan iterasi 30 ms, `preAllocatedVUs` 1, dan `maxVUs` 100 menjatuhkan 4 iterasi dengan `vus_max` hanya 5. Dengan 20 VU pada 1.000 iterasi per detik, ruangnya hanya sekitar 20 ms, sedangkan durasi iterasi terpanjang pada run itu 12 sampai 37 ms.

Tidak ada manusia selama run. Keputusan di bawah diambil oleh agent pada 2026-10-04 atas delegasi pemilik ("jika membutuhkan /architect anda bisa menjalankannya dengan mengambil keputusan sendiri berdasarkan rekomendasi anda"), tanpa konfirmasi manusia. Batas yang dipegang: `dropped_iterations` tetap `count==0`, beban dan target tidak berubah, dan memory k6 tetap paling banyak `generator_memory` 1.638 MiB (80 persen dari batas container 2 GiB).

**Bukti yang dipakai** (run nyata langkah 4 di `.local/feature-12/<profil>/`, dibaca 2026-10-04, dan dua probe builder dengan salinan profil di folder scratch yang hanya menyamakan `preAllocatedVUs` dengan `maxVUs` lama; probe bukan bukti profil):

| Run | VU dibuat (`vus_max`) | Request | Dropped iterations | Durasi iterasi terpanjang | Memory k6 maksimum |
| --- | --- | --- | --- | --- | --- |
| smoke, lulus | 40 | 4.404 | 0 | 12,4 ms | 41,0 MiB |
| load | 61 | 103.652 | 16 | 36,7 ms | 81,0 MiB |
| stress | 201 | 32.275 | 2 | 16,8 ms | 121,9 MiB |
| spike | 231 | 24.323 | 1 | 12,0 ms | 136,2 MiB |
| outage | 31 | 82.655 | 11 | 30,1 ms | 58,7 MiB |
| soak | 61 | 318.893 | 8 | 27,8 ms | 137,1 MiB |
| probe outage, alokasi penuh `maxVUs` lama | 350 | 231.003 | 0 | 13,6 ms untuk `status`; 3.002,6 ms untuk readiness 503 saat database berhenti | 278 MiB |
| probe stress, alokasi penuh `maxVUs` lama | 2.500 | 2.275.418 | 0 | 28,5 ms | 1.946,6 MiB |

Pada probe stress, memory k6 sudah 925 MiB sekitar 11 detik sebelum T0 (2.500 VU dibuat dalam sekitar 2 detik, belum menjalankan iterasi), naik ke 1.078 MiB pada 30 detik pertama, lalu tumbuh hampir rata sampai 1.946,6 MiB pada detik 510; scenario mulai 2 ms sesudah T0. Pada probe outage, 144 MiB sebelum T0, 227 MiB pada 30 detik pertama, lalu 278 MiB di akhir. Gauge `vus` (VU yang sedang menjalankan iterasi, diambil sekali per detik) paling tinggi 65 pada probe stress dan 7 pada probe outage. CPU k6 pada `hold` probe stress (beban O) rata rata 81,7 persen dan maksimum 132,5 persen satu CPU.

**Model memory untuk perkiraan.** Dari data di atas, memory k6 terdiri dari sekitar 20 MiB dasar, sekitar 0,36 MiB per VU saat dibuat (probe stress 925 MiB untuk 2.500 VU, probe outage 144 MiB untuk 350 VU), naik ke sekitar 0,51 sampai 0,59 MiB per VU sesudah VU menjalankan iterasi (0,51 dari pencocokan kuadrat terkecil atas delapan run, 0,59 dari lonjakan 30 detik pertama probe outage), ditambah sekitar 200 sampai 330 byte per request (208 byte dari sisa probe stress sesudah bagian VU, 323 byte dari run load). Bagian per request kemungkinan besar nilai metrik trend yang disimpan k6 untuk ringkasan akhir dan thresholds; angka ini diukur dari run, bukan dari dokumentasi k6. Angka 0,78 MiB per VU pada catatan builder adalah 1.946,6 dibagi 2.500, yang masih memuat bagian per request. Perkiraan per profil di `index.md` dihitung dari run terdekat (load, spike, dan soak dari run nyatanya, stress dan outage dari probe nya) dengan menambah atau mengurangi selisih VU dan request menurut model ini, sehingga setiap perkiraan bertumpu pada pengukuran nyata dan bukan hanya pada rumus.

**Pilihan yang dibandingkan**

- **(a) Alokasi penuh dengan ruang 100 ms: `preAllocatedVUs` = `maxVUs` = max(10, ceil(laju / 10)) (dipilih).** Pros: iterasi hanya dijatuhkan bila lebih dari 100 ms kedatangan menumpuk, sekitar 2,7 kali durasi iterasi terpanjang yang terukur (36,7 ms) dan sepanjang satu periode kuota CPU container (100 ms); seluruh VU dibuat sebelum T0 sehingga tidak ada pembuatan VU yang memakan CPU generator di tengah fase; memory VU tetap dan dapat dihitung dari `k6 inspect`; puncak 1.110 VU (spike) dan perkiraan memory terburuk 81 persen batas (soak) dan 72 persen (stress). Cons: VU yang menunggu memakai memory walau jarang aktif; jeda lebih dari sekitar 100 ms tetap menggagalkan run, termasuk jeda yang berasal dari mesin, bukan backend.
- **(b) Ruang 100 ms hanya untuk `preAllocatedVUs`, `maxVUs` tetap max(100, ceil(0,25 × laju)).** Arah yang disebut builder. Pros: perubahan paling kecil; VU tambahan masih dapat dibuat sesudah jeda panjang. Cons: VU tambahan baru dibuat sesudah sebuah iterasi dijatuhkan, sehingga di bawah `count==0` tidak pernah menolong run yang lulus; puncak VU yang mungkin tetap 2.500 (stress) dan 2.850 (spike), jadi memory terburuk dapat melewati 1.638 MiB tepat ketika run sudah gagal, dan alasan kegagalan bercampur `generator_saturated`; memory bergantung pada jeda yang tidak dapat diperkirakan.
- **(c) Alokasi penuh dengan `maxVUs` lama (ruang 250 ms).** Pros: probe membuktikan 0 dropped iterations pada outage dan stress. Cons: probe stress mencapai 1.946,6 MiB, di atas batas, dan spike membutuhkan 2.850 VU.
- **(d) Alokasi penuh dengan ruang lain.** Ruang 50 ms: Pros: stress sekitar 770 sampai 930 MiB. Cons: hanya sekitar 1,4 kali durasi iterasi terpanjang yang terukur, terlalu tipis untuk soak satu jam dan runner yang lebih berisik. Ruang 150 sampai 200 ms: Pros: ruang jeda lebih panjang. Cons: stress diperkirakan 1.360 sampai 1.690 MiB, dekat atau di atas batas.
- **(e) Satu scenario per endpoint per profil seperti `timeline` outage, dengan fase dari waktu mulai request.** Pros: VU tidak dihitung ganda di pergantian fase, sehingga ruang 250 ms muat (stress sekitar 1.250 VU). Cons: nama scenario, threshold beban aktual per scenario, `actual.scenarios`, laporan, fixture, dan PERF-001 berubah di tengah langkah 4, dan beban aktual per fase harus diukur dengan cara baru yang belum dibuktikan pada k6 2.3.0.
- **(f) Batas memory container k6 lebih besar, misalnya 3 GiB.** Pros: ruang 250 ms muat tanpa mengubah scenario. Cons: mengubah topologi dan kontrak generator yang sudah disepakati, jumlah batas memory menjadi 4,5 GiB sehingga pemeriksaan `environment_too_small` ikut berubah, dan bertentangan dengan batas memory yang dipegang keputusan ini.
- **(g) Melonggarkan `dropped_iterations`, misalnya rasio kecil.** Pros: run tidak berhenti karena satu jeda. Cons: dilarang spec ini dan scope (target tidak dilonggarkan agar lulus); iterasi yang dijatuhkan berarti beban yang direncanakan tidak dibangkitkan.

**Keputusan**

57. **Rumus VU.** Dipilih (a): `preAllocatedVUs` = `maxVUs` = `scenarioVUs(laju)` = max(10, ceil(laju × `VU_HEADROOM_MS` / 1.000)) dengan `VU_HEADROOM_MS` 100, laju terbesar fase itu. Alasannya dua kekuatan yang bertabrakan pada keputusan 40: `count==0` membuat iterasi pertama yang dijatuhkan sudah menentukan hasil, dan k6 2.3.0 hanya mencegah iterasi pertama itu dengan VU yang sudah dibuat. Karena itu hanya VU yang dibuat di awal yang berguna, dan jumlahnya ditentukan anggaran memory. Ruang 100 ms adalah ruang bulat terbesar yang menjaga perkiraan terburuk stress di bawah tiga perempat batas (110 ms sudah sekitar 75 persen, 120 ms sekitar 78 persen) sambil memberi sekitar 2,7 kali jeda terpanjang yang terukur. (b) ditolak karena VU tambahan tidak pernah menolong run yang lulus dan hanya membuka memory terburuk di atas batas; (c) karena terukur melewati batas; (d) karena 50 ms terlalu tipis dan 150 sampai 200 ms terlalu dekat dengan batas; (e) dicatat sebagai pilihan berikutnya bila memory tidak cukup, bukan sekarang, karena perubahannya besar dan belum terbukti; (f) karena mengubah kontrak environment; (g) karena dilarang.
58. **Batas bawah 10 VU tetap.** Scenario pelan tetap mendapat 10 VU: readiness pada N (50 per detik) mendapat ruang 200 ms, smoke `status` 100 ms, dan smoke readiness 1 detik. Pada outage hanya satu pemeriksaan readiness yang dapat menggantung sampai sekitar 3 detik (satu pemeriksaan aktif menurut spec 0006, sisanya 429 cepat), sehingga 10 VU readiness tetap cukup. Puncak smoke tetap 40 VU dan memory nya tidak berubah; yang berubah hanya `maxVUs` smoke dari 100 menjadi 10, yang ikut dibandingkan pemeriksaan inspect pada setiap push. Pilihan kedua, batas bawah 1 VU, ditolak karena readiness N akan hanya mempunyai 5 VU sementara satu VU dapat tertahan 3 detik pada outage.
59. **Penjaga anggaran VU.** PERF-001 memeriksa `scenarioVUs`, kesamaan `preAllocatedVUs` dan `maxVUs` di setiap scenario, dan field `maxVUs` tingkat atas setiap fixture inspect nyata terhadap puncak tabel *Alokasi VU*, sehingga perubahan laju, durasi, atau fase yang menaikkan puncak VU terlihat di tier cepat sebelum profil dijalankan. Tidak ada check run baru: `generator_memory` tetap satu satunya batas memory saat run, dan tabel perkiraan hanya dasar perencanaan. Pilihan kedua, check baru yang membandingkan `vus_max` dengan puncak saat run, ditolak karena dengan `maxVUs` sama dengan `preAllocatedVUs` k6 tidak dapat membuat VU di atas puncak; nilainya cukup dicatat sebagai pengamatan langkah 4.
60. **Run ulang langkah 4.** Sesudah `plan.ts`, PERF-001, dan keenam fixture inspect diperbarui, smoke dan `test:ci:real` dijalankan lagi karena keluaran inspect smoke berubah, lalu setiap profil kapasitas dijalankan sekali lagi. Bila satu profil masih menjatuhkan iterasi atau gagal `generator_memory`, builder berhenti dan kembali ke `/architect` dengan data run itu; `VU_HEADROOM_MS`, beban, batas memory, `count==0`, dan target tidak diubah di tempat. Soak paling dekat ke batas memory karena data ringkasan satu jam (perkiraan 56 sampai 81 persen); bila soak yang gagal di sana, pilihan pertama yang ditimbang adalah `GOMEMLIMIT` pada container k6 (batas lunak runtime Go yang membuat garbage collector bekerja lebih sering sebelum batas, tanpa mengubah batas container), lalu (e), lalu (f).
61. **Alasan sekunder pada run yang berhenti lebih awal tidak diubah.** Builder bertanya apakah alasan sekunder perlu dibedakan pada run yang berhenti lebih awal: `generator_cpu` tanpa sampel dicatat `generator_saturated`, perintah outage yang tidak sempat dikirim dicatat `outage_control_late`, `backend_memory_growth` tanpa jendela dicatat `observation_failed`, dan satu iterasi yang terpotong saat k6 berhenti membuat `iteration_request_mismatch` 32275/32274. Dipilih tetap: alasan disusun menurut kejadian sehingga yang pertama selalu penyebabnya (`k6_thresholds_failed`), setiap alasan sekunder benar menyatakan bukti yang hilang atau tidak cocok, dan aturan gagal tertutup memastikan pengamatan yang hilang tidak pernah dibaca lulus. Pilihan kedua, kode baru untuk run yang berhenti lebih awal, ditolak karena menambah cabang penilaian dan kosakata laporan hanya untuk run yang sudah gagal, dan exit 99 karena `abortOnFail` tidak dapat dibedakan dari threshold yang gagal di akhir run tanpa membaca isi ringkasan.

**Pemeriksaan silang.** Tingkat GA menyarankan pemeriksaan oleh model lain, tetapi run ini tidak mempunyai kemampuan subagent, sehingga agent menjalankan pemeriksaan kelengkapan keputusan dengan model yang sama di thread utama; pemeriksaan independen tidak berjalan untuk bagian ini. Celah yang ditemukan dan langsung ditutup di `index.md`: (1) nama fungsi dan konstanta yang menggantikan `preAllocatedVUs` dan `maxVUs` lama belum ditetapkan, sehingga ditetapkan `VU_HEADROOM_MS` dan `scenarioVUs`; (2) sumber nilai puncak VU per profil belum ada, sehingga baris *Value sourcing* menunjuk field `maxVUs` tingkat atas `k6 inspect` dan tabel puncak; (3) smoke ikut berubah walau puncaknya tetap, sehingga Build plan langkah 4 menjalankan ulang smoke dan `test:ci:real`; (4) langkah `verify.md` lama untuk VU smoke menjadi usang, sehingga Build plan meminta langkah pengganti; (5) memory soak didominasi data ringkasan, bukan VU, sehingga risikonya dan pilihan pertama bila gagal ditulis (keputusan 60). Satu hal sengaja dibiarkan terbuka: perkiraan memory bertumpu pada model dari run Mac ini, dan runner GitHub baru terukur sesudah push.

Milestone scope fitur 12 tidak berubah: perubahan ini berada di milestone keempat (profil kapasitas) yang memang belum selesai. Status spec tetap `In Progress`.

## Ambang beban aktual 2026-10-04

Review kode oleh model lain (`docs/reviews/2026-10-04-main-capacity-recovery.md`) mencatat dua temuan major tentang ambang `iterations{scenario:<nama>}` dan meminta keputusannya dicatat di spec. Run pertama tier kapasitas gagal pada spike karena `iterations{scenario:status_settle}` 9.986, di bawah `count>=9990`, dengan 0 dropped iterations, `http_reqs` sama dengan `iterations`, dan 53 threshold lain lulus; outage dan soak menjadi `not_run`, dan tier diulang sekitar 98 menit tanpa perubahan apa pun. Lima scenario hanya mempunyai ruang satu iterasi (tiga di antaranya pada smoke per push), dan fase `settle` 10 detik untuk `status` hanya 10 iterasi, sekitar 10 ms kedatangan.

Tidak ada manusia selama run. Keputusan di bawah diambil oleh agent pada 2026-10-04 atas delegasi pemilik ("jika membutuhkan /architect anda bisa menjalankannya dengan mengambil keputusan sendiri berdasarkan rekomendasi anda"), tanpa konfirmasi manusia. Batas yang dipegang: `dropped_iterations` tetap `count==0`, `http_reqs` tetap wajib sama dengan `iterations`, beban, VU, dan target latency serta ketersediaan tidak berubah, dan tidak ada ambang beban aktual yang menjadi lebih ketat dari 99,9 persen sehingga bukti lama tidak berubah arti.

**Bukti yang dipakai** (`result.json` yang disalin ke `docs/testing/evidence/0011/`, selisih iterasi aktual dengan rencana setiap scenario laju tetap):

| Run | Selisih terbesar ke bawah | Selisih lain |
| --- | --- | --- |
| smoke | 0 (`readiness_steady` 300 dari 300) | +1 pada tiga scenario lain |
| load | tidak ada | +1 |
| stress | −4 (`status_hold` 1.199.996 dari 1.200.000) | −1 sampai +2 |
| spike run pertama | −14 (`status_settle` 9.986 dari 10.000) | −1 sampai +2 |
| spike run ulang | tidak ada | +1 |
| outage | tidak ada | 0 dan +1 |
| soak | tidak ada | 0 dan +1 |

Selisih +1 adalah pembulatan batas scenario. Selisih ke bawah tanpa dropped iterations hanya dapat berasal dari akhir scenario: executor laju tetap k6 2.3.0 yang tertinggal memulai iterasi yang terlambat sekaligus pada VU yang bebas (atau menjatuhkannya bila VU tidak cukup, yang dihitung `dropped_iterations`), tetapi saat durasi scenario habis iterasi yang masih tertunda tidak dimulai dan tidak dihitung sebagai dropped. Kekurangan di akhir scenario karena itu sama dengan kedatangan selama jeda generator pada saat itu, yaitu 14 ms pada run pertama spike (CPU k6 pada jendela itu 27 sampai 61,5 persen satu CPU, jauh dari batas). Ambang 99,9 persen memberi ruang 0,1 persen durasi scenario, jadi fase 10 detik hanya mentoleransi jeda sekitar 10 ms di akhirnya, sedangkan di tengah scenario jeda sampai ruang VU (100 ms, atau lebih panjang pada scenario dengan batas bawah 10 VU) sudah diterima tanpa kegagalan.

**Pilihan yang dibandingkan**

- **(a) Tetap 99,9 persen dan menerima run ulang sesekali.** Pros: tanpa perubahan. Cons: satu dari dua run penuh sudah gagal karena batas fase; satu kegagalan membuat sisa langkah `not_run` dan memaksa run ulang sekitar 98 menit; smoke per push hanya mempunyai ruang satu iterasi pada tiga scenario; ambang menilai jeda generator di akhir fase pendek jauh lebih ketat daripada di tengahnya.
- **(b) 99,9 persen, tetapi tidak pernah lebih dari rencana dikurangi jumlah VU scenario itu (dipilih).** Pros: akhir scenario mendapat ruang yang sama dengan tengahnya, yaitu jeda yang diserap VU tanpa iterasi yang dijatuhkan (100 ms pada `status` S0 dan N serta pada beban O, 200 ms pada readiness N, 1 detik pada readiness S0); jeda yang lebih panjang tetap gagal di mana pun terjadinya; scenario panjang tetap 99,9 persen; tidak ada konstanta baru karena ruangnya diturunkan dari `scenarioVUs`; kegagalan run pertama (14 ms) lulus dengan ruang sekitar tujuh kali. Cons: ambang beberapa scenario pendek turun (paling jauh smoke readiness, 90 dari 100 dan 290 dari 300, karena batas bawah 10 VU); fixture inspect smoke, stress, dan spike berubah.
- **(c) 99,9 persen hanya untuk scenario 60 detik atau lebih, scenario pendek `count>=0`.** Pros: sederhana. Cons: smoke per push (10 dan 30 detik) dan fase `settle` kehilangan ikatan beban aktual sama sekali; batas 60 detik tidak bertumpu pada pengukuran.
- **(d) Toleransi mutlak tetap, misalnya 50 iterasi atau satu detik kedatangan.** Pros: mudah dibaca. Cons: 50 iterasi adalah 50 ms pada `status` N tetapi 5 detik pada readiness S0, dan satu detik kedatangan pada beban O adalah 4.000 iterasi; angka itu tidak terkait dengan jeda yang sudah diterima run di tengah scenario.
- **(e) Semua scenario laju tetap `count>=0`, hanya bergantung pada `dropped_iterations` dan kesamaan `http_reqs` dengan `iterations`.** Pros: tidak pernah gagal karena batas fase. Cons: jeda generator di akhir scenario tidak pernah terlihat, dan baris *Beban aktual* AC-4 kehilangan isinya.

**Keputusan**

62. **Ambang beban aktual.** Dipilih (b): `iterationFloor(laju, detik)` = min(floor(0,999 × laju × detik), laju × detik − `scenarioVUs(laju)`), tidak pernah di bawah 0. (a) ditolak karena ketidakstabilan yang terukur menilai jeda yang sudah diterima di tengah scenario; (c) dan (e) karena menghapus ikatan beban aktual pada fase pendek dan smoke; (d) karena angka tetap tidak sebanding antarlaju. PERF-001 mengunci rumus, setiap ambang keenam profil, sifat bahwa ambang tidak pernah lebih ketat dari 99,9 persen dan ruangnya tidak pernah kurang dari jumlah VU, serta angka run pertama spike (9.986 lulus, 9.899 gagal); keenam fixture inspect ditangkap ulang dari `k6 inspect` nyata dengan argumen container yang sama, dan hanya ekspresi ambang smoke, stress, dan spike yang berubah. Bukti tier kapasitas yang ada tetap memakai ambang lama; run tier kapasitas berikutnya menjadi bukti pertama ambang baru (Follow-up).
63. **Pemindaian credential sebelum redaksi.** Review mencatat bahwa langkah 8 memindai `observation.json` dan `result.json` sesudah redaksi, sehingga pemindaian itu tidak pernah dapat menemukan credential dan `artifact-scan.json` tanpa temuan hanya membuktikan bahwa redaksi berjalan. Dipilih: kedua teks dipindai sebelum redaksi, temuan menambah `secret_in_output`, lalu teks yang ditulis tetap teredaksi. Pilihan kedua, menyatakan di spec bahwa kedua file hanya dilindungi redaksi, ditolak karena pemindaian yang tidak dapat menemukan apa pun tetap tercatat sebagai bukti di `filesScanned`. Ini memperketat, tidak melonggarkan.
64. **`k6/summary.json` tidak diredaksi di disk.** File itu tetap data `handleSummary` apa adanya: temuan credential di sana sudah membuat run gagal `secret_in_output`, dan credential run hanya berlaku untuk PostgreSQL sementara yang hanya didengar di loopback dan dihapus pada setiap jalur keluar. Mengubah isi file nyata k6 akan membuat ringkasan berbeda dari yang dinilai k6. Pilihan kedua, meredaksi salinan di disk, ditolak dengan alasan itu.
65. **Kabel verdict `runProfile` diuji tanpa Docker.** Review menunjukkan bahwa exit k6, pemeriksaan `environment_busy` sesudah k6, alasan ringkasan, dan check pengamatan dapat dihapus tanpa satu test pun gagal. Dipilih: PERF-009 (d) menjalankan `runProfile` sampai penilaian dengan jam host yang dipercepat dan pemanggil perintah tiruan, sehingga setiap alasan dan exit 0 pada run yang lulus dibuktikan; `RunDeps` mendapat `chown` opsional agar jalur UID host 0 dapat diuji pada host bukan root. Tidak ada perilaku run yang berubah.
66. **Ruang VU smoke S0 tidak diubah sekarang.** Review mencatat bahwa `status` S0 hanya mempunyai ruang 100 ms pada runner GitHub yang belum terukur. Tidak ada bukti kegagalan (setiap smoke yang tercatat di Mac ini 0 dropped iterations), dan menaikkan alokasi S0 mengubah tabel *Alokasi VU*, fixture inspect, dan pembanding inspect per push tanpa data. Dipilih: dicatat sebagai Follow-up untuk diperiksa pada job `real` pertama di GitHub; `count==0` tidak dilonggarkan.

**Pemeriksaan silang.** Tingkat GA menyarankan pemeriksaan oleh model lain, tetapi run ini tidak mempunyai kemampuan subagent, sehingga agent memeriksa kelengkapan keputusan dengan model yang sama di thread utama; pemeriksaan independen tidak berjalan untuk bagian ini. Celah yang ditemukan dan langsung ditutup di `index.md`: (1) sumber nilai ambang beban aktual belum punya baris *Value sourcing*, sehingga baris itu ditambahkan; (2) AC-4 dan baris *Beban aktual* masih menyebut 99,9 persen saja, sehingga keduanya merujuk paragraf *Ambang beban aktual*; (3) uraian PERF-009 belum memuat test kabel verdict, sehingga butir (d) ditambahkan beserta AC yang dibuktikannya; (4) langkah 8 *Urutan orkestrasi* masih menyebut redaksi sebelum pemindaian, sehingga urutannya diganti. Status spec tetap `In Progress`.

## Bukti baseline

Diukur 2026-10-04 di mesin ini dengan generator beban Bun sementara (open model, kedatangan merata, di folder scratch dan tidak masuk repository), bukan k6, sehingga overhead k6 belum termasuk. Setiap container dihapus sesudah probe, dan tidak ada container, network, atau folder probe yang tersisa.

Environment probe: Apple M1 Max, 10 core, 32 GB, macOS 27.0; Docker Desktop 29.8.0 dengan VM linux/arm64 10 CPU dan sekitar 7,75 GiB; tujuh container lain berjalan (PostgreSQL dan MySQL proyek lain, idle). PostgreSQL dari `foundation-postgres:18-pinned` (2 CPU pada probe 1 dan 2, 1 CPU pada probe 3), diprovision dan dimigrasi dengan credential acak, satu migration. Backend `bun --no-env-file apps/backend/src/index.ts` di container `oven/bun:1.4.2` dengan 1 CPU dan 512 MiB; generator di container `oven/bun:1.4.2` yang berbagi namespace backend.

**Status** (latency ms dari sisi generator):

| Laju (per detik) | Durasi | Hasil | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| 250 | 15 s | 3.750 × 200 | 1,61 | 3,15 | 7,79 |
| 1.000 | 15 s | 15.000 × 200 | 1,37 | 2,72 | 28,02 |
| 2.000 | 15 s | 30.000 × 200 | 0,79 sampai 1,28 | 1,93 sampai 2,58 | 8,17 sampai 10,78 |
| 4.000 | 15 s | 60.000 × 200 | 0,22 | 0,47 | 4,23 |
| 8.000 | 15 s | 120.000 × 200 | 0,49 sampai 1,19 | 1,73 sampai 2,65 | 8,33 sampai 16,56 |
| 16.000 | 15 s | 240.000 × 200 | 1,01 | 3,66 | 33,11 |
| 24.000 | 15 s | 360.000 × 200 | 1,93 | 16,22 | 235,82 |
| 32.000 | 15 s | 480.000 × 200 | 1,71 | 4,13 | 30,31 |

**Readiness** (latency 200 kecuali disebut):

| Laju (per detik) | Hasil | Rasio 200 | p95 200 | p99 200 | p95 429 |
| --- | --- | --- | --- | --- | --- |
| 10 | 150 × 200 | 1,0 | 6,47 | 7,85 | tidak ada |
| 25 | 375 × 200 | 1,0 | 5,34 | 8,69 | tidak ada |
| 50 | 750 × 200 | 1,0 | 5,32 | 7,09 | tidak ada |
| 100 | 1.496 × 200, 4 × 429 | 0,997 | 3,43 | 5,46 | 2,86 |
| 200 | 2.962 × 200, 38 × 429 | 0,987 | 3,66 | 5,15 | 2,22 |
| 400 | 5.734 × 200, 266 × 429 | 0,956 | 2,67 | 4,01 | 1,92 |
| 1.000 | 11.974 × 200, 3.026 × 429 | 0,798 | 1,09 | 1,82 | 0,62 |

**Beban gabungan** (probe 3, PostgreSQL 1 CPU):

| Jendela | Status p95 dan p99 | Readiness | CPU backend rata rata dan maksimum | Memory backend rata rata dan maksimum | CPU PostgreSQL rata rata | Sesi `foundation_backend` maksimum, tidak idle maksimum |
| --- | --- | --- | --- | --- | --- | --- |
| N 120 s (1.000 dan 50) | 0,65 dan 1,69 ms | 6.000 × 200, p95 3,35, p99 5,38 ms | 9,8 dan 16,3 persen | 31,3 dan 35,7 MiB | 1,9 persen | 5 dan 1 |
| O 60 s (4.000 dan 1.000) | 0,26 dan 0,45 ms | 48.874 × 200 (0,815), 11.126 × 429; p95 200 0,76 ms, p95 429 0,28 ms | 30,6 dan 37,4 persen | 29,6 dan 31,2 MiB | 12,3 persen | 5 dan 1 |
| N sesudah O, 60 s | 1,26 dan 2,58 ms | 2.999 × 200, 1 × 429, p95 4,8 ms | 13,6 dan 17,5 persen | 27,9 dan 29,8 MiB | 2,7 persen | 5 dan 1 |
| N 300 s | 1,15 dan 2,22 ms (max 36,61) | 14.996 × 200, 4 × 429, p95 4,08, p99 5,77 ms | 12,6 dan 16,1 persen | 27,9 dan 30,4 MiB; sepertiga awal 28,0, sepertiga akhir 27,7 | 2,4 persen | 5 dan 1 |

Spike status 500 ke 8.000 lalu kembali ke 500 per detik (10, 10, dan 20 detik) memberi p95 1,08, 1,26, dan 1,35 ms tanpa error, dengan readiness 20 per detik selalu 200.

**Database berhenti** (probe 2, status 200 dan readiness 20 per detik, stop pada detik 15 dan start pada detik 35): `docker stop` selesai 407 ms dan `docker start` 124 ms; 503 pertama 260 ms sesudah perintah stop; selama berhenti readiness menjawab 374 × 429 dan 5 × 503, dengan 503 tiba sekitar 3.001 ms (batas `connectionTimeout` pool 3 detik, karena alamat container yang berhenti tidak menjawab); 200 pertama 227 ms sesudah start, lalu 488 × 200; status 12.000 × 200 dengan p95 0,7 ms dan max 14,2 ms selama database berhenti. Stderr backend kosong di semua probe dan stdout hanya `Backend listening at http://127.0.0.1:8888`.

**Probe jaringan dan image**: container dengan `--network host` tidak dapat menjangkau server yang mendengar `127.0.0.1` di host macOS (connection refused), sedangkan `host.docker.internal` dapat. Lewat `host.docker.internal`, status pada 500, 2.000, dan 4.000 per detik memberi p95 2,87, 1,71, dan 0,93 ms, dibanding p95 0,99, 1,36, dan 1,70 ms dari generator di host langsung. Backend berjalan di `oven/bun:1.4.2-slim` dengan mount hanya `apps/backend`, `libs`, `node_modules`, dan `package.json`, `--read-only`, tmpfs `noexec`, user host, `--cap-drop ALL`, dan `no-new-privileges`: `/api/status` 200, `/api/readiness` 503 tanpa database, dan `Backend stopped` sesudah `docker stop`; jam container sama dengan jam host dalam resolusi detik. Image PostgreSQL proyek memakai `STOPSIGNAL SIGINT`. Digest lokal yang tercatat Docker (`RepoDigests`) untuk `oven/bun:1.4.2-slim` diawali `sha256:cb3bbbb0`; nilai itu belum diperiksa sebagai digest indeks dan wajib dibaca ulang dengan `docker buildx imagetools inspect`.

**Target terhadap baseline**:

| Target | Nilai | Terburuk lokal | Margin |
| --- | --- | --- | --- |
| Status p95 | di bawah 10 ms | 1,61 ms | sekitar 6 kali |
| Status p99 | di bawah 25 ms | 3,66 ms (16,22 ms hanya pada 24.000 per detik) | sekitar 7 kali |
| Readiness 200 p95 | di bawah 25 ms | 6,47 ms | sekitar 4 kali |
| Readiness 200 p99 | di bawah 50 ms | 8,69 ms | sekitar 6 kali |
| Readiness 429 p95 pada O | di bawah 10 ms | 0,62 ms | lebih dari 10 kali |
| Rasio 200 readiness pada N | paling sedikit 0,98 | 0,997 | rasio 429 boleh naik sekitar 6 kali |
| Rasio 200 readiness pada O | paling sedikit 0,20 | 0,798 | sekitar 4 kali |
| Memory backend puncak | paling banyak 128 MiB | 35,7 MiB | sekitar 3,5 kali |
| CPU backend rata rata pada N | paling banyak 50 persen | 13,6 persen | sekitar 3,7 kali |
| Pertumbuhan memory soak | paling banyak 16 MiB | turun 0,3 MiB dalam 300 s | tidak berlaku |
| 503 maksimum saat database berhenti | di bawah 5.500 ms | 3.001 ms | batas desain 5.000 ms ditambah transport |
| Pemulihan sesudah start | 10 detik | 0,23 detik | mencakup start PostgreSQL dan `connectionTimeout` 3 detik |

## Pertanyaan yang belum dapat diputuskan

- Biaya CPU k6 2.3.0 per request belum terukur karena k6 tidak terpasang dan image belum ditarik. Apakah tiga CPU cukup membangkitkan 5.000 request per detik dengan checks di bawah 80 persen, di Mac maupun runner 4 vCPU, baru diketahui pada langkah 4 Build plan. Bila tidak cukup, keputusan environment dikembalikan ke pemilik lewat `/architect`; beban dan target tidak diubah. Diperbarui 2026-10-04: di Mac ini terukur rata rata 81,7 persen dan maksimum 132,5 persen satu CPU pada O (probe stress langkah 4), jauh di bawah 240 persen; runner GitHub belum terukur.
- Memory k6 pada soak satu jam belum terukur; run nyata soak pertama berhenti pada detik 334. Perkiraan 910 sampai 1.330 MiB (*Alokasi VU 2026-10-04*) bertumpu pada pertumbuhan per request yang diukur dari run lebih pendek, dan dibuktikan atau dibantah oleh run ulang langkah 4.
- Latency yang diukur k6 belum dibandingkan dengan generator Bun probe; target tetap berlaku apa pun selisihnya.
- Dukungan k6 2.3.0 untuk profil TypeScript yang mengimpor modul `.ts` relatif, ketersediaan `k6 inspect --execution-requirements` tanpa `--env`, bentuk JSON keluaran inspect, bentuk data `handleSummary` (`metrics[<nama>].values`, kunci submetrik, `setup_data`, hasil threshold), `count` pada `summaryTrendStats`, perilaku threshold atas submetrik tanpa sampel, dan exit code untuk galat `setup()` diambil dari pengetahuan rilis k6 1.x dan catatan rilis 2.0.0; semuanya dibuktikan probe langkah 1 Build plan dan keluaran nyatanya menjadi fixture PERF-001. Bila salah satu yang disebut wajib pada langkah itu tidak berlaku, implementasi berhenti dan kembali ke `/architect`.
- Digest indeks `grafana/k6:2.3.0` dan `oven/bun:1.4.2-slim` belum dibaca dengan `docker buildx imagetools inspect`; nilai dari antarmuka web tidak dipakai karena belum terverifikasi.
- Varians runner GitHub hosted, laju sampel `docker stats` di Linux, dan pola 503 sekitar 3 detik saat container berhenti di jaringan bridge Linux belum diukur; workflow kapasitas baru dapat dijalankan sesudah push dan pemicuan manual.
- Selisih jam VM Docker Desktop dengan host selama run panjang belum diukur di luar probe singkat; check `clock_offset` kini mengukur sebelum T0 dan sesudah k6 keluar, sehingga pergeseran yang kembali normal di tengah run tidak terdeteksi, tetapi pergeseran yang menetap terdeteksi.
- Apakah image PostgreSQL proyek berjalan dengan `--cap-drop ALL`, `no-new-privileges`, dan `--pids-limit 256` dibuktikan probe langkah 1; image berjalan sebagai `USER postgres` tanpa langkah turun privilege, sehingga flag itu diperkirakan tidak berpengaruh. Bila tidak berjalan, implementasi kembali ke `/architect`, bukan melepas flag diam diam.

## References

**Project sources**:

- `AGENTS.md`, sumber aturan, koordinasi subagent, dan pertanyaan schema.
- `docs/scope/scope.md`, fitur 12, batas dan keputusan (tidak ada angka performance yang diasumsikan), dan build approach Tracer Bullet.
- `docs/rules/testing.md`, bagian jenis test, struktur test, pemetaan skenario, performance dengan k6, dan workflow CI.
- `docs/rules/security.md`, kontrol konsumsi resource berlebihan, container berbatas resource, dan pemindai yang dipin.
- `docs/rules/infrastructure.md`, batas development PostgreSQL 1 GiB, 2 CPU, dan shm 128 MiB.
- `docs/rules/database.md`, kapasitas pool per container.
- `docs/testing/release-report-template.md`, bagian hasil performance.
- Spec 0001 AC-4 (route status hanya development), spec 0004 (pool `max` 5, `connectionTimeout` 3 detik), spec 0005 (runner satu satunya penulis riwayat), spec 0006 (kontrak readiness, READY-008, penjaga dan label container), dan spec 0010 (tier, manifest, laporan, daftar izin workflow, pin pemindai).
- `apps/backend/src/app.ts`, `apps/backend/src/index.ts`, `apps/backend/src/config/env.ts`, `apps/backend/src/features/development/readiness.*.ts`, `libs/server/database/client.ts`, `scripts/lib/gate.ts`, `scripts/check-workflow.ts`, `tests/orchestration/readiness-real.ts`, `tests/orchestration/security-scan.ts`, `tests/security/scanners.json`, `infrastructure/postgres/Dockerfile` (`STOPSIGNAL SIGINT`), `infrastructure/postgres/pins.json`, `docker-compose.yml`, dan `.github/workflows/application.yml`.
- Daftar rilis GitHub grafana/k6 dan catatan rilis k6 2.0.0, dibaca 2026-10-04 (rilis stabil terbaru 2.3.0 pada 21 September 2026).

**Practices & standards**:

- Open model dengan laju kedatangan tetap untuk request independen, dan pencatatan dropped iterations agar beban yang tidak tercapai tidak dianggap terbukti.
- Target per instance dengan batas CPU dan memory tetap agar hasil antarmesin dapat dibandingkan.
- Penetapan target sebelum pengukuran dengan margin terhadap baseline, tanpa melonggarkan sesudah hasil keluar.
- Pin image container dengan digest indeks multi arch dan container read only tanpa capability.
- Bukti test yang terikat identitas build untuk kandidat release.
- OWASP ASVS sebagai rujukan kontrol konsumsi resource yang dapat diuji, sesuai aturan keamanan proyek.
